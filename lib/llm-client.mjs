function normalizedBase(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function llmConfigFromEnv(env = process.env) {
  const protocol = String(env.LLM_API_PROTOCOL || 'openai-compatible').trim().toLowerCase();
  if (!['anthropic', 'openai-compatible'].includes(protocol)) throw new Error('LLM_API_PROTOCOL 只支持 anthropic 或 openai-compatible');
  return {
    protocol,
    baseUrl: normalizedBase(env.DIRECTOR_AGENT_BASE_URL || env.LLM_API_BASE),
    apiKey: String(env.DIRECTOR_AGENT_API_KEY || env.LLM_API_KEY || '').trim(),
    model: String(env.DIRECTOR_AGENT_MODEL || env.LLM_MODEL || 'deepseek-v4-flash').trim(),
  };
}

export function isLlmConfigured(config = llmConfigFromEnv()) {
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

function providerError(value, fallback) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return providerError(value.error?.message || value.message || value.detail || value.error, fallback);
  return fallback;
}

export function normalizeLlmResponse(protocol, value) {
  if (protocol === 'anthropic') {
    const text = Array.isArray(value?.content) ? value.content.filter(item => item?.type === 'text').map(item => item.text).join('\n') : '';
    return {
      text,
      model: value?.model || '',
      providerRequestId: value?.id || '',
      usage: {
        inputTokens: Number(value?.usage?.input_tokens),
        outputTokens: Number(value?.usage?.output_tokens),
      },
      raw: value,
    };
  }
  const message = value?.choices?.[0]?.message || {};
  const toolArguments = message?.tool_calls?.find(item => item?.type === 'function')?.function?.arguments;
  return {
    text: message.content || toolArguments || '',
    model: value?.model || '',
    providerRequestId: value?.id || '',
    usage: {
      inputTokens: Number(value?.usage?.prompt_tokens ?? value?.usage?.input_tokens),
      outputTokens: Number(value?.usage?.completion_tokens ?? value?.usage?.output_tokens),
    },
    finishReason: value?.choices?.[0]?.finish_reason || '',
    outputKind: toolArguments ? 'tool_call' : 'text',
    raw: value,
  };
}

export async function callLlm({ system, prompt, maxOutputTokens = 4096, jsonMode = false, outputSchema = null, toolName = 'submit_result', thinking = outputSchema ? 'disabled' : '', config = llmConfigFromEnv(), fetchImpl = fetch }) {
  if (!isLlmConfigured(config)) throw Object.assign(new Error('LLM 服务尚未配置'), { statusCode: 503 });
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32_000) throw new Error('maxOutputTokens 必须在 1–32000 之间');
  const anthropic = config.protocol === 'anthropic';
  const apiRoot = /\/v1$/i.test(config.baseUrl) ? config.baseUrl : `${config.baseUrl}/v1`;
  const url = `${apiRoot}${anthropic ? '/messages' : '/chat/completions'}`;
  const headers = anthropic
    ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  const structuredTool = outputSchema && !anthropic ? { type:'function', function:{ name:toolName, description:'提交经过校验的结构化结果', parameters:outputSchema } } : null;
  const body = anthropic
    ? { model: config.model, max_tokens: maxOutputTokens, system, messages: [{ role: 'user', content: prompt }] }
    : { model: config.model, max_tokens: maxOutputTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], ...(thinking ? { thinking:{ type:thinking } } : {}), ...(structuredTool ? { tools:[structuredTool], tool_choice:{ type:'function', function:{ name:toolName } } } : jsonMode ? { response_format:{ type:'json_object' } } : {}) };
  const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  const responseText = await response.text();
  let value;
  try { value = JSON.parse(responseText); } catch { value = { raw: responseText }; }
  if (!response.ok) throw Object.assign(new Error(providerError(value, `LLM 请求失败（HTTP ${response.status}）`)), { statusCode: 502 });
  const normalized = normalizeLlmResponse(config.protocol, value);
  if (!normalized.text) {
    const suffix = normalized.finishReason ? `（finish_reason: ${normalized.finishReason}）` : '';
    throw Object.assign(new Error(`LLM 没有返回可用结果${suffix}`), { statusCode: 502, providerResponse:value });
  }
  if (!Number.isSafeInteger(normalized.usage.inputTokens) || normalized.usage.inputTokens < 0 || !Number.isSafeInteger(normalized.usage.outputTokens) || normalized.usage.outputTokens < 0) {
    throw Object.assign(new Error('LLM 成功响应缺少有效 Token usage，需人工核账'), { statusCode: 502, billingReconcileRequired: true, providerResponse: value });
  }
  return normalized;
}
