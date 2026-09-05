import { randomUUID } from 'node:crypto';

export function mutationAllowed(req) {
  if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function readBody(req, limit, tooLargeMessage) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw Object.assign(new Error(tooLargeMessage), { statusCode: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function bodyJson(req, limit = 2_000_000) {
  const body = await readBody(req, limit, '请求体过大');
  try { return JSON.parse(body.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('JSON 格式不正确'), { statusCode: 400 }); }
}

export async function bodyBuffer(req, limit, tooLargeMessage = '请求体过大') {
  return readBody(req, limit, tooLargeMessage);
}

export async function bodyForm(req, limit = 1_000_000) {
  const body = await readBody(req, limit, '请求体过大');
  return Object.fromEntries(new URLSearchParams(body.toString('utf8')));
}

export function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export function sendText(res, status, value, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(String(value));
}

export function publicHttpErrorMessage(error) {
  if (error?.publicMessage) return String(error.publicMessage);
  if (error?.upstreamError) return '模型服务暂时不可用，请稍后重试';
  const message = String(error?.message || '').trim();
  const hasInternalMetadata = Boolean(error?.provider || error?.providerTaskId || error?.routeId || error?.routeDisplayName || error?.routeAdapter || error?.routeBaseUrl || error?.routeCredentialId || error?.upstreamStatus || error?.upstreamMessage || error?.providerResponse || error?.submissionUncertain);
  const containsInternalDetail = hasInternalMetadata || /上游|供应商|凭证|线路|渠道|接口地址|原始响应|请求地址|API\s*Key|Bearer|https?:\/\/|\b(?:provider|upstream|credential|route|request[_ -]?url|raw[_ -]?response)\b|\bsd(?:20|25)-|\b(?:WJ|DIW|CNTCN|TTAPI|AutoDL|Duomi)\b/i.test(message);
  if (containsInternalDetail) return Number(error?.statusCode) >= 500 ? '生成服务暂时不可用，请稍后重试' : '请求无法处理，请稍后重试或联系支持';
  return message || '服务错误';
}

const publicHttpErrorCodes = new Set([
  'WORKSPACE_SCOPE_REQUIRED',
  'PROJECT_VERSION_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'PRICE_CHANGED',
  'REFERENCE_NOT_READY',
  'UPLOAD_OBJECT_MISSING',
  'UPLOAD_SIZE_MISMATCH',
  'UPLOAD_MIME_MISMATCH',
  'UPLOAD_MAGIC_MISMATCH',
  'UPLOAD_FINAL_CONFLICT',
]);

export function publicHttpErrorBody(error, message = publicHttpErrorMessage(error)) {
  const body = { error: message, ...(error?.publicData && typeof error.publicData === 'object' ? error.publicData : {}) };
  if (publicHttpErrorCodes.has(String(error?.code || ''))) body.code = error.code;
  return body;
}

export function requestTraceId(req) {
  const supplied = String(req.headers['x-request-id'] || '').trim();
  return /^[A-Za-z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
}
