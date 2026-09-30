// GuGu's language gateway is deliberately restricted to the configured server.
const DEEPSEEK_CONTEXT_WINDOWS = { 'deepseek-v4-flash': 1000000, 'deepseek-flash': 1000000, 'deepseek-v4-pro': 1000000 };
function configuredWindows(value) {
  const result = { ...DEEPSEEK_CONTEXT_WINDOWS };
  for (const entry of String(value || '').split(',')) {
    if (!entry.trim()) continue;
    const match = entry.trim().match(/^([^:\s,]+):(\d+)$/);
    if (!match || Number(match[2]) < 8192 || Number(match[2]) > 2000000) throw new Error('AGENT_MODEL_CONTEXT_WINDOWS 配置无效');
    result[match[1]] = Number(match[2]);
  }
  return result;
}

export function agentConfig(env = process.env) {
  const base = String(env.AGENT_API_BASE || env.DIRECTOR_AGENT_BASE_URL || env.LLM_API_BASE || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const model = String(env.AGENT_MODEL || env.DIRECTOR_AGENT_MODEL || env.LLM_MODEL || '').trim();
  return {
    baseUrl: /\/v1$/i.test(base) ? base : `${base}/v1`,
    apiKey: String(env.AGENT_API_KEY || env.DIRECTOR_AGENT_API_KEY || env.LLM_API_KEY || '').trim(),
    model,
    models: String(env.AGENT_MODELS || '').split(',').map(s => s.trim()).filter(Boolean),
    maxTokens: Math.max(256, Math.min(384000, Number(env.AGENT_MAX_OUTPUT_TOKENS) || 64000)),
    modelContextWindows: configuredWindows(env.AGENT_MODEL_CONTEXT_WINDOWS),
    configured: Boolean(base && model && (env.AGENT_API_KEY || env.DIRECTOR_AGENT_API_KEY || env.LLM_API_KEY)),
  };
}

export function createAgentGateway({ config = agentConfig(), fetchImpl = fetch, streamIdleTimeoutMs = 90_000 } = {}) {
  let cache = null, expires = 0;
  async function listModels() {
    if (cache && expires > Date.now()) return cache;
    let ids = [...config.models], remote = [];
    if (!ids.length && config.configured) {
      try {
        const response = await fetchImpl(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(12000) });
        if (response.ok) {
          const body = await response.json();
          remote = (Array.isArray(body.data) ? body.data : []).filter(item => typeof item.id === 'string' && item.id.length <= 200);
          if (!ids.length) ids = remote.map(item => item.id);
        }
      } catch { /* A gateway may implement completions without a catalog. */ }
    }
    cache = [...new Set([config.model, ...ids].filter(Boolean))].slice(0, 500).map(id => {
      const reported = remote.find(item => item.id === id)?.context_window;
      const configured = config.modelContextWindows?.[id];
      const contextWindow = Number.isSafeInteger(reported) && reported >= 8192
        ? (configured ? Math.min(configured, reported) : reported) : configured;
      return { id, label: id, ...(contextWindow ? { contextWindow } : {}) };
    });
    expires = Date.now() + 60000;
    return cache;
  }
  async function contextWindow(model) {
    const entry = (await listModels()).find(item => item.id === model);
    if (!entry) throw new Error('所选对话模型不可用');
    if (!entry.contextWindow && config.configured) {
      try {
        const response = await fetchImpl(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(12000) });
        if (response.ok) {
          const body = await response.json();
          const reported = (Array.isArray(body.data) ? body.data : []).find(item => item.id === model)?.context_window;
          if (Number.isSafeInteger(reported) && reported >= 8192) entry.contextWindow = reported;
        }
      } catch { /* Explicit configuration is still required when metadata is unavailable. */ }
    }
    if (!entry.contextWindow) throw new Error('这个对话模型暂时无法使用，请选择其他模型。');
    return entry.contextWindow;
  }
  async function complete({ model, messages, tools, maxTokens = config.maxTokens, signal, onDelta = () => {} }) {
    if (!config.configured) throw Object.assign(new Error('对话服务尚未配置'), { statusCode: 503, beforeRequest: true });
    if (!(await listModels()).some(item => item.id === model)) throw Object.assign(new Error('所选对话模型不可用'), { beforeRequest: true });
    const timeoutMs = Math.min(30 * 60_000, Math.max(180_000, maxTokens * 20));
    const responseCharLimit = Math.max(250000, Math.min(4000000, maxTokens * 8));
    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}), max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) { throw Object.assign(new Error('连接暂时中断，点击“继续”重新获取回复。'), { cause, billingReconcileRequired: true, retryableReply: true }); }
    if (!response.ok) {
      // Do not expose gateway response bodies, which can contain credentials or internal URLs.
      throw Object.assign(new Error(`对话服务暂时不可用（${response.status}）`), { beforeRequest: response.status >= 400 && response.status < 500, billingReconcileRequired: response.status >= 500, retryableReply: response.status >= 500 });
    }
    let usage, requestId = '', actualModel = model, finishReason = '', content = '', reasoning = '', streamComplete = true;
    const calls = new Map();
    const consume = data => {
      if (data.id) requestId = data.id;
      if (data.model) actualModel = data.model;
      if (data.usage) usage = data.usage;
      const choice = data.choices?.[0];
      if (!choice) return;
      finishReason = choice.finish_reason || finishReason;
      const delta = choice.delta || choice.message || {};
      if (typeof delta.content === 'string') { content += delta.content; onDelta(content); }
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      for (const [i, call] of (delta.tool_calls || []).entries()) {
        const index = Number.isInteger(call.index) ? call.index : i;
        const stored = calls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) stored.id = call.id;
        if (call.function?.name) stored.function.name += call.function.name;
        if (call.function?.arguments) stored.function.arguments += call.function.arguments;
        calls.set(index, stored);
      }
      if (content.length + reasoning.length + [...calls.values()].reduce((n, c) => n + c.function.arguments.length, 0) > responseCharLimit) throw new Error('对话响应过长');
    };
    try {
      if (!(response.headers.get('content-type') || '').includes('text/event-stream')) consume(await response.json());
      else {
        streamComplete = false;
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        const line = value => {
          if (!value.startsWith('data:')) return;
          const payload = value.slice(5).trim();
          if (payload === '[DONE]') streamComplete = true;
          else if (payload && !streamComplete) consume(JSON.parse(payload));
        };
        try {
          while (true) {
            let idleTimer;
            const { value, done } = await Promise.race([
              reader.read(),
              new Promise((_, reject) => { idleTimer = setTimeout(() => reject(new Error('回复等待超时')), streamIdleTimeoutMs); }),
            ]).finally(() => clearTimeout(idleTimer));
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1); }
            if (streamComplete) break;
            if (buffer.length > 1000000) throw new Error('对话响应过长');
          }
          if (!streamComplete) {
            buffer += decoder.decode();
            if (buffer.trim()) line(buffer.trim());
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    } catch (cause) { throw Object.assign(new Error('回复中途断开，点击“继续”重新获取回复。'), { cause, billingReconcileRequired: true, retryableReply: true }); }
    const normalizedUsage = { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens };
    if (!Object.values(normalizedUsage).every(value => Number.isSafeInteger(value) && value >= 0)) throw Object.assign(new Error('这次回复未能完成，点击“继续”重新获取回复。'), { billingReconcileRequired: true, retryableReply: true });
    const toolCalls = [...calls.values()];
    const message = { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) };
    const result = { message, model: actualModel, providerRequestId: requestId, usage: normalizedUsage, finishReason };
    if (!streamComplete) result.invalidOutputReason = 'incomplete_stream';
    else if (finishReason === 'length') result.invalidOutputReason = 'length';
    else if (!['stop', 'tool_calls'].includes(finishReason)) result.invalidOutputReason = 'incomplete_response';
    else if (toolCalls.some(call => !call.id || !call.function.name)) result.invalidOutputReason = 'incomplete_tool_call';
    else if (!content && !toolCalls.length) result.invalidOutputReason = 'empty_response';
    if (result.invalidOutputReason) result.invalidOutput = true;
    return result;
  }
  return { config, listModels, contextWindow, complete };
}
