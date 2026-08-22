import http from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import OSS from 'ali-oss';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { conservativeInputTokenUpperBound, creditsToMicro, llmRatesFromEnv, llmReservationMicro, normalizeWallet } from './lib/billing.mjs';
import { closeDatabase, migrationCompleted, openDatabase, resolveDbFile, sql } from './lib/db.mjs';
import { chargeGenerationBatchMicro, chargeGenerationMicro, configureLedger, grantSignupBonus, markLlmBillingReconcile, recentCreditEntries, refundGenerationMicro, releaseLlmCredits, reserveLlmCredits, settleLlmCredits, walletOf } from './lib/ledger.mjs';
import { claimUploadIntent, completeUploadIntentWithAsset, configureCursors, countActiveUploadIntents, createSessionRecord, createUploadIntent, deleteAsset, deleteGeneration, deleteSession, expireUploadIntents, findAsset, findAssetBySha256, findDramaProject, findGeneration, findUploadIntent, findUserByUsername, latestDramaProject, listAssets, listDramaProjects, listGenerations, listPendingGenerations, listRecoverableUploadIntents, markUploadIntentFailed, parseLimit, purgeExpiredSessions, registerUser, saveAssetRecord, saveDramaProjectRecord, saveGenerationRecord, userForSession } from './lib/store.mjs';
import { analyzeDirectorPlanRecovery, analyzeDirectorShotShortage, buildDirectorPackageRepairPrompt, buildDirectorShotCompletionPrompt, buildDirectorShotRepairPrompt, directorPackageJsonSchema, directorPackageRepairSystemPrompt, directorPackageSystemPrompt, directorRecoveryDiagnostic, directorShotCompletionJsonSchema, directorShotCompletionSystemPrompt, directorShotRepairJsonSchema, directorShotRepairSystemPrompt, mergeDirectorShotCompletion, parseJsonObject, prepareDirectorPackage, replaceDirectorShots, scriptAnalysisSystemPrompt, storyboardSystemPrompt, validateDirectorPackage, validateScriptAnalysis, validateStoryboard } from './lib/drama-analysis.mjs';
import { normalizeMotionPlan, normalizeProductionScenes, productionQualitySummary, STORYBOARD_ENGINE_VERSION } from './lib/storyboard-engine.mjs';
import { callLlm, isLlmConfigured, llmConfigFromEnv } from './lib/llm-client.mjs';
import { buildVideoPayload, publicVideoCapabilities, validateVideoRequest, VIDEO_MODEL_IDS } from './lib/video-capabilities.mjs';
import { handleAdminRequest } from './lib/admin-api.mjs';
import { createLoginAttemptLimiter } from './lib/auth.mjs';
import { currentPricing, pricingSnapshot } from './lib/pricing.mjs';
import { isModelEnabled, publicVideoCapabilitiesWithControls } from './lib/model-controls.mjs';
import { buildShotVideoPrompt } from './public/video-prompt.js';

const scrypt = promisify(scryptCallback);
const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, 'data');
const legacyUsersFile = path.join(dataDir, 'users.json');
const userDataDir = path.join(dataDir, 'users');
const mediaTmpDir = process.env.MEDIA_TMP_DIR ? path.resolve(process.env.MEDIA_TMP_DIR) : path.join(dataDir, 'tmp');
const mediaTmpMaxAgeMs = Math.max(60_000, Number(process.env.MEDIA_TMP_MAX_AGE_MINUTES || 360) * 60_000);
const port = Number(process.env.PORT || 4317);
const duomiBase = (process.env.DUOMI_API_BASE || 'https://duomiapi.com').replace(/\/$/, '');
const ttapiBase = (process.env.TTAPI_API_BASE || 'https://api.ttapi.io').replace(/\/$/, '');
const configuredCntcnBase = (process.env.CNTCN_API_BASE || 'https://api.ai.cntcn.com').replace(/\/$/, '');
const cntcnBase = /\/v1$/i.test(configuredCntcnBase) ? configuredCntcnBase : `${configuredCntcnBase}/v1`;
const configuredOaiBase = (process.env.OAI_API_BASE || 'https://newapi.oairegbox.cc/v1').replace(/\/$/, '');
const oaiBase = /\/v1$/i.test(configuredOaiBase) ? configuredOaiBase : `${configuredOaiBase}/v1`;
const autodlBase = (process.env.AUTODL_API_BASE || 'https://autodl.art').replace(/\/$/, '');
const autodlWorkflowId = process.env.AUTODL_MINIMAX_H3_ID || 'minimax_h3_image_audio_to_video_v2_15s';
const autodlConfigured = Boolean(process.env.AUTODL_COMFYUI_KEY && autodlWorkflowId);
const ttapiConfigured = Boolean(process.env.TTAPI_API_KEY);
const cntcnConfigured = Boolean(process.env.CNTCN_KEY);
const oaiConfigured = Boolean(process.env.OAIAPI_GEMINI_KEY);
const oaiGrokConfigured = Boolean(process.env.OAIAPI_GROK_KEY);
const oaiVeoConfigured = Boolean(process.env.OAIAPI_VEO_KEY);
const oaiMinimaxConfigured = Boolean(process.env.OAIAPI_MINIMAX_KEY);
const oaiPollIntervalMs = 4_000;
const oaiRequestTimeoutMs = 300_000;
const ttapiPollIntervalMs = 8_000;
const ttapiMaxPollBackoffMs = 60_000;
const ttapiRequestTimeoutMs = 60_000;
const cntcnRequestTimeoutMs = 60_000;
const cntcnPollIntervalMs = 5_000;
const autodlPollIntervalMs = Math.max(5_000, Number(process.env.AUTODL_POLL_INTERVAL_MS || 10_000));
const autodlRequestTimeoutMs = Math.max(30_000, Number(process.env.AUTODL_REQUEST_TIMEOUT_MS || 60_000));
const autodlMaxPolls = Math.max(1, Number(process.env.AUTODL_MAX_POLLS || 360));
const autodlMaxPollDurationMs = autodlMaxPolls * autodlPollIntervalMs;
const generationRetryMaxDelayMs = 60_000;
const archiveAttemptsPerRun = 6;
const archiveRescheduleMs = 5 * 60_000;
const llmConfig = llmConfigFromEnv();
const llmRates = llmRatesFromEnv();
const ossPrefix = String(process.env.ALIYUN_OSS_PREFIX || 'model-studio').replace(/^\/+|\/+$/g, '');
const ossConfigured = Boolean(process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET && process.env.ALIYUN_OSS_ENDPOINT && process.env.ALIYUN_OSS_BUCKET);
const oss = ossConfigured ? new OSS({ accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, endpoint: process.env.ALIYUN_OSS_ENDPOINT, bucket: process.env.ALIYUN_OSS_BUCKET, secure: true }) : null;
const directOssUploadEnabled = String(process.env.DIRECT_OSS_UPLOAD_ENABLED || '').toLowerCase() === 'true';
const uploadIntentExpiresSeconds = Math.max(60, Number(process.env.UPLOAD_INTENT_EXPIRES_SECONDS || 600));
const ossUploadExpiresSeconds = Math.max(60, Number(process.env.ALIYUN_OSS_UPLOAD_EXPIRES_SECONDS || 300));
const ossAssetUrlExpiresSeconds = Math.max(60, Number(process.env.ALIYUN_OSS_ASSET_URL_EXPIRES_SECONDS || 900));
const uploadMaxPendingPerUser = Math.max(1, Number(process.env.UPLOAD_MAX_PENDING_PER_USER || 3));
const uploadInitLimitPerMinute = Math.max(1, Number(process.env.UPLOAD_INIT_LIMIT_PER_MINUTE || 10));
const uploadInitAttempts = new Map();
const sessionMaxAge = 60 * 60 * 24 * 14;
const maxUploadBytes = 25 * 1024 * 1024;
const maxReferenceImageBytes = 8 * 1024 * 1024;
const activeGenerations = new Map();
const generationRetryTimers = new Map();
const assetRestores = new Map();
const loginLimiter = createLoginAttemptLimiter({ maxAttempts: 8, windowMs: 15 * 60_000 });
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const videoTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const audioTypes = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/flac']);
const uploadMimeByExtension = Object.freeze({ '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.weba':'audio/webm', '.flac':'audio/flac' });
const imageSizes = new Set(['1:1', '3:2', '2:3', '16:9', '9:16', '1:2', '2:1', '4:3', '3:4', '5:4', '4:5']);
const videoAspectRatios = new Set(['2:3', '3:2', '1:1', '9:16', '16:9']);
const videoDurations = new Set([8, 10, 15, 20, 30]);
const dramaVideoDurations = new Set([8, 10, 15, 20, 30]);
const dramaStepOrder = ['script', 'resources', 'storyboard', 'video'];
const fixedModels = Object.freeze({ image: 'gpt-image-2' });
const invitationCodes = new Set();
const creditPricing = Object.freeze({ image: 1, videoPerSecond: 1, signupBonus: 50 });

