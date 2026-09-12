import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { createViralProject, findViralProject, listViralProjects, listViralTasks, saveViralProject, viralGenerationRecords } from '../../repositories/viral-projects.mjs';
import { normalizeViralInput, assetSnapshot, assetApprovalHash, planApprovalHash, assertViralReady, viralError, fingerprint, viralPlanSystem } from '../../lib/viral-lab.mjs';
import { buildSourceAnalysisPrompt, normalizeReplicaPlan, normalizeSourceObservation, sourceAnalysisFingerprint, sourceAnalysisSystemPrompt, splitSourceTimeline } from '../../services/viral-source-analysis.mjs';

export function createViralLabRouteHandler({ bodyJson, sendJson, requireUser, requireDesktopWorkspaceScope, findAsset, publicAsset, publicGeneration,
  llmConfig, isLlmConfigured, callLlm, llmRates, conservativeInputTokenUpperBound, llmReservationMicro, reserveLlmCredits, settleLlmCredits, releaseLlmCredits, markLlmBillingReconcile,
  ensureLocalAsset = null, sourceAnalysisExecutable = ffmpegPath }) {
  const activePlans = new Set();
  const activeAnalyses = new Set();
  const snapshot = (userId, scope, project) => assetSnapshot(project, id => findAsset(userId, id, scope));
  function get(userId, scope, id) {
    const project = findViralProject(userId, id, scope);
    if (!project) throw viralError('实验项目不存在', 404);
    return project;
  }
  function planQuote(project) {
    const prompt = JSON.stringify({ type: project.type, productName: project.productName, brief: project.brief, sourceNotes: project.sourceNotes, sourceObservation: project.sourceObservation || null, materials: project.materials, units: project.units });
    const maxOutputTokens = 6000;
    const maxMicro = llmReservationMicro(conservativeInputTokenUpperBound(viralPlanSystem, prompt), maxOutputTokens, llmRates);
    return { prompt, maxOutputTokens, maxMicro, quoteId: fingerprint({ revision: project.revision, prompt, maxMicro, model: llmConfig.model }) };
  }
  function sourceQuote(project, sourceHash) {
    const prompt = buildSourceAnalysisPrompt({ productName: '', brief: '' });
    const frameBudget = 24 * 256;
    const maxOutputTokens = 7_000;
    const maxMicro = llmReservationMicro(conservativeInputTokenUpperBound(sourceAnalysisSystemPrompt, `${prompt}\n[${frameBudget} image tokens]`), maxOutputTokens, llmRates);
    return { prompt, maxOutputTokens, maxMicro, sourceHash, quoteId: fingerprint({ revision: project.revision, sourceHash, maxMicro, model: llmConfig.model, workflow:'source-analysis-v1' }) };
  }
  function runProcess(executable, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { stdio:['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.trim().slice(-800) || `视频预处理失败（${code}）`)));
    });
  }
  async function sourceFrames(sourceFile) {
    if (!sourceAnalysisExecutable) throw viralError('当前环境缺少视频分析组件', 503);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gugu-viral-source-'));
    try {
      let durationSeconds = 0;
      try {
        const probe = await runProcess(sourceAnalysisExecutable, ['-hide_banner', '-loglevel', 'info', '-i', sourceFile, '-t', '0.01', '-f', 'null', '-']);
        const match = `${probe.stderr}\n${probe.stdout}`.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
        if (match) durationSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      } catch { /* A readable frame stream is sufficient; the model can infer the final boundary. */ }
      const frameRate = Math.min(2, 24 / Math.max(durationSeconds || 12, 1));
      await runProcess(sourceAnalysisExecutable, ['-hide_banner', '-loglevel', 'error', '-i', sourceFile, '-vf', `fps=${frameRate.toFixed(5)},scale=512:-2`, '-frames:v', '24', '-q:v', '7', path.join(directory, 'frame-%03d.jpg')]);
      const names = (await fs.readdir(directory)).filter(name => /^frame-\d+\.jpg$/.test(name)).sort();
      if (!names.length) throw viralError('参考视频没有可读取的画面', 422);
      const content = [];
      for (const name of names) {
        const frameIndex = Number(name.match(/(\d+)/)?.[1] || 1) - 1;
        const data = await fs.readFile(path.join(directory, name));
        content.push({ type:'text', text:`这是参考视频约 ${(frameIndex / frameRate).toFixed(1)} 秒处的画面（帧 ${frameIndex + 1}/${names.length}）。` });
        content.push({ type:'image_url', image_url:{ url:`data:image/jpeg;base64,${data.toString('base64')}`, detail:'low' } });
      }
      return { content, frameCount:names.length, frameRate, durationSeconds };
    } finally { await fs.rm(directory, { recursive:true, force:true }).catch(() => {}); }
  }
  function timelineNotes(observation) {
    return (observation.timeline || []).map(item => `${item.startSeconds.toFixed(3)}–${item.endSeconds.toFixed(3)}秒｜${item.visualAction || '画面保持'}${item.spokenContent ? `｜${item.speakerMode === 'voiceover' ? '画外音' : '口播'}：${item.spokenContent}` : ''}`).join('\n');
  }
  function prepareGeneration(userId, scope, input) {
    const project = get(userId, scope, String(input.viralProjectId));
    assertViralReady(project, snapshot(userId, scope, project), { forGeneration: true });
    const unit = project.units.find(unit => unit.id === input.viralUnitId);
    if (!unit || input.viralPlanHash !== project.planApproval.hash) throw viralError('分段或确认版本已变化，请刷新后重新确认', 409);
    if (project.planning) throw viralError('方案正在整理，请稍候', 409);
    const requestId = project.planApproval.requests[unit.id];
    if (input.requestId !== requestId) throw viralError('本次生成授权已失效，请刷新项目', 409);
    return { type: 'video', quantity: 1, ...unit, referenceAssetIds: [project.sourceAssetId, ...unit.referenceAssetIds.filter(id => id !== project.sourceAssetId)], videoModel: unit.modelId, referenceCounts: undefined, deferReferenceUpload: false,
      generationType: 'REFERENCE', requestId, viralProjectId: project.id, viralUnitId: unit.id, viralPlanHash: project.planApproval.hash,
      dramaProjectId: '', dramaShotId: '' };
  }
  async function route(req, res, url) {
    if (!url.pathname.startsWith('/api/viral-lab/')) return false;
    const user = await requireUser(req, res); if (!user) return true;
    const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return true;
    const path = url.pathname.slice('/api/viral-lab/'.length);
    if (path === 'tasks' && req.method === 'GET') {
      sendJson(res, 200, { tasks: listViralTasks(user.id, scope).map(task => ({ ...publicGeneration(task), viralProjectId:task.viralProjectId, viralUnitId:task.viralUnitId, viralPlanHash:task.viralPlanHash })) });
      return true;
    }
    if (path === 'projects' && req.method === 'GET') {
      sendJson(res, 200, { projects: listViralProjects(user.id, scope).map(p => ({ id: p.id, title: p.title, type: p.type, updatedAt: p.updatedAt, unitCount: p.units.length, approved: Boolean(p.planApproval), sourceAnalyzed: Boolean(p.sourceObservation) })), capabilities: { aiPlan: isLlmConfigured(llmConfig), automaticSourceAnalysis: Boolean(isLlmConfigured(llmConfig) && ensureLocalAsset && sourceAnalysisExecutable), identityReview: false } });
      return true;
    }
    if (path === 'projects' && req.method === 'POST') {
      const input = normalizeViralInput(await bodyJson(req), { allowDraft: true });
      snapshot(user.id, scope, input);
      sendJson(res, 201, { project: createViralProject(user.id, scope, input) }); return true;
    }
    const match = path.match(/^projects\/([\w-]+)(?:\/(assets-confirm|plan-confirm|source-quote|source-analyze|plan-quote|plan|retry))?$/);
    if (!match) { sendJson(res, 404, { error: '接口不存在' }); return true; }
    let project = get(user.id, scope, match[1]);
    const action = match[2];
    if (!action && req.method === 'GET') {
      const assets = [project.sourceAssetId, ...project.materials.map(m => m.assetId)].filter(Boolean).map(id => findAsset(user.id, id, scope)).filter(Boolean).map(publicAsset);
      sendJson(res, 200, { project, assets, tasks: viralGenerationRecords(user.id, project.id, scope).map(task => ({ ...publicGeneration(task), viralUnitId: task.viralUnitId, viralPlanHash: task.viralPlanHash })) }); return true;
    }
    if (!['PATCH', 'POST'].includes(req.method) || (!action && req.method !== 'PATCH') || (action && req.method !== 'POST')) { sendJson(res, 405, { error: '请求方法不支持' }); return true; }
    const input = await bodyJson(req);
    if (Number(input.revision) !== project.revision) throw viralError('项目版本已更新，请重新打开后操作；当前输入未覆盖服务器版本', 409);
    if (project.planning) throw viralError(activePlans.has(project.planning) ? 'AI 正在整理方案，请等待完成' : '上次 AI 请求已中断，请保留当前项目并联系支持核对计费；已有方案仍可导出', 409);
    if (project.sourceAnalysisState?.status === 'running' && activeAnalyses.has(project.id)) throw viralError('原片正在分析，请稍候', 409);
    if (project.sourceAnalysisState?.status === 'running' && !activeAnalyses.has(project.id) && !['source-quote', 'source-analyze'].includes(action)) throw viralError('原片分析上次未完成，请重新开始分析', 409);
    if (!action) {
      const next = { ...project, ...normalizeViralInput(input, { allowDraft: true }) };
      if (next.type !== project.type) throw viralError('创建后不能改变实验类型，请新建项目');
      if (project.type === 'replica' && project.sourceAssetId !== next.sourceAssetId && project.sourceObservation) {
        next.sourceObservation = null;
        next.sourceAnalysis = null;
        next.sourceAnalysisState = null;
        next.sourceAnalysisError = '';
        next.units = [];
      }
      const refs = snapshot(user.id, scope, next);
      const sourceRef = refs.find(item => item.id === next.sourceAssetId);
      if (next.type === 'replica' && project.sourceObservation && sourceRef?.sha256 !== project.sourceObservation.sourceHash) {
        next.sourceObservation = null;
        next.sourceAnalysis = null;
        next.sourceAnalysisState = null;
        next.sourceAnalysisError = '';
        next.sourceNotes = '';
        next.units = [];
      }
      if (next.assetApproval?.hash !== assetApprovalHash(next, refs)) next.assetApproval = null;
      if (next.planApproval && next.planApproval.hash !== planApprovalHash(next, refs, { allowDraft: true })) next.planApproval = null;
      project = saveViralProject(user.id, scope, next, project.revision);
    } else if (action === 'source-quote' || action === 'source-analyze') {
      if (project.type !== 'replica') throw viralError('原片分析只适用于视频复刻项目');
      if (!isLlmConfigured(llmConfig) || !ensureLocalAsset || !sourceAnalysisExecutable) throw viralError('原片分析服务暂不可用，可以先手动填写拆解', 503);
      const refs = snapshot(user.id, scope, project);
      const source = refs.find(item => item.id === project.sourceAssetId);
      if (!source || source.kind !== 'video') throw viralError('请先选择参考视频');
      const quote = sourceQuote(project, source.sha256);
      if (action === 'source-quote') { sendJson(res, 200, { quoteId: quote.quoteId, maxCredits: quote.maxMicro / 1000000 }); return true; }
      if (input.quoteId !== quote.quoteId) throw viralError('原片分析报价已变化，请重新查看费用', 409);
      if (activeAnalyses.has(project.id)) throw viralError('原片正在分析，请稍候', 409);
      const requestId = randomUUID();
      project = saveViralProject(user.id, scope, { ...project, sourceAnalysisState:{ status:'running', requestId, startedAt:new Date().toISOString() }, sourceAnalysisError:'' }, project.revision);
      activeAnalyses.add(project.id);
      let held = false; let settled = false;
      try {
        const reserved = await reserveLlmCredits(user.id, requestId, quote.maxMicro, { projectId:project.id, skillName:'viral-source-analysis', skillVersion:'1.0.0' });
        if (reserved.error) throw viralError(reserved.error, reserved.status);
        held = true;
        const asset = findAsset(user.id, project.sourceAssetId, scope);
        const sourceFile = await ensureLocalAsset(user.id, asset);
        const frames = await sourceFrames(sourceFile);
        const result = await callLlm({ system:sourceAnalysisSystemPrompt, prompt:buildSourceAnalysisPrompt() + '\n本次输入只有静态采样画面，没有音频。不得从口型或字幕猜测 spoken_content、asr_text 或声音风格；spoken_content 留空，speaker_mode 写 uncertain。', content:frames.content, maxOutputTokens:quote.maxOutputTokens, jsonMode:true, config:llmConfig });
        const billing = await settleLlmCredits(user.id, requestId, result, { projectId:project.id, skillName:'viral-source-analysis', skillVersion:'1.0.0' });
        settled = true;
        let parsed;
        try { parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw viralError('原片分析结果无法读取，已保留项目内容', 502); }
        const observation = normalizeSourceObservation(parsed, { sourceHash:source.sha256, durationSeconds:frames.durationSeconds });
        observation.asrText = '';
        observation.audioSummary = { speechStyle:'', musicAndSfx:'' };
        observation.timeline.forEach(beat => { beat.spokenContent = ''; beat.speakerMode = 'uncertain'; });
        observation.uncertainties.unshift('当前仅分析画面，未识别原片音频；需要保留的台词和声音请手动补充。');
        if (!observation.timeline.length) throw viralError('原片分析没有识别到可用时间线，已保留项目内容', 502);
        const modelId = project.units?.[0]?.modelId === 'seedance-2.0' ? 'seedance-2.0' : 'seedance-2.5';
        const draftUnits = splitSourceTimeline(observation, { modelId, materials:project.materials });
        const preparedProject = { ...project, sourceObservation: observation, units: draftUnits };
        const units = normalizeReplicaPlan(preparedProject, observation, { units: draftUnits });
        const nextInput = normalizeViralInput({ ...project, sourceNotes:project.sourceNotes || timelineNotes(observation), units }, { allowDraft:true });
        project = saveViralProject(user.id, scope, { ...project, ...nextInput, sourceObservation:observation, sourceAnalysis:{ requestId, frameCount:frames.frameCount, frameRate:frames.frameRate, durationSeconds:frames.durationSeconds, sourceHash:source.sha256, completedAt:new Date().toISOString(), usage:{ inputTokens:result.usage.inputTokens, outputTokens:result.usage.outputTokens, chargedCredits:billing.chargedCredits }, fingerprint:sourceAnalysisFingerprint(observation) }, sourceAnalysisState:{ status:'completed', requestId, completedAt:new Date().toISOString() }, sourceAnalysisError:'', planApproval:null }, project.revision);
        sendJson(res, 200, { project, balance:billing.wallet.balance }); return true;
      } catch (error) {
        if (held && !settled) {
          if (error.billingReconcileRequired) await markLlmBillingReconcile(user.id, requestId, error);
          else await releaseLlmCredits(user.id, requestId, error.message);
        }
        saveViralProject(user.id, scope, { ...project, sourceAnalysisState:{ status:'failed', requestId, failedAt:new Date().toISOString() }, sourceAnalysisError:error.message }, project.revision);
        throw error;
      } finally { activeAnalyses.delete(project.id); }
    } else if (action === 'assets-confirm') {
      if (!project.sourceAssetId || !project.materials.length) throw viralError('先添加原片和素材再确认');
      project.assetApproval = { hash: assetApprovalHash(project, snapshot(user.id, scope, project)), confirmedAt: new Date().toISOString(), review: 'user_visual_review' };
      project.planApproval = null;
      project = saveViralProject(user.id, scope, project, project.revision);
    } else if (action === 'plan-confirm') {
      const refs = snapshot(user.id, scope, project);
      assertViralReady(project, refs);
      if (project.units.some(unit => /待补充/.test(unit.prompt))) throw viralError('方案仍有待补充内容，请完善后确认');
      const hash = planApprovalHash(project, refs);
      // Reconfirming an unchanged plan must not create another paid submission scope.
      if (project.planApproval?.hash !== hash) project.planApproval = { hash, confirmedAt: new Date().toISOString(), requests: Object.fromEntries(project.units.map(unit => [unit.id, randomUUID()])) };
      project = saveViralProject(user.id, scope, project, project.revision);
    } else if (action === 'retry') {
      assertViralReady(project, snapshot(user.id, scope, project), { forGeneration: true });
      const id = project.planApproval.requests[input.unitId];
      const attempts = viralGenerationRecords(user.id, project.id, scope).filter(task => task.viralUnitId === input.unitId && task.viralPlanHash === project.planApproval.hash);
      const previous = attempts.find(task => task.id === id);
      if (!previous || previous.status !== 'failed' || attempts.length >= 2) throw viralError('仅失败分段可定向重试一次；再次失败请先修改具体方案');
      project.planApproval.requests[input.unitId] = randomUUID();
      project = saveViralProject(user.id, scope, project, project.revision);
    } else {
      if (!isLlmConfigured(llmConfig)) throw viralError('AI 方案服务暂不可用，你仍可填写或粘贴已有完整提示词', 503);
      if (!project.sourceNotes || !project.units.length || project.assetApproval?.hash !== assetApprovalHash(project, snapshot(user.id, scope, project))) throw viralError('请先确认资产、填写原片拆解并添加分段');
      const quote = planQuote(project);
      if (action === 'plan-quote') { sendJson(res, 200, { quoteId: quote.quoteId, maxCredits: quote.maxMicro / 1000000 }); return true; }
      if (input.quoteId !== quote.quoteId) throw viralError('AI 方案报价已变化，请重新查看费用', 409);
      const requestId = randomUUID();
      project = saveViralProject(user.id, scope, { ...project, planning: requestId, planError: '' }, project.revision);
      activePlans.add(requestId);
      let held = false; let settled = false;
      try {
        const reserved = await reserveLlmCredits(user.id, requestId, quote.maxMicro, { projectId: project.id, skillName: 'viral-plan', skillVersion: project.workflowVersion });
        if (reserved.error) throw viralError(reserved.error, reserved.status);
        held = true;
        const result = await callLlm({ system: viralPlanSystem, prompt: quote.prompt, maxOutputTokens: quote.maxOutputTokens, jsonMode: true, config: llmConfig });
        const billing = await settleLlmCredits(user.id, requestId, result, { projectId: project.id, skillName: 'viral-plan', skillVersion: project.workflowVersion });
        settled = true;
        const parsed = JSON.parse(result.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
        if (!Array.isArray(parsed.units) || parsed.units.length !== project.units.length) throw viralError('AI 返回的分段数量不一致，已保留原方案；本次模型调用已按实际用量结算', 502);
        const units = project.sourceObservation
          ? normalizeReplicaPlan(project, project.sourceObservation, parsed)
          : project.units.map((unit, i) => ({ ...unit, prompt: parsed.units[i].prompt }));
        if (units.some(unit => typeof unit.prompt !== 'string' || !unit.prompt.trim())) throw viralError('AI 返回的提示词不完整，已保留原方案', 502);
        project = saveViralProject(user.id, scope, { ...project, ...normalizeViralInput({ ...project, units }), planning: null, planApproval: null, planError: '', planUsage: { chargedCredits: billing.chargedCredits } }, project.revision);
        sendJson(res, 200, { project, balance: billing.wallet.balance }); return true;
      } catch (error) {
        if (held && !settled) {
          if (error.billingReconcileRequired) await markLlmBillingReconcile(user.id, requestId, error);
          else await releaseLlmCredits(user.id, requestId, error.message);
        }
        saveViralProject(user.id, scope, { ...project, planning: null, planError: settled ? '本次 AI 调用已结算，但结果未形成有效方案，原稿已保留。' : 'AI 方案未完成，原稿已保留。' }, project.revision);
        throw error;
      } finally { activePlans.delete(requestId); }
    }
    sendJson(res, 200, { project }); return true;
  }
  return { route, prepareGeneration };
}
