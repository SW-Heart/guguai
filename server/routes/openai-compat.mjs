import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeImageRequest, normalizeVideoRequest, publicModelObject } from '../../lib/api-catalog.mjs';
import { decodeDataUrl, fetchRemoteMedia, mediaKind, sniffMediaType } from '../../lib/remote-media.mjs';
import { API_SCOPE, hashApiKey } from '../../repositories/api-platform.mjs';

// OpenAI-compatible endpoints. Paths and payload shapes follow the OpenAI API
// (models, images, videos); image creation is asynchronous like videos, and
// results are read back with GET /v1/images/{id} the same way as videos.

const MAX_BODY_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const RESULT_RETENTION_SECONDS = 6 * 24 * 3600;
const EXTENSIONS = Object.freeze({
  'image/png':'.png', 'image/jpeg':'.jpg', 'image/webp':'.webp', 'video/mp4':'.mp4', 'video/webm':'.webm', 'video/quicktime':'.mov',
  'audio/mpeg':'.mp3', 'audio/wav':'.wav', 'audio/ogg':'.ogg', 'audio/mp4':'.m4a', 'audio/flac':'.flac', 'audio/webm':'.weba',
});
const ERROR_TYPES = Object.freeze({ 400:'invalid_request_error', 401:'invalid_request_error', 403:'permission_error', 404:'invalid_request_error', 405:'invalid_request_error', 409:'invalid_request_error', 410:'invalid_request_error', 413:'invalid_request_error', 415:'invalid_request_error', 429:'rate_limit_error' });

export class ApiError extends Error {
  constructor(status, message, { code = null, param = null, type = null, headers = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
    this.type = type || ERROR_TYPES[status] || 'server_error';
    this.headers = headers;
  }
}

const unix = value => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
};
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function createRateLimiter({ limit, windowMs = 60_000, maxEntries = 20_000 }) {
  const hits = new Map();
  return {
    take(key, at = Date.now()) {
      if (!(limit > 0)) return { ok:true };
      const recent = (hits.get(key) || []).filter(time => at - time < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { ok:false, retryAfterSeconds:Math.max(1, Math.ceil((recent[0] + windowMs - at) / 1000)) };
      }
      recent.push(at);
      if (!hits.has(key) && hits.size >= maxEntries) hits.delete(hits.keys().next().value);
      hits.set(key, recent);
      return { ok:true };
    },
  };
}

