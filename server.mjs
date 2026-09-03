import http from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { conservativeInputTokenUpperBound, creditsToMicro, llmRatesFromEnv, llmReservationMicro, normalizeWallet } from './lib/billing.mjs';
import { closeDatabase, openDatabase, resolveDbFile, sql } from './lib/db.mjs';
import { chargeGenerationBatchMicro, chargeGenerationMicro, configureLedger, markLlmBillingReconcile, recentCreditEntries, refundGenerationMicro, releaseLlmCredits, reserveLlmCredits, settleLlmCredits, walletOf } from './lib/ledger.mjs';
import { claimUploadIntent, completeUploadIntentWithAsset, configureCursors, countActiveUploadIntents, createSessionRecord, createSmsUser, createUploadIntent, deleteAsset, deleteGeneration, deleteSession, expireUploadIntent, expireUploadIntents, findAsset, findAssetBySha256, findDramaProject, findGeneration, findUploadIntent, findUserByLogin, findUserByPhoneNumber, latestDramaProject, listAssetChanges, listAssets, listDramaProjects, listGenerations, listPendingAssetDeliveries, listPendingGenerations, listRecoverableUploadIntents, markAssetDeliveryPending, markAssetDeliveryReady, markUploadIntentFailed, parseLimit, purgeExpiredSessions, registerUser, saveAssetRecord, saveDramaProjectRecord, saveGenerationRecord, updateUserProfile, userForSession } from './lib/store.mjs';
import { analyzeDirectorPlanRecovery, analyzeDirectorShotShortage, buildDirectorPackageRepairPrompt, buildDirectorShotCompletionPrompt, buildDirectorShotRepairPrompt, directorPackageJsonSchema, directorPackageRepairSystemPrompt, directorPackageSystemPrompt, directorRecoveryDiagnostic, directorShotCompletionJsonSchema, directorShotCompletionSystemPrompt, directorShotRepairJsonSchema, directorShotRepairSystemPrompt, mergeDirectorShotCompletion, parseJsonObject, prepareDirectorPackage, replaceDirectorShots, scriptAnalysisSystemPrompt, storyboardSystemPrompt, validateDirectorPackage, validateScriptAnalysis, validateStoryboard } from './lib/drama-analysis.mjs';
import { normalizeMotionPlan, normalizeProductionScenes, productionQualitySummary, STORYBOARD_ENGINE_VERSION } from './lib/storyboard-engine.mjs';
import { callLlm, isLlmConfigured, llmConfigFromEnv } from './lib/llm-client.mjs';
import { buildVideoPayload, publicVideoCapabilities, validateVideoRequest, VIDEO_MODEL_IDS, LEGACY_VIDEO_MODEL_IDS } from './lib/video-capabilities.mjs';
import { handleAdminRequest } from './lib/admin-api.mjs';
import { clientIp, createCaptchaStore, createLoginAttemptLimiter, createSmsSendLimiter, normalizePhoneNumber } from './lib/auth.mjs';
import { checkSmsVerifyCode, sendSmsVerifyCode, smsConfigFromEnv } from './lib/sms.mjs';
import { currentPricing, pricingSnapshot } from './lib/pricing.mjs';
import { isModelEnabled, publicVideoCapabilitiesWithControls } from './lib/model-controls.mjs';
import { ensureDefaultModelRoutes, publicModelPrices, routeCredential, selectModelRoute, startModelRouteMonitor } from './lib/model-routes.mjs';
import { buildShotVideoPrompt } from './public/video-prompt.js';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from './lib/notifications.mjs';
import { appendSystemEvent } from './lib/audit.mjs';
import { putSupportLogObject, supportLogMaxBytes, supportLogObjectKey, supportLogStorageReady, SUPPORT_LOG_MIME } from './lib/support-logs.mjs';
import {
  closePaymentOrder,
  createPaymentOrder,
  handleAlipayNotification,
  paymentOrderForUser,
  paymentReturnPage,
  publicCreditPackages,
  publicNotifyUrl,
  publicReturnUrl,
  queryPaymentOrder,
  queryPaymentRefund,
  refundPaymentOrder,
} from './lib/alipay-payments.mjs';

const scrypt = promisify(scryptCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, 'data');
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
const autodlWorkflowId = process.env.AUTODL_MINIMAX_H3_15S_WORKFLOW_ID || process.env.AUTODL_MINIMAX_H3_ID || 'minimax_h3_image_audio_to_video_v2_15s';
const autodlConfigured = Boolean(process.env.AUTODL_COMFYUI_KEY && autodlWorkflowId);
const ttapiConfigured = Boolean(process.env.TTAPI_API_KEY);
const cntcnConfigured = Boolean(process.env.CNTCN_KEY);
const oaiConfigured = Boolean(process.env.OAIAPI_GEMINI_KEY);
const oaiVeoConfigured = Boolean(process.env.OAIAPI_VEO_KEY);
const oaiMinimaxConfigured = Boolean(process.env.OAIAPI_MINIMAX_KEY);
const oaiPollIntervalMs = 4_000;
const oaiRequestTimeoutMs = 300_000;
const videoMaxPollDurationMs = Math.max(60_000, Number(process.env.VIDEO_MAX_POLL_DURATION_MS || 60 * 60_000));
const oaiMaxPollDurationMs = Math.max(oaiPollIntervalMs, Number(process.env.OAI_MAX_POLL_DURATION_MS || videoMaxPollDurationMs));
const oaiMaxPolls = Math.max(1, Math.ceil(oaiMaxPollDurationMs / oaiPollIntervalMs));
const ttapiPollIntervalMs = 8_000;
const ttapiMaxPollBackoffMs = 60_000;
const ttapiRequestTimeoutMs = 60_000;
const cntcnRequestTimeoutMs = 60_000;
const cntcnPollIntervalMs = 5_000;
const routedVideoSubmitTimeoutMs = Math.max(30_000, Number(process.env.VIDEO_ROUTE_SUBMIT_TIMEOUT_MS || 180_000));
const providerTaskIdTimeoutMs = Math.max(60_000, Number(process.env.VIDEO_PROVIDER_TASK_ID_TIMEOUT_MS || 5 * 60_000));
const autodlPollIntervalMs = Math.max(5_000, Number(process.env.AUTODL_POLL_INTERVAL_MS || 10_000));
const autodlRequestTimeoutMs = Math.max(30_000, Number(process.env.AUTODL_REQUEST_TIMEOUT_MS || 60_000));
const autodlMaxPollDurationMs = Math.max(autodlPollIntervalMs, Number(process.env.AUTODL_MAX_POLL_DURATION_MS || videoMaxPollDurationMs));
const autodlMaxPolls = Math.max(1, Number(process.env.AUTODL_MAX_POLLS || Math.ceil(autodlMaxPollDurationMs / autodlPollIntervalMs)));
const generationRetryMaxDelayMs = 60_000;
const archiveAttemptsPerRun = 6;
const archiveRescheduleMs = 5 * 60_000;
const desktopDirectDeliveryGraceMs = Math.max(10_000, Number(process.env.DESKTOP_DIRECT_DELIVERY_GRACE_SECONDS || 120) * 1_000);
// The web surface is a public product page. The creator workspace is served
// only to requests carrying the desktop client marker; tests can opt out to
// exercise the HTTP API without having to add that marker.
// The creator workspace is a desktop product. Only isolated HTTP tests may
// disable the desktop request marker; production configuration cannot turn the
// browser workspace back on.
const desktopAppOnly = process.env.NODE_ENV === 'production' || String(process.env.GUGU_TEST_ALLOW_BROWSER_WORKSPACE || '') !== '1';
const defaultPublicDownloadBaseUrl = 'https://guguai.oss-cn-hangzhou.aliyuncs.com/oline/desktop-updates';
const publicDownloadUrls = Object.freeze({
  mac: String(process.env.PUBLIC_MAC_DOWNLOAD_URL || `${defaultPublicDownloadBaseUrl}/latest-mac.dmg`).trim(),
  windows: String(process.env.PUBLIC_WINDOWS_DOWNLOAD_URL || `${defaultPublicDownloadBaseUrl}/latest-windows.exe`).trim(),
});
const llmConfig = llmConfigFromEnv();
const llmRates = llmRatesFromEnv();
const r2Endpoint = String(process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
const r2Bucket = String(process.env.R2_BUCKET || '').trim();
const r2Region = String(process.env.R2_REGION || 'auto').trim() || 'auto';
const r2Configured = Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && r2Endpoint && r2Bucket);
const r2 = r2Configured ? new S3Client({
  region: r2Region,
  endpoint: r2Endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
}) : null;
// Reference images use a separate public bucket. Credentials and connection
// settings may be shared with the private media bucket, but the bucket itself
// must be configured explicitly so a public domain never exposes user media.
const r2ReferenceAccessKeyId = String(process.env.R2_REFERENCE_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || '').trim();
const r2ReferenceSecretAccessKey = String(process.env.R2_REFERENCE_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || '').trim();
const r2ReferenceEndpoint = String(process.env.R2_REFERENCE_ENDPOINT || process.env.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
const r2ReferenceBucket = String(process.env.R2_REFERENCE_BUCKET || '').trim();
const r2ReferenceRegion = String(process.env.R2_REFERENCE_REGION || process.env.R2_REGION || 'auto').trim() || 'auto';
const r2ReferenceConfigured = Boolean(r2ReferenceAccessKeyId && r2ReferenceSecretAccessKey && r2ReferenceEndpoint && r2ReferenceBucket);
const r2Reference = r2ReferenceConfigured ? new S3Client({
  region: r2ReferenceRegion,
  endpoint: r2ReferenceEndpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: r2ReferenceAccessKeyId, secretAccessKey: r2ReferenceSecretAccessKey },
}) : null;
const storagePrefix = String(process.env.MEDIA_OBJECT_PREFIX || 'model-studio').replace(/^\/+|\/+$/g, '');
const r2ReferencePublicBaseUrl = String(process.env.R2_REFERENCE_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const r2ReferenceImagePrefix = String(process.env.R2_REFERENCE_IMAGE_PREFIX || 'model-studio/temporary/reference-images').trim().replace(/^\/+|\/+$/g, '');
const configuredR2ReferenceImageTtlMinutes = Number(process.env.R2_REFERENCE_IMAGE_TTL_MINUTES || 60);
const r2ReferenceImageTtlMinutes = Number.isFinite(configuredR2ReferenceImageTtlMinutes) && configuredR2ReferenceImageTtlMinutes > 0 ? configuredR2ReferenceImageTtlMinutes : 60;
const r2ReferenceImageTtlMs = Math.round(r2ReferenceImageTtlMinutes * 60_000);
const directUploadEnabled = String(process.env.DIRECT_UPLOAD_ENABLED ?? 'true').toLowerCase() !== 'false';
const uploadIntentExpiresSeconds = Math.max(60, Number(process.env.UPLOAD_INTENT_EXPIRES_SECONDS || 600));
const uploadUrlExpiresSeconds = Math.max(60, Number(process.env.R2_UPLOAD_EXPIRES_SECONDS || 300));
const assetUrlExpiresSeconds = Math.max(60, Number(process.env.R2_ASSET_URL_EXPIRES_SECONDS || 900));
const modelInputUrlExpiresSeconds = Math.max(60, Number(process.env.R2_MODEL_INPUT_URL_EXPIRES_SECONDS || 7200));
const assetPreviewCacheSeconds = Math.max(30, Math.min(300, assetUrlExpiresSeconds - 30));
const uploadMaxPendingPerUser = Math.max(1, Number(process.env.UPLOAD_MAX_PENDING_PER_USER || 3));
const uploadInitLimitPerMinute = Math.max(1, Number(process.env.UPLOAD_INIT_LIMIT_PER_MINUTE || 10));
const uploadInitAttempts = new Map();
// 诊断日志上传是人工触发的排查动作，一小时几次足够，限流只为挡住异常重试。
const supportLogWindowMs = 60 * 60_000;
const supportLogLimitPerHour = Math.max(1, Number(process.env.SUPPORT_LOG_LIMIT_PER_HOUR || 6));
const supportLogAttempts = new Map();
const sessionMaxAge = 60 * 60 * 24 * 14;
const maxUploadBytes = 25 * 1024 * 1024;
const maxReferenceImageBytes = 20 * 1024 * 1024;

const activeGenerations = new Map();
const generationRetryTimers = new Map();
const providerTaskIdTimeoutTimers = new Map();
const assetRestores = new Map();
const r2ReferenceImageCleanupTimers = new Map();
const loginLimiter = createLoginAttemptLimiter({ maxAttempts: 8, windowMs: 15 * 60_000 });
const smsConfig = smsConfigFromEnv();
const captchaStore = createCaptchaStore();
const smsSendLimiter = createSmsSendLimiter({ intervalMs: smsConfig.intervalSeconds * 1000 });
const smsVerifyLimiter = createLoginAttemptLimiter({ maxAttempts: 6, windowMs: 15 * 60_000 });
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const videoTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const audioTypes = new Set(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/flac']);
const uploadMimeByExtension = Object.freeze({ '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime', '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.aac':'audio/aac', '.weba':'audio/webm', '.flac':'audio/flac' });
const imageSizes = new Set(['1:1', '3:2', '2:3', '16:9', '9:16', '1:2', '2:1', '4:3', '3:4', '5:4', '4:5']);
const videoAspectRatios = new Set(['2:3', '3:2', '1:1', '9:16', '16:9']);
const videoDurations = new Set([8, 10, 15, 20, 30]);
// Short-drama shots are model-specific. GuGu 2.0 accepts every integer
// duration from 1 to 15 seconds, so the project persistence layer must not
// collapse those values back to the legacy 8/10/15/20/30-second set.
const dramaVideoDurations = new Set(Array.from({ length: 30 }, (_, index) => index + 1));
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

// Metadata lives in SQLite; media binaries use local caches and private R2 objects.
openDatabase({ verbose: true, file: process.env.NODE_ENV === 'test' ? ':memory:' : null });
ensureDefaultModelRoutes();

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
function videoPollTimeoutError(provider, taskId) {
  return Object.assign(new Error(`${provider || '视频'}任务等待超时`), {
    provider,
    providerTaskId: taskId,
    upstreamTerminal: true,
    pollTimedOut: true,
  });
}
function videoPollRemainingMs(startedAt, maxDurationMs) {
  return Math.max(0, maxDurationMs - (Date.now() - startedAt));
}
function videoPollStartedAt(task, fallback = Date.now()) {
  for (const value of [task?.submittedAt, task?.createdAt]) {
    const persisted = Date.parse(value || '');
    if (Number.isFinite(persisted)) return persisted;
  }
  return fallback;
}
function videoPollRequestSignal(provider, taskId, startedAt, maxDurationMs, requestTimeoutMs) {
  const remainingMs = videoPollRemainingMs(startedAt, maxDurationMs);
  if (remainingMs <= 0) throw videoPollTimeoutError(provider, taskId);
  return AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, remainingMs)));
}
const safeId = value => String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
const normalizeDeviceId = value => {
  const deviceId = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ? deviceId : '';
};
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const charLength = value => Array.from(String(value || '')).length;
const profileNicknamePattern = /^[\p{L}\p{N}_-]{2,24}$/u;
const publicUser = user => ({
  id: user.id,
  username: user.username,
  nickname: user.nickname || '',
  displayName: user.nickname || user.username,
  phoneNumber: user.phoneNumber || '',
  role: user.role || 'user',
  status: user.status || 'active',
  credits: normalizeWallet(user).balance,
  createdAt: user.createdAt,
});
const uploadSweepIntervalMs = Math.max(60_000, Number(process.env.UPLOAD_SWEEP_INTERVAL_MINUTES || 10) * 60_000);
const uploadVerifyStaleMs = Math.max(60_000, Number(process.env.UPLOAD_VERIFY_STALE_MINUTES || 10) * 60_000);
const uploadSweeper = setInterval(() => {
  if (!directUploadEnabled || !r2Configured) return;
  const nowIso = now();
  try {
    const expired = expireUploadIntents(nowIso);
    if (expired.length) expired.forEach(intent => deleteObject(intent.temporaryObjectKey).catch(() => {}));
    const staleBefore = new Date(Date.now() - uploadVerifyStaleMs).toISOString();
    const stale = listRecoverableUploadIntents(nowIso, staleBefore);
    stale.forEach(intent => {
      markUploadIntentFailed(intent.userId, intent.id, { errorCode: 'UPLOAD_VERIFY_TIMEOUT', nowIso });
      deleteObject(intent.temporaryObjectKey).catch(() => {});
      deleteObject(intent.finalObjectKey).catch(() => {});
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
  MODEL_UNRESPONSIVE: Object.freeze({ message: '模型无响应', suggestion: '上游未在规定时间内返回任务编号，本次任务已停止，请稍后重试。', action: 'retry_later' }),
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
  if (task.sourceUrl && (task.providerTaskId || task.archivePending)) return 'ARCHIVE_FAILED';
  if (/服务重启|任务.*中断|interrupted|cancelled|canceled/.test(raw)) return 'INTERRUPTED';
  if (/模型无响应|未获得上游任务\s*id|未返回上游任务编号/.test(raw)) return 'MODEL_UNRESPONSIVE';
  if (/content review|moderation|safety|policy|nsfw|审核|违规|敏感|涉政|色情|rejected/.test(raw)) return 'CONTENT_REJECTED';
  if (/unmarshal.*images|image.*\[\]string|参考图|参考素材.*(本地|同步|读取|云端|源地址)|文件本地缓存缺失|没有可用的云端归档|reference image|image[_ ]url|图片.*(格式|大小|尺寸|数量)|unsupported image/.test(raw)) return 'INVALID_REFERENCE';
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
    lastSubmissionError, lastSubmissionErrorAt, pollFailureCount, archiveFailureCount,
    submissionUncertain, submissionUncertainAt, submissionTimedOut, archivePending, sourceRequiresAuth, localReadyAt, localDeliveryDeadlineAt,
    routeBaseUrl, routeCredentialId, routeAdapter, routeVersion, ...value
  } = task;
  const failure = task.status === 'failed'
    ? { code: generationFailureCode(task), ...generationFailureCatalog[generationFailureCode(task)] }
    : null;
  const progressStage = task.status !== 'running' ? task.status
    : task.submissionUncertain ? 'awaiting_reconciliation'
      : task.archivePending ? 'archiving'
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
function resolveVideoPrompt(submittedPrompt, fallbackPrompt = '') {
  const submitted = String(submittedPrompt ?? '');
  return submitted.trim() ? submitted : String(fallbackPrompt ?? '');
}

function userDir(userId) { return path.join(userDataDir, safeId(userId)); }
/** Local cache of media binaries. The authoritative copy lives in R2. */
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
async function bodyBuffer(req, limit, tooLargeMessage = '请求体过大') { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error(tooLargeMessage), { statusCode: 413 }); chunks.push(chunk); } return Buffer.concat(chunks); }
async function bodyForm(req, limit = 1_000_000) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 }); chunks.push(chunk); } return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))); }
function sendJson(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(value)); }
function sendText(res, status, value, contentType = 'text/plain; charset=utf-8') { res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(String(value)); }
/**
 * Pagination travels in headers so the response bodies keep their original
 * shape. The front end consumes /api/generations and /api/files as bare arrays,
 * so wrapping them in a pagination envelope would break it.
 */
