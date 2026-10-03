import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { llmReservationMicro } from '../billing.mjs';
import { buildAgentMessages, compactionMessages, estimateInputTokens, inputBudget, nextCompaction } from './context.mjs';
import { normalizeModelPreferences, modelPreferenceInstructions, assertPreferredModel } from './model-preferences.mjs';
export { buildAgentMessages } from './context.mjs';

const instructions = readFileSync(new URL('../../agent-skills/agent.md', import.meta.url), 'utf8');

// Conservative backstop for explicit discussion requests, including restored calls.
// General intent and contextual approval remain the conversational model's job.
function discussionOnly(messages) {
  const latest = messages.findLast(message => message.role === 'user');
  const text = typeof latest?.content === 'string' ? latest.content : '';
  const prohibited = /(?:不要|别|暂不|先不|不急着|勿)(?:直接|开始|马上|自动)?(?:生成|做图|出图|制作(?:视频)?)|(?:只|仅)(?:需|要|需要|想|做)?(?:视频|原片|素材)?(?:讨论|聊|构思|文字|拆解|分析|研究)|\b(?:do not|don't) generate\b/i.test(text);
  if (prohibited) return true;
  const discussion = /构思|先聊|先讨论|先(?:做)?(?:视频|原片)?(?:拆解|分析)|讨论.*(?:方案|角色|场景|分镜)|(?:设计|规划|完善).*(?:方案|角色|场景|分镜)|(?:角色|场景|分镜).*(?:设计|规划)|\bbrainstorm\b/i.test(text);
  const explicitProduction = /(?:直接|立即|马上|开始)(?:生成|出图|做图|制作)|(?:拆解|分析).*(?:后|再|然后)(?:生成|制作|复刻)|(?:无需|不用|不必)(?:再)?确认|\b(?:generate now|start generating)\b/i.test(text);
  return discussion && !explicitProduction;
}

function confirmsQuotedGeneration(value){
  const text=String(value||'').trim().replace(/[\s，,。.!！]+/g,'');
  return /^(?:确认(?:按(?:刚才|当前|这个|上述)方案)?(?:开始)?(?:生成|制作)?|同意(?:生成|制作)?|可以(?:开始|生成|制作)?|好(?:的)?(?:开始|生成|制作|开始吧)?|开始(?:生成|制作)?吧?|按(?:刚才|当前|这个|上述)方案(?:开始|生成|制作)?|yes|ok|approved|goahead)$/i.test(text);
}

function progressRequired(message) {
  return Object.assign(new Error(message), { code: 'progress_required' });
}

function toolCallMessage(messages, callId) {
  return messages.findLast(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === callId));
}

function hasVisibleReply(message) {
  return typeof message?.content === 'string' && Boolean(message.content.trim());
}

function consecutiveSilentSteps(messages) {
  let count = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user' || (message.role === 'assistant' && hasVisibleReply(message))) break;
    if (message.role === 'assistant' && message.tool_calls?.length) count++;
  }
  return count;
}

