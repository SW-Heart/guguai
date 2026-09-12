const MAX_FAILURE_REASON_LENGTH = 8_000;
const MAX_FIELD_LENGTH = 500;
const SEND_TIMEOUT_MS = 5_000;
const SEND_RETRY_DELAYS_MS = [0, 500, 1_500];

const trimField = (value, limit = MAX_FIELD_LENGTH) => String(value ?? '').trim().slice(0, limit) || '未知';

function formatBeijingTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(date).replace(/\//g, '-');
}

function upstreamFailureReason(error, task = {}) {
  const candidates = [
    error?.upstreamMessage,
    error?.cause?.upstreamMessage,
    error?.cause?.message,
    error?.message,
    task?.error,
  ];
  return trimField(candidates.find(value => String(value ?? '').trim()), MAX_FAILURE_REASON_LENGTH);
}

function generationFailureCard({ task, user, error, createdAt = new Date() } = {}) {
  const model = task?.videoModelId || task?.modelId || task?.model || '未知';
  const channel = task?.routeDisplayName || task?.provider || task?.routeId || error?.provider || '未知';
  const username = user?.username || user?.nickname || task?.ownerId || '未知';
  const taskId = task?.id || '未知';
  const reason = upstreamFailureReason(error, task);
  const fields = [
    { is_short: true, text: { tag: 'plain_text', content: `模型：${trimField(model)}` } },
    { is_short: true, text: { tag: 'plain_text', content: `上游渠道：${trimField(channel)}` } },
  ];
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: 'red',
        title: { tag: 'plain_text', content: '生成任务失败' },
      },
      elements: [
        { tag: 'div', fields },
        { tag: 'div', text: { tag: 'plain_text', content: `任务 ID：${trimField(taskId)}` } },
        { tag: 'div', text: { tag: 'plain_text', content: `用户名：${trimField(username)}` } },
        { tag: 'hr' },
        { tag: 'div', text: { tag: 'plain_text', content: `失败原因：${reason}` } },
        { tag: 'div', text: { tag: 'plain_text', content: `时间：${formatBeijingTime(createdAt)}` } },
      ],
    },
  };
}

function feishuWebhook(env = process.env) {
  const webhook = String(env.FEISHU_WEBHOOK || '').trim();
  return /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+(?:\?.*)?$/.test(webhook) ? webhook : '';
}

async function postCard(webhook, payload, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new TypeError('飞书通知缺少 fetch 实现');
  const response = await fetchImpl(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const text = await response.text();
  let result = null;
  try { result = text ? JSON.parse(text) : null; } catch { /* Feishu may return an empty body on success. */ }
  if (!response.ok || (result && Number(result.code ?? result.StatusCode ?? 0) !== 0)) {
    throw new Error(`飞书通知失败：HTTP ${response.status}${result?.msg || result?.StatusMessage ? `，${result.msg || result.StatusMessage}` : ''}`);
  }
  return result;
}

export async function notifyGenerationFailure({ task, user, error, createdAt = new Date(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const webhook = feishuWebhook(env);
  if (!webhook) return { skipped: true, reason: 'FEISHU_WEBHOOK 未配置或格式无效' };
  const payload = generationFailureCard({ task, user, error, createdAt });
  let lastError;
  for (let attempt = 0; attempt < SEND_RETRY_DELAYS_MS.length; attempt++) {
    if (SEND_RETRY_DELAYS_MS[attempt]) await new Promise(resolve => setTimeout(resolve, SEND_RETRY_DELAYS_MS[attempt]));
    try {
      await postCard(webhook, payload, fetchImpl);
      return { sent: true, attempt: attempt + 1 };
    } catch (sendError) {
      lastError = sendError;
    }
  }
  throw lastError || new Error('飞书通知失败');
}

export const __test = { formatBeijingTime, upstreamFailureReason, generationFailureCard, feishuWebhook, postCard };