function setPageHeaders(res, page) {
  if (page.total !== null && page.total !== undefined) res.setHeader('X-Total-Count', String(page.total));
  if (page.nextCursor) res.setHeader('X-Next-Cursor', page.nextCursor);
}
function publicPlatformPrices(pricing, videoCapabilities) {
  const dynamicByModel = new Map();
  for (const item of publicModelPrices()) {
    const group = dynamicByModel.get(item.modelId) || [];
    group.push(item);
    dynamicByModel.set(item.modelId, group);
  }
  const seedanceIds = [VIDEO_MODEL_IDS.SEEDANCE_2, VIDEO_MODEL_IDS.SEEDANCE_2_FAST, VIDEO_MODEL_IDS.SEEDANCE_25];
  const modelOrder = { [VIDEO_MODEL_IDS.MINIMAX_H3_15S]: 10, [VIDEO_MODEL_IDS.GROK]: 20, [VIDEO_MODEL_IDS.SEEDANCE_2]: 30, [VIDEO_MODEL_IDS.SEEDANCE_25]: 40, [VIDEO_MODEL_IDS.SEEDANCE_2_FAST]: 50 };
  const models = [...(videoCapabilities.models || [])].sort((a, b) => (modelOrder[a.id] ?? 100) - (modelOrder[b.id] ?? 100));
  const items = [];
  for (const model of models) {
    if (model.enabled === false || model.availability === 'coming-soon') continue;
    if (seedanceIds.includes(model.id)) {
      const routeItems = dynamicByModel.get(model.id) || [];
      for (const item of routeItems) {
        if (!item.available || item.credits === null || item.yuan === null) continue;
        const seconds = Math.max(1, Number(item.duration) || 1);
        items.push({ ...item, enabled: true, availability: 'available', unit: 'second', totalCredits: item.credits, totalYuan: item.yuan, credits: item.credits / seconds, yuan: item.yuan / seconds });
      }
      continue;
    }
    const mode = model.modes?.find(item => item.generationType === 'TEXT') || model.modes?.[0];
    if (!mode) continue;
    for (const quality of mode.qualityOptions?.length ? mode.qualityOptions : ['标准']) {
      const price = mode.pricingByQuality?.[quality] || mode.pricing || { currency: 'credit', amount: pricing.videoPerSecond, unit: 'second' };
      const credits = Number(price.amount || 0);
      items.push({ modelId:model.id, label:model.label, quality, duration:null, available:true, enabled:model.enabled !== false, availability:model.availability || 'available', credits, yuan:credits * 0.1, unit:price.unit || 'second', priceVersion:`platform:${pricing.version}:${model.id}:${quality}` });
    }
  }
  if (isModelEnabled(fixedModels.image)) items.push({ modelId: fixedModels.image, label: 'GuGu 图像', quality: '标准', duration: null, available: true, enabled: true, availability: 'available', credits: pricing.imagePerRequest, yuan: pricing.imagePerRequest * 0.1, unit: 'request', priceVersion: `platform:${pricing.version}:image` });
  return items;
}

function configState() {
  const pricing = currentPricing();
  const videoCapabilities = publicVideoCapabilitiesWithControls();
  return {
    imageGeneration: Boolean(process.env.DUOMI_API_KEY),
    smsLogin: smsConfig.configured,
    mediaStorageReady: r2Configured,
    directUpload: r2Configured && directUploadEnabled,
    llm: isLlmConfigured(llmConfig),
    pricing: { version: pricing.version, imagePerRequest: pricing.imagePerRequest, videoPerSecond: pricing.videoPerSecond },
    videoCapabilities,
    modelPrices: publicPlatformPrices(pricing, videoCapabilities),
  };
}

// The marketing site must be able to show the same prices as the workspace
// without exposing credentials, route IDs, upstream model names, or admin
// controls. Keep this response deliberately smaller than /api/config.
function publicModelPriceState() {
  const pricing = currentPricing();
  const videoCapabilities = publicVideoCapabilitiesWithControls();
  const items = publicPlatformPrices(pricing, videoCapabilities).map(item => {
    const { selectedRouteId, selectedRouteName, ...safeItem } = item;
    return safeItem;
  });
  const pricedModelIds = new Set(items.map(item => item.modelId));
  const models = [
    { id: fixedModels.image, label: 'GuGu 图像', description: '从文字或参考图快速探索画面。', availability: 'available', qualityOptions: ['标准'] },
    ...(videoCapabilities.models || []).map(model => ({
      id: model.id,
      label: model.label,
      description: model.description || '',
      availability: model.availability || 'available',
      qualityOptions: [...new Set((model.modes || []).flatMap(mode => mode.qualityOptions || []))],
      priced: pricedModelIds.has(model.id),
    })),
  ];
  return {
    generatedAt: now(),
    currency: 'CNY',
    pricingVersion: pricing.version,
    yuanPerCredit: 0.1,
    items,
    models,
  };
}

function errorMessage(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => errorMessage(item)).filter(Boolean).join('；');
  if (value && typeof value === 'object') return errorMessage(value.message || value.msg || value.detail || value.error || value.errors || value.code) || fallback;
  return fallback;
}
function videoProgress(value) {
  const hasProgress = Object.prototype.hasOwnProperty.call(value || {}, 'progress')
    || Object.prototype.hasOwnProperty.call(value?.data || {}, 'progress');
  if (!hasProgress) return null;
  const raw = Object.prototype.hasOwnProperty.call(value || {}, 'progress') ? value.progress : value.data.progress;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}
async function notifyVideoProgress(hooks, state) {
  const progress = videoProgress(state);
  if (progress === null) return hooks.onProgressAbsent?.();
  return hooks.onProgress?.({ progress });
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
  let pollStartedAt = 0;
  try {
    const created = await fetchJson(`${duomiBase}/v1/videos/generations`, { method: 'POST', headers: { Authorization: process.env.DUOMI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(buildVideoPayload(task, refs)) });
    taskId = created.id || created.task_id;
    if (!taskId) throw Object.assign(new Error('多米视频任务没有返回任务 ID'), { provider: 'duomi', fallbackEligible: false });
    pollStartedAt = Date.now();
    for (;;) {
      const remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
      if (remainingMs <= 0) throw videoPollTimeoutError('多米', taskId);
      await sleep(Math.min(8000, remainingMs));
      const state = await fetchJson(`${duomiBase}/v1/videos/tasks/${taskId}`, {
        headers: { Authorization: process.env.DUOMI_API_KEY },
        signal: videoPollRequestSignal('多米', taskId, pollStartedAt, videoMaxPollDurationMs, 60_000),
      });
      if (['succeeded', 'completed'].includes(state.state)) return { provider: 'duomi', taskId, url: state.data?.videos?.[0]?.url };
      if (['error', 'failed'].includes(state.state)) throw Object.assign(new Error(state.message || '多米视频生成失败'), { provider: 'duomi', providerTaskId: taskId, fallbackEligible: true });
    }
  } catch (error) {
    if (pollStartedAt && Date.now() - pollStartedAt >= videoMaxPollDurationMs && !error.upstreamTerminal) error = videoPollTimeoutError('多米', taskId);
    console.error('[video] Duomi upstream failure', {
      generationId: task.id,
      modelId: task.videoModelId || task.modelId || null,
      model: task.model || null,
      phase: taskId ? 'poll' : 'submit',
      status: error.upstreamStatus || null,
      message: error.upstreamMessage || error.message,
    });
    if (taskId && error.fallbackEligible === undefined) error = Object.assign(error, { provider: 'duomi', providerTaskId: taskId, fallbackEligible: true });
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
async function pollTtapiVideo(taskId, hooks = {}, pollStartedAt = Date.now()) {
  let consecutiveErrors = 0;
  let recovering = false;
  for (;;) {
    const delay = consecutiveErrors
      ? Math.min(ttapiPollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), ttapiMaxPollBackoffMs)
      : ttapiPollIntervalMs;
    const remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
    if (remainingMs <= 0) throw videoPollTimeoutError('TTAPI', taskId);
    await sleep(Math.min(delay, remainingMs));
    if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('TTAPI', taskId);
    let state;
    try {
      state = await fetchJson(`${ttapiBase}/grok/fetch?jobId=${encodeURIComponent(taskId)}`, {
        headers: { 'TT-API-KEY': process.env.TTAPI_API_KEY },
        signal: videoPollRequestSignal('TTAPI', taskId, pollStartedAt, videoMaxPollDurationMs, ttapiRequestTimeoutMs),
      });
    } catch (error) {
      if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('TTAPI', taskId);
      if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider: 'ttapi', providerTaskId: taskId, upstreamTerminal: true });
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
    await notifyVideoProgress(hooks, state);
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
  return pollTtapiVideo(String(taskId), hooks, videoPollStartedAt(task));
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
async function pollCntcnVideo(taskId, hooks = {}, pollStartedAt = Date.now()) {
  let consecutiveErrors = 0;
  let recovering = false;
  for (;;) {
    const delay = consecutiveErrors ? Math.min(cntcnPollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), 60_000) : cntcnPollIntervalMs;
    const remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
    if (remainingMs <= 0) throw videoPollTimeoutError('CNTCN', taskId);
    await sleep(Math.min(delay, remainingMs));
    if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('CNTCN', taskId);
    let state;
    try {
      state = await fetchJson(`${cntcnBase}/videos/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${process.env.CNTCN_KEY}` },
        signal: videoPollRequestSignal('CNTCN', taskId, pollStartedAt, videoMaxPollDurationMs, cntcnRequestTimeoutMs),
      });
    } catch (error) {
      if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError('CNTCN', taskId);
      if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider:'cntcn', providerTaskId:taskId, upstreamTerminal:true });
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
    await notifyVideoProgress(hooks, state);
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
    return pollCntcnVideo(taskId, hooks, videoPollStartedAt(task));
  } catch (error) {
    if (error.upstreamTerminal) throw error;
    if (isDefinitiveSubmitRejection(error)) throw Object.assign(error, { provider: 'cntcn', upstreamTerminal: true });
    if (taskId && error.providerTaskId === undefined) throw Object.assign(new Error(error.message), { provider: 'cntcn', providerTaskId: taskId });
    throw Object.assign(new Error(`CNTCN 提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: 'cntcn', submissionUncertain: true, cause: error });
  }
}

function routedVideoPayload(task, refs) {
  const groups = Array.isArray(refs) ? { images: refs, videos: [], audios: [] } : (refs || { images: [], videos: [], audios: [] });
  const limits = task.referenceLimits || {};
  const images = groups.images?.slice(0, limits.image || 0) || [];
  const videos = groups.videos?.slice(0, limits.video || 0) || [];
  const audios = groups.audios?.slice(0, limits.audio || 0) || [];
  if (task.routeAdapter === 'cntcn-video') {
    return {
      model: task.model, prompt: task.prompt, seconds: task.duration,
      aspect_ratio: task.aspectRatio, resolution: task.quality,
      ...(images.length ? { reference_image_urls: images } : {}),
      ...(videos.length ? { reference_videos: videos } : {}),
      ...(audios.length ? { reference_audios: audios } : {}),
    };
  }
  const payload = {
    model: task.model, prompt: task.prompt,
    [task.routeAdapter === 'wj-video' ? 'seconds' : 'duration']: task.duration,
    aspect_ratio: task.aspectRatio,
  };
  if (task.routeAdapter === 'diw-video') payload.resolution = task.quality;
  if (images.length) payload.images = images;
  if (videos.length) payload.videos = videos;
  if (audios.length) payload.audios = audios;
  return payload;
}

async function pollRoutedVideo(task, hooks = {}) {
  const key = routeCredential(task.routeCredentialId);
  if (!key) throw Object.assign(new Error('任务原调用线路的 API Key 尚未配置'), { upstreamTerminal: true });
  const base = String(task.routeBaseUrl || '').replace(/\/$/, '');
  let consecutiveErrors = 0;
  const pollStartedAt = videoPollStartedAt(task);
  for (;;) {
    const delay = consecutiveErrors ? Math.min(10_000 * 2 ** Math.min(consecutiveErrors, 3), 60_000) : 10_000;
    const remainingMs = videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs);
    if (remainingMs <= 0) throw videoPollTimeoutError(task.provider, task.providerTaskId);
    await sleep(Math.min(delay, remainingMs));
    if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError(task.provider, task.providerTaskId);
    let state;
    try {
      state = await fetchJson(`${base}/v1/videos/${encodeURIComponent(task.providerTaskId)}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: videoPollRequestSignal(task.provider, task.providerTaskId, pollStartedAt, videoMaxPollDurationMs, 60_000),
      });
    } catch (error) {
      if (videoPollRemainingMs(pollStartedAt, videoMaxPollDurationMs) <= 0) throw videoPollTimeoutError(task.provider, task.providerTaskId);
      if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider:task.provider, providerTaskId:task.providerTaskId, upstreamTerminal:true });
      consecutiveErrors++;
      await hooks.onPollError?.({ consecutiveErrors, detail: upstreamRequestErrorDetail(error) });
      continue;
    }
    if (consecutiveErrors) await hooks.onPollRecovered?.();
    consecutiveErrors = 0;
    await notifyVideoProgress(hooks, state);
    const status = String(state.status || state.data?.status || '').trim().toLowerCase();
    const resultUrl = cntcnVideoUrl(state);
    if (resultUrl) return { provider: task.provider, taskId: task.providerTaskId, url: new URL(resultUrl, `${base}/`).href, requiresAuth: /\/v1\/videos\/[^/]+\/content(?:$|\?)/.test(resultUrl) };
    if (['completed', 'succeeded', 'success', 'done'].includes(status)) return { provider: task.provider, taskId: task.providerTaskId, url: `${base}/v1/videos/${encodeURIComponent(task.providerTaskId)}/content`, requiresAuth: true };
    if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) throw Object.assign(new Error(errorMessage(state.error || state, '视频生成失败')), { provider: task.provider, providerTaskId: task.providerTaskId, upstreamTerminal: true });
  }
}