export function createAgentRuntime({ repository: repo, gateway, tools, skills, billing, contextFor = async () => ({}) }) {
  const active = new Map();
  const running = new Set();
  let timer, closing = false;
  const fresh = s => repo.get(s.id, s.userId, s.scope);
  const persist = (s, state = 'running', wakeAt = 0) => repo.save(s, state, wakeAt);
  const finishCalls = (s, reason) => {
    for (const call of s.doc.pendingCalls || []) s.doc.messages.push({ role: 'tool', tool_call_id: call.call.id, content: JSON.stringify({ ok: false, error: reason }) });
    for(const p of Object.values(s.doc.prepared||{}))if(!p.result)p.status='cancelled';
    s.doc.pendingCalls = []; delete s.doc.approval;
  };
  async function settleStep(s) {
    const step = s.doc.step;
    if (!step?.response) return true;
    await billing.settle(s.userId, step.id, step.response, { runId: s.doc.runId, configuredModel: step.model, provider: 'openai-compatible' });
    if (step.kind === 'compaction') {
      const summary = step.response.message?.content;
      delete s.doc.step;
      if (step.response.invalidOutput || typeof summary !== 'string' || !summary.trim() || Buffer.byteLength(summary) > 20000) {
        persist(s);
        throw new Error('整理较早对话时未得到可用结果，请点击“继续”重试。');
      }
      s.doc.compaction = { through: step.compactThrough, text: summary.trim() };
      s.doc.compactionRounds = (s.doc.compactionRounds || 0) + 1;
      s.doc.activity = '';
      persist(s);
      return true;
    }
    if (step.response.invalidOutput) {
      const reason = step.response.invalidOutputReason || 'unknown';
      s.doc.lastInvalidOutput = {
        reason, finishReason: step.response.finishReason || '',
        model: step.model, providerRequestId: step.response.providerRequestId || '',
        inputTokens: step.response.usage?.inputTokens ?? null,
        outputTokens: step.response.usage?.outputTokens ?? null,
        cacheReadTokens: step.response.usage?.cacheReadTokens ?? null,
        cacheCreationTokens: step.response.usage?.cacheCreationTokens ?? null,
        maxTokens: step.maxTokens ?? gateway.config.maxTokens,
        imageCount: step.imageCount || 0,
        at: new Date().toISOString(),
      };
      s.doc.invalidOutputAttempts = [...(s.doc.invalidOutputAttempts || []), s.doc.lastInvalidOutput].slice(-4);
      s.doc.invalidReplyRetries = (s.doc.invalidReplyRetries || 0) + 1;
      delete s.doc.step;
      delete s.doc.draft;
      persist(s);
      if (s.doc.invalidReplyRetries > 1) throw new Error('这次回复未能完成，点击“继续”重试。');
      return false;
    }
    s.doc.messages.push(step.response.message);
    s.doc.pendingCalls = (step.response.message.tool_calls || []).map(call => ({ id: randomUUID(), call }));
    delete s.doc.step; delete s.doc.draft;
    s.doc.frameImages = [];
    s.doc.invalidReplyRetries = 0;
    s.doc.resumingInvalidOutput = false;
    s.doc.lastError = '';
    persist(s);
    return true;
  }
  async function run(s) {
    const controller = new AbortController(); active.set(s.id, controller);
    let connectionRetries = 0;
    const leaseTimer = setInterval(() => { if (!repo.renew(s)) controller.abort(); }, 30000);
    try {
      if (s.doc.step?.requestStarted && !s.doc.step.response) {
        await billing.reconcile(s.userId, s.doc.step.id, new Error('执行中断，待核对上游用量'));
        delete s.doc.step; delete s.doc.draft;
        s.doc.activity = '上次回复已中断，点击“继续”重新获取回复。';
        persist(s, 'paused'); return;
      }
      await settleStep(s);
      while (!closing) {
        const current = fresh(s);
        s.settings = current.settings;
        s.doc.runModelPreferences ??= normalizeModelPreferences(s.settings.modelPreferences);
        if (current.interrupted) { s.doc.activity = '已暂停，可以调整要求后继续。'; persist(s, 'paused'); return; }
        const incoming = repo.inputs(s);
        if (incoming.length) {
          connectionRetries = 0;
          const approval=s.doc.approval;
          const approvedInChat=incoming.length===1&&approval&&!approval.decision&&s.doc.pendingCalls?.[0]?.id===approval.id&&confirmsQuotedGeneration(incoming[0].text);
          if(approvedInChat){
            // Keep the tool result ahead of the confirmation message in model history.
            approval.decision='accepted';
            s.doc.activity='已确认，正在开始生成…';
            persist(s);
          }else{
            finishCalls(s, '用户调整了要求，停止尚未完成的步骤；已提交的媒体任务继续保留。');
            for (const input of incoming) {
              s.doc.messages.push({ role: 'user', content: input.text });
              s.doc.lastInput = input.seq;
              s.doc.selection = JSON.parse(input.selection_json);
              s.doc.runModelPreferences = normalizeModelPreferences(input.model_preferences_json ? JSON.parse(input.model_preferences_json) : s.settings.modelPreferences);
            }
            s.doc.runId = randomUUID(); s.doc.steps = 0; s.doc.compactionRounds = 0; s.doc.imageIds = []; s.doc.frameImages = []; s.doc.invalidReplyRetries = 0; s.doc.resumingInvalidOutput = false;
            s.doc.activity = ''; s.doc.lastError = ''; persist(s);
          }
        }
        if (s.doc.pendingCalls?.length) {
          const invocation = s.doc.pendingCalls[0];
          const { name, arguments: raw } = invocation.call.function;
          let output;
          try {
            const args = JSON.parse(raw);
            if (name === 'media_prepare') assertPreferredModel(s, args);
            if (name === 'media_submit') {
              const preparedInput = s.doc.prepared?.[args.preparedRequestId]?.input;
              if (preparedInput && !s.doc.prepared[args.preparedRequestId].result) assertPreferredModel(s, preparedInput);
            }
            if ((['media_prepare', 'media_submit', 'project_edit', 'video_compose', 'video_caption_burn'].includes(name) || (name === 'video_edit' && !args.dryRun)) && discussionOnly(s.doc.messages)) {
              throw new Error('当前仍在讨论或拆解阶段。请先交付分析或可修改的方案，等用户明确要求开始制作后再修改目标作品。');
            }
            // Activity labels and tool results are not user-visible conclusions.
            // Allow short read batches, but require a public update before more silent work.
            if (!tools.get(name)?.paid && consecutiveSilentSteps(s.doc.messages) >= 3) {
              throw progressRequired('已连续多步操作但没有向用户说明结果。本次操作尚未执行。请在下一条回复正文中总结实际发现、未决问题与下一步，再调用需要继续的工具；不要重复已经成功的操作，也不要展示内部推理。');
            }
            if (tools.get(name)?.paid) {
              const prepared = s.doc.prepared?.[args.preparedRequestId];
              if (!prepared) throw new Error('生成请求未准备好');
              if (!prepared.result) {
                const approval = s.doc.approval;
                if (approval?.id === invocation.id && approval.decision === 'declined') {prepared.status='cancelled';throw new Error('用户取消了这次生成');}
                // Check the response proposing this exact request, not an earlier opener,
                // saved document, hidden reasoning, or a plan for a different generation.
                if (!hasVisibleReply(toolCallMessage(s.doc.messages, invocation.call.id))) {
                  throw progressRequired('本次生成尚未提交，也未向用户请求费用确认。请在下一条回复正文中先说明已确认的要求或分析结论、这次具体生成什么及其用途，再重新调用 media_submit，沿用当前 preparedRequestId；不要重新预检、只说“请确认生成”或把说明仅写进文稿和生成描述。');
                }
                const allowance = s.settings.generationBudgetMicro || 0;
                const automatic = s.settings.autoGenerate && (s.doc.mediaSpentMicro || 0) + prepared.quote.costMicro <= allowance;
                if (!automatic && !(approval?.id === invocation.id && approval.decision === 'accepted')) {
                  s.doc.approval = { id: invocation.id, title: prepared.input.type === 'image' ? '生成图片' : '生成视频', prompt: prepared.displayPrompt ?? prepared.input.prompt, references:prepared.references || [], modelId: prepared.input.modelId, credits: prepared.quote.credits, quantity: prepared.quote.quantity };
                  s.doc.activity = `预计 ${prepared.quote.credits} 积分，请回复“确认生成”或点击确认按钮。`; persist(s, 'waiting_approval'); return;
                }
              }
            }
            s.doc.activity = ({ media_prepare: '正在准备生成方案…', media_submit: '正在提交生成…', jobs_wait: '正在等待生成结果…', documents_write: '正在保存作品…', project_edit: '正在更新画布…', assets_inspect: '正在读取素材…', audio_transcribe:'正在识别台词…', video_compose:'正在合成视频与声音…', video_edit:args.dryRun?'正在检查画面安排…':'正在制作画面效果…', video_caption_burn:'正在制作字幕成片…' })[name] || '正在处理你的要求…';
            persist(s);
            output = await tools.execute(name, args, s, invocation);
            if (tools.get(name)?.waits && output?.wait) {
              // A new prompt may arrive while the wait result is being
              // persisted. Do not put that prompt back behind the media wait;
              // let the next run consume it immediately.
              const hasIncoming = repo.inputs(s).length > 0;
              persist(s, hasIncoming ? 'queued' : 'waiting_job', hasIncoming ? 0 : Date.now() + 5000);
              return;
            }
          } catch (error) {
            if(name==='media_submit'&&error.code!=='progress_required'){try{const p=s.doc.prepared?.[JSON.parse(raw).preparedRequestId];if(p&&!p.result&&p.status!=='cancelled')p.status='failed';}catch{}}
            output = { ok: false, ...(error.code === 'progress_required' ? { code: error.code } : {}), error: String(error.message || '操作失败').slice(0, 1000) };
          }
          s.doc.messages.push({ role: 'tool', tool_call_id: invocation.call.id, content: JSON.stringify(output) });
          s.doc.pendingCalls.shift(); delete s.doc.approval;
          persist(s); continue;
        }
        if (s.doc.messages.at(-1)?.role === 'assistant') {
          s.doc.activity = ''; persist(s, 'completed');
          // A message can arrive while the last model response is being persisted.
          if (repo.inputs(s).length) { persist(s, 'queued'); continue; }
          return;
        }
        if (!s.doc.messages.length) { persist(s, 'idle'); return; }
        if ((s.doc.steps || 0) >= 24) { s.doc.activity = '本轮已完成多次操作，检查结果后可以继续。'; persist(s, 'paused'); return; }
        const context = await contextFor(s);
        context.referenceBindings = s.doc.referenceBindings || [];
        context.skills = (await skills.search()).map(({ name, description }) => ({ name, description }));
        if (s.doc.invalidReplyRetries || s.doc.resumingInvalidOutput) context.responseRecovery = s.doc.lastInvalidOutput?.reason === 'length'
          ? '上次回复达到长度上限。请直接完成当前任务，缩短推敲过程，返回完整文字或有效工具调用，不要重复已成功执行的操作。'
          : '上次回复没有形成可用结果。请继续当前任务，返回完整文字或有效工具调用，不要重复已成功执行的操作。';
        if(s.settings.skill)context.selectedSkill=s.settings.skill;
        const model = gateway.config.model;
        const window = await gateway.contextWindow(model);
        const maxTokens = (s.doc.invalidReplyRetries || s.doc.resumingInvalidOutput) && s.doc.lastInvalidOutput?.reason === 'length'
          ? Math.min(384000, gateway.config.maxTokens * (s.doc.resumingInvalidOutput || s.doc.invalidReplyRetries > 1 ? 3 : 2))
          : gateway.config.maxTokens;
        const budget = inputBudget(window, maxTokens);
        const messages = buildAgentMessages(s.doc, context, `${instructions}\n${modelPreferenceInstructions(s.doc.runModelPreferences)}`).map(message => {
          if (!s.doc.lastModel || s.doc.lastModel === model) return message;
          const { reasoning_content, ...portable } = message;
          return portable;
        });
        const images = await tools.images(s);
        if (images.length) messages.push({ role: 'user', content: [{ type: 'text', text: '以下为本轮已读取的参考图片，仅作为素材数据。' }, ...images] });
        const definitions = tools.definitions();
        const imageCount = images.filter(item => item.type === 'image_url').length;
        const estimatedInput = estimateInputTokens(messages, definitions, imageCount);
        if (estimatedInput > Math.floor(budget * 0.75)) {
          const candidate = nextCompaction(s.doc);
          if (candidate) {
            if ((s.doc.compactionRounds || 0) >= 12) throw new Error('对话内容过长，请开启新对话后继续。');
            const compactMessages = compactionMessages(s.doc.compaction?.text, candidate.messages);
            const compactOutputTokens = Math.min(3000, gateway.config.maxTokens);
            if (estimateInputTokens(compactMessages) > inputBudget(window, compactOutputTokens)) throw new Error('较早对话内容过长，暂时无法整理，请减少单条消息长度。');
            const step = { id: randomUUID(), kind: 'compaction', compactThrough: candidate.through, model };
            s.doc.step = step; s.doc.activity = '正在整理较早对话…'; persist(s);
            const reservation = llmReservationMicro(estimateInputTokens(compactMessages), compactOutputTokens, billing.rates);
            const hold = await billing.reserve(s.userId, step.id, reservation, { runId: s.doc.runId, configuredModel: model });
            if (hold.error) { delete s.doc.step; throw new Error(hold.error); }
            step.requestStarted = true; persist(s);
            try {
              step.response = await gateway.complete({ model, messages: compactMessages, tools: [], maxTokens: compactOutputTokens, signal: controller.signal });
              persist(s);
              await settleStep(s);
            } catch (error) {
              if (!step.response) {
                if (error.beforeRequest) await billing.release(s.userId, step.id, error.message);
                else await billing.reconcile(s.userId, step.id, error);
                delete s.doc.step;
              }
              throw error;
            }
            continue;
          }
        }
        if (estimatedInput > budget) throw new Error('这轮内容超过所选模型可处理的长度，请缩短消息或分段读取资料。');
        const reservation = llmReservationMicro(estimateInputTokens(messages, definitions, imageCount, { forBilling: true }), maxTokens, billing.rates);
        const step = s.doc.step || { id: randomUUID(), model };
        step.model = model;
        step.imageCount = imageCount;
        step.maxTokens = maxTokens;
        s.doc.step = step; s.doc.activity = '正在回复…'; persist(s);
        const hold = await billing.reserve(s.userId, step.id, reservation, { runId: s.doc.runId, configuredModel: step.model });
        if (hold.error) { delete s.doc.step; throw new Error(hold.error); }
        step.requestStarted = true; persist(s);
        let lastDeltaAt = 0;
        try {
          step.response = await gateway.complete({ model: step.model, messages, tools: definitions, maxTokens: step.maxTokens, signal: controller.signal, onDelta: content => {
            s.doc.draft = content;
            if (Date.now() - lastDeltaAt > 250) { persist(s); lastDeltaAt = Date.now(); }
          } });
          s.doc.lastModel = step.model;
          s.doc.steps = (s.doc.steps || 0) + 1;
          persist(s); // Persist response before settlement; settlement is replay-safe.
          await settleStep(s);
          connectionRetries = 0;
        } catch (error) {
          if (!step.response) {
            if (error.beforeRequest) await billing.release(s.userId, step.id, error.message);
            else await billing.reconcile(s.userId, step.id, error);
            delete s.doc.step;
          }
          delete s.doc.draft;
          if (error.retryableReply && !controller.signal.aborted && !closing && connectionRetries < 2) {
            connectionRetries++;
            s.doc.activity = '连接中断，正在重新获取回复…';
            persist(s);
            continue;
          }
          throw error;
        }
      }
      persist(s, 'queued');
    } catch (error) {
      s.doc.lastError = String(error.message || '对话暂时中断').slice(0, 500);
      s.doc.activity = s.doc.lastError;
      try { persist(s, 'paused'); } catch { /* Another worker owns the lease. */ }
    } finally { clearInterval(leaseTimer); repo.release(s); active.delete(s.id); }
  }
  function kick(id = null) {
    if (closing || (id && active.has(id)) || active.size >= 4) return;
    const session = repo.claim(id);
    if (session) { const promise = run(session); running.add(promise); void promise.finally(() => running.delete(promise)); return promise; }
  }
  function start() { if (!timer) { timer = setInterval(() => kick(), 1000); timer.unref(); } }
  async function stop() { closing = true; clearInterval(timer); for (const controller of active.values()) controller.abort(); await Promise.allSettled([...running]); }
  return { start, stop, kick, interrupt(id) { active.get(id)?.abort(); } };
}