export function createOpenAiCompatRoute({
  repo,
  apiCatalog,
  submitGeneration,
  findGeneration,
  publicGeneration,
  findAsset,
  saveAsset,
  deleteAssetRecord,
  hideGenerationForUser,
  activeGenerations,
  findUserById,
  ensureUserDirs,
  assetFilesDir,
  serveFile,
  signedAssetUrl,
  servePendingGenerationSource,
  bodyBuffer,
  clientIp,
  now = () => new Date().toISOString(),
  requestRateLimit = Number(process.env.API_KEY_RATE_LIMIT_PER_MINUTE || 300),
  createRateLimit = Number(process.env.API_KEY_CREATE_LIMIT_PER_MINUTE || 60),
  fetchMedia = fetchRemoteMedia,
} = {}) {
  const requestLimiter = createRateLimiter({ limit:requestRateLimit });
  const createLimiter = createRateLimiter({ limit:createRateLimit });
  const keyLocks = new Map();

  async function withKeyLock(keyId, action) {
    const previous = keyLocks.get(keyId) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    keyLocks.set(keyId, current);
    try { return await current; } finally { if (keyLocks.get(keyId) === current) keyLocks.delete(keyId); }
  }

  function setCors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', String(req.headers['access-control-request-headers'] || 'Authorization, Content-Type, Idempotency-Key').slice(0, 1000));
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  function sendApiJson(res, status, value, headers = {}) {
    res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...headers });
    res.end(JSON.stringify(value));
  }

  function sendApiError(res, error, ctx) {
    ctx.errorCode = error.code || error.type;
    ctx.errorMessage = error.message;
    sendApiJson(res, error.status, { error:{ message:error.message, type:error.type, param:error.param ?? null, code:error.code ?? null } }, error.headers || {});
  }

  function authenticate(req) {
    const header = String(req.headers.authorization || '');
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw new ApiError(401, '缺少 API 密钥，请在请求头中设置 Authorization: Bearer <API 密钥>', { code:'missing_api_key' });
    const key = repo.findKeyByHash(hashApiKey(match[1]));
    if (!key) throw new ApiError(401, 'API 密钥无效或已删除', { code:'invalid_api_key' });
    if (key.status !== 'active') throw new ApiError(401, 'API 密钥已停用', { code:'api_key_disabled' });
    if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) throw new ApiError(401, 'API 密钥已过期', { code:'api_key_expired' });
    const user = findUserById(key.userId);
    if (!user || user.status === 'disabled') throw new ApiError(403, '账号已停用，请联系客服', { code:'account_disabled' });
    if (!key.lastUsedAt || Date.now() - Date.parse(key.lastUsedAt) > 60_000) repo.touchKey(key.id);
    return { user, key };
  }

  function limitRate(limiter, keyId) {
    const result = limiter.take(keyId);
    if (!result.ok) throw new ApiError(429, `请求过于频繁，请 ${result.retryAfterSeconds} 秒后重试`, { code:'rate_limit_exceeded', headers:{ 'Retry-After':String(result.retryAfterSeconds) } });
  }

  async function readBody(req) {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const raw = await bodyBuffer(req, MAX_BODY_BYTES, '请求体不能超过 50 MB，较大的素材请改用链接').catch(error => {
      throw new ApiError(error.statusCode === 413 ? 413 : 400, error.message, { code:'request_too_large' });
    });
    if (contentType.startsWith('multipart/form-data')) {
      let form;
      try { form = await new Request('http://local/', { method:'POST', headers:{ 'content-type':req.headers['content-type'] }, body:raw }).formData(); }
      catch { throw new ApiError(400, 'multipart 表单格式不正确', { code:'invalid_body' }); }
      const body = {};
      for (const [rawName, value] of form.entries()) {
        const name = rawName.endsWith('[]') ? rawName.slice(0, -2) : rawName;
        const item = typeof value === 'string' ? value : { file:true, name:value.name || 'file', type:value.type || '', buffer:Buffer.from(await value.arrayBuffer()) };
        if (Object.hasOwn(body, name)) body[name] = [].concat(body[name], item);
        else body[name] = rawName.endsWith('[]') ? [item] : item;
      }
      return body;
    }
    if (!raw.length) return {};
    let body;
    try { body = JSON.parse(raw.toString('utf8')); }
    catch { throw new ApiError(400, '请求体需为 JSON 或 multipart/form-data', { code:'invalid_body' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, '请求体需为 JSON 对象', { code:'invalid_body' });
    return body;
  }

  const listOf = value => value === undefined || value === null || value === '' ? [] : [].concat(value).filter(item => item !== undefined && item !== null && item !== '');

  function referenceSources(body, kind) {
    if (kind === 'image') return listOf(body.image).map(source => ({ source, slot:'image', param:'image' }));
    return [
      ...listOf(body.input_reference).map(source => ({ source, slot:'image', param:'input_reference' })),
      ...listOf(body.reference_videos).map(source => ({ source, slot:'video', param:'reference_videos' })),
      ...listOf(body.reference_audios).map(source => ({ source, slot:'audio', param:'reference_audios' })),
    ];
  }

  function sourceFingerprint(source) {
    if (typeof source === 'object' && source?.file) return `file:${sha256(source.buffer)}`;
    if (typeof source !== 'string') throw new ApiError(400, '参考素材需为文件、https 链接或 data URL', { code:'invalid_parameter' });
    return source.startsWith('data:') ? `data:${sha256(source)}` : `url:${source}`;
  }

  async function loadSource({ source, slot, param }) {
    const maxBytes = slot === 'image' ? MAX_IMAGE_BYTES : MAX_MEDIA_BYTES;
    let loaded;
    try {
      if (typeof source === 'object' && source?.file) {
        if (source.buffer.length > maxBytes) throw Object.assign(new Error(`素材超过 ${maxBytes / 1024 / 1024} MB`), { statusCode:413 });
        loaded = { buffer:source.buffer, name:source.name };
      } else if (String(source).startsWith('data:')) loaded = decodeDataUrl(source, { maxBytes });
      else loaded = await fetchMedia(source, { maxBytes });
    } catch (error) {
      throw new ApiError(error.statusCode === 413 ? 400 : 400, `${param}：${error.publicMessage || error.message || '素材无法读取'}`, { code:'invalid_reference', param });
    }
    let mimeType = sniffMediaType(loaded.buffer);
    if (slot === 'audio' && ['video/mp4', 'video/webm'].includes(mimeType)) mimeType = mimeType.replace('video/', 'audio/');
    if (slot === 'video' && mimeType === 'audio/mp4') mimeType = 'video/mp4';
    if (!mimeType || mediaKind(mimeType) !== slot) {
      const expected = slot === 'image' ? 'PNG、JPEG 或 WebP 图片' : slot === 'video' ? 'MP4、WebM 或 MOV 视频' : 'MP3、WAV、M4A、OGG 或 FLAC 音频';
      throw new ApiError(400, `${param} 需为 ${expected}`, { code:'invalid_reference', param });
    }
    if (!loaded.buffer.length) throw new ApiError(400, `${param} 是空文件`, { code:'invalid_reference', param });
    return { buffer:loaded.buffer, mimeType, kind:slot, name:String(loaded.name || '').replace(/[\r\n\u0000-\u001f]/g, '').slice(0, 120) };
  }

  async function ingestReferences(userId, sources) {
    const loaded = await Promise.all(sources.map(loadSource));
    const assets = [];
    try {
      await ensureUserDirs(userId);
      for (const item of loaded) {
        const id = `apiref-${randomBytes(12).toString('hex')}`;
        const createdAt = now();
        const extension = EXTENSIONS[item.mimeType] || '';
        const asset = {
          id, ownerId:userId, name:item.name || `API 参考素材${extension}`, kind:item.kind, mimeType:item.mimeType, size:item.buffer.length,
          sha256:sha256(item.buffer), storageName:`${id}${extension}`, source:'upload', apiReference:true,
          sourceGenerationId:'', sourceUrl:'', originDeviceId:API_SCOPE.deviceId, originWorkspaceId:API_SCOPE.workspaceId, createdAt, updatedAt:createdAt,
        };
        await fs.writeFile(path.join(assetFilesDir(userId), asset.storageName), item.buffer, { mode:0o600 });
        await saveAsset(userId, asset);
        assets.push(asset);
      }
      return assets;
    } catch (error) {
      await discardAssets(userId, assets);
      throw error;
    }
  }

  async function discardAssets(userId, assets) {
    for (const asset of assets) await deleteAssetRecord(userId, asset).catch(error => console.warn('[api] 参考素材清理失败', { assetId:asset.id, message:error.message }));
  }

  function generationsOf(userId, task) {
    return task.generationIds.map(id => findGeneration(userId, id, API_SCOPE));
  }

  function taskState(userId, task) {
    const generations = generationsOf(userId, task);
    const present = generations.filter(Boolean);
    const terminal = item => ['completed', 'failed'].includes(item?.status);
    const pending = present.filter(item => !terminal(item));
    const completed = present.filter(item => item.status === 'completed');
    const failed = present.filter(item => item.status === 'failed');
    // A task row is written just before its generations are created; a
    // missing generation is still being submitted for a short while.
    const submitting = Date.now() - Date.parse(task.createdAt) < 120_000;
    const missing = submitting ? 0 : generations.length - present.length;
    let status;
    if (submitting && present.length < generations.length) status = 'queued';
    else if (pending.length) status = pending.every(item => item.status === 'queued') && !completed.length ? 'queued' : 'in_progress';
    else status = completed.length ? 'completed' : 'failed';
    const progressValues = present.map(item => item.status === 'completed' || item.status === 'failed' ? 100 : Number.isFinite(Number(item.progress)) ? Math.max(0, Math.min(99, Number(item.progress))) : item.status === 'running' ? 10 : 0);
    const progress = status === 'completed' || status === 'failed' ? 100 : Math.round(progressValues.reduce((sum, value) => sum + value, 0) / Math.max(1, progressValues.length));
    const failure = failed.length ? publicGeneration(failed[0]).failure : null;
    const chargedMicro = present.filter(item => item.creditStatus !== 'refunded').reduce((sum, item) => sum + (Number.isSafeInteger(item.creditCostMicro) ? item.creditCostMicro : 0), 0);
    const finishedAt = status === 'completed' || status === 'failed'
      ? present.map(item => item.finishedAt || item.updatedAt).filter(Boolean).sort().at(-1) || null
      : null;
    let error = null;
    if (status === 'failed') error = { code:failure?.code || 'generation_failed', message:failure ? `${failure.message}。${failure.suggestion}` : '生成失败，本次费用已退回' };
    else if (status === 'completed' && (failed.length || missing)) error = { code:'partial_failure', message:`${failed.length + missing} 张图片生成失败，对应费用已退回` };
    return { status, progress, completed, error, credits:chargedMicro / 1_000_000, refunded:status === 'failed' && failed.every(item => item.creditStatus === 'refunded'), finishedAt };
  }

  function baseUrl(req) {
    const configured = String(process.env.API_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    return `${proto}://${req.headers.host}`;
  }

  function videoObject(userId, task) {
    const state = taskState(userId, task);
    const completedAt = state.status === 'completed' ? unix(state.finishedAt) : null;
    return {
      id:task.id,
      object:'video',
      model:task.modelId,
      status:state.status,
      progress:state.progress,
      created_at:unix(task.createdAt),
      completed_at:completedAt,
      expires_at:completedAt ? completedAt + RESULT_RETENTION_SECONDS : null,
      seconds:task.params.seconds,
      size:task.params.size,
      aspect_ratio:task.params.aspect_ratio,
      resolution:task.params.resolution,
      mode:task.params.mode,
      credits:state.credits,
      error:state.error,
    };
  }

  function imageObject(req, userId, task) {
    const state = taskState(userId, task);
    const completedAt = state.status === 'completed' ? unix(state.finishedAt) : null;
    const base = baseUrl(req);
    return {
      id:task.id,
      object:'image',
      model:task.modelId,
      status:state.status,
      progress:state.progress,
      created_at:unix(task.createdAt),
      completed_at:completedAt,
      expires_at:completedAt ? completedAt + RESULT_RETENTION_SECONDS : null,
      n:task.generationIds.length,
      size:task.params.size,
      ...(task.params.quality ? { quality:task.params.quality } : {}),
      credits:state.credits,
      data:state.completed.map(generation => ({ index:task.generationIds.indexOf(generation.id), url:`${base}/v1/images/${task.id}/content?index=${task.generationIds.indexOf(generation.id)}` })),
      error:state.error,
    };
  }

  const objectFor = (req, userId, task) => task.kind === 'video' ? videoObject(userId, task) : imageObject(req, userId, task);

  function submissionError(result) {
    const data = result.data || {};
    const message = String(data.error || '请求无法处理');
    if (result.status === 402) return new ApiError(429, message, { code:'insufficient_quota', type:'insufficient_quota' });
    if (data.code === 'AGENT_BUDGET_EXCEEDED') return new ApiError(429, '已达到该 API 密钥的额度上限，请在控制台调整额度', { code:'key_quota_exceeded', type:'insufficient_quota' });
    if (data.code === 'IDEMPOTENCY_KEY_REUSED') return new ApiError(409, '同一个 Idempotency-Key 不能用于不同请求', { code:'idempotency_key_reused' });
    if (result.status === 503) return new ApiError(503, message, { code:'model_unavailable', type:'server_error' });
    if (result.status >= 500) return new ApiError(result.status, message, { code:'server_error', type:'server_error' });
    return new ApiError(result.status === 409 ? 409 : 400, message, { code:result.status === 409 ? 'conflict' : 'invalid_parameter' });
  }

  async function createTask(req, res, kind, ctx, { requireImage = false } = {}) {
    const { user, key } = ctx.auth;
    limitRate(createLimiter, key.id);
    const body = await readBody(req);
    const modelId = String(body.model || '').trim();
    if (!modelId) throw new ApiError(400, '请提供 model', { code:'invalid_parameter', param:'model' });
    ctx.modelId = modelId.slice(0, 80);
    const catalog = apiCatalog();
    const model = catalog.find(item => item.id === modelId);
    if (!model) throw new ApiError(404, `模型 ${modelId} 不存在或暂不可用，可通过 GET /v1/models 查看可用模型`, { code:'model_not_found', param:'model' });
    if (model.type !== kind) throw new ApiError(400, `${model.name} 是${model.type === 'image' ? '图片' : '视频'}模型，请使用 ${model.endpoints[0]}`, { code:'invalid_model_for_endpoint', param:'model' });

    const sources = referenceSources(body, kind);
    if (requireImage && !sources.length) throw new ApiError(400, '请提供参考图 image', { code:'invalid_parameter', param:'image' });
    const counts = { image:0, video:0, audio:0 };
    for (const item of sources) counts[item.slot]++;
    let normalized;
    try {
      normalized = kind === 'image'
        ? normalizeImageRequest(model, body, { referenceCount:counts.image })
        : normalizeVideoRequest(model, body, { referenceCounts:counts });
    } catch (error) {
      throw new ApiError(error.statusCode || 400, error.message, { code:error.apiCode || 'invalid_parameter', param:error.apiParam || null });
    }

    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (idempotencyKey && (idempotencyKey.length > 200 || /[\u0000-\u001f]/.test(idempotencyKey))) throw new ApiError(400, 'Idempotency-Key 需为 1–200 个可见字符', { code:'invalid_parameter' });
    const requestHash = sha256(JSON.stringify({ kind, input:normalized.input, references:sources.map(item => [item.slot, sourceFingerprint(item.source)]) }));
    if (idempotencyKey) {
      const existing = repo.findTaskByIdempotencyKey(user.id, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== requestHash || existing.kind !== kind) throw new ApiError(409, '同一个 Idempotency-Key 不能用于不同请求', { code:'idempotency_key_reused' });
        ctx.taskId = existing.id;
        return sendApiJson(res, 200, objectFor(req, user.id, existing));
      }
    }

    const requestId = idempotencyKey
      ? `api${sha256(`${user.id}:${idempotencyKey}`).slice(0, 40)}`
      : `api${randomBytes(16).toString('hex')}`;
    const quantity = Number(normalized.input.quantity || 1);
    const generationIds = quantity === 1 ? [requestId] : Array.from({ length:quantity }, (_, index) => `${requestId}-${index + 1}`);
    const taskId = `${kind === 'video' ? 'video' : 'img'}_${requestId.slice(3, 35)}`;
    ctx.taskId = taskId;

    const assets = await ingestReferences(user.id, sources);
    const task = { id:taskId, userId:user.id, keyId:key.id, kind, modelId:model.id, requestId, idempotencyKey:idempotencyKey || null, requestHash, generationIds, params:normalized.params, createdAt:now() };
    try { repo.createTask(task); }
    catch (error) {
      await discardAssets(user.id, assets);
      const existing = idempotencyKey ? repo.findTaskByIdempotencyKey(user.id, idempotencyKey) : null;
      if (existing) return sendApiJson(res, 200, objectFor(req, user.id, existing));
      throw error;
    }

    let result;
    try {
      const submit = maxCostMicro => submitGeneration({
        user, scope:API_SCOPE, headerRequestId:requestId, maxCostMicro,
        input:{ ...normalized.input, referenceAssetIds:assets.map(asset => asset.id) },
        taskExtras:{ apiTaskId:taskId, apiKeyId:key.id },
      });
      result = key.creditLimitMicro === null
        ? await submit(Infinity)
        : await withKeyLock(key.id, () => {
          const remaining = key.creditLimitMicro - repo.keyUsageMicro(key.id);
          if (remaining <= 0) return { status:409, data:{ error:'已达到该 API 密钥的额度上限', code:'AGENT_BUDGET_EXCEEDED' } };
          return submit(remaining);
        });
    } catch (error) {
      repo.removeTask(user.id, taskId);
      await discardAssets(user.id, assets);
      if (error.statusCode && error.statusCode < 500) throw new ApiError(error.statusCode, error.publicMessage || error.message, { code:error.code === 'REFERENCE_NOT_READY' ? 'invalid_reference' : 'invalid_parameter' });
      throw error;
    }
    if (result.status >= 400) {
      repo.removeTask(user.id, taskId);
      await discardAssets(user.id, assets);
      throw submissionError(result);
    }
    const created = [].concat(result.data.tasks || result.data);
    ctx.costMicro = created.reduce((sum, item) => sum + Math.round(Number(item.creditCost || 0) * 1_000_000), 0);
    return sendApiJson(res, 200, objectFor(req, user.id, task));
  }

  function findOwnTask(userId, taskId, kind) {
    const task = repo.findTask(userId, taskId, kind);
    if (!task) throw new ApiError(404, `${kind === 'video' ? '视频' : '图片'}任务 ${taskId} 不存在`, { code:'not_found' });
    return task;
  }

  function listTasks(req, res, url, kind, userId) {
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'limit 需为 1–100 的整数', { code:'invalid_parameter', param:'limit' });
    const order = url.searchParams.get('order') || 'desc';
    if (!['asc', 'desc'].includes(order)) throw new ApiError(400, 'order 可选 asc 或 desc', { code:'invalid_parameter', param:'order' });
    let page;
    try { page = repo.listTasks(userId, kind, { limit, after:url.searchParams.get('after') || null, order }); }
    catch (error) { throw new ApiError(400, error.message, { code:'invalid_parameter', param:error.param || null }); }
    const data = page.tasks.map(task => objectFor(req, userId, task));
    return sendApiJson(res, 200, { object:'list', data, first_id:data[0]?.id || null, last_id:data.at(-1)?.id || null, has_more:page.hasMore });
  }

  async function deleteTask(res, userId, task) {
    const generations = generationsOf(userId, task).filter(Boolean);
    if (generations.some(item => activeGenerations.has(item.id) || ['queued', 'running'].includes(item.status))) {
      throw new ApiError(409, '任务仍在生成中，完成后才能删除', { code:'task_in_progress' });
    }
    for (const generation of generations) await hideGenerationForUser(userId, generation);
    repo.markTaskDeleted(userId, task.id);
    return sendApiJson(res, 200, { id:task.id, object:task.kind === 'video' ? 'video.deleted' : 'image.deleted', deleted:true });
  }

  async function sendContent(res, userId, task, index) {
    const state = taskState(userId, task);
    if (state.status !== 'completed') throw new ApiError(409, state.status === 'failed' ? '任务生成失败，没有可下载的内容' : '任务尚未完成，请稍后再试', { code:'task_not_completed' });
    const generationId = task.generationIds[index];
    if (!generationId) throw new ApiError(400, `index 需为 0–${task.generationIds.length - 1}`, { code:'invalid_parameter', param:'index' });
    const generation = findGeneration(userId, generationId, API_SCOPE);
    if (generation?.status !== 'completed' || !generation.assetId) throw new ApiError(404, '这一项没有生成成功，费用已退回', { code:'not_found' });
    const asset = findAsset(userId, generation.assetId, API_SCOPE);
    if (!asset) throw new ApiError(410, '生成结果已过保存期限', { code:'content_expired' });
    const localFile = path.join(assetFilesDir(userId), asset.storageName);
    if (await fs.access(localFile).then(() => true).catch(() => false)) return serveFile(res, localFile, asset.mimeType, 'private, no-store');
    if (asset.objectKey) {
      res.writeHead(302, { Location:await signedAssetUrl(asset.objectKey), 'Cache-Control':'private, no-store' });
      return res.end();
    }
    if (await servePendingGenerationSource(res, asset)) return;
    throw new ApiError(410, '生成结果已过保存期限', { code:'content_expired' });
  }

  async function dispatch(req, res, url, ctx) {
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    ctx.auth = authenticate(req);
    ctx.userId = ctx.auth.user.id;
    ctx.keyId = ctx.auth.key.id;
    limitRate(requestLimiter, ctx.keyId);
    const userId = ctx.userId;

    if (pathname === '/v1/models' && req.method === 'GET') {
      return sendApiJson(res, 200, { object:'list', data:apiCatalog().map(publicModelObject) });
    }
    const modelMatch = pathname.match(/^\/v1\/models\/(.+)$/);
    if (modelMatch && req.method === 'GET') {
      const id = decodeURIComponent(modelMatch[1]);
      const model = apiCatalog().find(item => item.id === id);
      if (!model) throw new ApiError(404, `模型 ${id} 不存在或暂不可用`, { code:'model_not_found' });
      return sendApiJson(res, 200, model);
    }
    if (pathname === '/v1/images/generations' && req.method === 'POST') return createTask(req, res, 'image', ctx);
    if (pathname === '/v1/images/edits' && req.method === 'POST') return createTask(req, res, 'image', ctx, { requireImage:true });
    if (pathname === '/v1/videos' && req.method === 'POST') return createTask(req, res, 'video', ctx);
    if (pathname === '/v1/images' && req.method === 'GET') return listTasks(req, res, url, 'image', userId);
    if (pathname === '/v1/videos' && req.method === 'GET') return listTasks(req, res, url, 'video', userId);

    const taskMatch = pathname.match(/^\/v1\/(images|videos)\/((?:img|video)_[a-f0-9]{8,64})(\/content)?$/);
    if (taskMatch) {
      const kind = taskMatch[1] === 'videos' ? 'video' : 'image';
      const task = findOwnTask(userId, taskMatch[2], kind);
      ctx.taskId = task.id;
      ctx.modelId = task.modelId;
      if (taskMatch[3] && req.method === 'GET') {
        const variant = url.searchParams.get('variant');
        if (kind === 'video' && variant && variant !== 'video') throw new ApiError(400, '目前只提供视频文件下载', { code:'invalid_parameter', param:'variant' });
        const index = kind === 'image' ? Number(url.searchParams.get('index') || 0) : 0;
        if (!Number.isSafeInteger(index) || index < 0) throw new ApiError(400, 'index 需为非负整数', { code:'invalid_parameter', param:'index' });
        return sendContent(res, userId, task, index);
      }
      if (!taskMatch[3] && req.method === 'GET') return sendApiJson(res, 200, objectFor(req, userId, task));
      if (!taskMatch[3] && req.method === 'DELETE') return deleteTask(res, userId, task);
    }
    if (/^\/v1\/(models|images|videos)(\/|$)/.test(pathname)) throw new ApiError(405, `不支持 ${req.method} ${pathname}`, { code:'method_not_allowed' });
    throw new ApiError(404, `接口 ${req.method} ${pathname} 不存在`, { code:'unknown_endpoint' });
  }

  async function handle(req, res, url) {
    if (url.pathname !== '/v1' && !url.pathname.startsWith('/v1/')) return false;
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    const startedAt = Date.now();
    const ctx = { userId:null, keyId:null, modelId:null, taskId:null, costMicro:0, errorCode:null, errorMessage:null };
    res.once('finish', () => {
      if (!ctx.userId || (req.method === 'GET' && res.statusCode < 400)) return;
      try {
        repo.insertLog({
          userId:ctx.userId, keyId:ctx.keyId, requestId:String(res.getHeader('X-Request-Id') || ''), method:req.method, path:url.pathname,
          modelId:ctx.modelId, taskId:ctx.taskId, statusCode:res.statusCode, errorCode:ctx.errorCode, errorMessage:ctx.errorMessage,
          costMicro:res.statusCode < 400 ? ctx.costMicro : 0, latencyMs:Date.now() - startedAt, clientIp:clientIp(req),
        });
      } catch (error) { console.error('[api] 调用日志写入失败', error.message); }
    });
    try {
      await dispatch(req, res, url, ctx);
    } catch (error) {
      if (res.headersSent) { res.end(); return true; }
      if (error instanceof ApiError) sendApiError(res, error, ctx);
      else {
        const status = Number(error.statusCode) || 500;
        if (status >= 500) console.error('[api] 请求失败', { path:url.pathname, message:error.message });
        const message = status >= 500 ? '服务暂时不可用，请稍后重试' : String(error.publicMessage || error.message || '请求无法处理');
        sendApiError(res, new ApiError(status, message, { code:status >= 500 ? 'server_error' : 'invalid_request', type:status >= 500 ? 'server_error' : null }), ctx);
      }
    }
    return true;
  }

  // Reference files sent to the API are only needed while a task prepares
  // its inputs; remove them a day later unless a task still uses them.
  async function sweepReferences({ olderThanMs = 24 * 3600_000, activeAssetIds = () => [] } = {}) {
    const before = new Date(Date.now() - olderThanMs).toISOString();
    const inUse = new Set(activeAssetIds());
    let removed = 0;
    for (const row of repo.staleReferenceAssets(before)) {
      if (inUse.has(row.id)) continue;
      const asset = findAsset(row.userId, row.id);
      if (!asset) continue;
      await deleteAssetRecord(row.userId, asset).then(() => { removed++; }).catch(error => console.warn('[api] 过期参考素材删除失败', { assetId:row.id, message:error.message }));
    }
    return removed;
  }

  function taskStatus(userId, taskId) {
    const task = repo.findTask(userId, taskId);
    if (!task) return null;
    const state = taskState(userId, task);
    return { status:state.status, credits:state.credits, refunded:state.refunded };
  }

  return Object.assign(handle, { sweepReferences, taskStatus });
}