async function createRoutedVideo(task, refs, hooks = {}) {
  const key = routeCredential(task.routeCredentialId);
  if (!key) throw Object.assign(new Error('当前调用线路的 API Key 尚未配置'), { upstreamTerminal: true });
  const base = String(task.routeBaseUrl || '').replace(/\/$/, '');
  let taskId = '';
  try {
    const created = await fetchJson(`${base}/v1/videos`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(routedVideoPayload(task, refs)), signal: AbortSignal.timeout(routedVideoSubmitTimeoutMs),
    });
    taskId = cntcnTaskId(created);
    if (!taskId) throw new Error('渠道已接受请求，但没有返回任务 ID');
    await hooks.onSubmitted?.({ provider: task.provider, taskId });
    task.providerTaskId = taskId;
    return pollRoutedVideo(task, hooks);
  } catch (error) {
    if (error.upstreamTerminal) throw error;
    if (isDefinitiveSubmitRejection(error)) throw Object.assign(error, { provider: task.provider, upstreamTerminal: true });
    if (taskId && error.providerTaskId === undefined) throw Object.assign(new Error(error.message), { provider: task.provider, providerTaskId: taskId });
    throw Object.assign(new Error(`${task.routeDisplayName || '视频线路'}提交结果待确认：${upstreamRequestErrorDetail(error)}`), { provider: task.provider, submissionUncertain: true, cause: error });
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
  const startedAt = Number.isFinite(runtime.startedAt) ? runtime.startedAt : nowMs();
  let consecutiveErrors = 0;
  let recovering = false;
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const remainingMs = maxDurationMs - (nowMs() - startedAt);
    if (remainingMs <= 0) break;
    const delay = consecutiveErrors
      ? Math.min(pollIntervalMs * 2 ** Math.min(consecutiveErrors, 3), 60_000)
      : pollIntervalMs;
    await wait(Math.min(delay, remainingMs));
    const requestRemainingMs = maxDurationMs - (nowMs() - startedAt);
    if (requestRemainingMs <= 0) break;
    let state;
    try {
      state = await fetchState(`${autodlBase}/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${process.env.AUTODL_COMFYUI_KEY}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(autodlRequestTimeoutMs, requestRemainingMs))),
      });
      const businessError = autodlRetryableResponseError(state);
      if (businessError) throw businessError;
    } catch (error) {
      if (maxDurationMs - (nowMs() - startedAt) <= 0) break;
      if ([401, 403].includes(Number(error.upstreamStatus))) throw Object.assign(error, { provider:'autodl', providerTaskId:taskId, upstreamTerminal:true });
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
    await notifyVideoProgress(hooks, state);
    const videoUrl = autodlVideoUrl(state);
    const status = autodlStatus(state);
    if (videoUrl) return { provider: 'autodl', taskId, url: videoUrl };
    if (['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) {
      throw Object.assign(new Error(state.msg || state.message || 'AutoDL 视频生成失败'), { provider: 'autodl', providerTaskId: taskId, upstreamTerminal: true });
    }
  }
  throw videoPollTimeoutError('AutoDL', taskId);
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
    const persistedStartedAt = Date.parse(task.submittedAt || '');
    return pollAutodlVideo(taskId, hooks, Number.isFinite(persistedStartedAt) ? { ...runtime, startedAt:persistedStartedAt } : runtime);
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
function isLegacyOaiGrokTask(task) {
  return task?.provider === 'oai' && [LEGACY_VIDEO_MODEL_IDS.GUGU_2, LEGACY_VIDEO_MODEL_IDS.GROK_VIDEO_1_5].includes(task?.videoModelId);
}
function canonicalVideoModelId(value) {
  const modelId = String(value || '').trim().toLowerCase();
  return modelId === LEGACY_VIDEO_MODEL_IDS.GUGU_2 ? VIDEO_MODEL_IDS.MINIMAX_H3_15S : modelId;
}
function oaiKeyForTask(task) {
  if (isLegacyOaiGrokTask(task)) return process.env.OAIAPI_GROK_KEY;
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
  const isLegacyGrokOai = isLegacyOaiGrokTask(task);
  const payload = { model: task.model, prompt: task.prompt, aspect_ratio: task.aspectRatio, seconds: isLegacyGrokOai ? String(task.duration) : task.duration };
  if (isLegacyGrokOai) {
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
  let pollStartedAt = 0;
  try {
    const request = oaiVideoRequest(task, refs, apiKey);
    const created = await fetchJson(`${oaiBase}/videos`, { method: 'POST', ...request, signal: AbortSignal.timeout(oaiRequestTimeoutMs) });
    taskId = oaiTaskId(created);
    const submittedUrl = oaiVideoUrl(created);
    if (submittedUrl && taskId) return { provider: 'oai', taskId, url: submittedUrl, requiresAuth: /\/videos\/[^/]+\/content(?:$|\?)/.test(submittedUrl) };
    if (!taskId) throw new Error('OAI 视频任务没有返回任务 ID');
    pollStartedAt = Date.now();
    for (let i = 0; i < oaiMaxPolls; i++) {
      const remainingMs = videoPollRemainingMs(pollStartedAt, oaiMaxPollDurationMs);
      if (remainingMs <= 0) break;
      await sleep(Math.min(oaiPollIntervalMs, remainingMs));
      if (videoPollRemainingMs(pollStartedAt, oaiMaxPollDurationMs) <= 0) break;
      const state = await fetchJson(`${oaiBase}/videos/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: videoPollRequestSignal('OAI', taskId, pollStartedAt, oaiMaxPollDurationMs, oaiRequestTimeoutMs),
      });
      const videoUrl = oaiVideoUrl(state);
      const status = oaiStatus(state);
      if (videoUrl) return { provider: 'oai', taskId, url: videoUrl, requiresAuth: /\/videos\/[^/]+\/content(?:$|\?)/.test(videoUrl) };
      if (['SUCCEEDED', 'SUCCESS', 'COMPLETED', 'COMPLETE', 'DONE'].includes(status)) {
        if (task.videoModelId === VIDEO_MODEL_IDS.VEO_31) throw new Error('Veo 3.1 任务已完成，但响应没有返回顶层 video_url');
        if (task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3) throw new Error('MiniMax H3 任务已完成，但响应没有返回 video_url');
        return { provider: 'oai', taskId, url: `${oaiBase}/videos/${encodeURIComponent(taskId)}/content`, requiresAuth: true };
      }
      if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status)) throw new Error(errorMessage(state, 'OAI 视频生成失败'));
    }
    throw videoPollTimeoutError('OAI', taskId);
  } catch (error) {
    if (pollStartedAt && Date.now() - pollStartedAt >= oaiMaxPollDurationMs && !error.upstreamTerminal) error = videoPollTimeoutError('OAI', taskId);
    if (taskId && error.providerTaskId === undefined) error = Object.assign(error, { provider: 'oai', providerTaskId: taskId });
    throw error;
  }
}
async function createVideo(task, refs, hooks = {}) {
  if (task.routeId) return createRoutedVideo(task, refs, hooks);
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
      const message = isLegacyOaiGrokTask(task)
        ? '历史 Grok Video 服务尚未配置'
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
  project.projectAssetIds = Array.isArray(project.projectAssetIds) ? [...new Set(project.projectAssetIds.map(String).filter(Boolean))].slice(0, 200) : [];
  project.projectAssetCategories = project.projectAssetCategories && typeof project.projectAssetCategories === 'object' && !Array.isArray(project.projectAssetCategories) ? Object.fromEntries(Object.entries(project.projectAssetCategories).filter(([id, category]) => project.projectAssetIds.includes(String(id)) && ['characters','locations','props','other'].includes(category)).slice(0, 200)) : {};
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
    const assetMentions = Array.isArray(shot.assetMentions)
      ? shot.assetMentions.map(item => ({ id:String(item?.id || ''), label:String(item?.label || '').replace(/^@/, '').trim().slice(0, 120), kind:['image','video','audio'].includes(item?.kind) ? item.kind : 'image' })).filter(item => item.id && item.label).slice(0, 40)
      : [];
    const mentionedIds = assetMentions.map(item => item.id);
    const referenceAssetIds = [...new Set([...(Array.isArray(shot.referenceAssetIds) ? shot.referenceAssetIds.map(String) : []), ...categorizedIds, ...mentionedIds])];
    const requestedGenerationType = ['TEXT','FIRST&LAST','REFERENCE'].includes(shot.generation?.type) ? shot.generation.type : (referenceAssetIds.length ? 'REFERENCE' : 'TEXT');
    const generationType = requestedGenerationType;
    const professionalShot = project.mode === 'professional';
    const firstFrameAssetId = String(shot.generation?.firstFrameAssetId || (!professionalShot ? referenceAssetIds[0] : '') || '');
    const lastFrameAssetId = String(shot.generation?.lastFrameAssetId || '');
    const explicitReferences = Array.isArray(shot.generation?.referenceAssetIds) ? shot.generation.referenceAssetIds.map(String) : [];
    const generationReferenceAssetIds = generationType === 'TEXT'
      ? []
      : generationType === 'FIRST&LAST'
        ? [firstFrameAssetId, lastFrameAssetId].filter(Boolean).slice(0, 2)
        : [...new Set([...explicitReferences, ...referenceAssetIds])];
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
    return { id:shot.id || randomUUID(), shotNumber:index + 1, sceneNumber:Math.max(1,Number(shot.sceneNumber)||Math.max(1,project.scenes.findIndex(scene=>scene.id===shot.sceneId)+1)), sceneId:String(shot.sceneId || project.scenes[Math.max(0,(Number(shot.sceneNumber)||1)-1)]?.id || project.scenes[0]?.id || ''), title:String(shot.title || `分镜 ${index + 1}`), sourceBeatIds:Array.isArray(shot.sourceBeatIds)?shot.sourceBeatIds.map(String):[], script:String(shot.script || ''), assetMentions, prompt:String(shot.prompt || shot.visualDirection || ''), visualDirection:String(shot.visualDirection || shot.prompt || ''), narrativeFunction:String(shot.narrativeFunction || ''), shotSize:String(shot.shotSize || '中景'), cameraMovement:String(shot.cameraMovement || '固定'), framing:String(shot.framing || ''), startStateId:String(shot.startStateId || ''), startState:String(shot.startState || ''), action:String(shot.action || shot.script || ''), endStateId:String(shot.endStateId || ''), endState:String(shot.endState || ''), continuityNotes:String(shot.continuityNotes || ''), sound:String(shot.sound || ''), negativePrompt:String(shot.negativePrompt || '禁止人物变脸、服装变化、道具消失、空间轴线跳变'), motionPlan:normalizeMotionPlan(shot.motionPlan), duration:dramaVideoDurations.has(Number(shot.duration)) ? Number(shot.duration) : project.settings.shotDuration, aspectRatio:videoAspectRatios.has(shot.aspectRatio) ? shot.aspectRatio : project.settings.aspectRatio, resourceIds:Array.isArray(shot.resourceIds) ? shot.resourceIds : [], referenceAssetIds, professionalAssets, pendingImageGenerations, generation:{ type:generationType, modelId:canonicalVideoModelId(shot.generation?.modelId), firstFrameAssetId, lastFrameAssetId, referenceAssetIds:generationReferenceAssetIds, quality:['480p','720p','768p','1080p','4k'].includes(shot.generation?.quality) ? shot.generation.quality : '720p', count:[1,2,4].includes(Number(shot.generation?.count)) ? Number(shot.generation.count) : 1 }, lifecycle:{ status:String(shot.lifecycle?.status || (shot.selectedVideoTaskId ? 'generated' : 'draft')), revision:Math.max(1,Number(shot.lifecycle?.revision)||1), staleReasons:Array.isArray(shot.lifecycle?.staleReasons) ? shot.lifecycle.staleReasons.map(String) : [] }, videoVersions:Array.isArray(shot.videoVersions) ? shot.videoVersions : [], selectedVideoTaskId:String(shot.selectedVideoTaskId || ''), tailFrameAssetId:String(shot.tailFrameAssetId || '') };
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
function removeGenerationFromDramaProject(project, taskId) {
  const id=String(taskId||'');
  if(!project||!id)return false;
  let changed=false;
  const removeFromList=(value,assign)=>{
    if(!Array.isArray(value)||!value.some(item=>String(item)===id))return;
    assign(value.filter(item=>String(item)!==id));
    changed=true;
  };
  (Array.isArray(project.resources)?project.resources:[]).forEach(resource=>{
    removeFromList(resource.versions||[],next=>{resource.versions=next;});
    if(String(resource.selectedTaskId||'')===id){
      resource.selectedTaskId=resource.versions.at(-1)||'';
      resource.lifecycle={...resource.lifecycle,status:resource.selectedTaskId?'approved':'draft',approvedAt:resource.selectedTaskId?resource.lifecycle?.approvedAt||'':''};
      changed=true;
    }
  });
  (Array.isArray(project.shots)?project.shots:[]).forEach(shot=>{
    removeFromList(shot.videoVersions||[],next=>{shot.videoVersions=next;});
    if(String(shot.selectedVideoTaskId||'')===id){shot.selectedVideoTaskId=shot.videoVersions.at(-1)||'';changed=true;}
    if(Array.isArray(shot.pendingImageGenerations)&&shot.pendingImageGenerations.some(item=>String(item?.taskId||'')===id)){
      shot.pendingImageGenerations=shot.pendingImageGenerations.filter(item=>String(item?.taskId||'')!==id);
      changed=true;
    }
  });
  (Array.isArray(project.storyboard?.shots)?project.storyboard.shots:[]).forEach(shot=>{
    if(String(shot.videoTaskId||'')===id){shot.videoTaskId='';changed=true;}
    if(String(shot.keyframeTaskId||'')===id){shot.keyframeTaskId='';changed=true;}
  });
  if(changed)normalizeDramaProject(project);
  return changed;
}
async function removeGenerationFromDramaProjects(userId, task) {
  const id=String(task?.id||'');
  if(!id)return;
  const targetId=safeId(task?.dramaProjectId);
  const projects=[];
  if(targetId){
    const project=findDramaProject(userId,targetId);
    if(project)projects.push(project);
  }
  if(!projects.length){
    let cursor=null;
    do{
      const page=listDramaProjects(userId,{limit:200,cursor});
      projects.push(...page.items);
      cursor=page.nextCursor;
    }while(cursor);
  }
  for(const project of projects)if(removeGenerationFromDramaProject(project,id))await saveDramaProject(userId,project);
}
// 单条与批量的本地接收确认共用同一套校验和副作用：写回素材元数据、标记该设备投递完成、
// 结束对应生成任务的归档重试。返回 { error, status } 表示这一条被拒绝，调用方决定是整个
// 请求失败（单条入口）还是只记录该条结果（批量入口）。
const localReadyBatchLimit = 200;
async function applyLocalReadyAcknowledgement(userId, asset, { size, sha256, mimeType, deviceId = '' } = {}) {
  const normalizedSize = Number(size);
  const normalizedSha256 = String(sha256 || '').trim().toLowerCase();
  const normalizedMimeType = String(mimeType || '').trim().toLowerCase();
  if (!Number.isSafeInteger(normalizedSize) || normalizedSize <= 0) return { status: 400, error: '本地文件大小无效' };
  if (!/^[a-f0-9]{64}$/.test(normalizedSha256)) return { status: 400, error: '本地文件 SHA-256 无效' };
  if (![...imageTypes, ...videoTypes, ...audioTypes].includes(normalizedMimeType)) return { status: 400, error: '本地文件类型无效' };
  asset.size = normalizedSize;
  asset.sha256 = normalizedSha256;
  asset.mimeType = normalizedMimeType;
  asset.deliveryStatus = 'local_ready';
  asset.localReadyAt = now();
  asset.remoteStatus = asset.objectKey ? 'ready' : 'local_only';
  await saveAsset(userId, asset);
  if (deviceId) markAssetDeliveryReady(userId, deviceId, asset.id);
  if (asset.sourceGenerationId) {
    const task = findGeneration(userId, asset.sourceGenerationId);
    if (task?.assetId === asset.id) {
      task.archivePending = false;
      task.localReadyAt = asset.localReadyAt;
      task.localDeliveryDeadlineAt = '';
      task.lastArchiveError = '';
      task.lastArchiveErrorAt = null;
      task.status = 'completed';
      task.error = '';
      task.finishedAt ||= asset.localReadyAt;
      await saveGenerationWithRetry(userId, task, 'local-delivery-ack');
      const timer = generationRetryTimers.get(task.id);
      if (timer) { clearTimeout(timer); generationRetryTimers.delete(task.id); }
    }
  }
  return { asset };
}
async function deleteAssetRecord(userId, asset) { if (!asset) return; if (asset.objectKey) await deleteObject(asset.objectKey); deleteAsset(userId, asset.id); await fs.unlink(path.join(assetFilesDir(userId), asset.storageName)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
function publicAsset(asset) {
  const { ownerId, storageName, sourceUrl, sourceRequiresAuth, objectKey, objectUploadedAt, ...value } = asset;
  const url = `/api/files/${encodeURIComponent(asset.id)}/content`;
  return {
    ...value,
    ...(asset.sourceGenerationId ? { sourceGenerationId: asset.sourceGenerationId } : {}),
    referenceSourceAvailable: Boolean(asset.sourceUrl),
    remoteStatus: asset.objectKey ? 'ready' : (asset.remoteStatus || (asset.sourceUrl ? 'pending' : 'local_only')),
    url,
    directUrl: `/api/files/${encodeURIComponent(asset.id)}/direct`,
    ...(asset.kind === 'image' ? { previewUrl: `/api/files/${encodeURIComponent(asset.id)}/preview` } : {}),
  };
}
function assetObjectKey(userId, storageName) { const extension = path.extname(storageName).toLowerCase().replace(/[^a-z0-9.]/g, ''); const base = safeId(path.basename(storageName, path.extname(storageName))); return [storagePrefix, safeId(userId), `${base}${extension}`].filter(Boolean).join('/'); }
async function withMediaTempDir(label, callback) {
  const jobDir = path.join(mediaTmpDir, `${safeId(label) || 'job'}-${randomUUID()}`);
  await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
  try { return await callback(jobDir); }
  finally { await fs.rm(jobDir, { recursive: true, force: true }).catch(error => console.error(`[media] 临时目录清理失败 ${jobDir}`, error.message)); }
}
async function uploadAssetFile(userId, asset, sourceFile) {
  if (!r2Configured) throw storageUnavailable();
  const key = asset.objectKey || assetObjectKey(userId, asset.storageName);
  await putObject(key, sourceFile, asset.mimeType);
  asset.objectKey = key; asset.objectUploadedAt = now();
  await saveAsset(userId, asset);
  return key;
}
function uploadExtension(mimeType, name = '') {
  const requested = path.extname(String(name)).toLowerCase().replace(/[^a-z0-9.]/g, '');
  if (requested && requested.length <= 10) return requested;
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.weba', 'audio/flac': '.flac' }[mimeType] || '');
}
function pendingUploadKey(userId, uploadId, mimeType, name) { return [storagePrefix, 'pending', safeId(userId), `${safeId(uploadId)}${uploadExtension(mimeType, name)}`].filter(Boolean).join('/'); }
function finalUploadKey(userId, assetId, mimeType, name) { return [storagePrefix, 'assets', safeId(userId), `${safeId(assetId)}${uploadExtension(mimeType, name)}`].filter(Boolean).join('/'); }
function storageUnavailable(label = 'R2') { return Object.assign(new Error(`${label} 文件存储服务尚未配置`), { statusCode: 503 }); }
async function putObject(key, sourceFile, mimeType) {
  if (!r2) throw storageUnavailable();
  const body = typeof sourceFile === 'string' ? createReadStream(sourceFile) : sourceFile;
  const contentLength = typeof sourceFile === 'string' ? (await fs.stat(sourceFile)).size : undefined;
  await r2.send(new PutObjectCommand({ Bucket: r2Bucket, Key: key, Body: body, ...(contentLength === undefined ? {} : { ContentLength: contentLength }), ContentType: mimeType }));
  return key;
}
async function putR2ReferenceObject(key, sourceFile, mimeType) {
  if (!r2Reference) throw storageUnavailable('r2-reference');
  const body = typeof sourceFile === 'string' ? createReadStream(sourceFile) : sourceFile;
  const contentLength = typeof sourceFile === 'string' ? (await fs.stat(sourceFile)).size : undefined;
  await r2Reference.send(new PutObjectCommand({ Bucket: r2ReferenceBucket, Key: key, Body: body, ...(contentLength === undefined ? {} : { ContentLength: contentLength }), ContentType: mimeType }));
  return key;
}
async function deleteR2ReferenceObject(key) {
  if (!r2Reference) throw storageUnavailable('r2-reference');
  await r2Reference.send(new DeleteObjectCommand({ Bucket: r2ReferenceBucket, Key: key }));
}
async function deleteObject(key) {
  if (!r2) throw storageUnavailable();
  await r2.send(new DeleteObjectCommand({ Bucket: r2Bucket, Key: key }));
}
function r2ReferenceImageKey(userId, generationId, asset) {
  const extension = uploadExtension(asset?.mimeType, asset?.storageName) || '.bin';
  return [r2ReferenceImagePrefix, safeId(userId), safeId(generationId), `${Date.now()}-${randomUUID()}${extension}`].filter(Boolean).join('/');
}
function clearR2ReferenceImageCleanup(key) {
  const timer = r2ReferenceImageCleanupTimers.get(key);
  if (timer) clearTimeout(timer);
  r2ReferenceImageCleanupTimers.delete(key);
}
// Live requests get an exact-key timer. After a process restart, expiration is
// handled by the R2 lifecycle rule on r2ReferenceImagePrefix; there is no
// bucket-wide ListObjects scan in the application hot path.
function scheduleR2ReferenceImageCleanup(key, deleteAt = Date.now() + r2ReferenceImageTtlMs) {
  clearR2ReferenceImageCleanup(key);
  const timer = setTimeout(async () => {
    r2ReferenceImageCleanupTimers.delete(key);
    try { await deleteR2ReferenceObject(key); }
    catch (error) { console.error('[image-reference] R2 临时参考图清理失败', { key, message: error.message }); }
  }, Math.max(0, deleteAt - Date.now()));
  timer.unref();
  r2ReferenceImageCleanupTimers.set(key, timer);
}
function storageStatus(error) { return error?.$metadata?.httpStatusCode || error?.status || error?.statusCode || error?.res?.status; }
function isStorageNotFound(error) {
  const status = storageStatus(error);
  const code = String(error?.name || error?.code || '');
  return status === 404 || /NoSuchKey|NotFound|NoSuchObject/i.test(code);
}
async function headObject(key) {
  if (!r2) throw storageUnavailable();
  try {
    const result = await r2.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
    return { size: Number(result.ContentLength || 0), mimeType: String(result.ContentType || '').split(';')[0].toLowerCase(), etag: String(result.ETag || '').replace(/^"|"$/g, ''), status: result.$metadata?.httpStatusCode || 200 };
  } catch (error) {
    error.status = storageStatus(error);
    throw error;
  }
}
async function readObjectPrefix(key) {
  if (!r2) throw storageUnavailable();
  const result = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key, Range: 'bytes=0-63' }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).subarray(0, 64);
}
async function copyObject(sourceKey, destinationKey, mimeType) {
  if (!r2) throw storageUnavailable();
  const copySource = `/${r2Bucket}/${sourceKey.split('/').map(encodeURIComponent).join('/')}`;
  await r2.send(new CopyObjectCommand({ Bucket: r2Bucket, Key: destinationKey, CopySource: copySource, MetadataDirective: 'REPLACE', ContentType: mimeType }));
}
function publicR2ReferenceUrl(key) {
  return r2ReferencePublicBaseUrl ? `${r2ReferencePublicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}` : '';
}
async function signedAssetUrl(key, expires = assetUrlExpiresSeconds, { cacheControl = '' } = {}) {
  if (!r2) throw storageUnavailable();
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: r2Bucket, Key: key, ...(cacheControl ? { ResponseCacheControl: cacheControl } : {}) }), { expiresIn: expires });
}
async function signedUploadUrl(key, mimeType, expires = uploadUrlExpiresSeconds) {
  if (!r2) throw storageUnavailable();
  return getSignedUrl(r2, new PutObjectCommand({ Bucket: r2Bucket, Key: key, ContentType: mimeType }), { expiresIn: expires });
}
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
function supportLogRateAllowed(userId, timestamp = Date.now()) {
  const key = String(userId);
  const current = supportLogAttempts.get(key);
  if (!current || timestamp - current.startedAt >= supportLogWindowMs) {
    supportLogAttempts.set(key, { startedAt: timestamp, count: 1 });
    return true;
  }
  if (current.count >= supportLogLimitPerHour) return false;
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
  try { meta = await headObject(intent.temporaryObjectKey); } catch (error) {
    throw Object.assign(new Error('上传对象不存在或暂时不可读取'), { statusCode: 422, code: 'UPLOAD_OBJECT_MISSING', cause: error });
  }
  if (meta.size !== Number(intent.expectedSize)) throw Object.assign(new Error('上传文件大小校验失败'), { statusCode: 422, code: 'UPLOAD_SIZE_MISMATCH', actualSize: meta.size, objectEtag: meta.etag });
  if (normalizeUploadMime(meta.mimeType) !== String(intent.mimeType).toLowerCase()) throw Object.assign(new Error('上传文件类型校验失败'), { statusCode: 422, code: 'UPLOAD_MIME_MISMATCH', actualSize: meta.size, objectEtag: meta.etag });
  const prefix = await readObjectPrefix(intent.temporaryObjectKey);
  if (!magicMatches(intent.mimeType, prefix)) throw Object.assign(new Error('文件内容与声明类型不一致'), { statusCode: 422, code: 'UPLOAD_MAGIC_MISMATCH', actualSize: meta.size, objectEtag: meta.etag });
  return meta;
}
async function promoteUploadedObject(intent) {
  if (!r2Configured) throw storageUnavailable();
  try {
    const existing = await headObject(intent.finalObjectKey);
    if (existing.size === Number(intent.expectedSize) && existing.mimeType === String(intent.mimeType).toLowerCase()) return existing;
    throw Object.assign(new Error('正式对象已存在但内容不匹配'), { statusCode: 409, code: 'UPLOAD_FINAL_CONFLICT' });
  } catch (error) {
    if (error.code === 'UPLOAD_FINAL_CONFLICT') throw error;
    if (!isStorageNotFound(error)) throw error;
  }
  await copyObject(intent.temporaryObjectKey, intent.finalObjectKey, intent.mimeType);
  return headObject(intent.finalObjectKey);
}
async function uploadAsset(userId, asset) {
  if (!r2Configured) throw storageUnavailable();
  const key = asset.objectKey || assetObjectKey(userId, asset.storageName);
  await putObject(key, path.join(assetFilesDir(userId), asset.storageName), asset.mimeType);
  asset.objectKey = key; asset.objectUploadedAt = now();
  await saveAsset(userId, asset);
  return key;
}
async function ensureLocalAsset(userId, asset, targetDir = assetFilesDir(userId)) {
  const permanentFile = path.join(assetFilesDir(userId), asset.storageName);
  if (await fs.access(permanentFile).then(() => true).catch(() => false)) return permanentFile;
  const localFile = path.join(targetDir, asset.storageName);
  const restoreKey = `${safeId(userId)}:${asset.id}:${targetDir}`;
  if (assetRestores.has(restoreKey)) return assetRestores.get(restoreKey);
  const restore = (async () => {
    await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
    if (await fs.access(localFile).then(() => true).catch(() => false)) return localFile;
    if (r2Configured && asset.objectKey) {
      const url = await signedAssetUrl(asset.objectKey);
      await downloadToFile(url, localFile, 4);
      return localFile;
    }
    if (asset.sourceUrl) {
      const sourceUrl = new URL(asset.sourceUrl);
      if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('参考素材源地址不可用');
      const sourceTask = asset.sourceGenerationId ? findGeneration(userId, asset.sourceGenerationId) : null;
      await downloadToFile(sourceUrl.toString(), localFile, 4, { headers:generationSourceHeaders(sourceTask, sourceUrl.toString()) });
      return localFile;
    }
    throw Object.assign(new Error('参考素材仅存在于桌面本地，尚未同步到云端'), { statusCode:409, code:'REFERENCE_NOT_READY' });
  })().finally(() => assetRestores.delete(restoreKey));
  assetRestores.set(restoreKey, restore);
  return restore;
}
async function stageImageReference(userId, task, asset, targetDir) {
  if (!r2Reference) throw storageUnavailable('r2-reference');
  const sourceFile = await ensureLocalAsset(userId, asset, targetDir);
  const key = r2ReferenceImageKey(userId, task.id, asset);
  let uploaded = false;
  try {
    await putR2ReferenceObject(key, sourceFile, asset.mimeType);
    uploaded = true;
    const publicUrl = publicR2ReferenceUrl(key);
    const url = publicUrl || await getSignedUrl(r2Reference, new GetObjectCommand({ Bucket: r2ReferenceBucket, Key: key, ResponseCacheControl: 'private, no-store' }), { expiresIn: Math.ceil(r2ReferenceImageTtlMs / 1_000) });
    scheduleR2ReferenceImageCleanup(key);
    return url;
  } catch (error) {
    if (uploaded) await deleteR2ReferenceObject(key).catch(cleanupError => console.error('[image-reference] R2 临时参考图回滚失败', { key, message: cleanupError.message }));
    throw error;
  }
}
async function resolveImageRefs(userId, ids, task = {}) {
  const referenceIds = ids.slice(0, task.referenceLimits?.image || 7);
  if (!referenceIds.length) return [];
  if (!r2Reference) throw storageUnavailable('r2-reference');
  // Image providers may fetch the reference after submission. Always stage a
  // short-lived copy in the dedicated reference bucket.
  return withMediaTempDir(`image-reference-${task.id}`, async jobDir => {
    const refs = [];
    for (const id of referenceIds) {
      const asset = findAsset(userId, id);
      if (!asset || asset.kind !== 'image') continue;
      refs.push(await stageImageReference(userId, task, asset, jobDir));
    }
    return refs;
  });
}
async function resolveRefs(userId, ids, task = {}) {
  const mixed = task.routeId || task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_2 || task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_25 || task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_2_FAST || task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3 || task.provider === 'autodl';
  const refs = mixed ? { images: [], videos: [], audios: [] } : [];
  // Image references use the dedicated reference bucket; video and audio
  // references use longer-lived signed URLs from the private media bucket.
  return withMediaTempDir(`video-reference-${task.id}`, async jobDir => {
    for (const id of ids.slice(0, task.referenceLimits?.total || 15)) {
      const asset = findAsset(userId, id);
      if (!asset || !['image', 'video', 'audio'].includes(asset.kind)) continue;
      if (!mixed && asset.kind !== 'image') continue;
      let url;
      if (asset.kind === 'image') {
        url = await stageImageReference(userId, task, asset, jobDir);
      } else {
        const key = asset.objectKey || await uploadAsset(userId, asset);
        url = await signedAssetUrl(key, modelInputUrlExpiresSeconds);
      }
      if (mixed) refs[`${asset.kind}s`].push(url);
      else refs.push(url);
    }
    return refs;
  });
}
async function validateReferenceAssets(userId, value, limits = null, { requireReadable = true } = {}) {
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
    if (asset.kind === 'image' && Number(asset.size) > maxReferenceImageBytes) throw Object.assign(new Error(`参考图“${asset.name}”超过 20 MB`), { statusCode: 400 });
    if (asset.kind !== 'image' && Number(asset.size) > maxUploadBytes) throw Object.assign(new Error(`参考素材“${asset.name}”超过 25 MB`), { statusCode: 400 });
    if (requireReadable && !await referenceAssetHasReadableSource(userId, asset)) throw Object.assign(new Error(`参考素材“${asset.name}”尚未同步到云端，请重新选择或上传后再试`), { statusCode:409, code:'REFERENCE_NOT_READY' });
  }
  return ids;
}
function referenceAssetCounts(userId, ids) {
  const counts = { image: 0, video: 0, audio: 0 };
  for (const id of ids || []) {
    const asset = findAsset(userId, id);
    if (asset && Object.hasOwn(counts, asset.kind)) counts[asset.kind]++;
  }
  return counts;
}
function normalizeQuoteReferenceCounts(value) {
  const counts = { image: 0, video: 0, audio: 0 };
  if (value === undefined || value === null) return counts;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('参考素材数量格式无效'), { statusCode:400 });
  for (const kind of Object.keys(counts)) {
    const count = value[kind] === undefined ? 0 : Number(value[kind]);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100) throw Object.assign(new Error('参考素材数量无效'), { statusCode:400 });
    counts[kind] = count;
  }
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) > 100) throw Object.assign(new Error('参考素材数量过多'), { statusCode:400 });
  return counts;
}
async function referenceAssetHasReadableSource(userId, asset) {
  if (!asset?.storageName) return false;
  const permanentFile = path.join(assetFilesDir(userId), asset.storageName);
  if (await fs.access(permanentFile).then(() => true).catch(() => false)) return true;
  if (asset.objectKey && r2Configured) return true;
  if (!asset.sourceUrl) return false;
  try { return ['http:', 'https:'].includes(new URL(asset.sourceUrl).protocol); }
  catch { return false; }
}
function generationSourceHeaders(task, resultUrl) {
  const routeContent = task?.routeId && /\/v1\/videos\/[^/]+\/content(?:$|\?)/.test(String(resultUrl || ''));
  if (routeContent) return { Authorization: `Bearer ${routeCredential(task.routeCredentialId)}` };
  const contentUrl = task?.provider === 'oai' ? `${oaiBase}/videos/${encodeURIComponent(task.providerTaskId)}/content` : '';
  if (contentUrl && resultUrl === contentUrl) return { Authorization: `Bearer ${oaiKeyForTask(task)}` };
  return {};
}
function generationAssetExtension(task) { return task?.type === 'image' ? '.png' : '.mp4'; }
function generationAssetName(task, extension = generationAssetExtension(task)) {
  return `${task?.type === 'image' ? '生成图片' : '生成视频'} ${new Date(task?.createdAt || Date.now()).toLocaleString('zh-CN')}${extension}`;
}
async function prepareGenerationAsset(userId, task, result) {
  const assetId = task.assetId || `generation-${task.id}`;
  const extension = generationAssetExtension(task);
  const existing = findAsset(userId, assetId);
  if (existing?.sourceGenerationId === task.id && existing.objectKey) return existing;
  const asset = {
    ...(existing || {}),
    id: assetId,
    ownerId: userId,
    name: existing?.name || generationAssetName(task, extension),
    kind: task.type,
    mimeType: existing?.mimeType || (task.type === 'image' ? 'image/png' : 'video/mp4'),
    size: Number(existing?.size) || 0,
    storageName: existing?.storageName || `${assetId}${extension}`,
    source: 'generation',
    sourceGenerationId: task.id,
    sourceUrl: result.url,
    sourceRequiresAuth: Boolean(result.requiresAuth),
    deliveryStatus: existing?.deliveryStatus === 'local_ready' ? 'local_ready' : 'awaiting_local',
    remoteStatus: existing?.objectKey ? 'ready' : 'pending',
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
  };
  await saveAsset(userId, asset);
  return asset;
}
async function servePendingGenerationSource(res, asset) {
  if (!asset?.sourceUrl || asset.objectKey) return false;
  const sourceUrl = new URL(asset.sourceUrl);
  if (!['http:', 'https:'].includes(sourceUrl.protocol)) return false;
  if (!asset.sourceRequiresAuth) {
    res.writeHead(302, { Location: sourceUrl.toString(), 'Cache-Control': 'private, no-store' });
    res.end();
    return true;
  }
  const task = asset.sourceGenerationId ? findGeneration(asset.ownerId, asset.sourceGenerationId) : null;
  const response = await fetch(sourceUrl, { headers: generationSourceHeaders(task, sourceUrl.toString()), signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) {
    sendJson(res, response.status || 502, { error: `上游成品下载失败（${response.status || '无响应'}）` });
    return true;
  }
  const contentType = response.headers.get('content-type')?.split(';')[0] || asset.mimeType || 'application/octet-stream';
  const contentLength = response.headers.get('content-length');
  const headers = { 'Content-Type': contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (contentLength) headers['Content-Length'] = contentLength;
  res.writeHead(200, headers);
  Readable.fromWeb(response.body).pipe(res);
  return true;
}
async function archiveGenerationResult(userId, task, resultUrl) {
  const assetId = task.assetId || `generation-${task.id}`;
  const existing = findAsset(userId, assetId);
  if (existing?.sourceGenerationId === task.id && existing.objectKey) {
    task.assetId = assetId;
    task.status = 'completed';
    task.error = '';
    return;
  }
  return withMediaTempDir(`generation-${task.id}`, async jobDir => {
    const extension = generationAssetExtension(task);
    const storageName = `${assetId}${extension}`;
    const localFile = path.join(jobDir, storageName);
    const downloadHeaders = generationSourceHeaders(task, resultUrl);
    const saved = await downloadToFile(resultUrl, localFile, 4, { headers: downloadHeaders });
    const asset = {
      ...(existing || {}),
      id: assetId,
      ownerId: userId,
      name: existing?.name || generationAssetName(task, extension),
      kind: task.type,
      mimeType: saved.contentType,
      size: saved.size,
      storageName,
      source: 'generation',
      sourceGenerationId: task.id,
      sourceUrl: resultUrl,
      sourceRequiresAuth: Boolean(task.sourceRequiresAuth),
      deliveryStatus: 'remote_backed_up',
      remoteStatus: 'ready',
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    };
    await uploadAssetFile(userId, asset, localFile);
    task.assetId = assetId;
    task.status = 'completed';
    task.error = '';
  });
}
function progressPersistenceHooks(userId, task) {
  return {
    onProgress: async ({ progress }) => {
      if (task.progress === progress) return;
      task.progress = progress;
      await saveGeneration(userId, task);
    },
    onProgressAbsent: async () => {
      if (!Object.prototype.hasOwnProperty.call(task, 'progress')) return;
      delete task.progress;
      await saveGeneration(userId, task);
    },
  };
}
function ttapiPersistenceHooks(userId, task) {
  return {
    ...progressPersistenceHooks(userId, task),
    onSubmitted: async ({ provider, taskId }) => {
      clearProviderTaskIdTimeout(task.id);
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
    ...progressPersistenceHooks(userId, task),
    onSubmitted: async ({ provider, taskId }) => {
      clearProviderTaskIdTimeout(task.id);
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
function routedPersistenceHooks(userId, task) { return cntcnPersistenceHooks(userId, task); }
function autodlPersistenceHooks(userId, task) {
  return {
    ...progressPersistenceHooks(userId, task),
    onSubmitted: async ({ provider, taskId }) => {
      clearProviderTaskIdTimeout(task.id);
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
  const deadline = Date.parse(task.localDeliveryDeadlineAt || '');
  const remaining = Number.isFinite(deadline) ? deadline - Date.now() : NaN;
  const delay = Number.isFinite(remaining) && remaining > 0 ? remaining : archiveRescheduleMs;
  const timer = setTimeout(() => {
    generationRetryTimers.delete(task.id);
    const current = findGeneration(userId, task.id);
    if (current?.archivePending && current.sourceUrl && !current.localReadyAt) {
      resumeGenerationArchive(userId, current);
    }
  }, delay);
  timer.unref();
  generationRetryTimers.set(task.id, timer);
}
async function archiveGenerationWithRetry(userId, task) {
  if (!task.archivePending || task.localReadyAt) return true;
  let failures = Number(task.archiveFailureCount) || 0;
  for (let attempt = 1; attempt <= archiveAttemptsPerRun; attempt++) {
    try {
      await archiveGenerationResult(userId, task, task.sourceUrl);
      task.archiveFailureCount = 0;
      task.archivePending = false;
      task.localDeliveryDeadlineAt = '';
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
  task.sourceRequiresAuth = Boolean(result.requiresAuth);
  const asset = await prepareGenerationAsset(userId, task, result);
  task.assetId = asset.id;
  task.archivePending = true;
  task.localReadyAt = '';
  task.localDeliveryDeadlineAt = new Date(Date.now() + desktopDirectDeliveryGraceMs).toISOString();
  task.status = 'completed';
  task.error = '';
  await saveGenerationWithRetry(userId, task, 'provider-result');
  task.creditStatus = 'charged';
  await saveGenerationWithRetry(userId, task, 'local-delivery-ready');
  scheduleGenerationArchive(userId, task);
  return true;
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
function providerTaskIdDeadline(task) {
  const anchor = Date.parse(task.createdAt || task.submissionUncertainAt || '');
  return (Number.isFinite(anchor) ? anchor : Date.now()) + providerTaskIdTimeoutMs;
}
function awaitingProviderTaskId(task) {
  return ['queued', 'running'].includes(task.status)
    && !task.providerTaskId
    && !task.sourceUrl
    && Boolean(task.submissionUncertain);
}
function providerTaskIdTimedOut(task, at = Date.now()) {
  return awaitingProviderTaskId(task) && at >= providerTaskIdDeadline(task);
}
function clearProviderTaskIdTimeout(generationId) {
  const timer = providerTaskIdTimeoutTimers.get(generationId);
  if (timer) clearTimeout(timer);
  providerTaskIdTimeoutTimers.delete(generationId);
}
async function failMissingProviderTaskId(userId, task) {
  clearProviderTaskIdTimeout(task.id);
  task.lastSubmissionError ||= task.error || '';
  task.lastSubmissionErrorAt ||= task.submissionUncertainAt || task.updatedAt || now();
  task.submissionUncertain = false;
  task.submissionTimedOut = true;
  await failGeneration(userId, task, new Error('模型无响应：超过5分钟未获得上游任务 ID'));
  task.finishedAt = now();
  await saveGenerationWithRetry(userId, task, 'provider-task-id-timeout');
}
function scheduleProviderTaskIdTimeout(userId, task) {
  if (!awaitingProviderTaskId(task) || providerTaskIdTimeoutTimers.has(task.id)) return;
  const delay = Math.max(0, providerTaskIdDeadline(task) - Date.now());
  const timer = setTimeout(async () => {
    providerTaskIdTimeoutTimers.delete(task.id);
    try {
      const current = findGeneration(userId, task.id);
      if (current && providerTaskIdTimedOut(current)) {
        await failMissingProviderTaskId(userId, current);
        console.error('[generation] provider task ID timeout', { generationId: current.id, provider: current.provider });
      }
    } catch (error) {
      console.error('[generation] provider task ID timeout handling failed', { generationId: task.id, message: error.message });
    }
  }, delay);
  timer.unref();
  providerTaskIdTimeoutTimers.set(task.id, timer);
}
function startGeneration(userId, task) {
  const promise = (async () => {
    try {
      task.status = 'running';
      task.finishedAt = null;
      await saveGenerationWithRetry(userId, task, 'generation-running');
      const refs = task.type === 'image'
        ? await resolveImageRefs(userId, task.referenceAssetIds, task)
        : await resolveRefs(userId, task.referenceAssetIds, task);
      const hooks = task.routeId
        ? routedPersistenceHooks(userId, task)
        : task.provider === 'ttapi'
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
        task.submissionUncertainAt ||= now();
        task.lastSubmissionError = error.message;
        task.lastSubmissionErrorAt = now();
        task.error = error.message;
        task.creditStatus = 'charged';
        console.error('[video] async provider submission outcome is uncertain; no refund issued', { generationId: task.id, provider: task.provider, message: error.message });
      } else if ((task.routeId || ['ttapi', 'cntcn', 'autodl'].includes(task.provider)) && task.providerTaskId && !error.upstreamTerminal) {
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
      finally {
        activeGenerations.delete(task.id);
        scheduleProviderTaskIdTimeout(userId, task);
      }
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
      const result = await pollTtapiVideo(task.providerTaskId, ttapiPersistenceHooks(userId, task), videoPollStartedAt(task));
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
      const result = await pollCntcnVideo(task.providerTaskId, cntcnPersistenceHooks(userId, task), videoPollStartedAt(task));
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
function resumeRoutedGeneration(userId, task) {
  if (activeGenerations.has(task.id)) return activeGenerations.get(task.id);
  const promise = (async () => {
    try {
      task.status = 'running'; task.finishedAt = null; task.error = '';
      await saveGeneration(userId, task);
      const result = await pollRoutedVideo(task, routedPersistenceHooks(userId, task));
      await completeGenerationResult(userId, task, result);
    } catch (error) {
      if (error.upstreamTerminal) await failGeneration(userId, task, error);
      else {
        task.status = 'running'; task.error = `任务恢复暂时中断，将在服务重启后继续：${error.message}`; task.creditStatus = 'charged';
        console.error('[video] routed recovery paused without refund', { generationId: task.id, routeId: task.routeId, message: error.message });
      }
    } finally {
      task.finishedAt = ['completed', 'failed'].includes(task.status) ? now() : null;
      try { await saveGenerationWithRetry(userId, task, 'routed-recovery-final'); }
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
      const result = await pollAutodlVideo(task.providerTaskId, autodlPersistenceHooks(userId, task), { startedAt:videoPollStartedAt(task) });
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
    if (task.archivePending && task.sourceUrl && !task.localReadyAt) {
      const deadline = Date.parse(task.localDeliveryDeadlineAt || '');
      if (Number.isFinite(deadline) && deadline > Date.now()) scheduleGenerationArchive(userId, task);
      else resumeGenerationArchive(userId, task);
      archiving++;
    } else if (task.routeId && task.providerTaskId) {
      resumeRoutedGeneration(userId, task);
      polling++;
    } else if (task.provider === 'ttapi' && task.providerTaskId) {
      resumeTtapiGeneration(userId, task);
      polling++;
    } else if (task.provider === 'cntcn' && task.providerTaskId) {
      resumeCntcnGeneration(userId, task);
      polling++;
    } else if (task.provider === 'autodl' && task.providerTaskId) {
      resumeAutodlGeneration(userId, task);
      polling++;
    } else if (!task.providerTaskId) {
      task.status = 'running';
      task.finishedAt = null;
      task.creditStatus = 'charged';
      task.submissionUncertain = true;
      task.submissionUncertainAt ||= task.updatedAt || task.createdAt || now();
      task.error ||= '服务中断时未能确认上游任务 ID，任务保留待核对且不会自动退款';
      if (providerTaskIdTimedOut(task)) {
        await failMissingProviderTaskId(userId, task);
        refunded++;
      } else {
        saveGeneration(userId, task);
        scheduleProviderTaskIdTimeout(userId, task);
        awaitingReconciliation++;
      }
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

async function serveFile(res, file, mimeType, cacheControl = 'private, max-age=3600', validator = null) { const stat = await fs.stat(file); const headers = { 'Content-Type': mimeType, 'Content-Length': stat.size, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' }; if (validator) { const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`; headers.ETag = etag; if (validator.ifNoneMatch === etag) { delete headers['Content-Length']; res.writeHead(304, headers); return res.end(); } } res.writeHead(200, headers); createReadStream(file).pipe(res); }
function staticCacheControl(ext, { versioned = false, production = process.env.NODE_ENV === 'production' } = {}) {
  if (['.js', '.css'].includes(ext)) {
    return production && versioned ? 'public, max-age=31536000, immutable' : 'no-cache';
  }
  return ['.svg', '.woff', '.woff2'].includes(ext) ? 'public, max-age=604800, immutable' : 'no-cache';
}
const frontendRoutePaths = new Set(['/login', '/image', '/video', '/drama', '/files']);
const marketingRouteFiles = new Map([
  ['/features', 'features.html'],
  ['/features/', 'features.html'],
  ['/pricing', 'pricing.html'],
  ['/pricing/', 'pricing.html'],
]);
function isDesktopRequest(req) { return String(req.headers['x-gugu-desktop'] || '') === '1'; }
function staticEntryFile(pathname, { desktop = false, appOnly = desktopAppOnly } = {}) {
  return marketingRouteFiles.get(pathname)
    || (pathname === '/guguadmin' || pathname === '/guguadmin/'
      ? 'guguadmin.html'
      : (pathname === '/' || pathname === '/index.html' || frontendRoutePaths.has(pathname))
        ? (desktop || !appOnly ? 'index.html' : 'home.html')
        : pathname.slice(1));
}

async function serveStatic(res, pathname, req = null) {
  const desktop = Boolean(req && isDesktopRequest(req));
  const relative = staticEntryFile(pathname, { desktop });
  const file = path.resolve(publicDir, relative);
  if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, 'index.html')) return sendJson(res, 403, { error: '禁止访问' });
  const ext = path.extname(file);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
  // Production versioned JS/CSS URLs are safe to cache for a year. Development
  // must revalidate on every request because files can change without a query
  // version bump while the desktop client is running.
  const revalidate = ['.js', '.css'].includes(ext);
  const versioned = revalidate && Boolean(req?.url && new URL(req.url, 'http://localhost').searchParams.get('v'));
  const cacheControl = staticCacheControl(ext, { versioned });
  // The same route serves the public home page or the desktop workspace
  // depending on the request marker. Keep an intermediary cache from serving
  // one variant to the other.
  if (desktopAppOnly && (pathname === '/' || pathname === '/index.html' || frontendRoutePaths.has(pathname))) res.setHeader('Vary', 'X-GuGu-Desktop');
  try { await serveFile(res, file, mime, cacheControl, revalidate && !versioned ? { ifNoneMatch:req?.headers['if-none-match'] || '' } : null); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return sendJson(res, 404, { error: '静态文件不存在' }); throw error; }
}

function websiteApiAllowed(pathname) {
  return pathname.startsWith('/api/auth/')
    || pathname === '/api/credits'
    || pathname === '/api/payments/alipay/orders'
    || /^\/api\/payments\/alipay\/orders\/[A-Za-z0-9_-]+(?:\/(?:query|close|refunds)(?:\/[A-Za-z0-9_-]+)?)?$/.test(pathname);
}

export const __test = { hashPassword, verifyPassword, parseCookies, tokenHash, charLength, normalizeInviteCode, isKnownInviteCode, generationCost, errorMessage, videoProgress, downloadErrorDetail, assetObjectKey, pendingUploadKey, finalUploadKey, r2ReferenceImageKey, r2ReferenceImagePrefix, r2ReferenceImageTtlMs, normalizeUploadMime, magicMatches, imageSizes, videoAspectRatios, videoDurations, fixedModels, normalizeDramaProject, buildOaiVideoPayload, buildAutodlPayload, routedVideoPayload, publicPlatformPrices, publicModelPriceState, normalizeQuoteReferenceCounts, autodlRetryableResponseError, pollAutodlVideo, createAutodlVideo, generationFailureCode, publicGeneration, publicAsset, generationSourceHeaders, generationAssetExtension, generationAssetName, resolveVideoPrompt, providerTaskIdDeadline, awaitingProviderTaskId, providerTaskIdTimedOut, routedVideoSubmitTimeoutMs, videoMaxPollDurationMs, oaiMaxPollDurationMs, oaiMaxPolls, autodlMaxPollDurationMs, videoPollTimeoutError, videoPollStartedAt, websiteApiAllowed, staticEntryFile, staticCacheControl };

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
    if (url.pathname === '/api/payments/alipay/notify' && req.method === 'POST') {
      try {
        await handleAlipayNotification(await bodyForm(req));
        return sendText(res, 200, 'success');
      } catch (error) {
        console.warn('[alipay] notification rejected', { message: error.message });
        return sendText(res, 200, 'fail');
      }
    }
    if ((url.pathname === '/payments/alipay/return' || url.pathname === '/payments/alipay/return/') && req.method === 'GET') {
      const user = currentUser(req);
      const outTradeNo = String(url.searchParams.get('out_trade_no') || '').trim();
      if (!user || !outTradeNo) return sendText(res, 200, paymentReturnPage(), 'text/html; charset=utf-8');
      let order = null;
      let error = '';
      try { order = (await queryPaymentOrder(user.id, outTradeNo)).order; }
      catch (queryError) {
        try { order = paymentOrderForUser(user.id, outTradeNo); } catch {}
        error = '支付结果暂时无法确认，请返回 GuGu AI 后刷新。';
      }
      return sendText(res, 200, paymentReturnPage({ order, error }), 'text/html; charset=utf-8');
    }
    // Public pricing data intentionally sits before the desktop-only API
    // guard so website visitors can inspect prices before signing in.
    if (url.pathname === '/api/public/model-prices' && req.method === 'GET') return sendJson(res, 200, publicModelPriceState());
    if (url.pathname === '/api/public/credit-packages' && req.method === 'GET') return sendJson(res, 200, publicCreditPackages());
    if (desktopAppOnly && url.pathname.startsWith('/api/') && !isDesktopRequest(req) && !websiteApiAllowed(url.pathname)) return sendJson(res, 404, { error: '请使用 GuGu AI 客户端' });

    if (url.pathname === '/api/auth/captcha' && req.method === 'GET') {
      return sendJson(res, 200, captchaStore.issue(clientIp(req)));
    }
    if (url.pathname === '/api/auth/sms/send' && req.method === 'POST') {
      const input = await bodyJson(req);
      const phone = normalizePhoneNumber(input.phone);
      if (!phone) return sendJson(res, 400, { error: '请输入正确的手机号' });
      const captcha = captchaStore.verify(input.captchaId, input.captchaCode, clientIp(req));
      if (!captcha.ok) return sendJson(res, 400, { error: '人机验证失败，请刷新验证码后重试' });
      if (!smsConfig.configured) return sendJson(res, 503, { error: '短信登录服务尚未配置' });
      const remainingMs = smsSendLimiter.remainingMs(req, phone);
      if (remainingMs > 0) {
        return sendJson(res, 429, { error: `请 ${Math.ceil(remainingMs / 1000)} 秒后再试`, cooldownSeconds: Math.ceil(remainingMs / 1000) });
      }
      try {
        await sendSmsVerifyCode({ phone, config: smsConfig });
        smsSendLimiter.record(req, phone);
        return sendJson(res, 200, { ok: true, cooldownSeconds: smsConfig.intervalSeconds, expiresIn: smsConfig.validTimeSeconds });
      } catch (error) {
        return sendJson(res, error.statusCode || 502, { error: error.publicMessage || '短信服务暂时不可用，请稍后再试' });
      }
    }
    if (url.pathname === '/api/auth/sms/login' && req.method === 'POST') {
      const input = await bodyJson(req);
      const phone = normalizePhoneNumber(input.phone);
      const code = String(input.code || '').trim();
      if (!phone) return sendJson(res, 400, { error: '请输入正确的手机号' });
      if (!/^\d{4,8}$/.test(code)) return sendJson(res, 400, { error: '请输入短信验证码' });
      if (!smsConfig.configured) return sendJson(res, 503, { error: '短信登录服务尚未配置' });
      if (smsVerifyLimiter.isBlocked(req, phone)) return sendJson(res, 429, { error: '验证码尝试次数过多，请稍后再试' });
      let checked;
      try {
        checked = await checkSmsVerifyCode({ phone, code, config: smsConfig });
      } catch (error) {
        return sendJson(res, error.statusCode || 502, { error: error.publicMessage || '短信服务暂时不可用，请稍后再试' });
      }
      if (!checked.verified) {
        smsVerifyLimiter.recordFailure(req, phone);
        return sendJson(res, 401, { error: '验证码错误或已过期' });
      }
      smsVerifyLimiter.reset(req, phone);
      let user = findUserByPhoneNumber(phone);
      if (user?.status === 'disabled') return sendJson(res, 403, { error: '账号已停用，请联系管理员' });
      if (!user) {
        const createdAt = now();
        user = createSmsUser({ user: {
          id: randomUUID(),
          username: phone,
          phoneNumber: phone,
          role: 'user',
          status: 'active',
          credits: 0,
          creditBalanceMicro: 0,
          creditHeldMicro: 0,
          passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
          createdAt,
          updatedAt: createdAt,
        } });
      }
      if (!user) return sendJson(res, 500, { error: '创建短信账号失败，请稍后再试' });
      await ensureUserDirs(user.id);
      const token = createSession(user.id);
      setSessionCookie(res, token);
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      // Keep this endpoint for old clients, but registration no longer depends
      // on invitation codes. New accounts are created by verified phone login.
      const input = await bodyJson(req); const username = String(input.username || '').trim().toLowerCase(); const password = String(input.password || '');
      if (!/^[a-z0-9_]{3,24}$/.test(username)) return sendJson(res, 400, { error: '账号需为 3–24 位字母、数字或下划线' });
      if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: '密码长度需为 8–128 位' });
      // Password hashing is deliberately outside the transaction: scrypt takes
      // tens of milliseconds and must not be held across a write lock.
      const passwordHash = await hashPassword(password);
      const user = { id: randomUUID(), username, role: 'user', status: 'active', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, passwordHash, createdAt: now(), updatedAt: now() };
      const result = registerUser({ user });
      if (result.error) return sendJson(res, result.status, { error: result.error });
      await ensureUserDirs(result.user.id);
      const token = createSession(result.user.id); setSessionCookie(res, token); return sendJson(res, 201, { user: publicUser(result.user) });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const input = await bodyJson(req);
      const identifier = String(input.username || input.identifier || '').trim();
      if (loginLimiter.isBlocked(req, identifier)) return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
      const user = findUserByLogin(identifier);
      const valid = user && user.status === 'active' ? await verifyPassword(String(input.password || ''), user.passwordHash) : false;
      if (!valid) {
        loginLimiter.recordFailure(req, identifier);
        return sendJson(res, 401, { error: '账号或密码不正确' });
      }
      loginLimiter.reset(req, identifier);
      await ensureUserDirs(user.id);
      const token = createSession(user.id);
      setSessionCookie(res, token);
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (url.pathname === '/api/auth/profile' && req.method === 'PATCH') {
      const user = requireUser(req, res);
      if (!user) return;
      const input = await bodyJson(req);
      const hasNickname = Object.prototype.hasOwnProperty.call(input, 'nickname');
      const hasPassword = Object.prototype.hasOwnProperty.call(input, 'password');
      if (!hasNickname && !hasPassword) return sendJson(res, 400, { error: '没有需要保存的设置' });

      let nickname;
      if (hasNickname) {
        if (input.nickname !== null && typeof input.nickname !== 'string') return sendJson(res, 400, { error: '昵称格式不正确' });
        nickname = input.nickname === null ? '' : input.nickname.trim();
        if (nickname && !profileNicknamePattern.test(nickname)) return sendJson(res, 400, { error: '昵称需为 2–24 位中文、字母、数字、下划线或短横线' });
      }

      let passwordHash;
      if (hasPassword) {
        if (typeof input.password !== 'string') return sendJson(res, 400, { error: '密码格式不正确' });
        if (input.password && (input.password.length < 8 || input.password.length > 128)) return sendJson(res, 400, { error: '密码长度需为 8–128 位' });
        if (input.password) passwordHash = await hashPassword(input.password);
      }
      if (!hasNickname && passwordHash === undefined) return sendJson(res, 400, { error: '请输入新密码' });

      try {
        const updated = updateUserProfile(user.id, { nickname, passwordHash, updatedAt: now() });
        return updated ? sendJson(res, 200, { user: publicUser(updated) }) : sendJson(res, 401, { error: '登录状态已失效，请重新登录' });
      } catch (error) {
        return sendJson(res, error.statusCode || 500, { error: error.statusCode === 409 ? error.message : '账号设置保存失败，请稍后重试' });
      }
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const token = parseCookies(req.headers.cookie).studio_session; if (token) deleteSession(tokenHash(token)); clearSessionCookie(res); return sendJson(res, 200, { ok: true }); }
    if (url.pathname === '/api/auth/me' && req.method === 'GET') { const user = currentUser(req); return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: '未登录' }); }
    if (url.pathname === '/api/config' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; return sendJson(res, 200, configState()); }
    if (url.pathname === '/api/credits' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; const wallet = walletOf(user.id); const pricing = currentPricing(); const transactions = recentCreditEntries(user.id, 1000); return sendJson(res, 200, { ...wallet, pricing: { image: pricing.imagePerRequest, videoPerSecond: pricing.videoPerSecond, signupBonus: creditPricing.signupBonus, version: pricing.version, llmInputYuanPerMillion: llmRates.inputYuanPerMillion, llmOutputYuanPerMillion: llmRates.outputYuanPerMillion, yuanPerCredit: llmRates.yuanPerCredit }, transactions }); }
    if (url.pathname === '/api/payments/alipay/orders' && req.method === 'POST') {
      const user = requireUser(req, res); if (!user) return;
      const input = await bodyJson(req);
      const result = await createPaymentOrder({
        userId: user.id,
        credits: input.credits,
        returnUrl: publicReturnUrl(process.env, port),
        notifyUrl: publicNotifyUrl(process.env),
      });
      return sendJson(res, 201, result);
    }
    const alipayOrderMatch = url.pathname.match(/^\/api\/payments\/alipay\/orders\/([A-Za-z0-9_-]+)$/);
    if (alipayOrderMatch && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      return sendJson(res, 200, { order: paymentOrderForUser(user.id, alipayOrderMatch[1]) });
    }
    const alipayOrderActionMatch = url.pathname.match(/^\/api\/payments\/alipay\/orders\/([A-Za-z0-9_-]+)\/(query|close|refunds)$/);
    if (alipayOrderActionMatch && req.method === 'POST') {
      const user = requireUser(req, res); if (!user) return;
      const [, outTradeNo, action] = alipayOrderActionMatch;
      if (action === 'query') return sendJson(res, 200, await queryPaymentOrder(user.id, outTradeNo));
      if (action === 'close') return sendJson(res, 200, await closePaymentOrder(user.id, outTradeNo));
      return sendJson(res, 200, await refundPaymentOrder(user.id, outTradeNo, await bodyJson(req)));
    }
    const alipayRefundMatch = url.pathname.match(/^\/api\/payments\/alipay\/orders\/([A-Za-z0-9_-]+)\/refunds\/([A-Za-z0-9_-]+)$/);
    if (alipayRefundMatch && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      return sendJson(res, 200, await queryPaymentRefund(user.id, alipayRefundMatch[1], alipayRefundMatch[2]));
    }
    if (url.pathname === '/api/notifications' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; return sendJson(res, 200, listNotifications(user.id, { limit: url.searchParams.get('limit') })); }
    const notificationReadMatch = url.pathname.match(/^\/api\/notifications\/([\w-]+)\/read$/);
    if (notificationReadMatch && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; markNotificationRead(user.id, notificationReadMatch[1]); return sendJson(res, 200, listNotifications(user.id)); }
    if (url.pathname === '/api/notifications/read-all' && req.method === 'POST') { const user = requireUser(req, res); if (!user) return; markAllNotificationsRead(user.id); return sendJson(res, 200, listNotifications(user.id)); }

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
      if (Array.isArray(input.projectAssetIds)) project.projectAssetIds = input.projectAssetIds;
      if (input.projectAssetCategories && typeof input.projectAssetCategories === 'object' && !Array.isArray(input.projectAssetCategories)) project.projectAssetCategories = input.projectAssetCategories;
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
        project.workflowVersion=pack.workflowVersion; project.title=pack.title; project.synopsis=pack.synopsis; project.script=pack.script; project.scenes=pack.scenes.map(item=>({id:randomUUID(),...item})); project.resources=pack.resources.map(item=>({id:randomUUID(),...item,versions:[],selectedTaskId:''})); const byName=new Map(project.resources.map(item=>[item.name,item.id])); project.shots=pack.shots.map(item=>({id:randomUUID(),...item,sceneId:project.scenes[Math.max(0,item.sceneNumber-1)]?.id || project.scenes[0]?.id || '',resourceIds:item.resourceNames.map(name=>byName.get(name)).filter(Boolean),referenceAssetIds:[],generation:{type:'TEXT',firstFrameAssetId:'',lastFrameAssetId:'',referenceAssetIds:[],quality:'720p',count:1},videoVersions:[],selectedVideoTaskId:'',tailFrameAssetId:''})); project.productionQuality=pack.productionQuality; project.status='designed'; project.directorUsage=usage; normalizeDramaProject(project); await saveDramaProject(user.id,project);
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
    const shotVideoDeleteMatch = url.pathname.match(/^\/api\/drama\/projects\/([\w-]+)\/shots\/([\w-]+)\/videos\/([\w-]+)$/);
    if (shotVideoDeleteMatch && req.method === 'DELETE') {
      const user=await requireUser(req,res); if(!user)return;
      const project=await loadDramaProject(user.id,shotVideoDeleteMatch[1]);
      const shot=project?.shots.find(item=>item.id===shotVideoDeleteMatch[2]);
      if(!shot)return sendJson(res,404,{error:'分镜不存在'});
      const id=safeId(shotVideoDeleteMatch[3]);
      if(!shot.videoVersions.includes(id))return sendJson(res,404,{error:'视频版本不存在'});
      const task=findGeneration(user.id,id);
      if(!task||task.type!=='video')return sendJson(res,404,{error:'视频任务不存在'});
      if(task.status!=='failed')return sendJson(res,409,{error:'只有失败的视频版本可以删除'});
      if(activeGenerations.has(id))return sendJson(res,409,{error:'任务正在生成中，完成后才能删除'});
      const retryTimer=generationRetryTimers.get(id); if(retryTimer){clearTimeout(retryTimer);generationRetryTimers.delete(id);}
      clearProviderTaskIdTimeout(id);
      const asset=task.assetId?findAsset(user.id,task.assetId):null;
      shot.videoVersions=shot.videoVersions.filter(value=>value!==id);
      if(shot.selectedVideoTaskId===id)shot.selectedVideoTaskId=shot.videoVersions.at(-1)||'';
      normalizeDramaProject(project);
      await saveDramaProject(user.id,project);
      await deleteAssetRecord(user.id,asset);
      deleteGeneration(user.id,id);
      return sendJson(res,200,{project:publicDramaProject(project),deletedAssetId:asset?.id||null});
    }
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

    if (url.pathname === '/api/model-quote' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      const input = await bodyJson(req);
      const requestedReferenceCount = Array.isArray(input.referenceAssetIds) ? new Set(input.referenceAssetIds.map(safeId).filter(Boolean)).size : 0;
      const suppliedReferenceCounts = normalizeQuoteReferenceCounts(input.referenceCounts);
      const suppliedReferenceCount = Object.values(suppliedReferenceCounts).reduce((sum, count) => sum + count, 0);
      // Price previews can run before deferred reference uploads finish. Local
      // clients supply only media-kind counts so route compatibility and price
      // are exact without uploading assets just to render a button. Generation
      // submission still validates the real asset records and readable sources.
      const generationType = String(input.generationType || '').toUpperCase();
      const quoteReferenceCount = requestedReferenceCount || suppliedReferenceCount || (['REFERENCE', 'FIRST&LAST'].includes(generationType) ? 1 : 0);
      const request = validateVideoRequest(input, quoteReferenceCount);
      const referenceAssetIds = await validateReferenceAssets(user.id, input.referenceAssetIds, request.referenceLimits, { requireReadable:false });
      const quotedReferenceCounts = referenceAssetIds.length ? referenceAssetCounts(user.id, referenceAssetIds) : suppliedReferenceCounts;
      if (request.referenceLimits) {
        for (const kind of Object.keys(quotedReferenceCounts)) if (quotedReferenceCounts[kind] > Number(request.referenceLimits[kind] || 0)) throw Object.assign(new Error(`参考${kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'}最多支持 ${request.referenceLimits[kind] || 0} 个`), { statusCode:400 });
      }
      const route = request.provider === 'route' ? selectModelRoute({ logicalModelId: request.modelId, quality: request.quality, duration: request.duration, aspectRatio: request.aspectRatio, referenceCounts: quotedReferenceCounts }) : null;
      if (request.provider === 'route' && !route) return sendJson(res, 503, { error: '当前选项没有兼容且可用的调用线路' });
      if (route) return sendJson(res, 200, { modelId:request.modelId, quality:request.quality, duration:request.duration, aspectRatio:request.aspectRatio, available:true, credits:route.salePriceCredits, yuan:route.salePriceYuan, priceVersion:`${route.id}:${route.version}` });
      const selectedPricing = request.pricingByQuality?.[request.quality] || request.pricing;
      const credits = selectedPricing?.unit === 'second' ? Number(selectedPricing.amount) * request.duration : currentPricing().videoPerSecond * request.duration;
      return sendJson(res, 200, { modelId:request.modelId, quality:request.quality, duration:request.duration, aspectRatio:request.aspectRatio, available:true, credits, yuan:credits * 0.1, priceVersion:`static:${request.modelId}:${request.quality}:${request.duration}` });
    }

    if (url.pathname === '/api/generations' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      if (url.searchParams.has('ids')) {
        const ids = [...new Set(String(url.searchParams.get('ids') || '').split(',').map(safeId).filter(Boolean))].slice(0, 200);
        return sendJson(res, 200, ids.map(id => findGeneration(user.id, id)).filter(Boolean).map(publicGeneration));
      }
      const page = listGenerations(user.id, { type: url.searchParams.get('type'), limit: parseLimit(url.searchParams.get('limit')), cursor: url.searchParams.get('cursor') });
      setPageHeaders(res, page);
      return sendJson(res, 200, page.items.map(publicGeneration));
    }
    if (url.pathname === '/api/generations' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return; const input = await bodyJson(req); const type = input.type;
      if (!['image', 'video'].includes(type)) return sendJson(res, 400, { error: '只支持图片或视频生成' }); let prompt = String(input.prompt ?? '');
      await ensureUserDirs(user.id);
      let dramaProjectId = ''; let dramaShotId = ''; let dramaShot = null;
      if (type === 'video' && input.dramaProjectId && input.dramaShotId) { dramaProjectId=safeId(input.dramaProjectId);dramaShotId=safeId(input.dramaShotId);const dramaProject=await loadDramaProject(user.id,dramaProjectId);dramaShot=dramaProject?.shots.find(shot=>shot.id===dramaShotId);if(!dramaProject||!dramaShot)return sendJson(res,404,{error:'短剧项目或分镜不存在'});if(dramaProject.workflowVersion>=STORYBOARD_ENGINE_VERSION&&!dramaProject.productionQuality?.passed){const first=dramaProject.productionQuality?.gates?.find(gate=>!gate.ok)?.problems?.[0]||'分镜方案未通过质量检查';return sendJson(res,409,{error:`不能生成视频：${first}`});}if(!prompt.trim()){const scene=dramaProject.scenes.find(item=>item.id===dramaShot.sceneId);const resources=(dramaShot.resourceIds||[]).map(id=>dramaProject.resources.find(item=>item.id===id)).filter(Boolean);prompt=resolveVideoPrompt(prompt,buildShotVideoPrompt({project:dramaProject,shot:dramaShot,scene,resources}));} }
      if (!prompt.trim()) return sendJson(res, 400, { error: '请输入提示词' });
      const requestedVideoModelId = String(input.modelId ?? input.videoModel ?? '').trim().toLowerCase();
      const promptMaxLength = type === 'image' ? 5000 : [VIDEO_MODEL_IDS.MINIMAX_H3_15S, LEGACY_VIDEO_MODEL_IDS.GUGU_2].includes(requestedVideoModelId) ? 10000 : 4096;
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
      const referenceCounts = referenceAssetCounts(user.id, referenceAssetIds);
      if (referenceCounts.image && !r2ReferenceConfigured) {
        return sendJson(res, 503, { error: `${type === 'image' ? '图生图' : '图生视频'}参考图片暂时不可用：R2 临时参考图存储尚未配置` });
      }
      const modelId = type === 'image' ? fixedModels.image : videoRequest.modelId;
      if (!isModelEnabled(modelId)) return sendJson(res, 503, { error: '当前模型暂不可用' });
      const routeSelection = type === 'video' && videoRequest.provider === 'route'
        ? selectModelRoute({ logicalModelId: modelId, quality: videoRequest.quality, duration, aspectRatio, referenceCounts })
        : null;
      if (type === 'video' && videoRequest.provider === 'route' && !routeSelection) return sendJson(res, 503, { error: '当前模型没有兼容且可用的调用线路，请稍后重试' });
      const provider = type === 'image' ? 'duomi' : routeSelection?.provider || videoRequest.provider;
      if (type === 'video' && referenceCounts.image && !r2ReferencePublicBaseUrl) {
        return sendJson(res, 503, { error: '图生视频参考图片暂时不可用：所有视频模型都需要配置 R2_REFERENCE_PUBLIC_BASE_URL' });
      }
      if (provider === 'duomi' && !process.env.DUOMI_API_KEY) return sendJson(res, 503, { error: '视频生成服务尚未配置' });
      if (provider === 'ttapi' && !ttapiConfigured) return sendJson(res, 503, { error: '视频生成服务尚未配置' });
      if (provider === 'cntcn' && !cntcnConfigured) return sendJson(res, 503, { error: 'CNTCN Seedance 视频服务尚未配置' });
      if (provider === 'autodl' && !autodlConfigured) return sendJson(res, 503, { error: 'AutoDL GuGu 2.0 视频服务尚未配置' });
      if (provider === 'oai') {
        const configured = videoRequest.modelId === VIDEO_MODEL_IDS.VEO_31
          ? oaiVeoConfigured
          : videoRequest.modelId === VIDEO_MODEL_IDS.MINIMAX_H3
            ? oaiMinimaxConfigured
            : oaiConfigured;
        if (!configured) {
          const message = videoRequest.modelId === VIDEO_MODEL_IDS.VEO_31
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
      const pricingSnapshotValue = routeSelection ? {
        version: pricing.version, contentType: type, billingUnit: 'request', quantity: 1,
        unitPriceMicro: routeSelection.salePriceMicro, totalMicro: routeSelection.salePriceMicro,
        unitPrice: routeSelection.salePriceCredits, total: routeSelection.salePriceCredits,
        routeId: routeSelection.id, routeVersion: routeSelection.version,
        upstreamModelId: routeSelection.upstreamModelId, costYuan: routeSelection.costYuan,
        markupPercent: 20, salePriceYuan: routeSelection.salePriceYuan,
        priceVersion: `${routeSelection.id}:${routeSelection.version}`,
      } : pricingSnapshot(pricingForTask, type, type === 'video' ? duration : 1);
      if (routeSelection && input.expectedPriceVersion && input.expectedPriceVersion !== pricingSnapshotValue.priceVersion) return sendJson(res, 409, { error: '调用线路或价格已变化，请确认最新价格后重试', code: 'PRICE_CHANGED', price: { credits: pricingSnapshotValue.total, yuan: pricingSnapshotValue.salePriceYuan, priceVersion: pricingSnapshotValue.priceVersion } });
      const batchId = quantity > 1 ? randomUUID() : '';
      const tasks = Array.from({ length: quantity }, (_, index) => ({
        id: randomUUID(), ownerId: user.id, type, prompt, referenceAssetIds, provider,
        model: type === 'video' ? routeSelection?.upstreamModelId || videoRequest.model : fixedModels.image, modelId, size,
        quality: type === 'image' ? String(input.quality || 'medium') : videoRequest.quality,
        aspectRatio, duration,
        ...(type === 'video' ? { videoModelId:videoRequest.modelId, generationType:videoRequest.generationType, videoProfile:videoRequest.profileKey, maxReferenceImages:videoRequest.maxImages, referenceLimits: routeSelection ? { image:routeSelection.capabilities.image, video:routeSelection.capabilities.video, audio:routeSelection.capabilities.audio, total:routeSelection.capabilities.image + routeSelection.capabilities.video + routeSelection.capabilities.audio } : videoRequest.referenceLimits, dramaProjectId, dramaShotId } : {}),
        ...(routeSelection ? { routeId:routeSelection.id, routeVersion:routeSelection.version, routeDisplayName:routeSelection.displayName, routeAdapter:routeSelection.adapterType, routeBaseUrl:routeSelection.baseUrl, routeCredentialId:routeSelection.credentialId } : {}),
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
      clearProviderTaskIdTimeout(id);
      const asset = task.assetId ? findAsset(user.id, task.assetId) : null;
      await removeGenerationFromDramaProjects(user.id, task);
      await deleteAssetRecord(user.id, asset);
      deleteGeneration(user.id, id);
      return sendJson(res, 200, { ok: true, deletedAssetId: asset?.id || null });
    }

    if (url.pathname === '/api/files/sync' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      const deviceId = normalizeDeviceId(url.searchParams.get('deviceId'));
      if (!deviceId) return sendJson(res, 400, { error: '设备标识无效' });
      const page = listAssetChanges(user.id, {
        cursor: url.searchParams.get('cursor'),
        limit: parseLimit(url.searchParams.get('limit')),
      });
      const deliveries = listPendingAssetDeliveries(user.id, deviceId, { limit: parseLimit(url.searchParams.get('limit')) });
      deliveries.forEach(asset => markAssetDeliveryPending(user.id, deviceId, asset.id));
      return sendJson(res, 200, {
        deviceId,
        changes: page.items.map(change => ({
          seq: change.seq,
          action: change.action,
          assetId: change.assetId,
          asset: change.action === 'delete' ? null : publicAsset(change.asset),
        })),
        deliveries: deliveries.map(publicAsset),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    }

    const singleAssetMatch = url.pathname.match(/^\/api\/files\/([\w-]+)$/);
    if (singleAssetMatch && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      const asset = findAsset(user.id, singleAssetMatch[1]);
      return asset ? sendJson(res, 200, publicAsset(asset)) : sendJson(res, 404, { error: '文件不存在' });
    }

    if (url.pathname === '/api/files' && req.method === 'GET') {
      const user = requireUser(req, res); if (!user) return;
      const cursor = url.searchParams.get('cursor');
      const page = listAssets(user.id, {
        kind: url.searchParams.get('kind'),
        search: url.searchParams.get('search'),
        limit: parseLimit(url.searchParams.get('limit')),
        cursor,
        includeTotal: !cursor || url.searchParams.get('includeTotal') === '1',
      });
      setPageHeaders(res, page);
      return sendJson(res, 200, page.items.map(publicAsset));
    }
    // 客户端诊断日志上传。请求体就是客户端 gzip 好的日志包，服务端直接转存对象
    // 存储；素材直传那套 intent 状态机在这里没有价值（不入素材库、不需要秒传），
    // 而日志包本身只有几百 KB，走服务端反而少两次往返。
    if (url.pathname === '/api/support/logs' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      if (!supportLogStorageReady) return sendJson(res, 503, { error: '诊断日志上传服务尚未配置' });
      if (!supportLogRateAllowed(user.id)) return sendJson(res, 429, { error: '日志上传过于频繁，请稍后再试' });
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== SUPPORT_LOG_MIME) return sendJson(res, 415, { error: '日志包必须以 application/gzip 提交' });
      const bundle = await bodyBuffer(req, supportLogMaxBytes, `日志包不能超过 ${Math.round(supportLogMaxBytes / (1024 * 1024))} MB`);
      if (bundle.length < 3) return sendJson(res, 400, { error: '日志包为空' });
      if (bundle[0] !== 0x1f || bundle[1] !== 0x8b) return sendJson(res, 415, { error: '日志包必须是 gzip 数据' });
      const note = String(url.searchParams.get('note') || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim().slice(0, 500);
      const objectKey = supportLogObjectKey(user.id);
      await putSupportLogObject(objectKey, bundle);
      const event = appendSystemEvent({
        level: 'info',
        category: 'client_log',
        userId: user.id,
        message: note || '客户端上传诊断日志',
        details: {
          objectKey,
          size: bundle.length,
          note,
          username: user.username,
          appVersion: String(url.searchParams.get('version') || '').trim().slice(0, 40),
          platform: String(url.searchParams.get('platform') || '').trim().slice(0, 40),
          deviceId: normalizeDeviceId(url.searchParams.get('deviceId')),
          userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
        },
      });
      // 用户拿到短编号后报给客服，后台按编号直接定位这一次上传。
      return sendJson(res, 201, { ok: true, reference: event.id.slice(0, 8), size: bundle.length, uploadedAt: event.createdAt });
    }
    if (url.pathname === '/api/files/uploads/init' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      if (!directUploadEnabled || !r2Configured) return sendJson(res, 503, { error: '直传暂未启用' });
      if (!uploadInitRateAllowed(user.id)) return sendJson(res, 429, { error: '上传请求过于频繁，请稍后再试' });
      if (countActiveUploadIntents(user.id) >= uploadMaxPendingPerUser) return sendJson(res, 429, { error: '未完成上传数量过多，请先完成或稍后重试' });
      const input = await bodyJson(req, 32_000);
      const mimeType = normalizeUploadMime(input.mimeType, input.name);
      if (![...imageTypes, ...videoTypes, ...audioTypes].includes(mimeType)) return sendJson(res, 415, { error: '只支持 PNG、JPEG、WebP、MP4、WebM、MOV 或音频文件' });
      const size = Number(input.size);
      const sizeLimit = uploadSizeLimit(mimeType);
      if (!Number.isSafeInteger(size) || size <= 0) return sendJson(res, 400, { error: '文件大小无效' });
      if (size > sizeLimit) return sendJson(res, 413, { error: imageTypes.has(mimeType) ? '单张图片不能超过 20 MB' : '视频或音频不能超过 25 MB' });
      const name = String(input.name || 'file').replace(/[\r\n\u0000-\u001f]/g, '').trim().slice(0, 160) || 'file';
      const suppliedHash = input.sha256 === undefined || input.sha256 === null || input.sha256 === '' ? '' : String(input.sha256).trim().toLowerCase();
      if (suppliedHash && !/^[a-f0-9]{64}$/.test(suppliedHash)) return sendJson(res, 400, { error: 'sha256 格式无效' });
      if (suppliedHash) {
        const existingAsset = findAssetBySha256(user.id, suppliedHash, size, { requireRemote:true });
        if (existingAsset && existingAsset.mimeType === mimeType && existingAsset.kind === uploadKind(mimeType)) {
          return sendJson(res, 200, { mode: 'reuse', asset: publicAsset(existingAsset), sha256: suppliedHash });
        }
      }
      const uploadId = randomUUID();
      const assetId = randomUUID();
      const createdAt = now();
      const expiresAt = new Date(Date.now() + Math.min(uploadIntentExpiresSeconds, uploadUrlExpiresSeconds) * 1000).toISOString();
      const intent = {
        id: uploadId,
        userId: user.id,
        assetId,
        temporaryObjectKey: pendingUploadKey(user.id, uploadId, mimeType, name),
        finalObjectKey: finalUploadKey(user.id, assetId, mimeType, name),
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
      const uploadUrl = await signedUploadUrl(intent.temporaryObjectKey, mimeType, Math.min(uploadIntentExpiresSeconds, uploadUrlExpiresSeconds));
      return sendJson(res, 201, {
        uploadId,
        assetId,
        method: 'PUT',
        uploadUrl,
        headers: { 'Content-Type': mimeType },
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
      if (!directUploadEnabled || !r2Configured) return sendJson(res, 503, { error: '直传暂未启用' });
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
        const expired = expireUploadIntent(user.id, uploadId, nowIso);
        if (expired) await deleteObject(expired.temporaryObjectKey).catch(error => console.warn(`[upload] 清理过期 pending 失败 uploadId=${uploadId}`, error.message));
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
          objectKey: intent.finalObjectKey,
          objectUploadedAt: nowIso,
          ...(intent.kind === 'image' && intent.clientWidth && intent.clientHeight ? { width: intent.clientWidth, height: intent.clientHeight } : {}),
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        completeUploadIntentWithAsset(user.id, uploadId, { actualSize: finalMeta.size || meta.size, objectEtag: finalMeta.etag || meta.etag, asset, nowIso });
        await deleteObject(intent.temporaryObjectKey).catch(error => console.warn(`[upload] 清理 pending 失败 uploadId=${uploadId}`, error.message));
        return sendJson(res, 201, publicAsset(asset));
      } catch (error) {
        const code = error.code || 'UPLOAD_VERIFY_FAILED';
        if (code.startsWith('UPLOAD_')) {
          markUploadIntentFailed(user.id, uploadId, { errorCode: code, actualSize: error.actualSize ?? meta?.size ?? null, objectEtag: error.objectEtag ?? meta?.etag ?? null, nowIso: now() });
          await deleteObject(intent.temporaryObjectKey).catch(() => {});
          return sendJson(res, error.statusCode || 422, { error: error.message || '上传文件验证失败', code });
        }
        throw Object.assign(new Error(`上传文件归档失败：${error.message}`), { statusCode: 502, cause: error });
      }
    }
    const assetPreviewMatch = url.pathname.match(/^\/api\/files\/([\w-]+)\/preview$/);
    if (assetPreviewMatch && req.method === 'GET') {
      const user = await requireUser(req, res); if (!user) return;
      const asset = findAsset(user.id, assetPreviewMatch[1]);
      if (!asset) return sendJson(res, 404, { error: '文件不存在' });
      if (asset.kind !== 'image') return sendJson(res, 415, { error: '只有图片支持缩略图预览' });
      // Serve a local image first so gallery rendering never waits on remote storage.
      const localFile = path.join(assetFilesDir(user.id), asset.storageName);
      if (await fs.access(localFile).then(() => true).catch(() => false)) {
        return serveFile(res, localFile, asset.mimeType, `private, max-age=${assetPreviewCacheSeconds}`);
      }
      if (asset.objectKey) {
        const previewUrl = await signedAssetUrl(asset.objectKey, assetPreviewCacheSeconds + 60, { cacheControl: `private, max-age=${assetPreviewCacheSeconds}` });
        res.writeHead(302, { Location: previewUrl, 'Cache-Control': `private, max-age=${assetPreviewCacheSeconds}` });
        return res.end();
      }
      return sendJson(res, 404, { error: '文件内容不存在' });
    }
    // 批量入口：客户端启动时的历史素材对账一次提交一整页，避免每条素材一次 HTTP 往返。
    // 单条被拒绝不会让整个请求失败，逐条结果交给客户端判断哪些需要重试。
    if (url.pathname === '/api/files/local-ready' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      const input = await bodyJson(req);
      const items = Array.isArray(input.items) ? input.items : [];
      if (!items.length) return sendJson(res, 400, { error: '缺少本地接收确认条目' });
      if (items.length > localReadyBatchLimit) return sendJson(res, 400, { error: `单次最多确认 ${localReadyBatchLimit} 个素材` });
      const deviceId = normalizeDeviceId(input.deviceId);
      const results = [];
      for (const item of items) {
        const assetId = safeId(item?.id);
        const asset = assetId ? findAsset(user.id, assetId) : null;
        if (!asset) {
          results.push({ id: String(item?.id || ''), ok: false, error: '文件不存在' });
          continue;
        }
        const outcome = await applyLocalReadyAcknowledgement(user.id, asset, { ...item, deviceId });
        results.push(outcome.error ? { id: asset.id, ok: false, error: outcome.error } : { id: asset.id, ok: true });
      }
      return sendJson(res, 200, { deviceId, acknowledged: results.filter(result => result.ok).length, results });
    }
    const localReadyMatch = url.pathname.match(/^\/api\/files\/([\w-]+)\/local-ready$/);
    if (localReadyMatch && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      const asset = findAsset(user.id, localReadyMatch[1]);
      if (!asset) return sendJson(res, 404, { error: '文件不存在' });
      const input = await bodyJson(req);
      const outcome = await applyLocalReadyAcknowledgement(user.id, asset, { ...input, deviceId: normalizeDeviceId(input.deviceId) });
      if (outcome.error) return sendJson(res, outcome.status, { error: outcome.error });
      return sendJson(res, 200, publicAsset(outcome.asset));
    }
    const directMediaMatch = url.pathname.match(/^\/api\/files\/([\w-]+)\/direct$/);
    if (directMediaMatch && req.method === 'GET') {
      const user = await requireUser(req, res); if (!user) return;
      const asset = findAsset(user.id, directMediaMatch[1]);
      if (!asset) return sendJson(res, 404, { error: '文件不存在' });
      // Prefer a server-side local copy before issuing a private R2 redirect.
      const localFile = path.join(assetFilesDir(user.id), asset.storageName);
      if (await fs.access(localFile).then(() => true).catch(() => false)) {
        res.writeHead(302, { Location: `/api/files/${asset.id}/content`, 'Cache-Control': 'private, no-store' });
        return res.end();
      }
      if (asset.objectKey) {
        res.writeHead(302, { Location: await signedAssetUrl(asset.objectKey), 'Cache-Control': 'private, no-store' });
        return res.end();
      }
      if (await servePendingGenerationSource(res, asset)) return;
      return sendJson(res, 404, { error: '文件内容不存在' });
    }
    const fileMatch = url.pathname.match(/^\/api\/files\/([\w-]+)(?:\/(content))?$/);
    if (fileMatch) { const user = await requireUser(req, res); if (!user) return; const asset = findAsset(user.id, fileMatch[1]); if (!asset) return sendJson(res, 404, { error: '文件不存在' }); if (req.method === 'GET' && fileMatch[2]) { const localFile = path.join(assetFilesDir(user.id), asset.storageName); if (await fs.access(localFile).then(() => true).catch(() => false)) return serveFile(res, localFile, asset.mimeType); if (asset.objectKey) { res.writeHead(302, { Location:await signedAssetUrl(asset.objectKey), 'Cache-Control':'private, no-store' }); return res.end(); } if (await servePendingGenerationSource(res, asset)) return; return sendJson(res, 404, { error:'文件内容不存在' }); } if (req.method === 'PATCH' && !fileMatch[2]) { const input = await bodyJson(req); const name = String(input.name || '').trim().replace(/[\r\n]/g, '').slice(0, 160); if (!name) return sendJson(res, 400, { error: '文件名不能为空' }); asset.name = name; await saveAsset(user.id, asset); return sendJson(res, 200, publicAsset(asset)); } if (req.method === 'DELETE' && !fileMatch[2]) { await deleteAssetRecord(user.id, asset); return sendJson(res, 200, { ok: true }); } }

    const downloadMatch = url.pathname.match(/^\/downloads\/(mac|windows)$/);
    if (downloadMatch && req.method === 'GET') {
      const target = publicDownloadUrls[downloadMatch[1]];
      if (!target) return sendJson(res, 404, { error: '该平台客户端尚未发布' });
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return await serveStatic(res, url.pathname, req);
  } catch (error) { if (!error.statusCode || error.statusCode >= 500) console.error(error); if (res.headersSent) return res.end(); const message = error.upstreamError ? '模型服务暂时不可用，请稍后重试' : error.message || '服务错误'; return sendJson(res, error.statusCode || (error.code === 'ENOENT' ? 404 : 500), { error: message, ...(error.publicData && typeof error.publicData === 'object' ? error.publicData : {}) }); }
});

if (process.env.NODE_ENV !== 'test') {
  server.listen(port, '127.0.0.1', () => {
    console.log(`GuGu AI: http://127.0.0.1:${port}`);
    // Recovery runs after the port is open so a backlog never delays startup.
    recoverPendingGenerations().catch(error => console.error('启动恢复失败', error));
    startModelRouteMonitor();
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