await fs.mkdir(userDataDir, { recursive: true });
await fs.mkdir(mediaTmpDir, { recursive: true });
const staleMediaCutoff = Date.now() - mediaTmpMaxAgeMs;
for (const entry of await fs.readdir(mediaTmpDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const target = path.join(mediaTmpDir, entry.name);
  const stat = await fs.stat(target).catch(() => null);
  if (stat && stat.mtimeMs < staleMediaCutoff) await fs.rm(target, { recursive: true, force: true }).catch(error => console.error(`[media] 启动清理失败 ${target}`, error.message));
}

// Metadata lives in SQLite; only media binaries stay on disk (plus OSS).
openDatabase({ verbose: true, file: process.env.NODE_ENV === 'test' ? ':memory:' : null });

// Refuse to start on a half-migrated data directory, otherwise the server would
// silently serve an empty database while the real records sit in JSON files.
if (process.env.NODE_ENV !== 'test' && !migrationCompleted()) {
  const legacyPresent = await fs.readFile(legacyUsersFile, 'utf8')
    .then(text => { try { return JSON.parse(text).length > 0; } catch { return false; } })
    .catch(() => false);
  if (legacyPresent) {
    console.error(`检测到 ${legacyUsersFile} 中存在历史用户数据，但数据库没有迁移完成标记。`);
    console.error('请先执行：npm run migrate -- --dry-run  确认无误后再执行 npm run migrate');
    process.exit(1);
  }
}

configureLedger({ llmRates, llmProtocol: llmConfig.protocol, llmModel: llmConfig.model });
// Signing key for opaque list cursors. Derived from the session secret material
// so it survives restarts without adding another env var to manage.
configureCursors(createHash('sha256').update(`cursor:${process.env.DUOMI_API_KEY || ''}:${resolveDbFile()}`).digest('hex'));

const expiredSessions = purgeExpiredSessions(new Date().toISOString());
if (expiredSessions) console.log(`[sessions] 启动清理过期会话 ${expiredSessions} 条`);
const sessionSweeper = setInterval(() => {
  try {
    const removed = purgeExpiredSessions(new Date().toISOString());
    if (removed) console.log(`[sessions] 定期清理过期会话 ${removed} 条`);
  } catch (error) { console.error('清理过期会话失败', error); }
}, 6 * 60 * 60 * 1000);
sessionSweeper.unref();

const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeId = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const charLength = value => Array.from(String(value || '')).length;
const publicUser = user => ({ id: user.id, username: user.username, role: user.role || 'user', status: user.status || 'active', credits: normalizeWallet(user).balance, createdAt: user.createdAt });
const uploadSweepIntervalMs = Math.max(60_000, Number(process.env.UPLOAD_SWEEP_INTERVAL_MINUTES || 10) * 60_000);
const uploadVerifyStaleMs = Math.max(60_000, Number(process.env.UPLOAD_VERIFY_STALE_MINUTES || 10) * 60_000);
const uploadSweeper = setInterval(() => {
  if (!directOssUploadEnabled || !ossConfigured) return;
  const nowIso = now();
  try {
    const expired = expireUploadIntents(nowIso);
    if (expired.length) expired.forEach(intent => oss.delete(intent.temporaryOssKey).catch(() => {}));
    const staleBefore = new Date(Date.now() - uploadVerifyStaleMs).toISOString();
    const stale = listRecoverableUploadIntents(nowIso, staleBefore);
    stale.forEach(intent => {
      markUploadIntentFailed(intent.userId, intent.id, { errorCode: 'UPLOAD_VERIFY_TIMEOUT', nowIso });
      oss.delete(intent.temporaryOssKey).catch(() => {});
      oss.delete(intent.finalOssKey).catch(() => {});
    });
    if (expired.length || stale.length) console.log(`[uploads] 清理过期 ${expired.length} 条，超时 ${stale.length} 条`);
  } catch (error) { console.error('[uploads] 定期清理失败', error); }
}, uploadSweepIntervalMs);
uploadSweeper.unref();
const generationFailureCatalog = Object.freeze({
  CONTENT_REJECTED: Object.freeze({ message: '内容未通过生成检查', suggestion: '请调整可能涉及敏感、侵权或高风险的描述及参考图片后重试。', action: 'edit_input' }),
  INVALID_REFERENCE: Object.freeze({ message: '参考图片不符合生成要求', suggestion: '请检查图片格式、大小和数量，移除异常图片后重新生成。', action: 'edit_input' }),
  INVALID_REQUEST: Object.freeze({ message: '生成参数不符合要求', suggestion: '请检查提示词、画幅、时长和生成模式后重试。', action: 'edit_input' }),
  RATE_LIMITED: Object.freeze({ message: '当前生成请求较多', suggestion: '请稍等几分钟再试，不要连续重复提交。', action: 'retry_later' }),
  TIMEOUT: Object.freeze({ message: '生成等待超时', suggestion: '本次任务已停止，可重新生成；若持续发生，请稍后再试。', action: 'retry' }),
  SERVICE_UNAVAILABLE: Object.freeze({ message: '生成服务暂时不可用', suggestion: '请稍后重试；若持续失败，请联系支持并提供本平台任务编号。', action: 'retry_later' }),
  UPSTREAM_BILLING: Object.freeze({ message: '视频供应商账户余额不足', suggestion: '请为当前视频供应商账户充值，或切换到已开通且有余额的渠道后再试。', action: 'contact_support' }),
  RESULT_INVALID: Object.freeze({ message: '生成结果暂不可用', suggestion: '服务没有返回完整成品，请重新生成；若重复出现，请联系支持。', action: 'retry' }),
  ARCHIVE_FAILED: Object.freeze({ message: '成品归档暂未完成', suggestion: '模型已完成生成，请稍后刷新，不要重复提交；持续未恢复时请联系支持。', action: 'wait' }),
  INTERRUPTED: Object.freeze({ message: '任务处理被中断', suggestion: '任务未能继续执行，请确认积分状态后重新生成。', action: 'retry' }),
  REFUND_PENDING: Object.freeze({ message: '任务失败，积分退回待处理', suggestion: '请勿重复提交，联系支持并提供本平台任务编号。', action: 'contact_support' }),
  UNKNOWN: Object.freeze({ message: '生成失败，服务未返回具体原因', suggestion: '可调整提示词或参考图片后重试；若持续失败，请联系支持。', action: 'edit_input' }),
});
function generationFailureCode(task) {
  if (task.creditStatus === 'refund_failed') return 'REFUND_PENDING';
  const raw = String(task.error || '').toLowerCase();
  if ((task.providerTaskId && task.sourceUrl) || /成品下载|归档|文件存储|空文件/.test(raw)) return 'ARCHIVE_FAILED';
  if (/服务重启|任务.*中断|interrupted|cancelled|canceled/.test(raw)) return 'INTERRUPTED';
  if (/content review|moderation|safety|policy|nsfw|审核|违规|敏感|涉政|色情|rejected/.test(raw)) return 'CONTENT_REJECTED';
  if (/unmarshal.*images|image.*\[\]string|参考图|reference image|image[_ ]url|图片.*(格式|大小|尺寸|数量)|unsupported image/.test(raw)) return 'INVALID_REFERENCE';
  if (/\b429\b|rate.?limit|too many requests|overloaded|capacity|繁忙|请求过多|频率/.test(raw)) return 'RATE_LIMITED';
  if (/timeout|timed out|超时|等待超时/.test(raw)) return 'TIMEOUT';
  if (/account balance|insufficient balance|insufficient funds|余额不足|账户余额|余额不够/.test(raw)) return 'UPSTREAM_BILLING';
  if (/没有返回任务 id|没有返回结果|没有返回.*url|missing.*(task|result|url)|invalid response|结果地址/.test(raw)) return 'RESULT_INVALID';
  if (/\b400\b|\b409\b|\b422\b|invalid (parameter|argument|request)|bad request|参数|不支持.*(画幅|时长|模式)/.test(raw)) return 'INVALID_REQUEST';
  if (/\b(401|403|404|500|502|503|504)\b|fetch failed|network|econn|socket|service unavailable|服务.*(未配置|不可用)|任务没有返回任务 id/.test(raw)) return 'SERVICE_UNAVAILABLE';
  return 'UNKNOWN';
}
function publicGeneration(task) {
  const {
    ownerId, provider, providerTaskId, sourceUrl, error: internalError, internalError: storedInternalError,
    rawResponse, requestUrl, lastPollError, lastPollErrorAt, lastArchiveError, lastArchiveErrorAt,
    pollFailureCount, archiveFailureCount, submissionUncertain, archivePending, ...value
  } = task;
  const failure = task.status === 'failed'
    ? { code: generationFailureCode(task), ...generationFailureCatalog[generationFailureCode(task)] }
    : null;
  const progressStage = task.status !== 'running' ? task.status
    : task.submissionUncertain ? 'awaiting_reconciliation'
      : task.sourceUrl && !task.assetId ? 'archiving'
        : task.lastPollError ? 'polling_retry'
          : task.providerTaskId ? 'provider_processing'
            : 'submitting';
  if (failure && task.creditStatus === 'refunded') failure.suggestion += ' 本次预扣积分已退回。';
  return {
    ...value,
    progressStage,
    error: failure ? `${failure.message}。${failure.suggestion}` : '',
    failure,
  };
}
const normalizeInviteCode = value => String(value || '').trim().toUpperCase();
const isKnownInviteCode = value => invitationCodes.has(normalizeInviteCode(value));
const generationCost = (type, duration = 0) => type === 'image' ? creditPricing.image : Math.max(1, Math.round(Number(duration) || 1)) * creditPricing.videoPerSecond;

function userDir(userId) { return path.join(userDataDir, safeId(userId)); }
/** Local cache of media binaries. The authoritative copy lives in OSS. */
function assetFilesDir(userId) { return path.join(userDir(userId), 'files'); }
async function ensureUserDirs(userId) { await fs.mkdir(assetFilesDir(userId), { recursive: true }); }

function parseCookies(header = '') { return Object.fromEntries(header.split(';').map(part => part.trim().split('=')).filter(x => x[0]).map(([key, ...rest]) => [key, decodeURIComponent(rest.join('='))])); }
function setSessionCookie(res, token) { res.setHeader('Set-Cookie', `studio_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionMaxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`); }
function clearSessionCookie(res) { res.setHeader('Set-Cookie', 'studio_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'); }
async function hashPassword(password) { const salt = randomBytes(16).toString('hex'); const derived = await scrypt(password, salt, 64); return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`; }
async function verifyPassword(password, stored) { const [, salt, expectedHex] = String(stored).split(':'); if (!salt || !expectedHex) return false; const actual = Buffer.from(await scrypt(password, salt, 64)); const expected = Buffer.from(expectedHex, 'hex'); return actual.length === expected.length && timingSafeEqual(actual, expected); }
function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  createSessionRecord({
    tokenHash: tokenHash(token),
    userId,
    expiresAt: new Date(Date.now() + sessionMaxAge * 1000).toISOString(),
    createdAt: now(),
  });
  return token;
}
function currentUser(req) {
  const token = parseCookies(req.headers.cookie).studio_session;
  if (!token) return null;
  return userForSession(tokenHash(token), now());
}
function requireUser(req, res) { const user = currentUser(req); if (!user) { sendJson(res, 401, { error: '请先登录' }); return null; } return user; }
function mutationAllowed(req) { if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) return true; const origin = req.headers.origin; if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } }

async function bodyJson(req, limit = 2_000_000) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 }); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON 格式不正确'), { statusCode: 400 }); } }
function sendJson(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
/**
 * Pagination travels in headers so the response bodies keep their original
 * shape. The front end consumes /api/generations and /api/files as bare arrays,
 * so wrapping them in a pagination envelope would break it.
 */
function setPageHeaders(res, page) {
  res.setHeader('X-Total-Count', String(page.total));
  if (page.nextCursor) res.setHeader('X-Next-Cursor', page.nextCursor);
}
function configState() {
  const pricing = currentPricing();
  return {
    imageGeneration: Boolean(process.env.DUOMI_API_KEY),
    oss: ossConfigured,
    directOssUpload: ossConfigured && directOssUploadEnabled,
    llm: isLlmConfigured(llmConfig),
    pricing: { version: pricing.version, imagePerRequest: pricing.imagePerRequest, videoPerSecond: pricing.videoPerSecond },
    videoCapabilities: publicVideoCapabilitiesWithControls(),
  };
}

function errorMessage(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => errorMessage(item)).filter(Boolean).join('；');
  if (value && typeof value === 'object') return errorMessage(value.message || value.msg || value.detail || value.error || value.errors || value.code) || fallback;
  return fallback;
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = { raw: text }; }
  if (!response.ok) {
    const message = errorMessage(value, text.slice(0, 300));
    throw Object.assign(new Error(`${response.status} ${message}`), {
      upstreamStatus: response.status,
      upstreamMessage: message,
    });
  }
  return value;
}
async function createImage(task, refs) { const payload = { model: task.model, prompt: task.prompt, size: task.size, quality: task.quality }; if (refs.length) payload.image = refs.slice(0, 7); const created = await fetchJson(`${duomiBase}/v1/images/generations?async=true`, { method: 'POST', headers: { Authorization: process.env.DUOMI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const taskId = created.id || created.task_id; if (!taskId) throw new Error('图片任务没有返回任务 ID'); for (let i = 0; i < 100; i++) { await sleep(6000); const state = await fetchJson(`${duomiBase}/v1/tasks/${taskId}`, { headers: { Authorization: process.env.DUOMI_API_KEY } }); if (state.state === 'succeeded') return { taskId, url: state.data?.images?.[0]?.url }; if (['error', 'failed'].includes(state.state)) throw new Error(state.message || '图片生成失败'); } throw new Error('图片任务等待超时'); }
async function createDuomiVideo(task, refs) {
  let taskId = '';
  try {
    const created = await fetchJson(`${duomiBase}/v1/videos/generations`, { method: 'POST', headers: { Authorization: process.env.DUOMI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(buildVideoPayload(task, refs)) });
    taskId = created.id || created.task_id;
    if (!taskId) throw Object.assign(new Error('多米视频任务没有返回任务 ID'), { provider: 'duomi', fallbackEligible: false });
    for (let i = 0; i < 160; i++) {
      await sleep(8000);
      const state = await fetchJson(`${duomiBase}/v1/videos/tasks/${taskId}`, { headers: { Authorization: process.env.DUOMI_API_KEY } });
      if (['succeeded', 'completed'].includes(state.state)) return { provider: 'duomi', taskId, url: state.data?.videos?.[0]?.url };
      if (['error', 'failed'].includes(state.state)) throw Object.assign(new Error(state.message || '多米视频生成失败'), { provider: 'duomi', providerTaskId: taskId, fallbackEligible: true });
    }
    throw Object.assign(new Error('多米视频任务等待超时'), { provider: 'duomi', providerTaskId: taskId, fallbackEligible: true });
  } catch (error) {
    console.error('[video] Duomi upstream failure', {
      generationId: task.id,
      modelId: task.videoModelId || task.modelId || null,
      model: task.model || null,
      phase: taskId ? 'poll' : 'submit',
      status: error.upstreamStatus || null,
      message: error.upstreamMessage || error.message,
    });
    if (taskId && error.fallbackEligible === undefined) error = Object.assign(new Error(error.message), { provider: 'duomi', providerTaskId: taskId, fallbackEligible: true });
    throw error;
  }
}
function upstreamRequestErrorDetail(error) {
  return [error?.upstreamStatus, error?.cause?.code, error?.upstreamMessage || error?.cause?.message || error?.message]
    .filter(Boolean).join(' · ') || '未知上游网络错误';
}
function isDefinitiveSubmitRejection(error) {
  return Number(error?.upstreamStatus) >= 400
    && Number(error?.upstreamStatus) < 500
    && ![408, 409, 425, 429].includes(Number(error.upstreamStatus));
}
async function pollTtapiVideo(taskId, hooks = {}) {
  let consecutiveErrors = 0;
  let recovering = false;
  for (;;) {
    const delay = consecutiveErrors
      ? Math.min(ttapiPollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), ttapiMaxPollBackoffMs)
      : ttapiPollIntervalMs;
    await sleep(delay);
    let state;
    try {
      state = await fetchJson(`${ttapiBase}/grok/fetch?jobId=${encodeURIComponent(taskId)}`, {
        headers: { 'TT-API-KEY': process.env.TTAPI_API_KEY },
        signal: AbortSignal.timeout(ttapiRequestTimeoutMs),
      });
    } catch (error) {
      consecutiveErrors++;
      recovering = true;
      const detail = upstreamRequestErrorDetail(error);
      console.error('[video] TTAPI poll transport failure; task remains active', { taskId, consecutiveErrors, detail });
      try { await hooks.onPollError?.({ consecutiveErrors, detail }); }
      catch (saveError) { console.error('[video] TTAPI poll state persistence failed', { taskId, message: saveError.message }); }
      continue;
    }

    if (recovering) {
      try { await hooks.onPollRecovered?.(); }
      catch (saveError) { console.error('[video] TTAPI recovery state persistence failed', { taskId, message: saveError.message }); }
    }
    consecutiveErrors = 0;
    recovering = false;
    const videoUrl = state.data?.videoUrl;
    if (videoUrl) return { provider: 'ttapi', taskId, url: videoUrl };
    const status = String(state.status || state.data?.status || '').toUpperCase();
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status)) {
      throw Object.assign(new Error(errorMessage(state, 'TTAPI 视频生成失败')), {
        provider: 'ttapi', providerTaskId: taskId, upstreamTerminal: true,
      });
    }
  }
}
async function createTtapiVideo(task, refs, hooks = {}) {
  const payload = { prompt: task.prompt, model: task.model, aspect_ratio: task.aspectRatio, video_length: String(task.duration), resolution_name: task.quality || '720p' };
  if (refs.length) payload.refer_images = refs.slice(0, task.maxReferenceImages || 7);
  let created;
  try {
    created = await fetchJson(`${ttapiBase}/grok/generations`, {
      method: 'POST',
      headers: { 'TT-API-KEY': process.env.TTAPI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ttapiRequestTimeoutMs),
    });
  } catch (error) {
    if (isDefinitiveSubmitRejection(error)) {
      throw Object.assign(error, { provider: 'ttapi', upstreamTerminal: true });
    }
    throw Object.assign(new Error(`TTAPI 提交结果待确认：${upstreamRequestErrorDetail(error)}`), {
      provider: 'ttapi', submissionUncertain: true, cause: error,
    });
  }
  const taskId = created.data?.jobId || created.jobId;
  if (!taskId) {
    throw Object.assign(new Error('TTAPI 已接受请求，但没有返回任务 ID，提交结果待核对'), {
      provider: 'ttapi', submissionUncertain: true,
    });
  }
  await hooks.onSubmitted?.({ provider: 'ttapi', taskId: String(taskId) });
  return pollTtapiVideo(String(taskId), hooks);
}
function cntcnVideoUrl(value) {
  const candidates = [
    value?.video_url, value?.url, value?.download_url, value?.original_video_url,
    value?.data?.video_url, value?.data?.url, value?.data?.download_url, value?.data?.original_video_url,
  ];
  const candidate = candidates.find(item => typeof item === 'string' && item.trim());
  return candidate ? candidate.trim() : '';
}
function cntcnTaskId(value) {
  const candidate = value?.task_id || value?.taskId || value?.id || value?.data?.task_id || value?.data?.taskId || value?.data?.id;
  return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
}
function cntcnStatus(value) {
  return String(value?.status || value?.data?.status || value?.data?.status_code || '').trim().toLowerCase();
}
function cntcnError(value) {
  return errorMessage(value?.error || value?.error_message || value?.api_error || value, 'CNTCN 视频生成失败');
}
async function pollCntcnVideo(taskId, hooks = {}) {
  let consecutiveErrors = 0;
  let recovering = false;
  for (;;) {
    await sleep(consecutiveErrors ? Math.min(cntcnPollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), 60_000) : cntcnPollIntervalMs);
    let state;
    try {
      state = await fetchJson(`${cntcnBase}/videos/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${process.env.CNTCN_KEY}` },
        signal: AbortSignal.timeout(cntcnRequestTimeoutMs),
      });
    } catch (error) {
      consecutiveErrors++;
      recovering = true;
      const detail = upstreamRequestErrorDetail(error);
      console.error('[video] CNTCN poll transport failure; task remains active', { taskId, consecutiveErrors, detail });
      try { await hooks.onPollError?.({ consecutiveErrors, detail }); }
      catch (saveError) { console.error('[video] CNTCN poll state persistence failed', { taskId, message: saveError.message }); }
      continue;
    }
    if (recovering) {
      try { await hooks.onPollRecovered?.(); }
      catch (saveError) { console.error('[video] CNTCN recovery state persistence failed', { taskId, message: saveError.message }); }
    }
    consecutiveErrors = 0;
    recovering = false;
    const videoUrl = cntcnVideoUrl(state);
    if (videoUrl) return { provider: 'cntcn', taskId, url: videoUrl };
    const status = cntcnStatus(state);
    if (['failed', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) {
      throw Object.assign(new Error(cntcnError(state)), { provider: 'cntcn', providerTaskId: taskId, upstreamTerminal: true });
    }
    // An expired URL can be regenerated by querying the task again.
  }
}
async function createCntcnVideo(task, refs, hooks = {}) {
  let taskId = '';
  try {
    const created = await fetchJson(`${cntcnBase}/videos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.CNTCN_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildVideoPayload(task, refs)),
      signal: AbortSignal.timeout(cntcnRequestTimeoutMs),
    });
    taskId = cntcnTaskId(created);
    if (!taskId) throw new Error('CNTCN 已接受请求，但没有返回任务 ID，提交结果待核对');
    await hooks.onSubmitted?.({ provider: 'cntcn', taskId });
    return pollCntcnVideo(taskId, hooks);
  } catch (error) {
    if (error.upstreamTerminal) throw error;
    if (isDefinitiveSubmitRejection(error)) throw Object.assign(error, { provider: 'cntcn', upstreamTerminal: true });
    if (taskId && error.providerTaskId === undefined) throw Object.assign(new Error(error.message), { provider: 'cntcn', providerTaskId: taskId });
    throw Object.assign(new Error(`CNTCN 提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: 'cntcn', submissionUncertain: true, cause: error });
  }
}
function autodlStatus(value) {
  return String(value?.data?.status || value?.status || '').trim().toLowerCase();
}
function autodlTaskId(value) {
  const candidate = value?.data?.task_id || value?.data?.taskId || value?.task_id || value?.taskId;
  return candidate === undefined || candidate === null ? '' : String(candidate);
}
function autodlResults(value) {
  return Array.isArray(value?.data?.results) ? value.data.results : Array.isArray(value?.results) ? value.results : [];
}
function autodlVideoUrl(value) {
  const result = autodlResults(value).find(item => item?.type === 'video' && typeof item.url === 'string' && item.url.trim())
    || autodlResults(value).find(item => typeof item?.url === 'string' && item.url.trim());
  return result?.url?.trim() || '';
}
function autodlRetryableResponseError(value) {
  const code = value?.code;
  const normalizedCode = code === undefined || code === null ? '' : String(code).trim().toLowerCase();
  if (!normalizedCode || normalizedCode === 'success' || value?.data != null) return null;
  const detail = errorMessage(value, 'AutoDL 返回业务错误');
  return Object.assign(new Error(detail), {
    upstreamCode: String(code),
    upstreamMessage: detail,
    retryableBusinessResponse: true,
  });
}
async function pollAutodlVideo(taskId, hooks = {}, runtime = {}) {
  const fetchState = runtime.fetchJson || fetchJson;
  const wait = runtime.sleep || sleep;
  const nowMs = runtime.now || Date.now;
  const maxPolls = Math.max(1, Number(runtime.maxPolls ?? autodlMaxPolls));
  const maxDurationMs = Math.max(1, Number(runtime.maxDurationMs ?? autodlMaxPollDurationMs));
  const pollIntervalMs = Math.max(0, Number(runtime.pollIntervalMs ?? autodlPollIntervalMs));
  const startedAt = nowMs();
  let consecutiveErrors = 0;
  let recovering = false;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const remainingMs = maxDurationMs - (nowMs() - startedAt);
    if (remainingMs <= 0) break;
    const delay = consecutiveErrors
      ? Math.min(pollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), 60_000)
      : pollIntervalMs;
    await wait(Math.min(delay, remainingMs));
    let state;
    try {
      state = await fetchState(`${autodlBase}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${process.env.AUTODL_COMFYUI_KEY}` },
        signal: AbortSignal.timeout(autodlRequestTimeoutMs),
      });
      const businessError = autodlRetryableResponseError(state);
      if (businessError) throw businessError;
    } catch (error) {
      consecutiveErrors++;
      recovering = true;
      const detail = upstreamRequestErrorDetail(error);
      console.error('[video] AutoDL poll retryable failure; task remains active', { taskId, consecutiveErrors, detail });
      try { await hooks.onPollError?.({ consecutiveErrors, detail }); }
      catch (saveError) { console.error('[video] AutoDL poll state persistence failed', { taskId, message: saveError.message }); }
      continue;
    }
    if (recovering) {
      try { await hooks.onPollRecovered?.(); }
      catch (saveError) { console.error('[video] AutoDL recovery state persistence failed', { taskId, message: saveError.message }); }
    }
    consecutiveErrors = 0;
    recovering = false;
    const videoUrl = autodlVideoUrl(state);
    const status = autodlStatus(state);
    if (videoUrl) return { provider: 'autodl', taskId, url: videoUrl };
    if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) {
      throw Object.assign(new Error(state.msg || state.message || 'AutoDL 视频生成失败'), { provider: 'autodl', providerTaskId: taskId, upstreamTerminal: true });
    }
  }
  throw Object.assign(new Error('AutoDL 视频任务等待超时'), { provider: 'autodl', providerTaskId: taskId });
}
function buildAutodlPayload(task, refs) {
  const groups = Array.isArray(refs) ? { images: refs, audios: [] } : (refs || { images: [], audios: [] });
  const payload = {
    prompt: task.prompt,
    duration: task.duration,
    resolution: `${task.quality || '768p'}${task.aspectRatio === '9:16' ? '竖' : '横'}`,
  };
  groups.images?.slice(0, task.referenceLimits?.image || task.maxReferenceImages || 9).forEach((url, index) => { payload[`ref_image_${index}`] = url; });
  groups.audios?.slice(0, task.referenceLimits?.audio || 3).forEach((url, index) => { payload[`ref_audio_${index}`] = url; });
  return payload;
}
async function createAutodlVideo(task, refs, hooks = {}, runtime = {}) {
  const submit = runtime.fetchJson || fetchJson;
  let taskId = '';
  try {
    const created = await submit(`${autodlBase}/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(autodlWorkflowId)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.AUTODL_COMFYUI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAutodlPayload(task, refs)),
      signal: AbortSignal.timeout(autodlRequestTimeoutMs),
    });
    taskId = autodlTaskId(created);
    if (!taskId) throw Object.assign(new Error('AutoDL 已接受请求，但没有返回任务 ID，提交结果待核对'), { submissionUncertain: true });
    await hooks.onSubmitted?.({ provider: 'autodl', taskId });
    const immediateUrl = autodlVideoUrl(created);
    if (immediateUrl) return { provider: 'autodl', taskId, url: immediateUrl };
    return pollAutodlVideo(taskId, hooks, runtime);
  } catch (error) {
    if (error.upstreamTerminal || error.submissionUncertain) throw error;
    if (!taskId && isDefinitiveSubmitRejection(error)) {
      throw Object.assign(error, { provider: 'autodl', upstreamTerminal: true });
    }
    if (taskId && error.providerTaskId === undefined) throw Object.assign(new Error(error.message), { provider: 'autodl', providerTaskId: taskId });
    throw Object.assign(new Error(`AutoDL 提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: 'autodl', submissionUncertain: true, cause: error });
  }
}
function oaiVideoUrl(value) {
  const candidate = value?.data?.[0]?.video_url || value?.data?.[0]?.url || value?.data?.video_url || value?.data?.url || value?.video_url || value?.videoUrl || value?.output?.url || value?.result?.url || value?.url;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : '';
}
function oaiTaskId(value) {
  const candidate = value?.task_id || value?.taskId || value?.id || value?.data?.task_id || value?.data?.taskId || value?.data?.id || value?.data?.[0]?.task_id || value?.data?.[0]?.taskId || value?.data?.[0]?.id;
  return typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
}
function oaiStatus(value) {
  return String(value?.status || value?.state || value?.data?.status || value?.data?.state || value?.data?.[0]?.status || value?.data?.[0]?.state || '').trim().toUpperCase();
}
function oaiKeyForTask(task) {
  if (task.videoModelId === VIDEO_MODEL_IDS.GROK_15) return process.env.OAIAPI_GROK_KEY;
  if (task.videoModelId === VIDEO_MODEL_IDS.VEO_31) return process.env.OAIAPI_VEO_KEY;
  if (task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3) return process.env.OAIAPI_MINIMAX_KEY;
  return process.env.OAIAPI_GEMINI_KEY;
}
function veo31Size(task) {
  const sizeByAspect = {
    '16:9': { '720p': '1280x720', '1080p': '1920x1080' },
    '9:16': { '720p': '720x1280', '1080p': '1080x1920' },
  };
  return sizeByAspect[task.aspectRatio]?.[task.quality || '720p'] || '1280x720';
}
function buildOaiVideoPayload(task, refs) {
  if (task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3) return buildVideoPayload(task, refs);
  if (task.videoModelId === VIDEO_MODEL_IDS.VEO_31) {
    const payload = {
      model: task.model,
      prompt: task.prompt,
      seconds: String(task.duration),
      size: veo31Size(task),
      generation_type: task.generationType || (refs.length ? 'REFERENCE' : 'TEXT'),
    };
    if (task.generationType === 'FIRST&LAST') {
      if (refs[0]) payload.first_image_url = refs[0];
      if (refs[1]) payload.last_image_url = refs[1];
    } else if (task.generationType === 'REFERENCE') {
      if (refs.length === 1) payload.image_url = refs[0];
      else if (refs.length > 1) payload.images = refs.slice(0, task.maxReferenceImages || 3);
    }
    return payload;
  }
  const isGrok15 = task.videoModelId === VIDEO_MODEL_IDS.GROK_15;
  const payload = { model: task.model, prompt: task.prompt, aspect_ratio: task.aspectRatio, seconds: isGrok15 ? String(task.duration) : task.duration };
  if (isGrok15) {
    payload.resolution = task.quality || '720p';
    if (refs[0]) payload.image = refs[0];
  } else if (task.generationType === 'FIRST&LAST') {
    if (refs[0]) payload.first_image_url = refs[0];
    if (refs[1]) payload.last_image_url = refs[1];
  } else if (refs.length === 1) {
    payload.image_url = refs[0];
  } else if (refs.length > 1) {
    payload.images = refs.slice(0, task.maxReferenceImages || 5);
  }
  return payload;
}
function oaiVideoRequest(task, refs, apiKey) {
  const payload = buildOaiVideoPayload(task, refs);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  return { headers, body: JSON.stringify(payload) };
}
async function createOaiVideo(task, refs) {
  const apiKey = oaiKeyForTask(task);
  let taskId = '';
  try {
    const request = oaiVideoRequest(task, refs, apiKey);
    const created = await fetchJson(`${oaiBase}/videos`, { method: 'POST', ...request, signal: AbortSignal.timeout(oaiRequestTimeoutMs) });
    taskId = oaiTaskId(created);
    const submittedUrl = oaiVideoUrl(created);
    if (submittedUrl && taskId) return { provider: 'oai', taskId, url: submittedUrl };
    if (!taskId) throw new Error('OAI 视频任务没有返回任务 ID');
    for (let i = 0; i < 160; i++) {
      await sleep(oaiPollIntervalMs);
      const state = await fetchJson(`${oaiBase}/videos/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(oaiRequestTimeoutMs) });
      const videoUrl = oaiVideoUrl(state);
      const status = oaiStatus(state);
      if (videoUrl) return { provider: 'oai', taskId, url: videoUrl };
      if (['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'COMPLETE', 'DONE'].includes(status)) {
        if (task.videoModelId === VIDEO_MODEL_IDS.VEO_31) throw new Error('Veo 3.1 任务已完成，但响应没有返回顶层 video_url');
        if (task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3) throw new Error('MiniMax H3 任务已完成，但响应没有返回 video_url');
        return { provider: 'oai', taskId, url: `${oaiBase}/videos/${encodeURIComponent(taskId)}/content`, requiresAuth: true };
      }
      if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status)) throw new Error(errorMessage(state, 'OAI 视频生成失败'));
    }
    throw new Error('OAI 视频任务等待超时');
  } catch (error) {
    if (taskId && error.providerTaskId === undefined) error = Object.assign(new Error(error.message), { provider: 'oai', providerTaskId: taskId });
    throw error;
  }
}
async function createVideo(task, refs, hooks = {}) {
  if (task.provider === 'ttapi') {
    if (!ttapiConfigured) throw new Error('TTAPI 视频服务尚未配置');
    return createTtapiVideo(task, refs, hooks);
  }
  if (task.provider === 'duomi') return createDuomiVideo(task, refs);
  if (task.provider === 'cntcn') {
    if (!cntcnConfigured) throw new Error('CNTCN Seedance 视频服务尚未配置');
    return createCntcnVideo(task, refs, hooks);
  }
  if (task.provider === 'autodl') {
    if (!autodlConfigured) throw new Error('AutoDL GuGu 2.0 视频服务尚未配置');
    return createAutodlVideo(task, refs, hooks);
  }
  if (task.provider === 'oai') {
    if (!oaiKeyForTask(task)) {
      const message = task.videoModelId === VIDEO_MODEL_IDS.GROK_15
        ? 'Grok Video 服务尚未配置'
        : task.videoModelId === VIDEO_MODEL_IDS.VEO_31
          ? 'Veo 3.1 服务尚未配置'
          : task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3
            ? 'MiniMax H3 服务尚未配置'
            : 'OAI 视频服务尚未配置';
      throw new Error(message);
    }
    return createOaiVideo(task, refs);
  }
  throw new Error(`不支持的视频供应商：${task.provider || '未指定'}`);
}
function downloadErrorDetail(error) { const cause = error?.cause; return [cause?.code, cause?.message || error?.message].filter(Boolean).join(' · ') || '未知网络错误'; }
async function downloadToFile(url, target, attempts = 4, options = {}) {
  const partial = `${target}.part`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'Model-Studio/1.0', Accept: '*/*', ...(options.headers || {}) } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('响应没有文件内容');
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'w' }));
      const stat = await fs.stat(partial);
      if (!stat.size) throw new Error('模型返回了空文件');
      await fs.rename(partial, target);
      return { contentType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream', size: stat.size };
    } catch (error) {
      lastError = error;
      await fs.unlink(partial).catch(() => {});
      if (attempt < attempts) await sleep(1500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`成品下载失败（已重试 ${attempts} 次）：${downloadErrorDetail(lastError)}`);
}

