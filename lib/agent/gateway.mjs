// GuGu's language gateway is deliberately restricted to the configured server.
export function agentConfig(env = process.env) {
  const base = String(env.AGENT_API_BASE || env.DIRECTOR_AGENT_BASE_URL || env.LLM_API_BASE || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return {
    baseUrl: /\/v1$/i.test(base) ? base : `${base}/v1`,
    apiKey: String(env.AGENT_API_KEY || env.DIRECTOR_AGENT_API_KEY || env.LLM_API_KEY || '').trim(),
    model: String(env.AGENT_MODEL || env.DIRECTOR_AGENT_MODEL || env.LLM_MODEL || 'deepseek-v4-flash').trim(),
    models: String(env.AGENT_MODELS || '').split(',').map(s => s.trim()).filter(Boolean),
    maxTokens: Math.max(256, Math.min(16000, Number(env.AGENT_MAX_OUTPUT_TOKENS) || 6000)),
    contextBytes: Math.max(24000, Math.min(500000, Number(env.AGENT_CONTEXT_BYTES) || 120000)),
    configured: Boolean(base && (env.AGENT_API_KEY || env.DIRECTOR_AGENT_API_KEY || env.LLM_API_KEY)),
  };
}

export function createAgentGateway({ config = agentConfig(), fetchImpl = fetch } = {}) {
  let cache = null, expires = 0;
  async function listModels() {
    if (cache && expires > Date.now()) return cache;
    let ids = [...config.models];
    if (!ids.length && config.configured) {
      try {
        const response = await fetchImpl(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: AbortSignal.timeout(12000) });
        if (response.ok) {
          const body = await response.json();
          ids = (Array.isArray(body.data) ? body.data : []).map(item => item.id).filter(id => typeof id === 'string' && id.length <= 200);
        }
      } catch { /* A gateway may implement completions without a catalog. */ }
    }
    cache = [...new Set([config.model, ...ids])].slice(0, 500).map(id => ({ id, label: id }));
    expires = Date.now() + 60000;
    return cache;
  }
  async function complete({ model, messages, tools, signal, onDelta = () => {} }) {
    if (!config.configured) throw Object.assign(new Error('对话服务尚未配置'), { statusCode: 503, beforeRequest: true });
    if (!(await listModels()).some(item => item.id === model)) throw Object.assign(new Error('所选对话模型不可用'), { beforeRequest: true });
    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', max_tokens: config.maxTokens, stream: true, stream_options: { include_usage: true } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
      });
    } catch (cause) { throw Object.assign(new Error('对话连接中断，本次用量需要核对'), { cause, billingReconcileRequired: true }); }
    if (!response.ok) {
      // Do not expose gateway response bodies, which can contain credentials or internal URLs.
      throw Object.assign(new Error(`对话服务暂时不可用（${response.status}）`), { beforeRequest: response.status >= 400 && response.status < 500, billingReconcileRequired: response.status >= 500 });
    }
    let usage, requestId = '', actualModel = model, finishReason = '', content = '', reasoning = '';
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
      if (content.length + reasoning.length + [...calls.values()].reduce((n, c) => n + c.function.arguments.length, 0) > 250000) throw new Error('对话响应过长');
    };
    try {
      if (!(response.headers.get('content-type') || '').includes('text/event-stream')) consume(await response.json());
      else {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = '';
        const line = value => {
          if (!value.startsWith('data:')) return;
          const payload = value.slice(5).trim();
          if (payload && payload !== '[DONE]') consume(JSON.parse(payload));
        };
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, end).replace(/\r$/, '')); buffer = buffer.slice(end + 1); }
            if (buffer.length > 1000000) throw new Error('对话响应过长');
          }
          buffer += decoder.decode();
          if (buffer.trim()) line(buffer.trim());
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    } catch (cause) { throw Object.assign(new Error('对话响应未完整接收，本次用量需要核对'), { cause, billingReconcileRequired: true }); }
    const normalizedUsage = { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens };
    if (!Object.values(normalizedUsage).every(value => Number.isSafeInteger(value) && value >= 0)) throw Object.assign(new Error('对话服务缺少有效用量，本次费用需要核对'), { billingReconcileRequired: true });
    const toolCalls = [...calls.values()];
    const message = { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) };
    const result = { message, model: actualModel, providerRequestId: requestId, usage: normalizedUsage, finishReason };
    if (finishReason === 'length' || toolCalls.some(call => !call.id || !call.function.name) || (!content && !toolCalls.length)) result.invalidOutput = true;
    return result;
  }
  return { config, listModels, complete };
}