function saveGeneration(userId, task) { task.updatedAt = now(); return saveGenerationRecord(userId, task); }
async function saveGenerationWithRetry(userId, task, phase = 'update') {
  let failures = 0;
  for (;;) {
    try { return await saveGeneration(userId, task); }
    catch (error) {
      failures++;
      console.error('[generation] critical state persistence retry', { generationId: task.id, phase, failures, message: error.message });
      await sleep(Math.min(500 * 2 ** Math.min(failures - 1, 6), generationRetryMaxDelayMs));
    }
  }
}
function saveDramaProject(userId, project) { project.updatedAt = now(); return saveDramaProjectRecord(userId, project); }
function publicDramaProject(project) { const { ownerId, ...value } = project; return value; }
function normalizeDramaProject(project) {
  const legacyMaxStep = !dramaStepOrder.includes(project.maxStep);
  project.schemaVersion = 5; project.workflowVersion = Number(project.workflowVersion) || 1; project.mode ||= 'smart';
  if (project.mode === 'professional' && project.workflowVersion < 2) project.workflowVersion = 2;
  project.step ||= project.storyboard ? 'storyboard' : 'script'; project.input ||= project.script || '';
  project.synopsis ||= project.analysis?.logline || '';
  project.settings = { shotCount:Math.max(1, Math.min(120, Number(project.settings?.shotCount) || project.storyboard?.shots?.length || 5)), totalDuration:Math.max(20, Math.min(3600, Number(project.settings?.totalDuration) || (project.storyboard?.shots?.length || 5) * 20)), shotDuration:dramaVideoDurations.has(Number(project.settings?.shotDuration)) ? Number(project.settings.shotDuration) : 20, aspectRatio:videoAspectRatios.has(project.settings?.aspectRatio) ? project.settings.aspectRatio : '9:16' };
  if (!Array.isArray(project.episodes)) project.episodes = [{ id:randomUUID(), number:1, title:'第 1 集', synopsis:project.synopsis, status:'draft' }];
  project.episodes = project.episodes.map((episode,index)=>({ id:episode.id || randomUUID(), number:index+1, title:String(episode.title || `第 ${index+1} 集`), synopsis:String(episode.synopsis || ''), status:String(episode.status || 'draft') }));
  if (!Array.isArray(project.scenes)) project.scenes = [];
  project.scenes = normalizeProductionScenes(project.scenes.map((scene,index)=>({ id:scene.id || randomUUID(), sceneNumber:index+1, heading:String(scene.heading || `场次 ${index+1}`), location:String(scene.location || ''), timeOfDay:String(scene.timeOfDay || '日'), dramaticFunction:String(scene.dramaticFunction || ''), geography:String(scene.geography || ''), lighting:String(scene.lighting || ''), continuityNotes:String(scene.continuityNotes || ''), beats:Array.isArray(scene.beats) ? scene.beats : [] })), project.settings);
  if (!Array.isArray(project.resources)) {
    const mapping = { characters:'character', locations:'location', props:'prop' };
    project.resources = Object.entries(mapping).flatMap(([key,type]) => (project.analysis?.assets?.[key] || []).map(item => ({ id:randomUUID(), type, name:typeof item === 'string' ? item : item.name, description:typeof item === 'string' ? '' : item.description || '', prompt:`${typeof item === 'string' ? item : item.name}，${typeof item === 'string' ? '' : item.description || ''}，真人短剧设定图，9:16`, versions:[], selectedTaskId:'' })));
  }
  project.resources = project.resources.map(item => ({ id:item.id || randomUUID(), type:['character','location','prop'].includes(item.type) ? item.type : 'prop', name:String(item.name || '未命名资源'), description:String(item.description || ''), prompt:String(item.prompt || ''), bible:{ identity:String(item.bible?.identity || item.description || ''), dramaticGoal:String(item.bible?.dramaticGoal || ''), appearance:String(item.bible?.appearance || ''), costume:String(item.bible?.costume || ''), canonicalViews:String(item.bible?.canonicalViews || ''), stateNotes:String(item.bible?.stateNotes || '') }, lifecycle:{ status:String(item.lifecycle?.status || (item.selectedTaskId ? 'approved' : 'draft')), revision:Math.max(1,Number(item.lifecycle?.revision)||1), approvedAt:String(item.lifecycle?.approvedAt || '') }, versions:Array.isArray(item.versions) ? item.versions : [], selectedTaskId:String(item.selectedTaskId || '') }));
  if (!Array.isArray(project.shots)) project.shots = (project.storyboard?.shots || []).map((shot,index) => ({ id:shot.id || randomUUID(), shotNumber:index + 1, title:shot.title, script:[shot.action, shot.dialogue].filter(Boolean).join('\n'), prompt:shot.videoPrompt, duration:shot.duration || 6, aspectRatio:'9:16', resourceIds:[], referenceAssetIds:[], videoVersions:shot.videoTaskId ? [shot.videoTaskId] : [], selectedVideoTaskId:shot.videoTaskId || '', tailFrameAssetId:'' }));
  const dramaPromptOverrides = project.shots.map(shot => String(shot?.promptOverride || '').slice(0, 4000));
  project.shots = project.shots.map((shot,index) => {
    const professionalAssets = {
      characters:[...new Set(Array.isArray(shot.professionalAssets?.characters) ? shot.professionalAssets.characters.map(String) : [])],
      locations:[...new Set(Array.isArray(shot.professionalAssets?.locations) ? shot.professionalAssets.locations.map(String) : [])],
    };
    const categorizedIds = [...professionalAssets.characters, ...professionalAssets.locations];
    const referenceAssetIds = [...new Set([...(Array.isArray(shot.referenceAssetIds) ? shot.referenceAssetIds.map(String) : []), ...categorizedIds])];
    const generationType = ['TEXT','FIRST&LAST','REFERENCE'].includes(shot.generation?.type) ? shot.generation.type : (referenceAssetIds.length ? 'REFERENCE' : 'TEXT');
    const professionalShot = project.mode === 'professional';
    const firstFrameAssetId = String(shot.generation?.firstFrameAssetId || (!professionalShot ? referenceAssetIds[0] : '') || '');
    const lastFrameAssetId = String(shot.generation?.lastFrameAssetId || '');
    const explicitReferences = Array.isArray(shot.generation?.referenceAssetIds) ? shot.generation.referenceAssetIds.map(String) : [];
    const generationReferenceAssetIds = generationType === 'TEXT'
      ? []
      : generationType === 'FIRST&LAST'
        ? [firstFrameAssetId, lastFrameAssetId].filter(Boolean).slice(0, 2)
        : (explicitReferences.length ? explicitReferences : referenceAssetIds).slice(0, 7);
    const pendingImageGenerations = professionalShot && Array.isArray(shot.pendingImageGenerations)
      ? shot.pendingImageGenerations.slice(0, 20).map(item => ({
          id:String(item.id || item.taskId || randomUUID()),
          taskId:String(item.taskId || ''),
          targetType:item.targetType === 'frame' ? 'frame' : 'category',
          kind:item.kind === 'locations' ? 'locations' : 'characters',
          frameField:item.frameField === 'lastFrameAssetId' ? 'lastFrameAssetId' : 'firstFrameAssetId',
          label:String(item.label || '图片').slice(0, 40),
          prompt:String(item.prompt || '').slice(0, 4000),
          size:imageSizes.has(item.size) ? item.size : '1:1',
          quality:['low','medium','high'].includes(item.quality) ? item.quality : 'medium',
          referenceAssetIds:Array.isArray(item.referenceAssetIds) ? item.referenceAssetIds.map(String).slice(0, 7) : [],
        }))
      : [];
    return { id:shot.id || randomUUID(), shotNumber:index + 1, sceneNumber:Math.max(1,Number(shot.sceneNumber)||Math.max(1,project.scenes.findIndex(scene=>scene.id===shot.sceneId)+1)), sceneId:String(shot.sceneId || project.scenes[Math.max(0,(Number(shot.sceneNumber)||1)-1)]?.id || project.scenes[0]?.id || ''), title:String(shot.title || `分镜 ${index + 1}`), sourceBeatIds:Array.isArray(shot.sourceBeatIds)?shot.sourceBeatIds.map(String):[], script:String(shot.script || ''), prompt:String(shot.prompt || shot.visualDirection || ''), visualDirection:String(shot.visualDirection || shot.prompt || ''), narrativeFunction:String(shot.narrativeFunction || ''), shotSize:String(shot.shotSize || '中景'), cameraMovement:String(shot.cameraMovement || '固定'), framing:String(shot.framing || ''), startStateId:String(shot.startStateId || ''), startState:String(shot.startState || ''), action:String(shot.action || shot.script || ''), endStateId:String(shot.endStateId || ''), endState:String(shot.endState || ''), continuityNotes:String(shot.continuityNotes || ''), sound:String(shot.sound || ''), negativePrompt:String(shot.negativePrompt || '禁止人物变脸、服装变化、道具消失、空间轴线跳变'), motionPlan:normalizeMotionPlan(shot.motionPlan), duration:dramaVideoDurations.has(Number(shot.duration)) ? Number(shot.duration) : project.settings.shotDuration, aspectRatio:videoAspectRatios.has(shot.aspectRatio) ? shot.aspectRatio : project.settings.aspectRatio, resourceIds:Array.isArray(shot.resourceIds) ? shot.resourceIds : [], referenceAssetIds, professionalAssets, pendingImageGenerations, generation:{ type:generationType, modelId:String(shot.generation?.modelId || ''), firstFrameAssetId, lastFrameAssetId, referenceAssetIds:generationReferenceAssetIds, quality:['480p','720p','768p','1080p','4k'].includes(shot.generation?.quality) ? shot.generation.quality : '720p' }, lifecycle:{ status:String(shot.lifecycle?.status || (shot.selectedVideoTaskId ? 'generated' : 'draft')), revision:Math.max(1,Number(shot.lifecycle?.revision)||1), staleReasons:Array.isArray(shot.lifecycle?.staleReasons) ? shot.lifecycle.staleReasons.map(String) : [] }, videoVersions:Array.isArray(shot.videoVersions) ? shot.videoVersions : [], selectedVideoTaskId:String(shot.selectedVideoTaskId || ''), tailFrameAssetId:String(shot.tailFrameAssetId || '') };
  });
  project.shots.forEach((shot,index) => { shot.promptOverride = dramaPromptOverrides[index] || ''; });
  project.productionQuality = productionQualitySummary({scenes:project.scenes,shots:project.shots}, project.settings);
  let inferredStep = dramaStepOrder.includes(project.step) ? project.step : 'script';
  if (project.resources.some(item => item.selectedTaskId || item.lifecycle.revision > 1)) inferredStep = dramaStepOrder[Math.max(dramaStepOrder.indexOf(inferredStep), 1)];
  if (project.shots.some(shot => shot.selectedVideoTaskId || shot.videoVersions.length)) inferredStep = 'video';
  else if (project.shots.some(shot => shot.lifecycle.status === 'reviewed' || shot.lifecycle.revision > 1 || shot.referenceAssetIds.length)) inferredStep = dramaStepOrder[Math.max(dramaStepOrder.indexOf(inferredStep), 2)];
  project.maxStep = legacyMaxStep ? inferredStep : dramaStepOrder[Math.max(dramaStepOrder.indexOf(project.maxStep), dramaStepOrder.indexOf(inferredStep))];
  if (legacyMaxStep && dramaStepOrder.indexOf(project.step) < dramaStepOrder.indexOf(project.maxStep)) project.step = project.maxStep;
  return project;
}
async function loadDramaProject(userId, id) { const project = findDramaProject(userId, id); return project ? normalizeDramaProject(project) : null; }
async function saveAsset(userId, asset) { asset.updatedAt = now(); saveAssetRecord(userId, asset); return asset; }
async function deleteAssetRecord(userId, asset) { if (!asset) return; if (asset.ossKey && oss) await oss.delete(asset.ossKey); deleteAsset(userId, asset.id); await fs.unlink(path.join(assetFilesDir(userId), asset.storageName)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
function publicAsset(asset) {
  const { ownerId, storageName, sourceUrl, sourceGenerationId, ossKey, ossUploadedAt, ...value } = asset;
  return { ...value, url: `/api/files/${asset.id}/content` };
}
function ossObjectKey(userId, storageName) { const extension = path.extname(storageName).toLowerCase().replace(/[^a-z0-9.]/g, ''); const base = safeId(path.basename(storageName, path.extname(storageName))); return [ossPrefix, safeId(userId), `${base}${extension}`].filter(Boolean).join('/'); }
async function withMediaTempDir(label, callback) {
  const jobDir = path.join(mediaTmpDir, `${safeId(label) || 'job'}-${randomUUID()}`);
  await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
  try { return await callback(jobDir); }
  finally { await fs.rm(jobDir, { recursive: true, force: true }).catch(error => console.error(`[media] 临时目录清理失败 ${jobDir}`, error.message)); }
}
async function uploadAssetFileToOss(userId, asset, sourceFile) {
  if (!oss) throw Object.assign(new Error('文件存储服务尚未配置'), { statusCode: 503 });
  const key = asset.ossKey || ossObjectKey(userId, asset.storageName);
  await oss.put(key, sourceFile, { headers: { 'Content-Type': asset.mimeType } });
  asset.ossKey = key; asset.ossUploadedAt = now();
  await saveAsset(userId, asset);
  return key;
}
function uploadExtension(mimeType, name = '') {
  const requested = path.extname(String(name)).toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (requested && requested.length <= 10) return requested;
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.weba', 'audio/flac': '.flac' }[mimeType] || '');
}
function pendingUploadKey(userId, uploadId, mimeType, name) { return [ossPrefix, 'pending', safeId(userId), `${safeId(uploadId)}${uploadExtension(mimeType, name)}`].filter(Boolean).join('/'); }
function finalUploadKey(userId, assetId, mimeType, name) { return [ossPrefix, 'assets', safeId(userId), `${safeId(assetId)}${uploadExtension(mimeType, name)}`].filter(Boolean).join('/'); }
function ossUploadUrl() { return oss ? `${oss.generateObjectUrl('').replace(/\/+$/, '')}/` : ''; }
function uploadInitRateAllowed(userId, timestamp = Date.now()) {
  const key = String(userId);
  const current = uploadInitAttempts.get(key);
  if (!current || timestamp - current.startedAt >= 60_000) {
    uploadInitAttempts.set(key, { startedAt: timestamp, count: 1 });
    return true;
  }
  if (current.count >= uploadInitLimitPerMinute) return false;
  current.count += 1;
  return true;
}
function uploadSizeLimit(mimeType) { return imageTypes.has(mimeType) ? maxReferenceImageBytes : maxUploadBytes; }
function uploadKind(mimeType) { return imageTypes.has(mimeType) ? 'image' : videoTypes.has(mimeType) ? 'video' : 'audio'; }
function normalizeUploadMime(mimeType, name = '') {
  const declared = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (declared === 'image/jpg' || declared === 'image/pjpeg') return 'image/jpeg';
  if (declared === 'audio/x-m4a' || declared === 'audio/m4a') return 'audio/mp4';
  if ([...imageTypes, ...videoTypes, ...audioTypes].includes(declared)) return declared;
  const extension = path.extname(String(name || '')).toLowerCase();
  return uploadMimeByExtension[extension] || declared;
}
function buildUploadPostPolicy({ key, mimeType, sizeLimit, expiresAt }) {
  return {
    expiration: expiresAt,
    conditions: [
      { bucket: process.env.ALIYUN_OSS_BUCKET },
      ['eq', '$key', key],
      ['eq', '$Content-Type', mimeType],
      ['content-length-range', 1, sizeLimit],
      ['eq', '$success_action_status', '200'],
      ['eq', '$x-oss-forbid-overwrite', 'true'],
    ],
  };
}
function uploadPolicyFields(policy) {
  if (!oss) return {};
  const signed = oss.calculatePostSignature(policy);
  return {
    ...signed,
    key: policy.conditions.find(item => Array.isArray(item) && item[1] === '$key')?.[2],
    'Content-Type': policy.conditions.find(item => Array.isArray(item) && item[1] === '$Content-Type')?.[2],
    success_action_status: '200',
    'x-oss-forbid-overwrite': 'true',
  };
}
function objectHeaders(result) {
  const headers = result?.res?.headers || {};
  const get = (...names) => names.map(name => headers[name] ?? headers[name.toLowerCase()]).find(value => value !== undefined && value !== null);
  return {
    size: Number(get('content-length') || 0),
    mimeType: String(get('content-type') || '').split(';')[0].toLowerCase(),
    etag: String(get('etag') || '').replace(/^"|"$/g, ''),
  };
}
function combinedOssObjectMetadata(metaResult, headResult) {
  const sizeMeta = objectHeaders(metaResult);
  const headerMeta = objectHeaders(headResult);
  return {
    size: sizeMeta.size,
    mimeType: headerMeta.mimeType || sizeMeta.mimeType,
    etag: sizeMeta.etag || headerMeta.etag,
    status: metaResult?.status || headResult?.status,
  };
}
async function headOssObject(key) {
  if (!oss) throw Object.assign(new Error('文件存储服务尚未配置'), { statusCode: 503 });
  // getObjectMeta returns an accurate object size, but OSS does not include
  // the standard Content-Type header in that response. HeadObject does.
  const [metaResult, headResult] = await Promise.all([oss.getObjectMeta(key), oss.head(key)]);
  return combinedOssObjectMetadata(metaResult, headResult);
}
async function readOssPrefix(key) {
  if (!oss) throw Object.assign(new Error('文件存储服务尚未配置'), { statusCode: 503 });
  const result = await oss.get(key, { headers: { Range: 'bytes=0-63' } });
  return Buffer.from(result.content || '');
}
function magicMatches(mimeType, content) {
  const bytes = Buffer.from(content || '');
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  if (mimeType === 'audio/ogg') return bytes.subarray(0, 4).toString('ascii') === 'OggS';
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') return bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (mimeType === 'audio/aac') return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (mimeType === 'audio/mp4') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'audio/webm') return bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  if (mimeType === 'audio/flac') return bytes.subarray(0, 4).toString('ascii') === 'fLaC';
  return false;
}
async function verifyUploadedObject(intent) {
  let meta;
  try { meta = await headOssObject(intent.temporaryOssKey); } catch (error) {
    throw Object.assign(new Error('上传对象不存在或暂时不可读取'), { statusCode: 422, code: 'UPLOAD_OBJECT_MISSING', cause: error });
  }
  if (meta.size !== Number(intent.expectedSize)) throw Object.assign(new Error('上传文件大小校验失败'), { statusCode: 422, code: 'UPLOAD_SIZE_MISMATCH', actualSize: meta.size, objectEtag: meta.etag });
  if (normalizeUploadMime(meta.mimeType) !== String(intent.mimeType).toLowerCase()) throw Object.assign(new Error('上传文件类型校验失败'), { statusCode: 422, code: 'UPLOAD_MIME_MISMATCH', actualSize: meta.size, objectEtag: meta.etag });
  const prefix = await readOssPrefix(intent.temporaryOssKey);
  if (!magicMatches(intent.mimeType, prefix)) throw Object.assign(new Error('文件内容与声明类型不一致'), { statusCode: 422, code: 'UPLOAD_MAGIC_MISMATCH', actualSize: meta.size, objectEtag: meta.etag });
  return meta;
}
async function promoteUploadedObject(intent) {
  if (!oss) throw Object.assign(new Error('文件存储服务尚未配置'), { statusCode: 503 });
  try {
    const existing = await headOssObject(intent.finalOssKey);
    if (existing.size === Number(intent.expectedSize) && existing.mimeType === String(intent.mimeType).toLowerCase()) return existing;
    throw Object.assign(new Error('正式对象已存在但内容不匹配'), { statusCode: 409, code: 'UPLOAD_FINAL_CONFLICT' });
  } catch (error) {
    if (error.code === 'UPLOAD_FINAL_CONFLICT') throw error;
    // A missing final object is the normal first-promotion path. Other OSS
    // errors must still surface instead of being mistaken for a 404.
    const status = error?.status || error?.statusCode || error?.res?.status;
    const code = String(error?.code || '');
    if (status && status !== 404 && !/NoSuchKey|NotFound|NoSuchObject/i.test(code)) throw error;
  }
  await oss.copy(intent.finalOssKey, intent.temporaryOssKey, { headers: { 'Content-Type': intent.mimeType, 'x-oss-forbid-overwrite': 'true' } });
  return headOssObject(intent.finalOssKey);
}
async function uploadAssetToOss(userId, asset) {
  if (!oss) throw Object.assign(new Error('文件存储服务尚未配置'), { statusCode: 503 });
  const key = asset.ossKey || ossObjectKey(userId, asset.storageName);
  await oss.put(key, path.join(assetFilesDir(userId), asset.storageName), { headers: { 'Content-Type': asset.mimeType } });
  asset.ossKey = key; asset.ossUploadedAt = now();
  await saveAsset(userId, asset);
  return key;
}
function publicOssUrl(key) { return oss.generateObjectUrl(key); }
async function signedOssUrl(key, expires = ossAssetUrlExpiresSeconds) { return oss.signatureUrl(key, { expires, method: 'GET' }); }
async function ensureLocalAsset(userId, asset, targetDir = assetFilesDir(userId)) {
  const permanentFile = path.join(assetFilesDir(userId), asset.storageName);
  if (await fs.access(permanentFile).then(() => true).catch(() => false)) return permanentFile;
  if (!oss || !asset.ossKey) throw Object.assign(new Error('文件本地缓存缺失，且没有可用的 OSS 归档'), { statusCode: 503 });

  const localFile = path.join(targetDir, asset.storageName);
  const restoreKey = `${safeId(userId)}:${asset.id}:${targetDir}`;
  if (assetRestores.has(restoreKey)) return assetRestores.get(restoreKey);
  const restore = (async () => {
    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
    if (await fs.access(localFile).then(() => true).catch(() => false)) return localFile;
    const url = await signedOssUrl(asset.ossKey);
    await downloadToFile(url, localFile, 4);
    return localFile;
  })().finally(() => assetRestores.delete(restoreKey));
  assetRestores.set(restoreKey, restore);
  return restore;
}
async function resolveRefs(userId, ids, task = {}) {
  const mixed = task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_2 || task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_2_FAST || task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3 || task.provider === 'autodl';
  const refs = mixed ? { images: [], videos: [], audios: [] } : [];
  for (const id of ids.slice(0, task.referenceLimits?.total || 15)) {
    const asset = findAsset(userId, id);
    if (!asset || !['image', 'video', 'audio'].includes(asset.kind)) continue;
    if (!mixed && asset.kind !== 'image') continue;
    const key = asset.ossKey || await uploadAssetToOss(userId, asset);
    const url = task.provider === 'cntcn' || task.provider === 'autodl' ? publicOssUrl(key) : await signedOssUrl(key);
    if (mixed) refs[`${asset.kind}s`].push(url);
    else refs.push(url);
  }
  return refs;
}
async function validateReferenceAssets(userId, value, limits = null) {
  if (value !== undefined && !Array.isArray(value)) throw Object.assign(new Error('参考素材 referenceAssetIds 必须使用数组格式'), { statusCode: 400 });
  const ids = [...new Set((value || []).map(safeId).filter(Boolean))];
  const referenceLimits = limits || { image: 7, video: 0, audio: 0, total: 7 };
  if (ids.length > referenceLimits.total) throw Object.assign(new Error(`参考素材最多支持 ${referenceLimits.total} 个（图片 ${referenceLimits.image} / 视频 ${referenceLimits.video} / 音频 ${referenceLimits.audio}）`), { statusCode: 400 });
  const counts = { image: 0, video: 0, audio: 0 };
  for (const id of ids) {
    const asset = findAsset(userId, id);
    if (!asset || !Object.hasOwn(counts, asset.kind)) throw Object.assign(new Error('参考素材不存在或类型不受当前模型支持'), { statusCode: 400 });
    counts[asset.kind]++;
    if (counts[asset.kind] > Number(referenceLimits[asset.kind] || 0)) throw Object.assign(new Error(`参考${asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : '音频'}最多支持 ${referenceLimits[asset.kind]} 个`), { statusCode: 400 });
    if (asset.kind === 'image' && Number(asset.size) > maxReferenceImageBytes) throw Object.assign(new Error(`参考图“${asset.name}”超过 8 MB`), { statusCode: 400 });
    if (asset.kind !== 'image' && Number(asset.size) > maxUploadBytes) throw Object.assign(new Error(`参考素材“${asset.name}”超过 25 MB`), { statusCode: 400 });
  }
  return ids;
}
async function archiveGenerationResult(userId, task, resultUrl) {
  const assetId = task.assetId || `generation-${task.id}`;
  const existing = findAsset(userId, assetId);
  if (existing?.sourceGenerationId === task.id) {
    task.assetId = assetId;
    task.status = 'completed';
    task.error = '';
    return;
  }
  return withMediaTempDir(`generation-${task.id}`, async jobDir => {
    const extension = task.type === 'image' ? '.png' : '.mp4';
    const storageName = `${assetId}${extension}`;
    const localFile = path.join(jobDir, storageName);
    const contentUrl = task.provider === 'oai' ? `${oaiBase}/videos/${encodeURIComponent(task.providerTaskId)}/content` : '';
    const downloadHeaders = resultUrl === contentUrl ? { Authorization: `Bearer ${oaiKeyForTask(task)}` } : {};
    const saved = await downloadToFile(resultUrl, localFile, 4, { headers: downloadHeaders });
    const asset = { id: assetId, ownerId: userId, name: `${task.type === 'image' ? '生成图片' : '生成视频'} ${new Date().toLocaleString('zh-CN')}${extension}`, kind: task.type, mimeType: saved.contentType, size: saved.size, storageName, source: 'generation', sourceGenerationId: task.id, sourceUrl: resultUrl, createdAt: now(), updatedAt: now() };
    await uploadAssetFileToOss(userId, asset, localFile);
    task.assetId = assetId;
    task.status = 'completed';
    task.error = '';
  });
}
async function archiveLocalAsset(userId, sourceFile, { name, kind, mimeType, source, projectId }) {
  const id = randomUUID(); const extension = path.extname(sourceFile); const storageName = `${id}${extension}`; const stat = await fs.stat(sourceFile);
  const asset = { id, ownerId:userId, name, kind, mimeType, size:stat.size, storageName, source, projectId, sourceGenerationId:'', sourceUrl:'', createdAt:now(), updatedAt:now() };
  try { await uploadAssetFileToOss(userId, asset, sourceFile); } finally { await fs.unlink(sourceFile).catch(() => {}); }
  return asset;
}
async function extractVideoTailFrame(userId, project, shot) {
  const task = findGeneration(userId, shot.selectedVideoTaskId); const video = task?.assetId ? findAsset(userId, task.assetId) : null;
  if (!video || video.kind !== 'video') throw Object.assign(new Error('请先选择一个已完成的分镜视频'), { statusCode:400 });
  return withMediaTempDir(`tail-${shot.id}`, async jobDir => {
    const source = await ensureLocalAsset(userId, video, jobDir); const temp = path.join(jobDir, 'tail.jpg');
    await execFile('ffmpeg', ['-y','-sseof','-0.08','-i',source,'-frames:v','1','-q:v','2',temp], { timeout:120_000 });
    const asset = await archiveLocalAsset(userId, temp, { name:`${project.title} · 分镜 ${shot.shotNumber} 尾帧.jpg`, kind:'image', mimeType:'image/jpeg', source:'drama_tail_frame', projectId:project.id });
    shot.tailFrameAssetId = asset.id; await saveDramaProject(userId, project); return asset;
  });
}
async function assembleDramaProject(userId, project) {
  if (!project.shots.length) throw Object.assign(new Error('项目还没有分镜'), { statusCode:400 });
  if (project.mode === 'professional' && project.shots.length < 2) throw Object.assign(new Error('专业编辑项目至少需要 2 个分镜才能合成'), { statusCode:400 });
  return withMediaTempDir(`assemble-${project.id}`, async jobDir => {
    const sources = [];
    for (const shot of project.shots) { const task = findGeneration(userId, shot.selectedVideoTaskId); const asset = task?.assetId ? findAsset(userId, task.assetId) : null; if (!asset || asset.kind !== 'video') throw Object.assign(new Error(`分镜 ${shot.shotNumber} 还没有选择完成的视频`), { statusCode:400 }); sources.push(await ensureLocalAsset(userId, asset, jobDir)); }
    const concatFile = path.join(jobDir, 'concat.txt'); const temp = path.join(jobDir, 'final.mp4');
    await fs.writeFile(concatFile, sources.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'));
    await execFile('ffmpeg', ['-y','-f','concat','-safe','0','-i',concatFile,'-c:v','libx264','-preset','medium','-crf','20','-c:a','aac','-movflags','+faststart',temp], { timeout:900_000, maxBuffer:10_000_000 });
    const asset = await archiveLocalAsset(userId, temp, { name:`${project.title} · 完整成片.mp4`, kind:'video', mimeType:'video/mp4', source:'drama_final', projectId:project.id });
    project.finalAssetId = asset.id; project.step = 'video'; project.status = 'completed'; await saveDramaProject(userId, project); return asset;
  });
}
function ttapiPersistenceHooks(userId, task) {
  return {
    onSubmitted: async ({ provider, taskId }) => {
      task.provider = provider;
      task.providerTaskId = taskId;
      task.submittedAt ||= now();
      task.submissionUncertain = false;
      task.error = '';
      task.lastPollError = '';
      task.lastPollErrorAt = null;
      task.pollFailureCount = 0;
      await saveGenerationWithRetry(userId, task, 'ttapi-submitted');
    },
    onPollError: async ({ consecutiveErrors, detail }) => {
      task.status = 'running';
      task.lastPollError = detail;
      task.lastPollErrorAt = now();
      task.pollFailureCount = consecutiveErrors;
      await saveGeneration(userId, task);
    },
    onPollRecovered: async () => {
      task.lastPollError = '';
      task.lastPollErrorAt = null;
      task.pollFailureCount = 0;
      await saveGeneration(userId, task);
    },
  };
}
function cntcnPersistenceHooks(userId, task) {
  return {
    onSubmitted: async ({ provider, taskId }) => {
      task.provider = provider;
      task.providerTaskId = taskId;
      task.submittedAt ||= now();
      task.submissionUncertain = false;
      task.error = '';
      task.lastPollError = '';
      task.lastPollErrorAt = null;
      task.pollFailureCount = 0;
      await saveGenerationWithRetry(userId, task, 'cntcn-submitted');
    },
    onPollError: async ({ consecutiveErrors, detail }) => {
      task.status = 'running';
      task.lastPollError = detail;
      task.lastPollErrorAt = now();
      task.pollFailureCount = consecutiveErrors;
      await saveGeneration(userId, task);
    },
    onPollRecovered: async () => {
      task.lastPollError = '';
      task.lastPollErrorAt = null;
      task.pollFailureCount = 0;
      await saveGeneration(userId, task);
    },
  };
}
function autodlPersistenceHooks(userId, task) {
  return {
    onSubmitted: async ({ provider, taskId }) => {
      task.provider = provider;
      task.providerTaskId = taskId;
      task.submittedAt ||= now();
      task.submissionUncertain = false;
      task.error = '';
      task.lastPollError = '';
      task.lastPollErrorAt = null;
      task.pollFailureCount = 0;
      await saveGenerationWithRetry(userId, task, 'autodl-submitted');
    },
    onPollError: async ({ consecutiveErrors, detail }) => {
      task.status = 'running';
      task.lastPollError = detail;
      task.lastPollErrorAt = now();
      task.pollFailureCount = consecutiveErrors;
      await saveGeneration(userId, task);
    },
    onPollRecovered: async () => {
      task.lastPollError = '';
      task.lastPollErrorAt = null;
      task.pollFailureCount = 0;
      await saveGeneration(userId, task);
    },
  };
}
function scheduleGenerationArchive(userId, task) {
  if (generationRetryTimers.has(task.id)) return;
  const timer = setTimeout(() => {
    generationRetryTimers.delete(task.id);
    const current = findGeneration(userId, task.id);
    if (current?.status === 'running' && current.sourceUrl && !current.assetId) {
      resumeGenerationArchive(userId, current);
    }
  }, archiveRescheduleMs);
  timer.unref();
  generationRetryTimers.set(task.id, timer);
}
async function archiveGenerationWithRetry(userId, task) {
  let failures = Number(task.archiveFailureCount) || 0;
  for (let attempt = 1; attempt <= archiveAttemptsPerRun; attempt++) {
    try {
      await archiveGenerationResult(userId, task, task.sourceUrl);
      task.archiveFailureCount = 0;
      task.archivePending = false;
      task.lastArchiveError = '';
      task.lastArchiveErrorAt = null;
      return true;
    } catch (error) {
      failures++;
      task.status = 'running';
      task.archiveFailureCount = failures;
      task.lastArchiveError = error.message;
      task.lastArchiveErrorAt = now();
      await saveGeneration(userId, task);
      console.error('[generation] archive retry scheduled', { generationId: task.id, failures, message: error.message });
      if (attempt < archiveAttemptsPerRun) {
        await sleep(Math.min(2_000 * 2 ** Math.min(attempt - 1, 5), generationRetryMaxDelayMs));
      }
    }
  }
  task.archivePending = true;
  await saveGenerationWithRetry(userId, task, 'archive-deferred');
  scheduleGenerationArchive(userId, task);
  return false;
}
async function completeGenerationResult(userId, task, result) {
  task.provider = result.provider || task.provider;
  task.providerTaskId = result.taskId || task.providerTaskId;
  task.sourceUrl = result.url;
  task.status = 'running';
  task.error = '';
  await saveGenerationWithRetry(userId, task, 'provider-result');
  const archived = await archiveGenerationWithRetry(userId, task);
  task.creditStatus = 'charged';
  return archived;
}
async function failGeneration(userId, task, error) {
  task.status = 'failed';
  task.error = error.message;
  try {
    await refundGenerationMicro(userId, task.id, task.creditCostMicro ?? creditsToMicro(task.creditCost));
    task.creditStatus = 'refunded';
  } catch (refundError) {
    task.creditStatus = 'refund_failed';
    task.error += `；自动退款失败：${refundError.message}`;
  }
}
function startGeneration(userId, task) {
  const promise = (async () => {
    try {
      task.status = 'running';
      task.finishedAt = null;
      await saveGenerationWithRetry(userId, task, 'generation-running');
      const refs = await resolveRefs(userId, task.referenceAssetIds, task);
      const hooks = task.provider === 'ttapi'
        ? ttapiPersistenceHooks(userId, task)
        : task.provider === 'cntcn'
          ? cntcnPersistenceHooks(userId, task)
          : task.provider === 'autodl'
            ? autodlPersistenceHooks(userId, task)
            : {};
      const result = task.type === 'image' ? await createImage(task, refs) : await createVideo(task, refs, hooks);
      if (!result.url) throw new Error('模型任务完成，但没有返回结果地址');
      await completeGenerationResult(userId, task, result);
    } catch (error) {
      if (error.submissionUncertain) {
        task.status = 'running';
        task.submissionUncertain = true;
        task.error = error.message;
        task.creditStatus = 'charged';
        console.error('[video] async provider submission outcome is uncertain; no refund issued', { generationId: task.id, provider: task.provider, message: error.message });
      } else if (['ttapi', 'cntcn', 'autodl'].includes(task.provider) && task.providerTaskId && !error.upstreamTerminal) {
        task.status = 'running';
        task.error = `任务处理暂时中断，将由持久化任务恢复：${error.message}`;
        task.creditStatus = 'charged';
        console.error('[video] async provider task paused without refund', { generationId: task.id, provider: task.provider, providerTaskId: task.providerTaskId, message: error.message });
      } else {
        await failGeneration(userId, task, error);
      }
    } finally {
      task.finishedAt = ['completed', 'failed'].includes(task.status) ? now() : null;
      try { await saveGenerationWithRetry(userId, task, 'generation-final'); }
      finally { activeGenerations.delete(task.id); }
    }
  })();
  activeGenerations.set(task.id, promise);
  return promise;
}
function resumeTtapiGeneration(userId, task) {
  if (activeGenerations.has(task.id)) return activeGenerations.get(task.id);
  const promise = (async () => {
    try {
      task.status = 'running';
      task.finishedAt = null;
      task.error = '';
      await saveGeneration(userId, task);
      const result = await pollTtapiVideo(task.providerTaskId, ttapiPersistenceHooks(userId, task));
      await completeGenerationResult(userId, task, result);
    } catch (error) {
      if (error.upstreamTerminal) {
        await failGeneration(userId, task, error);
      } else {
        task.status = 'running';
        task.error = `任务恢复暂时中断，将在服务重启后继续：${error.message}`;
        task.creditStatus = 'charged';
        console.error('[video] TTAPI recovery paused without refund', { generationId: task.id, message: error.message });
      }
    } finally {
      task.finishedAt = ['completed', 'failed'].includes(task.status) ? now() : null;
      try { await saveGenerationWithRetry(userId, task, 'ttapi-recovery-final'); }
      finally { activeGenerations.delete(task.id); }
    }
  })();
  activeGenerations.set(task.id, promise);
  return promise;
}
function resumeCntcnGeneration(userId, task) {
  if (activeGenerations.has(task.id)) return activeGenerations.get(task.id);
  const promise = (async () => {
    try {
      task.status = 'running';
      task.finishedAt = null;
      task.error = '';
      await saveGeneration(userId, task);
      const result = await pollCntcnVideo(task.providerTaskId, cntcnPersistenceHooks(userId, task));
      await completeGenerationResult(userId, task, result);
    } catch (error) {
      if (error.upstreamTerminal) await failGeneration(userId, task, error);
      else {
        task.status = 'running';
        task.error = `任务恢复暂时中断，将在服务重启后继续：${error.message}`;
        task.creditStatus = 'charged';
        console.error('[video] CNTCN recovery paused without refund', { generationId: task.id, message: error.message });
      }
    } finally {
      task.finishedAt = ['completed', 'failed'].includes(task.status) ? now() : null;
      try { await saveGenerationWithRetry(userId, task, 'cntcn-recovery-final'); }
      finally { activeGenerations.delete(task.id); }
    }
  })();
  activeGenerations.set(task.id, promise);
  return promise;
}
function resumeAutodlGeneration(userId, task) {
  if (activeGenerations.has(task.id)) return activeGenerations.get(task.id);
  const promise = (async () => {
    try {
      task.status = 'running';
      task.finishedAt = null;
      task.error = '';
      await saveGeneration(userId, task);
      const result = await pollAutodlVideo(task.providerTaskId, autodlPersistenceHooks(userId, task));
      await completeGenerationResult(userId, task, result);
    } catch (error) {
      if (error.upstreamTerminal) await failGeneration(userId, task, error);
      else {
        task.status = 'running';
        task.error = `任务恢复暂时中断，将在服务重启后继续：${error.message}`;
        task.creditStatus = 'charged';
        console.error('[video] AutoDL recovery paused without refund', { generationId: task.id, message: error.message });
      }
    } finally {
      task.finishedAt = ['completed', 'failed'].includes(task.status) ? now() : null;
      try { await saveGenerationWithRetry(userId, task, 'autodl-recovery-final'); }
      finally { activeGenerations.delete(task.id); }
    }
  })();
  activeGenerations.set(task.id, promise);
  return promise;
}
function resumeGenerationArchive(userId, task) {
  if (activeGenerations.has(task.id)) return activeGenerations.get(task.id);
  const promise = (async () => {
    try {
      task.status = 'running';
      task.finishedAt = null;
      await saveGenerationWithRetry(userId, task, 'generation-running');
      await archiveGenerationWithRetry(userId, task);
      task.creditStatus = 'charged';
    } finally {
      task.finishedAt = task.status === 'completed' ? now() : null;
      try { await saveGenerationWithRetry(userId, task, 'archive-recovery-final'); }
      finally { activeGenerations.delete(task.id); }
    }
  })();
  activeGenerations.set(task.id, promise);
  return promise;
}

/** Resume durable generation work after a process restart without depending on any browser session. */
async function recoverPendingGenerations() {
  const startedAt = Date.now();
  const pending = listPendingGenerations();
  let polling = 0;
  let archiving = 0;
  let refunded = 0;
  let awaitingReconciliation = 0;

  for (const { userId, task } of pending) {
    if (task.providerTaskId && task.sourceUrl && !task.assetId) {
      resumeGenerationArchive(userId, task);
      archiving++;
    } else if (task.provider === 'ttapi' && task.providerTaskId) {
      resumeTtapiGeneration(userId, task);
      polling++;
    } else if (task.provider === 'cntcn' && task.providerTaskId) {
      resumeCntcnGeneration(userId, task);
      polling++;
    } else if (task.provider === 'autodl' && task.providerTaskId) {
      resumeAutodlGeneration(userId, task);
      polling++;
    } else if (task.submissionUncertain || (['ttapi', 'cntcn', 'autodl'].includes(task.provider) && !task.providerTaskId)) {
      task.status = 'running';
      task.finishedAt = null;
      task.creditStatus = 'charged';
      task.submissionUncertain = true;
      task.error ||= '服务中断时未能确认上游任务 ID，任务保留待核对且不会自动退款';
      saveGeneration(userId, task);
      awaitingReconciliation++;
    } else {
      await failGeneration(userId, task, new Error(task.error || '服务重启时任务尚未提交到模型服务'));
      task.finishedAt = now();
      saveGeneration(userId, task);
      refunded++;
    }
  }

  if (pending.length) {
    console.log(`[recovery] 待恢复 ${pending.length} 恢复轮询 ${polling} 恢复归档 ${archiving} 待核对 ${awaitingReconciliation} 退款 ${refunded} 耗时 ${Date.now() - startedAt}ms`);
  }
}

async function streamUpload(req, target, limit = maxUploadBytes, digest = null) { const handle = await fs.open(target, 'w'); let size = 0; try { for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error(limit === maxReferenceImageBytes ? '单张图片不能超过 8 MB' : '文件不能超过 25 MB'), { statusCode: 413 }); digest?.update(chunk); await handle.write(chunk); } } catch (error) { await handle.close(); await fs.unlink(target).catch(() => {}); throw error; } await handle.close(); return digest ? { size, sha256: digest.digest('hex') } : size; }
async function serveFile(res, file, mimeType, downloadName = '', cacheControl = 'private, max-age=3600') { const stat = await fs.stat(file); const headers = { 'Content-Type': mimeType, 'Content-Length': stat.size, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' }; if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`; res.writeHead(200, headers); createReadStream(file).pipe(res); }
const frontendRoutePaths = new Set(['/login', '/image', '/video', '/drama', '/files']);

async function serveStatic(res, pathname) { const relative = pathname === '/guguadmin' || pathname === '/guguadmin/' ? 'guguadmin.html' : pathname === '/' || frontendRoutePaths.has(pathname) ? 'index.html' : pathname.slice(1); const file = path.resolve(publicDir, relative); if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, 'index.html')) return sendJson(res, 403, { error: '禁止访问' }); const ext = path.extname(file); const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'; const cacheControl = ['.js', '.css', '.svg', '.woff', '.woff2'].includes(ext) ? 'public, max-age=604800, immutable' : 'no-cache'; try { await serveFile(res, file, mime, '', cacheControl); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return sendJson(res, 404, { error: '静态文件不存在' }); throw error; } }

export const __test = { hashPassword, verifyPassword, parseCookies, tokenHash, charLength, normalizeInviteCode, isKnownInviteCode, generationCost, errorMessage, downloadErrorDetail, ossObjectKey, pendingUploadKey, finalUploadKey, buildUploadPostPolicy, normalizeUploadMime, combinedOssObjectMetadata, magicMatches, imageSizes, videoAspectRatios, videoDurations, fixedModels, normalizeDramaProject, buildOaiVideoPayload, buildAutodlPayload, autodlRetryableResponseError, pollAutodlVideo, createAutodlVideo, generationFailureCode, publicGeneration };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/healthz' && req.method === 'GET') return sendJson(res, 200, { status: 'ok' });
    if (url.pathname === '/readyz' && req.method === 'GET') {
      try {
        sql('SELECT 1 AS ready').get();
        return sendJson(res, 200, { status: 'ready' });
      } catch {
        return sendJson(res, 503, { status: 'not_ready' });
      }
    }
    if (!mutationAllowed(req)) return sendJson(res, 403, { error: '请求来源不允许' });
    if (url.pathname.startsWith('/api/admin/')) return await handleAdminRequest(req, res);
    if (url.pathname === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); return res.end(); }

    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      const input = await bodyJson(req); const username = String(input.username || '').trim().toLowerCase(); const password = String(input.password || ''); const inviteCode = normalizeInviteCode(input.inviteCode);
      if (!/^[a-z0-9_]{3,24}$/.test(username)) return sendJson(res, 400, { error: '账号需为 3–24 位字母、数字或下划线' });
      if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: '密码长度需为 8–128 位' });
      if (!inviteCode) return sendJson(res, 400, { error: '请输入邀请码' });
      // Password hashing is deliberately outside the transaction: scrypt takes
      // tens of milliseconds and must not be held across a write lock.
      const passwordHash = await hashPassword(password);
      const user = { id: randomUUID(), username, role: 'user', status: 'active', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, passwordHash, inviteCode, createdAt: now(), updatedAt: now() };
      // The invite code is burnt in the same transaction that creates the user,
      // so concurrent registrations on one code cannot both win.
      const result = registerUser({ user, inviteCode, grantBonus: grantSignupBonus });
      if (result.error) return sendJson(res, result.status, { error: result.error });
      await ensureUserDirs(result.user.id);
      const token = createSession(result.user.id); setSessionCookie(res, token); return sendJson(res, 201, { user: publicUser(result.user) });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const input = await bodyJson(req);
      const username = String(input.username || '').trim().toLowerCase();
      if (loginLimiter.isBlocked(req, username)) return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
      const user = findUserByUsername(username);
      const valid = user && user.status === 'active' ? await verifyPassword(String(input.password || ''), user.passwordHash) : false;
      if (!valid) {
        loginLimiter.recordFailure(req, username);
        return sendJson(res, 401, { error: '账号或密码不正确' });
      }
      loginLimiter.reset(req, username);
      await ensureUserDirs(user.id);
      const token = createSession(user.id);
      setSessionCookie(res, token);
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const token = parseCookies(req.headers.cookie).studio_session; if (token) deleteSession(tokenHash(token)); clearSessionCookie(res); return sendJson(res, 200, { ok: true }); }
    if (url.pathname === '/api/auth/me' && req.method === 'GET') { const user = currentUser(req); return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: '未登录' }); }
    if (url.pathname === '/api/config' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; return sendJson(res, 200, configState()); }
    if (url.pathname === '/api/credits' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; const wallet = walletOf(user.id); const pricing = currentPricing(); const transactions = recentCreditEntries(user.id, 1000); return sendJson(res, 200, { ...wallet, pricing: { image: pricing.imagePerRequest, videoPerSecond: pricing.videoPerSecond, signupBonus: creditPricing.signupBonus, version: pricing.version, llmInputYuanPerMillion: llmRates.inputYuanPerMillion, llmOutputYuanPerMillion: llmRates.outputYuanPerMillion, yuanPerCredit: llmRates.yuanPerCredit }, transactions }); }

    if (url.pathname === '/api/drama/projects' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      const page = listDramaProjects(user.id, { limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor') });
      setPageHeaders(res, page);
      return sendJson(res, 200, { projects: page.items.map(project => publicDramaProject(normalizeDramaProject(project))) });
    }
    if (url.pathname === '/api/drama/projects' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return; const input = await bodyJson(req);
      const mode = input.mode === 'professional' ? 'professional' : 'smart'; const title = String(input.title || '未命名短剧').trim().slice(0, 80);
      const project = normalizeDramaProject({ id:randomUUID(), ownerId:user.id, title, mode, step:'script', status:'draft', input:'', synopsis:'', script:'', settings:input.settings || {}, resources:[], shots:[], finalAssetId:'', createdAt:now(), updatedAt:now() });
      await saveDramaProject(user.id, project); return sendJson(res, 201, { project:publicDramaProject(project) });
    }
    // Must precede the /:id route below, otherwise "latest" is captured as a
    // project id and always resolves to 404.
    if (url.pathname === '/api/drama/projects/latest' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      const project = latestDramaProject(user.id);
      return project ? sendJson(res, 200, { project: publicDramaProject(normalizeDramaProject(project)) }) : sendJson(res, 404, { error: '还没有短剧项目' });
    }
    const dramaProjectMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)$/);
    if (dramaProjectMatch && req.method === 'GET') { const user = await requireUser(req, res); if (!user) return; const project = await loadDramaProject(user.id, dramaProjectMatch[1]); return project ? sendJson(res, 200, { project:publicDramaProject(project) }) : sendJson(res, 404, { error:'短剧项目不存在' }); }
    if (dramaProjectMatch && req.method === 'PATCH') {
      const user = await requireUser(req, res); if (!user) return; const project = await loadDramaProject(user.id, dramaProjectMatch[1]); if (!project) return sendJson(res, 404, { error:'短剧项目不存在' }); const input = await bodyJson(req);
      if (input.title !== undefined) project.title = String(input.title).trim().slice(0,80) || project.title;
      if (input.mode !== undefined) project.mode = input.mode === 'professional' ? 'professional' : 'smart';
      if (dramaStepOrder.includes(input.step)) { project.step = input.step; project.maxStep = dramaStepOrder[Math.max(dramaStepOrder.indexOf(project.maxStep || 'script'), dramaStepOrder.indexOf(input.step))]; }
      for (const key of ['input','synopsis','script']) if (input[key] !== undefined) project[key] = String(input[key]).slice(0, key === 'script' ? 120000 : 10000);
      if (input.settings) project.settings = { ...project.settings, ...input.settings };
      if (Array.isArray(input.scenes)) project.scenes = input.scenes;
      if (Array.isArray(input.resources)) project.resources = input.resources;
      if (Array.isArray(input.shots)) project.shots = input.shots;
      normalizeDramaProject(project); await saveDramaProject(user.id, project); return sendJson(res, 200, { project:publicDramaProject(project) });
    }
    const directorMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/direct$/);
    if (directorMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return; if (!isLlmConfigured(llmConfig)) return sendJson(res, 503, { error:'导演服务尚未配置' }); const project = await loadDramaProject(user.id, directorMatch[1]); if (!project) return sendJson(res,404,{error:'短剧项目不存在'}); const input = await bodyJson(req);
      project.input = String(input.input ?? project.input).trim(); if (!project.input) return sendJson(res,400,{error:'请输入一句话创意或剧本'}); project.settings = { ...project.settings, ...(input.settings || {}) }; normalizeDramaProject(project);
      const inputIsScript = project.input.length >= 200 || /(?:^|\n)\s*(?:#{1,3}\s*)?(?:\d+[-–—]\d+秒|场景|第[一二三四五六七八九十\d]+场|[A-Z]+\s*[：:])/m.test(project.input);
      const prompt = `制作参数：${JSON.stringify(project.settings)}\n生产协议版本：${STORYBOARD_ENGINE_VERSION}\n输入类型：${inputIsScript?'完整剧本，必须保留原稿，不需要在结果中重复 script':'故事创意，需要生成完整 script'}\n用户输入：\n${project.input}`;
      const maxOutputTokens = 12000;
      const maxDirectorAttempts = 4;
      const maxRecoveryRounds = maxDirectorAttempts - 1;
      const initialRequestId = randomUUID();
      let activeRequestId = initialRequestId;
      let activeRequestHeld = false;
      let initialShotCount = 0;
      let recoveredShotCount = 0;
      let appendedShotCount = 0;
      let attemptCount = 0;
      let recoveryAttemptCount = 0;
      let recoveryMode = '';
      let recoveryProblemCount = 0;
      let latestFailureKind = '';
      let latestGateIds = [];
      let failureBalance;
      const recoveryHistory = [];
      const settlements = [];
      const usageSummary = () => ({
        inputTokens:settlements.reduce((sum,item)=>sum+item.inputTokens,0),
        outputTokens:settlements.reduce((sum,item)=>sum+item.outputTokens,0),
        chargedCredits:settlements.reduce((sum,item)=>sum+item.chargedCredits,0),
        attemptCount,
        maxAttemptCount:maxDirectorAttempts,
        recoveryAttempts:recoveryAttemptCount,
        maxRecoveryRounds,
        initialReturnedCount:initialShotCount,
        recoveredShotCount,
        completionCount:appendedShotCount,
        recoveryMode,
        correctedProblemCount:recoveryMode==='replace'?recoveryProblemCount:0,
        autoCompleted:recoveryHistory.includes('append') && appendedShotCount > 0,
        autoRegenerated:recoveryHistory.includes('regenerate'),
        autoCorrected:recoveryHistory.includes('replace') && recoveryAttemptCount > 0,
        attempts:settlements.map(item=>({type:item.attemptType,requestId:item.id,inputTokens:item.inputTokens,outputTokens:item.outputTokens,chargedCredits:item.chargedCredits})),
      });
      const reservedMicro = llmReservationMicro(conservativeInputTokenUpperBound(directorPackageSystemPrompt,prompt),maxOutputTokens,llmRates);
      const reserved = await reserveLlmCredits(user.id,initialRequestId,reservedMicro,{projectId:project.id,skillName:'smart-director',skillVersion:'6.0.0',attemptType:'initial'});
      if (reserved.error) return sendJson(res,reserved.status,{error:reserved.error,balance:reserved.balance});
      activeRequestHeld = true;
      try {
        attemptCount += 1;
        const initialResult = await callLlm({system:directorPackageSystemPrompt,prompt,maxOutputTokens,outputSchema:directorPackageJsonSchema({requireScript:!inputIsScript,shotCount:project.settings.shotCount}),toolName:'submit_director_package',config:llmConfig});
        settlements.push({...await settleLlmCredits(user.id,initialRequestId,initialResult,{projectId:project.id,skillName:'smart-director',skillVersion:'6.0.0',attemptType:'initial'}),attemptType:'initial'});
        activeRequestHeld = false;
        let candidate;
        let pack;
        let prepared;
        let validationError;
        try {
          candidate = parseJsonObject(initialResult.text);
          initialShotCount = Array.isArray(candidate.shots) ? candidate.shots.length : 0;
          pack = validateDirectorPackage(candidate,project.settings,project.input);
        } catch (error) {
          validationError = error;
          if (candidate) {
            try { prepared = prepareDirectorPackage(candidate,project.settings,project.input); }
            catch (prepareError) { validationError = prepareError; }
          }
        }

        while (!pack && !prepared && attemptCount < maxDirectorAttempts) {
          const recoveryRound = recoveryAttemptCount + 1;
          recoveryMode = 'regenerate';
          const feedback = directorRecoveryDiagnostic(validationError,{requestedShotCount:project.settings.shotCount,returnedShotCount:initialShotCount});
          latestFailureKind = feedback.kind;
          latestGateIds = (feedback.gateIds || []).slice(0, 7);
          recoveryProblemCount = Math.max(recoveryProblemCount,(feedback.problems || []).length);
          const recoveryPrompt = buildDirectorPackageRepairPrompt(prompt,project.settings,feedback,{round:recoveryRound,requireScript:!inputIsScript});
          const recoveryRequestId = randomUUID();
          activeRequestId = recoveryRequestId;
          const attemptType = `package-repair-${recoveryRound}`;
          const recoveryReservedMicro = llmReservationMicro(conservativeInputTokenUpperBound(directorPackageRepairSystemPrompt,recoveryPrompt),maxOutputTokens,llmRates);
          const recoveryReserved = await reserveLlmCredits(user.id,recoveryRequestId,recoveryReservedMicro,{projectId:project.id,skillName:'smart-director-package-repair',skillVersion:'1.0.0',attemptType,parentRequestId:initialRequestId,recoveryRound});
          if (recoveryReserved.error) {
            failureBalance = recoveryReserved.balance;
            throw Object.assign(new Error(`第 ${recoveryRound} 轮自动重建导演方案所需积分不足：${recoveryReserved.error}`),{statusCode:recoveryReserved.status});
          }
          activeRequestHeld = true;
          recoveryAttemptCount = recoveryRound;
          recoveryHistory.push('regenerate');
          attemptCount += 1;
          const recoveryResult = await callLlm({system:directorPackageRepairSystemPrompt,prompt:recoveryPrompt,maxOutputTokens,outputSchema:directorPackageJsonSchema({requireScript:!inputIsScript,shotCount:project.settings.shotCount}),toolName:'submit_director_package',config:llmConfig});
          settlements.push({...await settleLlmCredits(user.id,recoveryRequestId,recoveryResult,{projectId:project.id,skillName:'smart-director-package-repair',skillVersion:'1.0.0',attemptType,parentRequestId:initialRequestId,recoveryRound}),attemptType});
          activeRequestHeld = false;
          let regenerated;
          try {
            regenerated = parseJsonObject(recoveryResult.text);
            recoveredShotCount = Array.isArray(regenerated.shots) ? regenerated.shots.length : 0;
            pack = validateDirectorPackage(regenerated,project.settings,project.input);
          } catch (error) {
            validationError = error;
            if (regenerated) {
              try { prepared = prepareDirectorPackage(regenerated,project.settings,project.input); }
              catch (prepareError) { validationError = prepareError; }
            }
          }
        }

        if (!pack && !prepared) throw validationError || new Error('智能导演未形成可修复的完整方案');

        if (!pack) {
          let recovery = analyzeDirectorPlanRecovery(prepared,project.settings);
          if (recovery.mode === 'none') throw validationError;
          let mode = recovery.mode;
          let base = prepared;
          let feedback = directorRecoveryDiagnostic(validationError,{requestedShotCount:project.settings.shotCount,returnedShotCount:initialShotCount});
          let candidateShots = base.shots;

          while (!pack && attemptCount < maxDirectorAttempts) {
            const recoveryRound = recoveryAttemptCount + 1;
            recoveryMode = mode;
            latestFailureKind = feedback.kind;
            latestGateIds = (feedback.gateIds || []).slice(0, 7);
            recoveryProblemCount = Math.max(recoveryProblemCount,(feedback.problems || []).length);
            const append = mode === 'append';
            const replaceRecovery = append ? recovery : { ...recovery, mode:'replace', requestedShotCount:project.settings.shotCount, failedGates:validationError?.gates?.filter(gate=>!gate.ok) || recovery.failedGates || [] };
            const recoveryPrompt = append
              ? buildDirectorShotCompletionPrompt(base,project.settings,recovery.shortage)
              : buildDirectorShotRepairPrompt(base,project.settings,replaceRecovery,{feedback,round:recoveryRound,candidateShots});
            const recoverySystem = append ? directorShotCompletionSystemPrompt : directorShotRepairSystemPrompt;
            const recoverySchema = append ? directorShotCompletionJsonSchema(recovery.shortage.missingShotCount) : directorShotRepairJsonSchema(project.settings.shotCount);
            const recoveryCount = append ? recovery.shortage.missingShotCount : project.settings.shotCount;
            const recoveryMaxOutputTokens = Math.min(12000,Math.max(2048,recoveryCount*1800));
            const recoveryRequestId = randomUUID();
            activeRequestId = recoveryRequestId;
            const attemptType = append ? 'completion' : `quality-repair-${recoveryRound}`;
            const skillName = append ? 'smart-director-completion' : 'smart-director-quality-repair';
            const recoveryReservedMicro = llmReservationMicro(conservativeInputTokenUpperBound(recoverySystem,recoveryPrompt),recoveryMaxOutputTokens,llmRates);
            const recoveryReserved = await reserveLlmCredits(user.id,recoveryRequestId,recoveryReservedMicro,{projectId:project.id,skillName,skillVersion:'2.0.0',attemptType,parentRequestId:initialRequestId,recoveryRound});
            if (recoveryReserved.error) {
              failureBalance = recoveryReserved.balance;
              throw Object.assign(new Error(`已有导演方案通过基础校验，但第 ${recoveryRound} 轮自动${append?'补全':'校正'}所需积分不足：${recoveryReserved.error}`),{statusCode:recoveryReserved.status});
            }
            activeRequestHeld = true;
            recoveryAttemptCount = recoveryRound;
            recoveryHistory.push(mode);
            attemptCount += 1;
            const recoveryResult = await callLlm({system:recoverySystem,prompt:recoveryPrompt,maxOutputTokens:recoveryMaxOutputTokens,outputSchema:recoverySchema,toolName:append?'submit_director_shot_completion':'submit_director_shot_repair',config:llmConfig});
            settlements.push({...await settleLlmCredits(user.id,recoveryRequestId,recoveryResult,{projectId:project.id,skillName,skillVersion:'2.0.0',attemptType,parentRequestId:initialRequestId,recoveryRound}),attemptType});
            activeRequestHeld = false;

            let recoveryCandidate;
            try {
              recoveryCandidate = parseJsonObject(recoveryResult.text);
              recoveredShotCount = Array.isArray(recoveryCandidate.shots) ? recoveryCandidate.shots.length : 0;
              if (append) appendedShotCount = recoveredShotCount;
              const combinedShots = append ? [...base.shots,...(Array.isArray(recoveryCandidate.shots)?recoveryCandidate.shots:[])] : recoveryCandidate.shots;
              candidateShots = Array.isArray(combinedShots) ? combinedShots : candidateShots;
              pack = append
                ? mergeDirectorShotCompletion(base,recoveryCandidate,project.settings,project.input)
                : replaceDirectorShots(base,recoveryCandidate,project.settings,project.input);
            } catch (error) {
              validationError = error;
              feedback = directorRecoveryDiagnostic(error,{requestedShotCount:project.settings.shotCount,returnedShotCount:recoveredShotCount});
              latestFailureKind = feedback.kind;
              latestGateIds = (feedback.gateIds || []).slice(0, 7);
              recoveryProblemCount = Math.max(recoveryProblemCount,(feedback.problems || []).length);
              if (Array.isArray(candidateShots) && candidateShots.length) {
                try { base = prepareDirectorPackage({ ...base, shots:candidateShots },project.settings,project.input); }
                catch {}
              }
              mode = 'replace';
              recovery = { ...analyzeDirectorPlanRecovery(base,project.settings), mode:'replace', requestedShotCount:project.settings.shotCount, failedGates:error?.gates?.filter(gate=>!gate.ok) || [] };
            }
          }
          if (!pack) throw validationError || new Error('导演方案未通过最终生产校验');
        }

        const usage = usageSummary();
        project.workflowVersion=pack.workflowVersion; project.title=pack.title; project.synopsis=pack.synopsis; project.script=pack.script; project.scenes=pack.scenes.map(item=>({id:randomUUID(),...item})); project.resources=pack.resources.map(item=>({id:randomUUID(),...item,versions:[],selectedTaskId:''})); const byName=new Map(project.resources.map(item=>[item.name,item.id])); project.shots=pack.shots.map(item=>({id:randomUUID(),...item,sceneId:project.scenes[Math.max(0,item.sceneNumber-1)]?.id || project.scenes[0]?.id || '',resourceIds:item.resourceNames.map(name=>byName.get(name)).filter(Boolean),referenceAssetIds:[],generation:{type:'TEXT',firstFrameAssetId:'',lastFrameAssetId:'',referenceAssetIds:[],quality:'720p'},videoVersions:[],selectedVideoTaskId:'',tailFrameAssetId:''})); project.productionQuality=pack.productionQuality; project.status='designed'; project.directorUsage=usage; normalizeDramaProject(project); await saveDramaProject(user.id,project);
        console.info('smart-director',JSON.stringify({projectId:project.id,attemptCount:usage.attemptCount,maxAttemptCount:maxDirectorAttempts,recoveryAttempts:recoveryAttemptCount,recoveryMode,recoveryHistory,initialShotCount,recoveredShotCount,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,chargedCredits:usage.chargedCredits,status:'succeeded'}));
        return sendJson(res,200,{project:publicDramaProject(project),usage,balance:settlements.at(-1).wallet.balance});
      } catch(error) {
        if (activeRequestHeld) {
          if(error.billingReconcileRequired) await markLlmBillingReconcile(user.id,activeRequestId,error);
          else await releaseLlmCredits(user.id,activeRequestId,error.message).catch(releaseError=>console.error('释放智能导演 LLM 冻结额度失败',releaseError));
          activeRequestHeld = false;
        }
        if (recoveryAttemptCount || settlements.length) {
          const usage = usageSummary();
          error.publicData={directorRecovery:{attempted:recoveryAttemptCount>0,mode:recoveryMode,history:recoveryHistory,round:recoveryAttemptCount,maxRounds:maxRecoveryRounds,exhausted:attemptCount>=maxDirectorAttempts,requestedShotCount:project.settings.shotCount,initialShotCount,recoveredShotCount,problemCount:recoveryProblemCount,lastFailureKind:latestFailureKind,lastGateIds:latestGateIds},usage,balance:failureBalance ?? settlements.at(-1)?.wallet?.balance};
          if (recoveryAttemptCount && !/^(?:已有导演方案通过基础校验，但第 \d+ 轮自动(?:补全|校正)|第 \d+ 轮自动重建导演方案)所需积分不足/.test(error.message)) {
            const recoveryLabel = recoveryHistory.includes('regenerate') ? '重建并校正' : recoveryMode==='append' ? '补全' : '校正';
            error.message = `系统已自动${recoveryLabel} ${recoveryAttemptCount} 轮，但仍未形成可制作方案`;
          }
          console.info('smart-director',JSON.stringify({projectId:project.id,attemptCount:usage.attemptCount,maxAttemptCount:maxDirectorAttempts,recoveryAttempts:recoveryAttemptCount,recoveryMode,recoveryHistory,initialShotCount,recoveredShotCount,lastFailureKind:latestFailureKind,lastGateIds:latestGateIds,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,chargedCredits:usage.chargedCredits,status:'failed',category:error.code || (error.billingReconcileRequired?'billing_reconcile':'validation')}));
        }
        throw error;
      }
    }
    const resourceVersionMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/resources\/([\w-]+)\/versions$/);
    if (resourceVersionMatch && req.method === 'POST') { const user=await requireUser(req,res); if(!user)return; const project=await loadDramaProject(user.id,resourceVersionMatch[1]); const resource=project?.resources.find(item=>item.id===resourceVersionMatch[2]); if(!resource)return sendJson(res,404,{error:'资源不存在'}); const input=await bodyJson(req); const task=findGeneration(user.id, safeId(input.taskId)); if(!task||task.type!=='image')return sendJson(res,400,{error:'图片任务不存在'}); if(!resource.versions.includes(task.id))resource.versions.push(task.id); if(!resource.selectedTaskId)resource.selectedTaskId=task.id; await saveDramaProject(user.id,project); return sendJson(res,200,{project:publicDramaProject(project)}); }
    const resourceSelectMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/resources\/([\w-]+)\/select$/);
    if (resourceSelectMatch && req.method === 'PATCH') { const user=await requireUser(req,res); if(!user)return; const project=await loadDramaProject(user.id,resourceSelectMatch[1]); const resource=project?.resources.find(item=>item.id===resourceSelectMatch[2]); if(!resource)return sendJson(res,404,{error:'资源不存在'}); const input=await bodyJson(req); if(!resource.versions.includes(input.taskId))return sendJson(res,400,{error:'该版本不属于此资源'}); if(resource.selectedTaskId!==input.taskId){resource.selectedTaskId=input.taskId;resource.lifecycle={...resource.lifecycle,status:'approved',revision:(resource.lifecycle?.revision||1)+1,approvedAt:now()};project.shots.filter(shot=>shot.resourceIds.includes(resource.id)).forEach(shot=>{shot.lifecycle.staleReasons=[...new Set([...(shot.lifecycle.staleReasons||[]),`${resource.name} 视觉版本已变更`])];});} await saveDramaProject(user.id,project); return sendJson(res,200,{project:publicDramaProject(project)}); }
    const shotVideoMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)\/videos$/);
    if (shotVideoMatch && req.method === 'POST') { const user=await requireUser(req,res); if(!user)return; const project=await loadDramaProject(user.id,shotVideoMatch[1]); const shot=project?.shots.find(item=>item.id===shotVideoMatch[2]); if(!shot)return sendJson(res,404,{error:'分镜不存在'}); const input=await bodyJson(req); const task=findGeneration(user.id, safeId(input.taskId)); if(!task||task.type!=='video')return sendJson(res,400,{error:'视频任务不存在'}); if(!shot.videoVersions.includes(task.id))shot.videoVersions.push(task.id); shot.selectedVideoTaskId=task.id; await saveDramaProject(user.id,project); return sendJson(res,200,{project:publicDramaProject(project)}); }
    const tailMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)\/tail-frame$/);
    if (tailMatch && req.method === 'POST') { const user=await requireUser(req,res); if(!user)return; const project=await loadDramaProject(user.id,tailMatch[1]); const shot=project?.shots.find(item=>item.id===tailMatch[2]); if(!shot)return sendJson(res,404,{error:'分镜不存在'}); const asset=await extractVideoTailFrame(user.id,project,shot); return sendJson(res,201,{asset:publicAsset(asset),project:publicDramaProject(project)}); }
    const assembleMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/assemble$/);
    if (assembleMatch && req.method === 'POST') { const user=await requireUser(req,res); if(!user)return; const project=await loadDramaProject(user.id,assembleMatch[1]); if(!project)return sendJson(res,404,{error:'项目不存在'}); const asset=await assembleDramaProject(user.id,project); return sendJson(res,201,{asset:publicAsset(asset),project:publicDramaProject(project)}); }

    if (url.pathname === '/api/drama/analyze-script' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      if (!isLlmConfigured(llmConfig)) return sendJson(res, 503, { error: 'LLM 服务尚未配置' });
      const input = await bodyJson(req); const script = String(input.script || '').trim();
      if (!script) return sendJson(res, 400, { error: '请输入剧本内容' });
      if (charLength(script) > 80_000) return sendJson(res, 400, { error: '单次剧本分析不能超过 80,000 个字符' });
      const maxOutputTokens = 4096;
      const requestId = randomUUID();
      const inputTokenUpperBound = conservativeInputTokenUpperBound(scriptAnalysisSystemPrompt, script);
      const reservedMicro = llmReservationMicro(inputTokenUpperBound, maxOutputTokens, llmRates);
      const reserved = await reserveLlmCredits(user.id, requestId, reservedMicro, { skillName: 'script-structure', skillVersion: '1.0.0' });
      if (reserved.error) return sendJson(res, reserved.status, { error: reserved.error, balance: reserved.balance, held: reserved.held, available: reserved.available });
      try {
        const result = await callLlm({ system: scriptAnalysisSystemPrompt, prompt: script, maxOutputTokens, jsonMode:true, config: llmConfig });
        const analysis = validateScriptAnalysis(parseJsonObject(result.text));
        const settled = await settleLlmCredits(user.id, requestId, result, { skillName: 'script-structure', skillVersion: '1.0.0' });
        const project = { id: randomUUID(), ownerId: user.id, title: analysis.title, script, analysis, storyboard: null, status: 'analysis_complete', analysisRequestId: requestId, analysisUsage: { inputTokens: settled.inputTokens, outputTokens: settled.outputTokens, chargedCredits: settled.chargedCredits }, createdAt: now(), updatedAt: now() };
        await saveDramaProject(user.id, project);
        return sendJson(res, 200, { requestId, project: publicDramaProject(project), analysis, usage: project.analysisUsage, balance: settled.wallet.balance, held: settled.wallet.held, available: settled.wallet.available });
      } catch (error) {
        if (error.billingReconcileRequired) await markLlmBillingReconcile(user.id, requestId, error);
        else await releaseLlmCredits(user.id, requestId, error.message).catch(releaseError => console.error('释放 LLM 冻结额度失败', releaseError));
        throw error;
      }
    }

    const storyboardMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/storyboard$/);
    if (storyboardMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      if (!isLlmConfigured(llmConfig)) return sendJson(res, 503, { error: '导演服务尚未配置' });
      const project = findDramaProject(user.id, storyboardMatch[1]);
      if (!project) return sendJson(res, 404, { error: '短剧项目不存在' });
      const maxOutputTokens = 8_000; const requestId = randomUUID();
      const prompt = `原始剧本：\n${project.script}\n\n已确认分析：\n${JSON.stringify(project.analysis)}`;
      const inputTokenUpperBound = conservativeInputTokenUpperBound(storyboardSystemPrompt, prompt);
      const reservedMicro = llmReservationMicro(inputTokenUpperBound, maxOutputTokens, llmRates);
      const reserved = await reserveLlmCredits(user.id, requestId, reservedMicro, { projectId: project.id, skillName: 'shot-director', skillVersion: '1.0.0' });
      if (reserved.error) return sendJson(res, reserved.status, { error: reserved.error, balance: reserved.balance, held: reserved.held, available: reserved.available });
      try {
        const result = await callLlm({ system: storyboardSystemPrompt, prompt, maxOutputTokens, jsonMode:true, config: llmConfig });
        const storyboard = validateStoryboard(parseJsonObject(result.text));
        storyboard.shots = storyboard.shots.map(shot => ({ id: randomUUID(), ...shot, keyframeTaskId: '', videoTaskId: '' }));
        const settled = await settleLlmCredits(user.id, requestId, result, { projectId: project.id, skillName: 'shot-director', skillVersion: '1.0.0' });
        project.storyboard = storyboard; project.status = 'storyboard_ready'; project.storyboardRequestId = requestId;
        project.storyboardUsage = { inputTokens: settled.inputTokens, outputTokens: settled.outputTokens, chargedCredits: settled.chargedCredits };
        await saveDramaProject(user.id, project);
        return sendJson(res, 200, { project: publicDramaProject(project), usage: project.storyboardUsage, balance: settled.wallet.balance, held: settled.wallet.held, available: settled.wallet.available });
      } catch (error) {
        if (error.billingReconcileRequired) await markLlmBillingReconcile(user.id, requestId, error);
        else await releaseLlmCredits(user.id, requestId, error.message).catch(releaseError => console.error('释放分镜 LLM 冻结额度失败', releaseError));
        throw error;
      }
    }

    const shotBindingMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)$/);
    if (shotBindingMatch && req.method === 'PATCH') {
      const user = await requireUser(req, res); if (!user) return;
      const project = findDramaProject(user.id, shotBindingMatch[1]);
      if (!project?.storyboard?.shots) return sendJson(res, 404, { error: '短剧项目或分镜不存在' });
      const shot = project.storyboard.shots.find(item => item.id === shotBindingMatch[2]);
      if (!shot) return sendJson(res, 404, { error: '镜头不存在' });
      const input = await bodyJson(req); const field = input.kind === 'video' ? 'videoTaskId' : input.kind === 'keyframe' ? 'keyframeTaskId' : '';
      if (!field) return sendJson(res, 400, { error: '只支持绑定关键帧或视频任务' });
      const taskId = safeId(input.taskId); const task = findGeneration(user.id, taskId);
      const expectedType = field === 'keyframeTaskId' ? 'image' : 'video';
      if (!task || task.type !== expectedType) return sendJson(res, 400, { error: '生成任务不存在或类型不匹配' });
      shot[field] = taskId; await saveDramaProject(user.id, project);
      return sendJson(res, 200, { project: publicDramaProject(project) });
    }

    if (url.pathname === '/api/generations' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      const page = listGenerations(user.id, { type: url.searchParams.get('type'), limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor') });
      setPageHeaders(res, page);
      return sendJson(res, 200, page.items.map(publicGeneration));
    }
    if (url.pathname === '/api/generations' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return; const input = await bodyJson(req); const type = input.type;
      if (!['image', 'video'].includes(type)) return sendJson(res, 400, { error: '只支持图片或视频生成' }); let prompt = String(input.prompt || ''); if (!prompt.trim()) return sendJson(res, 400, { error: '请输入提示词' });
      await ensureUserDirs(user.id);
      let dramaProjectId = ''; let dramaShotId = ''; let dramaShot = null;
      if (type === 'video' && input.dramaProjectId && input.dramaShotId) { dramaProjectId=safeId(input.dramaProjectId);dramaShotId=safeId(input.dramaShotId);const dramaProject=await loadDramaProject(user.id,dramaProjectId);dramaShot=dramaProject?.shots.find(shot=>shot.id===dramaShotId);if(!dramaProject||!dramaShot)return sendJson(res,404,{error:'短剧项目或分镜不存在'});if(dramaProject.workflowVersion>=STORYBOARD_ENGINE_VERSION&&!dramaProject.productionQuality?.passed){const first=dramaProject.productionQuality?.gates?.find(gate=>!gate.ok)?.problems?.[0]||'分镜方案未通过质量检查';return sendJson(res,409,{error:`不能生成视频：${first}`});}const scene=dramaProject.scenes.find(item=>item.id===dramaShot.sceneId);const resources=(dramaShot.resourceIds||[]).map(id=>dramaProject.resources.find(item=>item.id===id)).filter(Boolean);prompt=buildShotVideoPrompt({project:dramaProject,shot:dramaShot,scene,resources}); }
      const requestedVideoModelId = String(input.modelId ?? input.videoModel ?? '').trim().toLowerCase();
      const promptMaxLength = type === 'image' ? 5000 : requestedVideoModelId === VIDEO_MODEL_IDS.GROK_15 ? 10000 : 4096;
      if (charLength(prompt) > promptMaxLength) return sendJson(res, 400, { error: `${type === 'image' ? '图片' : '视频'}提示词不能超过 ${promptMaxLength} 个字符` });
      if (type === 'video' && !dramaProjectId && !String(input.modelId ?? input.videoModel ?? '').trim()) return sendJson(res, 400, { error: '请选择视频模型' });
      if (type === 'video' && dramaShot) {
        const requestedDuration = Number(input.duration ?? dramaShot.duration);
        if (!Number.isFinite(requestedDuration) || requestedDuration !== Number(dramaShot.duration)) return sendJson(res, 409, { error: `分镜时长已保存为 ${dramaShot.duration} 秒，请刷新页面后再生成` });
        input.duration = Number(dramaShot.duration);
      }
      const size = type === 'image' ? String(input.size || '16:9') : null;
      if (type === 'image' && !imageSizes.has(size)) return sendJson(res, 400, { error: '不支持的图片比例' });
      const requestedReferenceCount = Array.isArray(input.referenceAssetIds) ? new Set(input.referenceAssetIds.map(safeId).filter(Boolean)).size : 0;
      let aspectRatio = null; let duration = null; let videoRequest = null;
      if (type === 'video') { videoRequest = validateVideoRequest(input, requestedReferenceCount); aspectRatio = videoRequest.aspectRatio; duration = videoRequest.duration; }
      const referenceAssetIds = await validateReferenceAssets(user.id, input.referenceAssetIds, videoRequest?.referenceLimits);
      const modelId = type === 'image' ? fixedModels.image : videoRequest.modelId;
      if (!isModelEnabled(modelId)) return sendJson(res, 503, { error: '当前模型暂不可用' });
      const provider = type === 'image' ? 'duomi' : videoRequest.provider;
      if (provider === 'duomi' && !process.env.DUOMI_API_KEY) return sendJson(res, 503, { error: '视频生成服务尚未配置' });
      if (provider === 'ttapi' && !ttapiConfigured) return sendJson(res, 503, { error: '视频生成服务尚未配置' });
      if (provider === 'cntcn' && !cntcnConfigured) return sendJson(res, 503, { error: 'CNTCN Seedance 视频服务尚未配置' });
      if (provider === 'autodl' && !autodlConfigured) return sendJson(res, 503, { error: 'AutoDL GuGu 2.0 视频服务尚未配置' });
      if (provider === 'oai') {
        const configured = videoRequest.modelId === VIDEO_MODEL_IDS.GROK_15
          ? oaiGrokConfigured
          : videoRequest.modelId === VIDEO_MODEL_IDS.VEO_31
            ? oaiVeoConfigured
            : videoRequest.modelId === VIDEO_MODEL_IDS.MINIMAX_H3
              ? oaiMinimaxConfigured
              : oaiConfigured;
        if (!configured) {
          const message = videoRequest.modelId === VIDEO_MODEL_IDS.GROK_15
            ? 'Grok Video 服务尚未配置'
            : videoRequest.modelId === VIDEO_MODEL_IDS.VEO_31
              ? 'Veo 3.1 服务尚未配置'
              : videoRequest.modelId === VIDEO_MODEL_IDS.MINIMAX_H3
                ? 'MiniMax H3 服务尚未配置'
                : '视频生成服务尚未配置';
          return sendJson(res, 503, { error: message });
        }
      }
      const pricing = currentPricing();
      const pricingForTask = type === 'video' && videoRequest.pricing?.unit === 'second'
        ? { ...pricing, videoPerSecondMicro: creditsToMicro(videoRequest.pricing.amount) }
        : pricing;
      const quantity = type === 'image' ? (input.quantity === undefined ? 1 : input.quantity) : 1;
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10) return sendJson(res, 400, { error: '图片生成数量需为 1–10 的整数' });
      const pricingSnapshotValue = pricingSnapshot(pricingForTask, type, type === 'video' ? duration : 1);
      const batchId = quantity > 1 ? randomUUID() : '';
      const tasks = Array.from({ length: quantity }, (_, index) => ({
        id: randomUUID(), ownerId: user.id, type, prompt, referenceAssetIds, provider,
        model: type === 'video' ? videoRequest.model : fixedModels.image, modelId, size,
        quality: type === 'image' ? String(input.quality || 'medium') : videoRequest.quality,
        aspectRatio, duration,
        ...(type === 'video' ? { videoModelId:videoRequest.modelId, generationType:videoRequest.generationType, videoProfile:videoRequest.profileKey, maxReferenceImages:videoRequest.maxImages, referenceLimits: videoRequest.referenceLimits, dramaProjectId, dramaShotId } : {}),
        ...(quantity > 1 ? { batchId, batchIndex: index + 1, batchSize: quantity } : {}),
        creditCost: pricingSnapshotValue.total, creditCostMicro: pricingSnapshotValue.totalMicro,
        pricingVersion: pricingSnapshotValue.version, pricingSnapshot: pricingSnapshotValue,
        creditStatus: 'charged', status: 'queued', providerTaskId: '', assetId: '', error: '',
        createdAt: now(), updatedAt: now(), finishedAt: null,
      }));
      const chargeItems = tasks.map(task => ({
        generationId: task.id,
        costMicro: task.creditCostMicro,
        metadata: { modelId, contentType:type, provider, pricingVersion: task.pricingVersion, onCharged: () => saveGeneration(user.id, task) },
      }));
      const charged = quantity === 1
        ? await chargeGenerationMicro(user.id, tasks[0].id, tasks[0].creditCostMicro, chargeItems[0].metadata)
        : await chargeGenerationBatchMicro(user.id, chargeItems);
      if (charged.error) return sendJson(res, charged.status, { error: charged.error, balance: charged.balance });
      tasks.forEach(task => startGeneration(user.id, task));
      if (quantity === 1) return sendJson(res, 202, { ...publicGeneration(tasks[0]), balance: charged.balance });
      return sendJson(res, 202, { tasks: tasks.map(publicGeneration), quantity, balance: charged.balance });
    }
    const generationMatch = url.pathname.match(/^\/api\/generations\/([\w-]+)$/);
    if (generationMatch && req.method === 'DELETE') {
      const user = await requireUser(req, res); if (!user) return; const id = safeId(generationMatch[1]);
      if (activeGenerations.has(id)) return sendJson(res, 409, { error: '任务正在生成中，完成后才能删除' });
      const task = findGeneration(user.id, id); if (!task) return sendJson(res, 404, { error: '生成记录不存在' });
      const retryTimer = generationRetryTimers.get(id); if (retryTimer) { clearTimeout(retryTimer); generationRetryTimers.delete(id); }
      const asset = task.assetId ? findAsset(user.id, task.assetId) : null;
      await deleteAssetRecord(user.id, asset);
      deleteGeneration(user.id, id);
      return sendJson(res, 200, { ok: true, deletedAssetId: asset?.id || null });
    }

    if (url.pathname === '/api/files' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      const page = listAssets(user.id, { kind: url.searchParams.get('kind'), limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor') });
      setPageHeaders(res, page);
      return sendJson(res, 200, page.items.map(publicAsset));
    }
    if (url.pathname === '/api/files/uploads/init' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      if (!directOssUploadEnabled || !ossConfigured) return sendJson(res, 503, { error: '直传暂未启用' });
      if (!uploadInitRateAllowed(user.id)) return sendJson(res, 429, { error: '上传请求过于频繁，请稍后再试' });
      if (countActiveUploadIntents(user.id) >= uploadMaxPendingPerUser) return sendJson(res, 429, { error: '未完成上传数量过多，请先完成或稍后重试' });
      const input = await bodyJson(req, 32_000);
      const mimeType = normalizeUploadMime(input.mimeType, input.name);
      if (![...imageTypes, ...videoTypes, ...audioTypes].includes(mimeType)) return sendJson(res, 415, { error: '只支持 PNG、JPEG、WebP、MP4、WebM、MOV 或音频文件' });
      const size = Number(input.size);
      const sizeLimit = uploadSizeLimit(mimeType);
      if (!Number.isSafeInteger(size) || size <= 0) return sendJson(res, 400, { error: '文件大小无效' });
      if (size > sizeLimit) return sendJson(res, 413, { error: imageTypes.has(mimeType) ? '单张图片不能超过 8 MB' : '视频或音频不能超过 25 MB' });
      const name = String(input.name || 'file').replace(/[\r\n\u0000-\u001f]/g, '').trim().slice(0, 160) || 'file';
      const suppliedHash = input.sha256 === undefined || input.sha256 === null || input.sha256 === '' ? '' : String(input.sha256).trim().toLowerCase();
      if (suppliedHash && !/^[a-f0-9]{64}$/.test(suppliedHash)) return sendJson(res, 400, { error: 'sha256 格式无效' });
      if (suppliedHash) {
        const existingAsset = findAssetBySha256(user.id, suppliedHash, size);
        if (existingAsset && existingAsset.mimeType === mimeType && existingAsset.kind === uploadKind(mimeType)) {
          return sendJson(res, 200, { mode: 'reuse', asset: publicAsset(existingAsset), sha256: suppliedHash });
        }
      }
      const uploadId = randomUUID();
      const assetId = randomUUID();
      const createdAt = now();
      const expiresAt = new Date(Date.now() + Math.min(uploadIntentExpiresSeconds, ossUploadExpiresSeconds) * 1000).toISOString();
      const intent = {
        id: uploadId,
        userId: user.id,
        assetId,
        temporaryOssKey: pendingUploadKey(user.id, uploadId, mimeType, name),
        finalOssKey: finalUploadKey(user.id, assetId, mimeType, name),
        name,
        kind: uploadKind(mimeType),
        mimeType,
        expectedSize: size,
        sha256: suppliedHash || null,
        clientWidth: imageTypes.has(mimeType) ? Math.max(0, Math.min(100000, Math.round(Number(input.width) || 0))) || null : null,
        clientHeight: imageTypes.has(mimeType) ? Math.max(0, Math.min(100000, Math.round(Number(input.height) || 0))) || null : null,
        status: 'pending',
        expiresAt,
        createdAt,
        updatedAt: createdAt,
      };
      createUploadIntent(intent);
      const policy = buildUploadPostPolicy({ key: intent.temporaryOssKey, mimeType, sizeLimit, expiresAt });
      return sendJson(res, 201, {
        uploadId,
        assetId,
        method: 'POST',
        uploadUrl: ossUploadUrl(),
        fields: uploadPolicyFields(policy),
        expiresAt,
      });
    }
    const uploadStatusMatch = url.pathname.match(/^\/api\/files\/uploads\/([\w-]+)$/);
    if (uploadStatusMatch && req.method === 'GET') {
      const user = await requireUser(req, res); if (!user) return;
      const intent = findUploadIntent(user.id, uploadStatusMatch[1]);
      if (!intent) return sendJson(res, 404, { error: '上传任务不存在' });
      const asset = intent.status === 'completed' ? findAsset(user.id, intent.assetId) : null;
      return sendJson(res, 200, { uploadId: intent.id, assetId: intent.assetId, status: intent.status, expiresAt: intent.expiresAt, asset: asset ? publicAsset(asset) : null });
    }
    const uploadCompleteMatch = url.pathname.match(/^\/api\/files\/uploads\/([\w-]+)\/complete$/);
    if (uploadCompleteMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      if (!directOssUploadEnabled || !ossConfigured) return sendJson(res, 503, { error: '直传暂未启用' });
      const uploadId = uploadCompleteMatch[1];
      const existing = findUploadIntent(user.id, uploadId);
      if (!existing) return sendJson(res, 404, { error: '上传任务不存在' });
      if (existing.status === 'completed') {
        const asset = findAsset(user.id, existing.assetId);
        return asset ? sendJson(res, 200, publicAsset(asset)) : sendJson(res, 409, { error: '上传记录不完整，请联系支持' });
      }
      if (existing.status === 'expired') return sendJson(res, 410, { error: '上传凭证已过期，请重新选择文件' });
      if (existing.status === 'failed') return sendJson(res, 422, { error: '上传文件验证失败，请重新选择文件' });
      const nowIso = now();
      if (existing.expiresAt <= nowIso) {
        expireUploadIntents(nowIso, 1);
        return sendJson(res, 410, { error: '上传凭证已过期，请重新选择文件' });
      }
      if (!claimUploadIntent(user.id, uploadId, nowIso)) {
        const current = findUploadIntent(user.id, uploadId);
        if (current?.status === 'completed') {
          const asset = findAsset(user.id, current.assetId);
          return asset ? sendJson(res, 200, publicAsset(asset)) : sendJson(res, 409, { error: '上传记录不完整，请联系支持' });
        }
        return sendJson(res, 202, { uploadId, assetId: existing.assetId, status: current?.status || 'verifying' });
      }
      const intent = findUploadIntent(user.id, uploadId);
      let meta;
      try {
        meta = await verifyUploadedObject(intent);
        const finalMeta = await promoteUploadedObject(intent);
        const extension = uploadExtension(intent.mimeType, intent.name);
        const asset = {
          id: intent.assetId,
          ownerId: user.id,
          name: intent.name,
          kind: intent.kind,
          mimeType: intent.mimeType,
          size: meta.size,
          ...(intent.sha256 ? { sha256: intent.sha256 } : {}),
          storageName: `${intent.assetId}${extension}`,
          source: 'upload',
          sourceGenerationId: '',
          sourceUrl: '',
          ossKey: intent.finalOssKey,
          ossUploadedAt: nowIso,
          ...(intent.kind === 'image' && intent.clientWidth && intent.clientHeight ? { width: intent.clientWidth, height: intent.clientHeight } : {}),
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        completeUploadIntentWithAsset(user.id, uploadId, { actualSize: finalMeta.size || meta.size, objectEtag: finalMeta.etag || meta.etag, asset, nowIso });
        await oss.delete(intent.temporaryOssKey).catch(error => console.warn(`[upload] 清理 pending 失败 uploadId=${uploadId}`, error.message));
        return sendJson(res, 201, publicAsset(asset));
      } catch (error) {
        const code = error.code || 'UPLOAD_VERIFY_FAILED';
        if (code.startsWith('UPLOAD_')) {
          markUploadIntentFailed(user.id, uploadId, { errorCode: code, actualSize: error.actualSize ?? meta?.size ?? null, objectEtag: error.objectEtag ?? meta?.etag ?? null, nowIso: now() });
          await oss.delete(intent.temporaryOssKey).catch(() => {});
          return sendJson(res, error.statusCode || 422, { error: error.message || '上传文件验证失败', code });
        }
        throw Object.assign(new Error(`上传文件归档失败：${error.message}`), { statusCode: 502, cause: error });
      }
    }
    if (url.pathname === '/api/files/upload' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return; if (!ossConfigured) return sendJson(res, 503, { error: '文件存储服务尚未配置' }); const mimeType = String(req.headers['content-type'] || '').split(';')[0]; if (![...imageTypes, ...videoTypes, ...audioTypes].includes(mimeType)) return sendJson(res, 415, { error: '只支持 PNG、JPEG、WebP、MP4、WebM、MOV 或音频文件' }); const isImage = imageTypes.has(mimeType); const kind = uploadKind(mimeType); const uploadLimit = isImage ? maxReferenceImageBytes : maxUploadBytes; const declaredSize = Number(req.headers['content-length'] || 0); if (declaredSize > uploadLimit) return sendJson(res, 413, { error: isImage ? '单张图片不能超过 8 MB' : '视频或音频不能超过 25 MB' }); const suppliedHash = String(req.headers['x-file-sha256'] || '').trim().toLowerCase(); if (suppliedHash && !/^[a-f0-9]{64}$/.test(suppliedHash)) return sendJson(res, 400, { error: 'sha256 格式无效' }); const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).replace(/[\r\n]/g, '').slice(0, 160); const extension = path.extname(rawName).toLowerCase() || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.weba', 'audio/flac': '.flac' }[mimeType]); const id = randomUUID(); const storageName = `${id}${extension}`; await ensureUserDirs(user.id); const localFile = path.join(assetFilesDir(user.id), storageName); const upload = await streamUpload(req, localFile, uploadLimit, createHash('sha256')); const size = upload.size; if (!size) return sendJson(res, 400, { error: '文件为空' }); if (suppliedHash && suppliedHash === upload.sha256) { const existing = findAssetBySha256(user.id, suppliedHash, size); if (existing && existing.mimeType === mimeType && existing.kind === kind) { await fs.unlink(localFile).catch(() => {}); return sendJson(res, 200, { ...publicAsset(existing), mode: 'reuse', sha256: suppliedHash }); } } const width = Math.max(0, Math.min(100000, Math.round(Number(req.headers['x-image-width'] || 0)))); const height = Math.max(0, Math.min(100000, Math.round(Number(req.headers['x-image-height'] || 0)))); const asset = { id, ownerId: user.id, name: rawName || storageName, kind, mimeType, size, sha256: upload.sha256, ...(isImage && width && height ? { width, height } : {}), storageName, source: 'upload', sourceGenerationId: '', sourceUrl: '', createdAt: now(), updatedAt: now() }; try { await uploadAssetToOss(user.id, asset); } catch (error) { await fs.unlink(localFile).catch(() => {}); throw Object.assign(new Error(`文件上传失败：${error.message}`), { statusCode: 502 }); } return sendJson(res, 201, publicAsset(asset));
    }
    const directMediaMatch = url.pathname.match(/^\/api\/files\/([\w-]+)\/direct$/);
    if (directMediaMatch && req.method === 'GET') {
      const user = await requireUser(req, res); if (!user) return;
      const asset = findAsset(user.id, directMediaMatch[1]);
      if (!asset) return sendJson(res, 404, { error: '文件不存在' });
      if (asset.ossKey && oss) {
        res.writeHead(302, { Location: await signedOssUrl(asset.ossKey), 'Cache-Control': 'private, no-store' });
        return res.end();
      }
      const localFile = path.join(assetFilesDir(user.id), asset.storageName);
      if (await fs.access(localFile).then(() => true).catch(() => false)) {
        res.writeHead(302, { Location: `/api/files/${asset.id}/content`, 'Cache-Control': 'private, no-store' });
        return res.end();
      }
      return sendJson(res, 404, { error: '文件内容不存在' });
    }
    const fileMatch = url.pathname.match(/^\/api\/files\/([\w-]+)(?:\/(content|download))?$/);
    if (fileMatch) { const user = await requireUser(req, res); if (!user) return; const asset = findAsset(user.id, fileMatch[1]); if (!asset) return sendJson(res, 404, { error: '文件不存在' }); if (req.method === 'GET' && fileMatch[2]) { const localFile = path.join(assetFilesDir(user.id), asset.storageName); if (await fs.access(localFile).then(() => true).catch(() => false)) return serveFile(res, localFile, asset.mimeType, fileMatch[2] === 'download' ? asset.name : ''); if (asset.ossKey) { res.writeHead(302, { Location: await signedOssUrl(asset.ossKey), 'Cache-Control': 'private, no-store' }); return res.end(); } return sendJson(res, 404, { error: '文件内容不存在' }); } if (req.method === 'PATCH' && !fileMatch[2]) { const input = await bodyJson(req); const name = String(input.name || '').trim().replace(/[\r\n]/g, '').slice(0, 160); if (!name) return sendJson(res, 400, { error: '文件名不能为空' }); asset.name = name; await saveAsset(user.id, asset); return sendJson(res, 200, publicAsset(asset)); } if (req.method === 'DELETE' && !fileMatch[2]) { await deleteAssetRecord(user.id, asset); return sendJson(res, 200, { ok: true }); } }

    return await serveStatic(res, url.pathname);
  } catch (error) { console.error(error); if (res.headersSent) return res.end(); const message = error.upstreamError ? '模型服务暂时不可用，请稍后重试' : error.message || '服务错误'; return sendJson(res, error.statusCode || (error.code === 'ENOENT' ? 404 : 500), { error: message, ...(error.publicData && typeof error.publicData === 'object' ? error.publicData : {}) }); }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, '127.0.0.1', () => {
    console.log(`GuGu AI: http://127.0.0.1:${port}`);
    // Recovery runs after the port is open so a backlog never delays startup.
    recoverPendingGenerations().catch(error => console.error('启动恢复失败', error));
  });

  // Checkpoint the WAL on the way out so the .db file is self-contained.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      clearInterval(sessionSweeper);
      clearInterval(uploadSweeper);
      server.close(() => {
        try { closeDatabase(); } catch (error) { console.error('关闭数据库失败', error); }
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
