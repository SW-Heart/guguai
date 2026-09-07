import http from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { validateDownloadedMedia } from './desktop/media-integrity.mjs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { conservativeInputTokenUpperBound, creditsToMicro, llmRatesFromEnv, llmReservationMicro, normalizeWallet } from './lib/billing.mjs';
import { closeDatabase, openDatabase, resolveDbFile, sql, tx } from './lib/db.mjs';
import { chargeGenerationBatchMicro, chargeGenerationMicro, configureLedger, markLlmBillingReconcile, recentCreditEntries, refundGenerationMicro, releaseLlmCredits, reserveLlmCredits, settleLlmCredits, walletOf } from './lib/ledger.mjs';
import { claimLegacyWorkspace, claimUploadIntent, decodeCursor, encodeCursor, completeUploadIntentWithAsset, configureCursors, countActiveUploadIntents, createSessionRecord, createSmsUser, createUploadIntent, deleteAsset, deleteDramaProject, deleteGeneration, deleteSession, expireUploadIntent, expireUploadIntents, findAsset, findAssetBySha256, findCloudAssets, findDramaProject, findGeneration, findUploadIntent, findUserByLogin, findUserByPhoneNumber, latestDramaProject, listAssetChanges, listAssets, listDramaProjects, listGenerations, listPendingAssetDeliveries, listPendingGenerations, listRecoverableUploadIntents, markAssetDeliveryPending, markAssetDeliveryReady, markUploadIntentFailed, parseLimit, purgeExpiredSessions, registerUser, saveAssetRecord, saveDramaProjectRecord, saveGenerationRecord, updateUserProfile, userForSession } from './lib/store.mjs';
import { claimGenerationJobs, completeGenerationJob, createGenerationRequest, enqueueGenerationJob, findGenerationRequest, generationJobLeaseActive, generationQueueStats, rescheduleGenerationJob, renewGenerationJobLease } from './repositories/generation-jobs.mjs';
import { normalizeMotionPlan, normalizeProductionScenes, productionQualitySummary, STORYBOARD_ENGINE_VERSION } from './lib/storyboard-engine.mjs';
import { callLlm, isLlmConfigured, llmConfigFromEnv } from './lib/llm-client.mjs';
import { buildVideoPayload, publicVideoCapabilities, validateVideoRequest, VIDEO_MODEL_IDS, LEGACY_VIDEO_MODEL_IDS } from './lib/video-capabilities.mjs';
import { createProviderAdapterRegistry } from './lib/provider-adapters.mjs';
import { generationRequestFingerprint } from './lib/generation-service.mjs';
import { createProjectService } from './services/projects.mjs';
import { createDirectorService } from './services/director.mjs';
import { createDuomiProvider } from './providers/duomi.mjs';
import { createTtapiProvider } from './providers/ttapi.mjs';
import { createCntcnProvider } from './providers/cntcn.mjs';
import { createRoutedProvider } from './providers/routed.mjs';
import { createAutodlProvider } from './providers/autodl.mjs';
import { createOaiProvider } from './providers/oai.mjs';
import { createProviderTransport } from './providers/transport.mjs';
import { createStorageKeyService } from './storage/keys.mjs';
import { createGenerationJobPolicy } from './jobs/generation-policy.mjs';
import { createGenerationLifecycleService } from './services/generations.mjs';
import { createGenerationRecoveryService } from './services/generation-recovery.mjs';
import { createMediaArchiveService } from './services/media-archive.mjs';
import { createRuntimeLifecycle } from './services/runtime-lifecycle.mjs';
import { bodyBuffer, bodyForm, bodyJson, mutationAllowed, publicHttpErrorBody, publicHttpErrorMessage, requestTraceId, sendJson, sendText } from './server/http-protocol.mjs';
import { isDesktopRequest, serveFile, serveStatic, staticCacheControl, staticEntryFile } from './server/static.mjs';
import { createAuthRouteHandler } from './server/routes/auth.mjs';
import { createAccountRouteHandler } from './server/routes/account.mjs';
import { createDramaRouteHandler } from './server/routes/drama.mjs';
import { createFilesRouteHandler } from './server/routes/files.mjs';
import { createGenerationRouteHandler } from './server/routes/generations.mjs';
import { createSystemRouteHandler } from './server/routes/system.mjs';
import { handleAdminRequest } from './lib/admin-api.mjs';
import { clientIp, createCaptchaStore, createLoginAttemptLimiter, createSmsSendLimiter, normalizePhoneNumber } from './lib/auth.mjs';
import { checkSmsVerifyCode, sendSmsVerifyCode, smsConfigFromEnv } from './lib/sms.mjs';
import { currentPricing, pricingSnapshot } from './lib/pricing.mjs';
import { isModelEnabled, publicVideoCapabilitiesWithControls } from './lib/model-controls.mjs';
import { ensureDefaultModelRoutes, publicModelPrices, publicRoutePriceVersion, routeCredential, selectModelRoute, startModelRouteMonitor } from './lib/model-routes.mjs';
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
const isMainModule = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
const runtimeBootstrapEnabled = isMainModule || process.env.NODE_ENV === 'test';
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
const imagePollIntervalMs = Math.max(10, Number(process.env.IMAGE_POLL_INTERVAL_MS || 6_000));
const imageMaxPollDurationMs = Math.max(imagePollIntervalMs, Number(process.env.IMAGE_MAX_POLL_DURATION_MS || 10 * 60_000));
const providerSubmissionShutdownGraceMs = Math.max(1_000, Number(process.env.PROVIDER_SUBMISSION_SHUTDOWN_GRACE_MS || 15_000));
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
const archiveRescheduleMs = 5 * 60_000;
const generationRecoverySweepMs = Math.max(15_000, Number(process.env.GENERATION_RECOVERY_SWEEP_MS || 60_000));
const generationJobConcurrency = Math.max(1, Math.min(12, Number(process.env.GENERATION_JOB_CONCURRENCY || 4)));
const generationJobLeaseMs = Math.max(60_000, Number(process.env.GENERATION_JOB_LEASE_MS || 300_000));
const generationJobPollMs = Math.max(5_000, Number(process.env.GENERATION_JOB_POLL_MS || 5_000));
const generationJobPolicy = createGenerationJobPolicy({
  imagePollIntervalMs,
  oaiPollIntervalMs,
  autodlPollIntervalMs,
  ttapiPollIntervalMs,
  cntcnPollIntervalMs,
  defaultPollIntervalMs: generationJobPollMs,
  recoverySweepMs: generationRecoverySweepMs,
  archiveRescheduleMs,
  providerTaskIdDeadline: task => {
    const anchor = Date.parse(task?.createdAt || task?.submissionUncertainAt || '');
    return (Number.isFinite(anchor) ? anchor : Date.now()) + providerTaskIdTimeoutMs;
  },
});
const generationJobOwner = `${process.pid}:${randomUUID()}`;
const generationJobGuards = new Map();
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
const activeGenerationJobs = new Map();
const activeGenerationIds = new Set();
const runtimeLifecycle = createRuntimeLifecycle();
const activeRequests = new Set();
const runtimeMetrics = {
  projectVersionConflicts: 0,
  idempotencyConflicts: 0,
  generationJobsClaimed: 0,
  generationJobsCompleted: 0,
  generationJobsRescheduled: 0,
  generationJobLeaseRenewalFailures: 0,
  generationJobExecutionFailures: 0,
  recoveryRuns: 0,
};
const pendingProviderSubmissions = new Set();
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
// This is the persistence envelope shared by every configured video model.
// Model-specific validation still happens in validateVideoRequest; keeping the
// union here prevents a valid professional-workbench choice from being silently
// rewritten while the drama project is saved.
const videoAspectRatios = new Set(['2:3', '3:2', '1:1', '9:16', '16:9', '21:9', '4:3', '3:4']);
const videoDurations = new Set([8, 10, 15, 20, 30]);
// Short-drama shots are model-specific. GuGu 2.0 accepts every integer
// duration from 1 to 15 seconds, so the project persistence layer must not
// collapse those values back to the legacy 8/10/15/20/30-second set.
const dramaVideoDurations = new Set(Array.from({ length: 30 }, (_, index) => index + 1));
const dramaStepOrder = ['script', 'resources', 'storyboard', 'video'];
const fixedModels = Object.freeze({ image: 'gpt-image-2' });
const invitationCodes = new Set();
const creditPricing = Object.freeze({ image: 1, videoPerSecond: 1, signupBonus: 50 });

if (runtimeBootstrapEnabled) {
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(mediaTmpDir, { recursive: true });
  const staleMediaCutoff = Date.now() - mediaTmpMaxAgeMs;
  for (const entry of await fs.readdir(mediaTmpDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(mediaTmpDir, entry.name);
    const stat = await fs.stat(target).catch(() => null);
    if (stat && stat.mtimeMs < staleMediaCutoff) await fs.rm(target, { recursive: true, force: true }).catch(error => console.error(`[media] 启动清理失败 ${target}`, error.message));
  }
}

// Metadata lives in SQLite; media binaries use local caches and private R2 objects.
if (runtimeBootstrapEnabled) {
  openDatabase({ verbose: true, file: isMainModule ? null : ':memory:' });
  ensureDefaultModelRoutes();
  configureLedger({ llmRates, llmProtocol: llmConfig.protocol, llmModel: llmConfig.model });
  // Signing key for opaque list cursors. Derived from the session secret material
  // so it survives restarts without adding another env var to manage.
  configureCursors(createHash('sha256').update(`cursor:${process.env.DUOMI_API_KEY || ''}:${resolveDbFile()}`).digest('hex'));
}

const expiredSessions = runtimeBootstrapEnabled ? purgeExpiredSessions(new Date().toISOString()) : 0;
if (expiredSessions) console.log(`[sessions] 启动清理过期会话 ${expiredSessions} 条`);
const sessionSweeper = runtimeBootstrapEnabled ? setInterval(() => {
  try {
    const removed = purgeExpiredSessions(new Date().toISOString());
    if (removed) console.log(`[sessions] 定期清理过期会话 ${removed} 条`);
  } catch (error) { console.error('清理过期会话失败', error); }
}, 6 * 60 * 60 * 1000) : null;
sessionSweeper?.unref();
if (sessionSweeper) runtimeLifecycle.registerTimer(sessionSweeper);

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
const storageKeyService = createStorageKeyService({ storagePrefix, referenceImagePrefix: r2ReferenceImagePrefix, safeId, id: randomUUID });
const normalizeDeviceId = value => {
  const deviceId = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,128}$/.test(deviceId) ? deviceId : '';
};
const normalizeWorkspaceId = value => {
  const workspaceId = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,128}$/.test(workspaceId) ? workspaceId : '';
};
function desktopWorkspaceScope(req) {
  const desktop = String(req.headers['x-gugu-desktop'] || '') === '1';
  const deviceId = normalizeDeviceId(req.headers['x-gugu-device-id']);
  const workspaceId = normalizeWorkspaceId(req.headers['x-gugu-workspace-id']);
  return { desktop, deviceId, workspaceId, valid:!desktop || Boolean(deviceId && workspaceId) };
}
function requireDesktopWorkspaceScope(req, res) {
  const scope = desktopWorkspaceScope(req);
  if (!scope.valid) {
    sendJson(res, 400, { error:'桌面工作区标识缺失，请重启客户端后重试', code:'WORKSPACE_SCOPE_REQUIRED' });
    return null;
  }
  return scope;
}
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
const uploadSweeper = runtimeBootstrapEnabled ? setInterval(() => {
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
}, uploadSweepIntervalMs) : null;
uploadSweeper?.unref();
if (uploadSweeper) runtimeLifecycle.registerTimer(uploadSweeper);
const generationFailureCatalog = Object.freeze({
  CONTENT_REJECTED: Object.freeze({ message: '内容未通过生成检查', suggestion: '请调整可能涉及敏感、侵权或高风险的描述及参考图片后重试。', action: 'edit_input' }),
  REFERENCE_REQUIRED: Object.freeze({ message: '当前视频服务要求参考图片', suggestion: '请添加符合要求的参考图片，或切换到支持纯文本生成的视频服务后重试。', action: 'edit_input' }),
  INVALID_REFERENCE: Object.freeze({ message: '参考图片不符合生成要求', suggestion: '请检查图片格式、大小和数量，移除异常图片后重新生成。', action: 'edit_input' }),
  REFERENCE_UPLOAD_FAILED: Object.freeze({ message: '参考图片上传失败', suggestion: '请重新上传或更换参考图片后重试。', action: 'edit_input' }),
  REFERENCE_UNAVAILABLE: Object.freeze({ message: '参考图片暂时无法读取', suggestion: '请重新上传参考图片，确认素材已同步后再试。', action: 'edit_input' }),
  PORTRAIT_RESTRICTED: Object.freeze({ message: '参考图片未通过真人肖像检查', suggestion: '当前服务不接受这张真人参考图片，请更换图片或切换支持该类素材的模型后重试。', action: 'edit_input' }),
  INVALID_REQUEST: Object.freeze({ message: '生成参数不符合要求', suggestion: '请检查提示词、画幅、时长和生成模式后重试。', action: 'edit_input' }),
  PROMPT_TOO_LONG: Object.freeze({ message: '创作描述过长', suggestion: '请精简创作描述后重试。', action: 'edit_input' }),
  UNSUPPORTED_ASPECT_RATIO: Object.freeze({ message: '当前视频服务不支持所选画幅', suggestion: '请更换画幅后重试。', action: 'edit_input' }),
  RATE_LIMITED: Object.freeze({ message: '当前生成请求较多', suggestion: '请稍等几分钟再试，不要连续重复提交。', action: 'retry_later' }),
  TIMEOUT: Object.freeze({ message: '生成等待超时', suggestion: '本次任务已停止，可重新生成；若持续发生，请稍后再试。', action: 'retry' }),
  MODEL_UNRESPONSIVE: Object.freeze({ message: '模型无响应', suggestion: '生成服务未在规定时间内返回任务编号，本次任务已停止，请稍后重试。', action: 'retry_later' }),
  MODEL_UNAVAILABLE: Object.freeze({ message: '当前生成服务不支持所选模型', suggestion: '请稍后重试；若持续出现，请联系支持检查模型配置。', action: 'retry_later' }),
  SERVICE_UNAVAILABLE: Object.freeze({ message: '生成服务暂时不可用', suggestion: '请稍后重试；若持续失败，请联系支持并提供本平台任务编号。', action: 'retry_later' }),
  SERVICE_NOT_CONFIGURED: Object.freeze({ message: '生成服务尚未配置', suggestion: '请联系支持处理当前生成服务配置后再试。', action: 'contact_support' }),
  NETWORK_ERROR: Object.freeze({ message: '生成服务连接失败', suggestion: '请检查网络后稍后重试；若持续失败，请联系支持。', action: 'retry_later' }),
  UPSTREAM_BILLING: Object.freeze({ message: '生成服务额度不足', suggestion: '当前服务暂时无法提交本次任务，请稍后重试或联系支持。', action: 'contact_support' }),
  UPSTREAM_REJECTED: Object.freeze({ message: '生成服务拒绝了本次任务', suggestion: '请调整提示词或参考素材后重试；若仍失败，请联系支持并提供本平台任务编号。', action: 'edit_input' }),
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
  if (/insufficient[_ -]?credits|insufficient balance|insufficient funds|account balance|余额不足|账户余额|余额不够/.test(raw)) return 'UPSTREAM_BILLING';
  if (/may contain real person|real person|肖像保护|本人肖像/.test(raw)) return 'PORTRAIT_RESTRICTED';
  if (/content[_ ]policy|content review|moderation|safety|policy|nsfw|审核|违规|敏感|涉政|色情/.test(raw)) return 'CONTENT_REJECTED';
  if (/requires?\s+\d+\s+to\s+\d+\s+reference images?|reference images?\s+(?:is|are)?\s*required|参考图.*必需|必须.*参考图/.test(raw)) return 'REFERENCE_REQUIRED';
  if (/image upload failed|upload failed.*image|图片上传失败/.test(raw)) return 'REFERENCE_UPLOAD_FAILED';
  if (/(?:reference|参考).*(?:\b(?:404|403)\b|链接.*(?:过期|失效)|download.*failed)|(?:\b(?:404|403)\b).*(?:reference|参考图|图片)/.test(raw)) return 'REFERENCE_UNAVAILABLE';
  if (/unmarshal.*images|image.*\[\]string|参考图|参考素材.*(本地|同步|读取|云端|源地址)|文件本地缓存缺失|没有可用的云端归档|reference image|image[_ ]url|图片.*(格式|大小|尺寸|数量)|unsupported image/.test(raw)) return 'INVALID_REFERENCE';
  if (/prompt length exceeds|prompt.*(?:too long|maximum allowed length)|提示词.*过长|创作描述.*过长/.test(raw)) return 'PROMPT_TOO_LONG';
  if (/aspect ratio.*(?:not supported|unsupported)|不支持画幅|画幅.*不支持/.test(raw)) return 'UNSUPPORTED_ASPECT_RATIO';
  if (/模型不存在|模型.*未开放|model.*(?:does not exist|not found|not available|not enabled|not open)/.test(raw)) return 'MODEL_UNAVAILABLE';
  if (/\bupstream[_ -]?rejected\b/.test(raw)) return 'UPSTREAM_REJECTED';
  if (/\b429\b|rate.?limit|too many requests|overloaded|capacity|繁忙|请求过多|频率/.test(raw)) return 'RATE_LIMITED';
  if (/timeout|timed out|超时|等待超时/.test(raw)) return 'TIMEOUT';
  if (/没有返回任务 id|没有返回结果|没有返回.*url|missing.*(task|result|url)|invalid response|结果地址/.test(raw)) return 'RESULT_INVALID';
  if (/服务.*(尚未配置|未配置)|尚未配置/.test(raw)) return 'SERVICE_NOT_CONFIGURED';
  if (/service(?:\s+is)?\s+unavailable|服务.*不可用/.test(raw)) return 'SERVICE_UNAVAILABLE';
  if (/fetch failed|network|econn|socket/.test(raw)) return 'NETWORK_ERROR';
  if (/\b400\b|\b409\b|\b422\b|invalid (parameter|argument|request)|bad request|参数|不支持.*(画幅|时长|模式)/.test(raw)) return 'INVALID_REQUEST';
  if (/\b(401|403|404|500|502|503|504)\b|fetch failed|network|econn|socket|service unavailable|服务.*(未配置|不可用)|任务没有返回任务 id/.test(raw)) return 'SERVICE_UNAVAILABLE';
  return 'UNKNOWN';
}
function referenceNumber(raw) {
  const match = String(raw || '').match(/(?:reference\s+(?:image\s+)?|image\s+reference\s+|参考(?:图片|图)\s*)#?(\d+)/i);
  return match ? Number(match[1]) : 0;
}
function generationFailure(task) {
  const code = generationFailureCode(task);
  const base = { code, ...(generationFailureCatalog[code] || generationFailureCatalog.UNKNOWN) };
  const raw = String(task.error || '');
  if (code === 'REFERENCE_REQUIRED') {
    const range = raw.match(/requires?\s+(\d+)\s+to\s+(\d+)\s+reference images?/i);
    const requirement = range ? `${range[1]}～${range[2]} 张` : '至少 1 张';
    return { ...base, message: '当前视频服务要求参考图片', suggestion: `本次要求 ${requirement}参考图片，请添加后重试；如果要纯文本生成，请切换到支持纯文本的视频服务。` };
  }
  if (code === 'REFERENCE_UPLOAD_FAILED') {
    return { ...base, suggestion: '参考图片未能上传到生成服务，请重新上传或更换图片后重试。' };
  }
  if (code === 'REFERENCE_UNAVAILABLE') {
    const number = referenceNumber(raw);
    const label = number ? `第 ${number} 张参考图` : '参考图';
    return { ...base, message: `${label}暂时无法读取`, suggestion: `请重新上传${label}，确认素材已同步后再试。` };
  }
  if (code === 'PORTRAIT_RESTRICTED') {
    const requiresOwnerPortrait = /only supports.*(?:本人|real person)|包含本人肖像/.test(raw.toLowerCase());
    return requiresOwnerPortrait
      ? { ...base, suggestion: '当前模型只接受包含本人肖像的参考图，请使用已获本人授权且符合当前服务规则的素材，或移除参考图改用纯文本生成。' }
      : { ...base, suggestion: '当前服务不接受这张真人参考图；如果当前服务规则允许，可先转换为彩铅或插画风格，或按要求增加面部网格/标记后重试。请确保素材已获授权并符合服务规则；也可以改用虚构角色或非真人素材，或切换到明确支持真人肖像的模型。' };
  }
  if (code === 'CONTENT_REJECTED' && /reference|image reference|参考图|图片/.test(raw.toLowerCase())) {
    const number = referenceNumber(raw);
    const label = number ? `第 ${number} 张参考图` : '参考图片';
    return { ...base, message: `${label}未通过内容安全检查`, suggestion: `请更换或移除触发检查的${label}后重试。` };
  }
  if (code === 'PROMPT_TOO_LONG') {
    const limit = raw.match(/maximum allowed length of\s*(\d+)/i)?.[1] || '允许上限';
    return { ...base, suggestion: `请将创作描述压缩到 ${limit} 个字符以内后重试。` };
  }
  if (code === 'UNSUPPORTED_ASPECT_RATIO') {
    const requested = task.aspectRatio || '当前';
    const supported = raw.match(/可选[：:]\s*([^。]+)/i)?.[1]?.trim();
    return { ...base, message: `当前视频服务不支持 ${requested} 画幅`, suggestion: supported ? `请改用 ${supported} 后重试。` : '请改用支持的画幅后重试。' };
  }
  if (code === 'RATE_LIMITED' && /系统繁忙|overloaded|capacity/.test(raw.toLowerCase())) {
    return { ...base, message: '当前视频生成服务暂时繁忙', suggestion: '请稍后重试，或切换其他可用模型。' };
  }
  if (code === 'UPSTREAM_BILLING') {
    return { ...base, message: task.type === 'image' ? '当前图像生成服务额度不足' : '当前视频生成服务额度不足', suggestion: '当前服务暂时无法提交本次任务，请稍后重试或联系支持。' };
  }
  if (code === 'INTERRUPTED' && /服务重启/.test(raw)) {
    return { ...base, message: '任务在提交前被服务重启中断', suggestion: '本次任务没有提交到模型服务，可以直接重新生成。' };
  }
  return base;
}
const publicGenerationFields = Object.freeze([
  'id', 'type', 'status', 'prompt', 'referenceAssetIds', 'modelId', 'size', 'quality', 'aspectRatio', 'duration',
  'videoModelId', 'generationType', 'assetId', 'creditCost', 'creditStatus', 'createdAt', 'updatedAt', 'submittedAt',
  'finishedAt', 'progress', 'awaitingReferences', 'batchSize',
]);
function publicGeneration(task) {
  // Keep this response allow-listed. Generation records also contain provider
  // credentials, endpoints, provider task IDs, upstream model IDs and raw
  // diagnostics that must never cross the customer API boundary.
  const value = Object.fromEntries(publicGenerationFields
    .filter(field => Object.hasOwn(task, field))
    .map(field => [field, task[field]]));
  const failure = task.status === 'failed' ? generationFailure(task) : null;
  const progressStage = task.awaitingReferences ? 'preparing_references'
    : task.status !== 'running' ? task.status
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
const publicCreditModelIds = new Set([
  fixedModels.image,
  ...Object.values(VIDEO_MODEL_IDS),
  ...Object.values(LEGACY_VIDEO_MODEL_IDS),
]);
function publicCreditEntry(entry) {
  const value = {
    type: entry?.type || 'credit_entry',
    amount: Number(entry?.amount) || 0,
    createdAt: entry?.createdAt || '',
  };
  if (['image', 'video'].includes(entry?.contentType)) value.contentType = entry.contentType;
  if (publicCreditModelIds.has(entry?.modelId)) value.modelId = entry.modelId;
  return value;
}
const publicLlmUsageFields = Object.freeze([
  'inputTokens', 'outputTokens', 'chargedCredits', 'attemptCount', 'maxAttemptCount',
  'recoveryAttempts', 'maxRecoveryRounds', 'initialReturnedCount', 'recoveredShotCount',
  'completionCount', 'recoveryMode', 'correctedProblemCount', 'autoCompleted',
  'autoRegenerated', 'autoCorrected',
]);
function publicLlmUsage(usage) {
  const value = Object.fromEntries(publicLlmUsageFields
    .filter(field => Object.hasOwn(usage || {}, field))
    .map(field => [field, usage[field]]));
  if (Array.isArray(usage?.attempts)) {
    value.attempts = usage.attempts.map(attempt => Object.fromEntries(
      ['type', 'inputTokens', 'outputTokens', 'chargedCredits']
        .filter(field => Object.hasOwn(attempt || {}, field))
        .map(field => [field, attempt[field]]),
    ));
  }
  return value;
}
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
        const { selectedRouteId, selectedRouteName, ...safeItem } = item;
        items.push({ ...safeItem, enabled: true, availability: 'available', unit: 'second', totalCredits: item.credits, totalYuan: item.yuan, credits: item.credits / seconds, yuan: item.yuan / seconds });
      }
      continue;
    }
    const mode = model.modes?.find(item => item.generationType === 'TEXT') || model.modes?.[0];
    if (!mode) continue;
    for (const quality of mode.qualityOptions?.length ? mode.qualityOptions : ['标准']) {
      const price = mode.pricingByQuality?.[quality] || mode.pricing || { currency: 'credit', amount: pricing.videoPerSecond, unit: 'second' };
      const credits = Number(price.amount || 0);
      items.push({ modelId:model.id, label:model.label, quality, duration:null, available:true, enabled:model.enabled !== false, availability:model.availability || 'available', credits, yuan:credits * 0.1, unit:price.unit || 'second', priceVersion:`v1-${createHash('sha256').update(`gugu-price:platform:${pricing.version}:${model.id}:${quality}`).digest('hex').slice(0, 32)}` });
    }
  }
  if (isModelEnabled(fixedModels.image)) items.push({ modelId: fixedModels.image, label: 'GuGu 图像', quality: '标准', duration: null, available: true, enabled: true, availability: 'available', credits: pricing.imagePerRequest, yuan: pricing.imagePerRequest * 0.1, unit: 'request', priceVersion: `v1-${createHash('sha256').update(`gugu-price:platform:${pricing.version}:image`).digest('hex').slice(0, 32)}` });
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
const providerTransport = createProviderTransport({ fetchImpl: (...args) => globalThis.fetch(...args), errorMessage, videoProgress, sleep, pendingProviderSubmissions });
const duomiProvider = createDuomiProvider({
  baseUrl: duomiBase,
  apiKey: process.env.DUOMI_API_KEY,
  ...providerTransport,
  sleep,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  imageMaxPollDurationMs,
  videoMaxPollDurationMs,
  buildVideoPayload,
  errorMessage,
});
const ttapiProvider = createTtapiProvider({
  baseUrl: ttapiBase,
  apiKey: process.env.TTAPI_API_KEY,
  ...providerTransport,
  sleep,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  videoMaxPollDurationMs,
  pollIntervalMs: ttapiPollIntervalMs,
  maxBackoffMs: ttapiMaxPollBackoffMs,
  requestTimeoutMs: ttapiRequestTimeoutMs,
  errorMessage,
});
const cntcnProvider = createCntcnProvider({
  baseUrl: cntcnBase,
  apiKey: process.env.CNTCN_KEY,
  ...providerTransport,
  sleep,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  videoMaxPollDurationMs,
  pollIntervalMs: cntcnPollIntervalMs,
  requestTimeoutMs: cntcnRequestTimeoutMs,
  buildVideoPayload,
  errorMessage,
});
const routedProvider = createRoutedProvider({
  ...providerTransport,
  sleep,
  routeCredential,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  videoMaxPollDurationMs,
  submitTimeoutMs: routedVideoSubmitTimeoutMs,
  errorMessage,
});
const autodlProvider = createAutodlProvider({
  baseUrl: autodlBase,
  workflowId: autodlWorkflowId,
  apiKey: process.env.AUTODL_COMFYUI_KEY,
  ...providerTransport,
  sleep,
  notifyVideoProgress: providerTransport.notifyVideoProgress,
  upstreamRequestErrorDetail: providerTransport.upstreamRequestErrorDetail,
  isDefinitiveSubmitRejection: providerTransport.isDefinitiveSubmitRejection,
  errorMessage,
  videoPollTimeoutError,
  pollIntervalMs: autodlPollIntervalMs,
  requestTimeoutMs: autodlRequestTimeoutMs,
  maxPollDurationMs: autodlMaxPollDurationMs,
  maxPolls: autodlMaxPolls,
});
const oaiProvider = createOaiProvider({
  baseUrl: oaiBase,
  keys: {
    gemini: process.env.OAIAPI_GEMINI_KEY,
    veo: process.env.OAIAPI_VEO_KEY,
    minimax: process.env.OAIAPI_MINIMAX_KEY,
    grok: process.env.OAIAPI_GROK_KEY,
  },
  ...providerTransport,
  sleep,
  videoPollRemainingMs,
  videoPollRequestSignal,
  videoPollTimeoutError,
  videoPollStartedAt,
  buildVideoPayload,
  videoModelIds: VIDEO_MODEL_IDS,
  legacyVideoModelIds: LEGACY_VIDEO_MODEL_IDS,
  pollIntervalMs: oaiPollIntervalMs,
  requestTimeoutMs: oaiRequestTimeoutMs,
  maxPollDurationMs: oaiMaxPollDurationMs,
  maxPolls: oaiMaxPolls,
  errorMessage,
});
const { fetchJson, trackProviderSubmission, waitForProviderSubmissions, upstreamRequestErrorDetail, isDefinitiveSubmitRejection, notifyVideoProgress } = providerTransport;
const pollDuomiImage = (...args) => duomiProvider.pollImage(...args);
const createImage = (...args) => duomiProvider.createImage(...args);
const routedVideoPayload = routedProvider.payload;

const oaiVideoUrl = oaiProvider.videoUrl;
const oaiTaskId = oaiProvider.taskId;
const oaiStatus = oaiProvider.status;
const isLegacyOaiGrokTask = oaiProvider.isLegacyGrokTask;
const oaiKeyForTask = oaiProvider.keyForTask;
const buildOaiVideoPayload = oaiProvider.payload;
const autodlStatus = autodlProvider.status;
const autodlTaskId = autodlProvider.taskId;
const autodlResults = autodlProvider.results;
const autodlVideoUrl = autodlProvider.videoUrl;
const autodlRetryableResponseError = autodlProvider.retryableResponseError;
const buildAutodlPayload = autodlProvider.payload;
const pollAutodlVideo = (...args) => autodlProvider.pollVideo(...args);
const createAutodlVideo = (...args) => autodlProvider.createVideo(...args);
function canonicalVideoModelId(value) {
  const modelId = String(value || '').trim().toLowerCase();
  return modelId === LEGACY_VIDEO_MODEL_IDS.GUGU_2 ? VIDEO_MODEL_IDS.MINIMAX_H3_15S : modelId;
}
const projectService = createProjectService({
  videoAspectRatios, dramaVideoDurations, dramaStepOrder, canonicalVideoModelId, publicLlmUsage,
});
const { publicDramaProject, createDefaultDramaShot, normalizeDramaProject, dramaProjectGenerationIds, removeGenerationFromDramaProject } = projectService;
const directorService = createDirectorService({
  storyboardEngineVersion: STORYBOARD_ENGINE_VERSION,
  llmConfig,
  conservativeInputTokenUpperBound,
  llmReservationMicro,
  llmRates,
  reserveLlmCredits,
  settleLlmCredits,
  releaseLlmCredits,
  markLlmBillingReconcile,
  callLlm,
  publicLlmUsage,
  publicDramaProject,
  normalizeDramaProject,
});
const { runSmartDirector, analyzeScript, createStoryboard } = directorService;
async function createVideo(task, refs, hooks = {}) {
  const adapter = videoProviderAdapters.forTask(task);
  if (!adapter) throw new Error(`不支持的视频供应商：${task.provider || '未指定'}`);
  adapter.validate(task);
  return adapter.submit(task, refs, hooks);
}

function persistedProviderTask(task) {
  return task?.providerTaskId ? { taskId:String(task.providerTaskId) } : null;
}
function validVideoTask(task) {
  if (!task || task.type !== 'video') throw new Error('视频任务参数无效');
  return task;
}
const videoProviderAdapters = createProviderAdapterRegistry({
  duomi: {
    validate: validVideoTask,
    submit: (task, refs, hooks) => duomiProvider.createVideo(task, refs, hooks),
    poll: (task, hooks, startedAt, options) => duomiProvider.pollVideo(task, hooks, startedAt, options),
    lookup: persistedProviderTask,
  },
  ttapi: {
    validate: task => { validVideoTask(task); if (!ttapiConfigured) throw new Error('TTAPI 视频服务尚未配置'); return task; },
    submit: (task, refs, hooks) => ttapiProvider.createVideo(task, refs, hooks),
    poll: (task, hooks, startedAt, options) => ttapiProvider.pollVideo(task.providerTaskId, hooks, startedAt, options),
    lookup: persistedProviderTask,
  },
  cntcn: {
    validate: task => { validVideoTask(task); if (!cntcnConfigured) throw new Error('CNTCN Seedance 视频服务尚未配置'); return task; },
    submit: (task, refs, hooks) => cntcnProvider.createVideo(task, refs, hooks),
    poll: (task, hooks, startedAt, options) => cntcnProvider.pollVideo(task.providerTaskId, hooks, startedAt, options),
    lookup: persistedProviderTask,
  },
  autodl: {
    validate: task => { validVideoTask(task); if (!autodlConfigured) throw new Error('AutoDL GuGu 2.0 视频服务尚未配置'); return task; },
    submit: (task, refs, hooks) => autodlProvider.createVideo(task, refs, hooks),
    poll: (task, hooks, _startedAt) => autodlProvider.pollVideo(task.providerTaskId, hooks, { startedAt: videoPollStartedAt(task) }),
    lookup: persistedProviderTask,
  },
  oai: {
    validate: task => {
      validVideoTask(task);
      if (!oaiProvider.keyForTask(task)) {
        const message = oaiProvider.isLegacyGrokTask(task)
          ? '历史 Grok Video 服务尚未配置'
          : task.videoModelId === VIDEO_MODEL_IDS.VEO_31
            ? 'Veo 3.1 服务尚未配置'
            : task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3
              ? 'MiniMax H3 服务尚未配置'
              : 'OAI 视频服务尚未配置';
        throw new Error(message);
      }
      return task;
    },
    submit: (task, refs, hooks) => oaiProvider.createVideo(task, refs, hooks),
    poll: (task, hooks, _startedAt, options) => oaiProvider.pollVideo(task, hooks, options),
    lookup: persistedProviderTask,
  },
  route: {
    validate: validVideoTask,
    submit: (task, refs, hooks) => routedProvider.createVideo(task, refs, hooks),
    poll: (task, hooks) => routedProvider.pollVideo(task, hooks),
    lookup: persistedProviderTask,
  },
});
function downloadErrorDetail(error) { const cause = error?.cause; return [cause?.code, cause?.message || error?.message].filter(Boolean).join(' · ') || '未知网络错误'; }
async function downloadToFile(url, target, attempts = 4, options = {}) {
  const partial = `${target}.part`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'Model-Studio/1.0', Accept: '*/*', ...(options.headers || {}) } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('响应没有文件内容');
      const hash = createHash('sha256');
      let prefix = Buffer.alloc(0);
      const digest = new Transform({ transform(chunk, _encoding, done) {
        hash.update(chunk);
        if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)]);
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), digest, createWriteStream(partial, { flags:'w' }));
      const stat = await fs.stat(partial);
      const detectedType = validateDownloadedMedia(prefix, stat.size, { kind:options.kind, contentType:response.headers.get('content-type') || '' });
      await fs.rename(partial, target);
      return { contentType: detectedType || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream', size: stat.size, sha256:hash.digest('hex') };
    } catch (error) {
      lastError = error;
      await fs.unlink(partial).catch(() => {});
      if (attempt < attempts) await sleep(1500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`成品下载失败（已重试 ${attempts} 次）：${downloadErrorDetail(lastError)}`);
}

function assertGenerationJobLease(task, leaseGuard = generationJobGuards.get(task?.id)) {
  const guard = leaseGuard;
  if (!guard) return;
  if (!generationJobLeaseActive(guard)) {
    throw Object.assign(new Error('生成任务执行租约已失效'), { code:'GENERATION_JOB_LEASE_LOST' });
  }
}
function saveGeneration(userId, task) {
  assertGenerationJobLease(task);
  task.updatedAt = now();
  return saveGenerationRecord(userId, task);
}
async function saveGenerationWithRetry(userId, task, phase = 'update') {
  let failures = 0;
  for (;;) {
    try { return await saveGeneration(userId, task); }
    catch (error) {
      if (error.code === 'GENERATION_JOB_LEASE_LOST') throw error;
      failures++;
      console.error('[generation] critical state persistence retry', { generationId: task.id, phase, failures, message: error.message });
      await sleep(Math.min(500 * 2 ** Math.min(failures - 1, 6), generationRetryMaxDelayMs));
    }
  }
}
function saveDramaProject(userId, project, { create = false, expectedRevision = project.revision } = {}) {
  if (create) {
    project.revision = Math.max(1, Number(project.revision) || 1);
    project.updatedAt = now();
    saveDramaProjectRecord(userId, project, { insertOnly: true });
    return project;
  }

  const currentRevision = Number(expectedRevision);
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1) {
    throw Object.assign(new Error('项目版本无效，请刷新后重试'), {
      statusCode: 409,
      code: 'PROJECT_VERSION_CONFLICT',
      publicMessage: '项目版本已过期，请刷新后重试',
    });
  }
  const candidate = { ...project, revision: currentRevision + 1, updatedAt: now() };
  const result = saveDramaProjectRecord(userId, candidate, { expectedRevision: currentRevision });
  if (!result.saved) {
    runtimeMetrics.projectVersionConflicts++;
    throw Object.assign(new Error('项目已在其他操作中更新'), {
      statusCode: 409,
      code: 'PROJECT_VERSION_CONFLICT',
      publicMessage: '项目已在其他操作中更新，请刷新后重试',
    });
  }
  Object.assign(project, candidate);
  return project;
}
async function loadDramaProject(userId, id, scope = {}) {
  const project = findDramaProject(userId, id, scope);
  if (!project) return null;
  normalizeDramaProject(project);
  // Projects outlive generation records. Repair references while loading so a
  // deleted work can never leave the short-drama page pointing at a phantom
  // task and showing “任务记录不可用” forever.
  const staleIds = dramaProjectGenerationIds(project).filter(taskId => !findGeneration(userId, taskId, scope));
  if (staleIds.length) {
    staleIds.forEach(taskId => removeGenerationFromDramaProject(project, taskId));
    await saveDramaProject(userId, project);
  }
  return project;
}
function reconcileDramaProjectGenerationReferences(userId, project, scope = {}) {
  const staleIds = dramaProjectGenerationIds(project).filter(taskId => !findGeneration(userId, taskId, scope));
  staleIds.forEach(taskId => removeGenerationFromDramaProject(project, taskId));
  return staleIds.length > 0;
}
async function saveAsset(userId, asset) {
  asset.updatedAt = now();
  saveAssetRecord(userId, asset);
  return asset;
}
function saveGenerationAsset(userId, asset, task, leaseGuard) {
  assertGenerationJobLease(task, leaseGuard);
  return tx(() => {
    assertGenerationJobLease(task, leaseGuard);
    asset.updatedAt = now();
    const saved = saveAssetRecord(userId, asset);
    assertGenerationJobLease(task, leaseGuard);
    return saved;
  });
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
async function deleteGenerationRecord(userId, task, { project = null } = {}) {
  const id = String(task?.id || '');
  if (!id) throw new Error('生成记录不存在');
  const retryTimer = generationRetryTimers.get(id);
  if (retryTimer) { clearTimeout(retryTimer); generationRetryTimers.delete(id); }
  clearProviderTaskIdTimeout(id);
  const asset = task.assetId ? findAsset(userId, task.assetId) : null;
  // Mutate the supplied project in memory so the short-drama endpoint can
  // return the exact post-delete selection in the same response.
  if (project) removeGenerationFromDramaProject(project, id);
  await deleteAssetRecord(userId, asset);
  deleteGeneration(userId, id);
  if (project) await saveDramaProject(userId, project);
  else await removeGenerationFromDramaProjects(userId, task);
  return { deletedAssetId: asset?.id || null };
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
  // Client receipt is evidence of local delivery, not a replacement for
  // metadata already measured by the server while archiving.
  if (asset.objectKey && ((asset.size > 0 && asset.size !== normalizedSize) || (asset.sha256 && asset.sha256 !== normalizedSha256))) {
    return { status:409, error:'本地文件与云端文件不一致，请重新下载' };
  }
  if (!asset.objectKey) {
    asset.size = normalizedSize;
    asset.sha256 = normalizedSha256;
    asset.mimeType = normalizedMimeType;
  }
  asset.deliveryStatus = 'local_ready';
  asset.localReadyAt = now();
  asset.remoteStatus = asset.objectKey ? 'ready' : 'local_only';
  await saveAsset(userId, asset);
  if (deviceId) markAssetDeliveryReady(userId, deviceId, asset.id);
  if (asset.sourceGenerationId) {
    const task = findGeneration(userId, asset.sourceGenerationId, { deviceId:asset.originDeviceId, workspaceId:asset.originWorkspaceId });
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
const publicAssetFields = Object.freeze([
  'id', 'name', 'kind', 'mimeType', 'size', 'sha256', 'width', 'height', 'source', 'createdAt', 'updatedAt', 'deliveryStatus', 'remoteStatus', 'sourceGenerationId',
]);
function publicAsset(asset) {
  const value = Object.fromEntries(publicAssetFields
    .filter(field => Object.hasOwn(asset, field))
    .map(field => [field, asset[field]]));
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
const assetObjectKey = storageKeyService.assetObjectKey;
const mediaArchive = createMediaArchiveService({
  assertGenerationJobLease,
  findAsset,
  findGeneration,
  saveAsset,
  saveGenerationAsset,
  withMediaTempDir,
  generationAssetExtension,
  generationAssetName,
  generationSourceHeaders,
  assetObjectKey,
  download:downloadToFile,
  put:putObject,
  remove:deleteObject,
  now,
});
const { prepareGenerationAsset, archiveGenerationResult } = mediaArchive;
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
const uploadExtension = storageKeyService.uploadExtension;
const pendingUploadKey = storageKeyService.pendingUploadKey;
const finalUploadKey = storageKeyService.finalUploadKey;
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
const r2ReferenceImageKey = storageKeyService.referenceImageKey;
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
  runtimeLifecycle.registerTimer(timer);
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
  const scope = { deviceId:task.originDeviceId, workspaceId:task.originWorkspaceId };
  if (!referenceIds.length) return [];
  if (!r2Reference) throw storageUnavailable('r2-reference');
  // Image providers may fetch the reference after submission. Always stage a
  // short-lived copy in the dedicated reference bucket.
  return withMediaTempDir(`image-reference-${task.id}`, async jobDir => {
    const refs = [];
    for (const id of referenceIds) {
      const asset = findAsset(userId, id, scope);
      if (!asset || asset.kind !== 'image') continue;
      refs.push(await stageImageReference(userId, task, asset, jobDir));
    }
    return refs;
  });
}
async function resolveRefs(userId, ids, task = {}) {
  const mixed = task.routeId || task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_2 || task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_25 || task.videoModelId === VIDEO_MODEL_IDS.SEEDANCE_2_FAST || task.videoModelId === VIDEO_MODEL_IDS.MINIMAX_H3 || task.provider === 'autodl';
  const scope = { deviceId:task.originDeviceId, workspaceId:task.originWorkspaceId };
  const refs = mixed ? { images: [], videos: [], audios: [] } : [];
  // Image references use the dedicated reference bucket; video and audio
  // references use longer-lived signed URLs from the private media bucket.
  return withMediaTempDir(`video-reference-${task.id}`, async jobDir => {
    for (const id of ids.slice(0, task.referenceLimits?.total || 15)) {
      const asset = findAsset(userId, id, scope);
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
async function validateReferenceAssets(userId, value, limits = null, { requireReadable = true, scope = {} } = {}) {
  if (value !== undefined && !Array.isArray(value)) throw Object.assign(new Error('参考素材 referenceAssetIds 必须使用数组格式'), { statusCode: 400 });
  const ids = [...new Set((value || []).map(safeId).filter(Boolean))];
  const referenceLimits = limits || { image: 7, video: 0, audio: 0, total: 7 };
  if (ids.length > referenceLimits.total) throw Object.assign(new Error(`参考素材最多支持 ${referenceLimits.total} 个（图片 ${referenceLimits.image} / 视频 ${referenceLimits.video} / 音频 ${referenceLimits.audio}）`), { statusCode: 400 });
  const counts = { image: 0, video: 0, audio: 0 };
  for (const id of ids) {
    const asset = findAsset(userId, id, scope);
    if (!asset || !Object.hasOwn(counts, asset.kind)) throw Object.assign(new Error('参考素材不存在或类型不受当前模型支持'), { statusCode: 400 });
    counts[asset.kind]++;
    if (counts[asset.kind] > Number(referenceLimits[asset.kind] || 0)) throw Object.assign(new Error(`参考${asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : '音频'}最多支持 ${referenceLimits[asset.kind]} 个`), { statusCode: 400 });
    if (asset.kind === 'image' && Number(asset.size) > maxReferenceImageBytes) throw Object.assign(new Error(`参考图“${asset.name}”超过 20 MB`), { statusCode: 400 });
    if (asset.kind !== 'image' && Number(asset.size) > maxUploadBytes) throw Object.assign(new Error(`参考素材“${asset.name}”超过 25 MB`), { statusCode: 400 });
    if (requireReadable && !await referenceAssetHasReadableSource(userId, asset)) throw Object.assign(new Error(`参考素材“${asset.name}”尚未同步到云端，请重新选择或上传后再试`), { statusCode:409, code:'REFERENCE_NOT_READY' });
  }
  return ids;
}
function referenceAssetCounts(userId, ids, scope = {}) {
  const counts = { image: 0, video: 0, audio: 0 };
  for (const id of ids || []) {
    const asset = findAsset(userId, id, scope);
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
function assertReferenceCountsWithinLimits(counts, limits) {
  if (!limits) return;
  const normalized = counts || {};
  const total = ['image', 'video', 'audio'].reduce((sum, kind) => sum + Number(normalized[kind] || 0), 0);
  if (total > Number(limits.total || 0)) throw Object.assign(new Error(`参考素材最多支持 ${limits.total} 个`), { statusCode: 400 });
  for (const kind of ['image', 'video', 'audio']) {
    if (Number(normalized[kind] || 0) > Number(limits[kind] || 0)) {
      const label = kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频';
      throw Object.assign(new Error(`参考${label}最多支持 ${limits[kind] || 0} 个`), { statusCode: 400 });
    }
  }
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
  if (contentUrl && resultUrl === contentUrl) return { Authorization: `Bearer ${oaiProvider.keyForTask(task)}` };
  return {};
}
function generationAssetExtension(task) { return task?.type === 'image' ? '.png' : '.mp4'; }
function generationAssetName(task, extension = generationAssetExtension(task)) {
  return `${task?.type === 'image' ? '生成图片' : '生成视频'} ${new Date(task?.createdAt || Date.now()).toLocaleString('zh-CN')}${extension}`;
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
  const controller = new AbortController();
  const cancel = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', cancel);
  try {
    const response = await fetch(sourceUrl, { headers:generationSourceHeaders(task, sourceUrl.toString()), signal:AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]) });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      sendJson(res, 502, { error:`成品下载暂时失败（${response.status}）` });
      return true;
    }
    const contentType = response.headers.get('content-type')?.split(';')[0] || asset.mimeType || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');
    const headers = { 'Content-Type':contentType, 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff' };
    if (contentLength) headers['Content-Length'] = contentLength;
    res.writeHead(200, headers);
    await pipeline(Readable.fromWeb(response.body), res, { signal:controller.signal });
  } catch (error) {
    if (!res.destroyed && !res.headersSent) sendJson(res, 502, { error:'成品下载中断，请重试' });
    else if (!res.destroyed) res.destroy();
    if (!controller.signal.aborted) console.warn('[delivery] 上游传输中断', { assetId:asset.id, message:error.message });
  } finally { res.off('close', cancel); }
  return true;
}
function progressPersistenceHooks(userId, task) {
  return {
    onProgress: async ({ progress }) => {
      const pollRecovered = clearPollFailureState(task);
      if (task.progress === progress && !pollRecovered) return;
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
function clearPollFailureState(task) {
  const changed = Boolean(task.lastPollError || task.lastPollErrorAt || task.pollFailureCount);
  if (!changed) return false;
  task.lastPollError = '';
  task.lastPollErrorAt = null;
  task.pollFailureCount = 0;
  return true;
}
function duomiImagePersistenceHooks(userId, task) {
  return {
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
      await saveGenerationWithRetry(userId, task, 'duomi-image-submitted');
    },
    onPollError: async ({ consecutiveErrors, detail }) => {
      task.status = 'running';
      task.lastPollError = detail;
      task.lastPollErrorAt = now();
      task.pollFailureCount = consecutiveErrors;
      await saveGeneration(userId, task);
    },
    onPollRecovered: async () => {
      if (!clearPollFailureState(task)) return;
      await saveGeneration(userId, task);
    },
  };
}
function duomiVideoPersistenceHooks(userId, task) {
  return { ...progressPersistenceHooks(userId, task), ...duomiImagePersistenceHooks(userId, task) };
}
function oaiPersistenceHooks(userId, task) {
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
      await saveGenerationWithRetry(userId, task, 'oai-submitted');
    },
    onPollError: async ({ consecutiveErrors, detail }) => {
      task.status = 'running';
      task.lastPollError = detail;
      task.lastPollErrorAt = now();
      task.pollFailureCount = consecutiveErrors;
      await saveGeneration(userId, task);
    },
    onPollRecovered: async () => {
      if (!clearPollFailureState(task)) return;
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
      if (!clearPollFailureState(task)) return;
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
      if (!clearPollFailureState(task)) return;
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
      if (!clearPollFailureState(task)) return;
      await saveGeneration(userId, task);
    },
  };
}
function requestGenerationArchive(userId, asset) {
  if (asset.objectKey) return { status:'ready' };
  if (asset.localReadyAt || asset.deliveryStatus === 'local_ready') return { status:'local_ready' };
  const task = asset.sourceGenerationId ? findGeneration(userId, asset.sourceGenerationId, { deviceId:asset.originDeviceId, workspaceId:asset.originWorkspaceId }) : null;
  if (!task || task.assetId !== asset.id || task.status !== 'completed' || !asset.sourceUrl) return { error:'没有可恢复的生成结果' };
  if (task.localReadyAt) return { status:'local_ready' };
  tx(() => {
    task.sourceUrl ||= asset.sourceUrl;
    task.archivePending = true;
    task.localReadyAt = '';
    task.localDeliveryDeadlineAt = '';
    asset.localReadyAt = '';
    asset.deliveryStatus = 'awaiting_local';
    asset.remoteStatus = 'pending';
    saveAssetRecord(userId, { ...asset, updatedAt:now() });
    saveGenerationRecord(userId, { ...task, updatedAt:now() });
    enqueueGenerationJob({ userId, generationId:task.id, kind:'archive', nextRunAt:Date.now() });
  });
  drainGenerationJobs();
  return { status:'pending' };
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
      enqueueGenerationJob({ userId, generationId:current.id, kind:'archive', nextRunAt:Date.now() });
      drainGenerationJobs();
    }
  }, delay);
  timer.unref();
  runtimeLifecycle.registerTimer(timer);
  generationRetryTimers.set(task.id, timer);
}
async function archiveGenerationWithRetry(userId, task) {
  let current = findGeneration(userId, task.id) || task;
  if (!current.archivePending || current.localReadyAt) { Object.assign(task, current); return true; }
  let validSource = false;
  try { validSource = typeof current.sourceUrl === 'string' && ['http:', 'https:'].includes(new URL(current.sourceUrl).protocol); } catch {}
  if (!validSource) {
    current.archivePending = false;
    current.lastArchiveError = '生成结果链接缺失或无效，归档已停止，请联系支持';
    current.lastArchiveErrorAt = now();
    current.archiveErrorCode = 'INVALID_SOURCE_URL';
    await saveGenerationWithRetry(userId, current, 'archive-invalid-source');
    Object.assign(task, current);
    return true;
  }
  try {
    await archiveGenerationResult(userId, current, current.sourceUrl);
    current = findGeneration(userId, task.id) || current;
    current.archiveFailureCount = 0;
    current.archivePending = false;
    current.localDeliveryDeadlineAt = '';
    current.lastArchiveError = '';
    current.lastArchiveErrorAt = null;
    current.status = 'completed';
    current.error = '';
    current.finishedAt ||= now();
    await saveGenerationWithRetry(userId, current, 'archive-completed');
    Object.assign(task, current);
    return true;
  } catch (error) {
    current = findGeneration(userId, task.id) || current;
    if (current.localReadyAt || !current.archivePending) { Object.assign(task, current); return true; }
    const failures = (Number(current.archiveFailureCount) || 0) + 1;
    generationLifecycle.markArchivePending(current);
    current.archiveFailureCount = failures;
    current.lastArchiveError = error.message;
    current.lastArchiveErrorAt = now();
    await saveGeneration(userId, current);
    Object.assign(task, current);
    console.error('[generation] archive retry scheduled', { generationId: task.id, failures, message: error.message });
    return false;
  }
}
async function completeGenerationResult(userId, task, result) {
  assertGenerationJobLease(task);
  task.provider = result.provider || task.provider;
  task.providerTaskId = result.taskId || task.providerTaskId;
  task.sourceUrl = result.url;
  task.sourceRequiresAuth = Boolean(result.requiresAuth);
  // A transient poll failure is diagnostic state, not part of the terminal
  // result. Clear it here as a defensive boundary so a completed task cannot
  // carry a stale retry indicator into a later client refresh.
  clearPollFailureState(task);
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
  assertGenerationJobLease(task);
  task.status = 'failed';
  task.error = error.message;
  try {
    await refundGenerationMicro(userId, task.id, task.creditCostMicro ?? creditsToMicro(task.creditCost));
    task.creditStatus = 'refunded';
  } catch (refundError) {
    task.creditStatus = 'refund_failed';
    task.error += `；自动退款失败：${refundError.message}`;
    enqueueGenerationJob({ userId, generationId:task.id, kind:'refund_reconcile', nextRunAt:Date.now() + archiveRescheduleMs });
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
const generationLifecycle = createGenerationLifecycleService({ now, saveGenerationWithRetry, providerTaskIdDeadline });
const generationRecovery = createGenerationRecoveryService({ activeGenerations, now, saveGeneration, saveGenerationWithRetry, completeGenerationResult, failGeneration });
function clearProviderTaskIdTimeout(generationId) {
  const timer = providerTaskIdTimeoutTimers.get(generationId);
  if (timer) clearTimeout(timer);
  providerTaskIdTimeoutTimers.delete(generationId);
}
async function failMissingProviderTaskId(userId, task) {
  clearProviderTaskIdTimeout(task.id);
  generationLifecycle.markSubmissionTimedOut(task);
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
        enqueueGenerationJob({ userId, generationId:current.id, kind:'reconcile_submission', nextRunAt:Date.now() });
        drainGenerationJobs();
      }
    } catch (error) {
      console.error('[generation] provider task ID timeout handling failed', { generationId: task.id, message: error.message });
    }
  }, delay);
  timer.unref();
  runtimeLifecycle.registerTimer(timer);
  providerTaskIdTimeoutTimers.set(task.id, timer);
}
function startGeneration(userId, task, { deferPolling = false } = {}) {
  if (activeGenerations.has(task.id)) return activeGenerations.get(task.id);
  const promise = (async () => {
    try {
      generationLifecycle.markRunning(task);
      await saveGenerationWithRetry(userId, task, 'generation-running');
      const refs = task.type === 'image'
        ? await resolveImageRefs(userId, task.referenceAssetIds, task)
        : await resolveRefs(userId, task.referenceAssetIds, task);
      const hooks = task.type === 'image' && task.provider === 'duomi'
        ? duomiImagePersistenceHooks(userId, task)
        : task.provider === 'oai'
        ? oaiPersistenceHooks(userId, task)
        : task.routeId
        ? routedPersistenceHooks(userId, task)
        : task.provider === 'ttapi'
        ? ttapiPersistenceHooks(userId, task)
        : task.provider === 'cntcn'
          ? cntcnPersistenceHooks(userId, task)
          : task.provider === 'autodl'
            ? autodlPersistenceHooks(userId, task)
            : {};
      hooks.deferPolling = deferPolling;
      const result = task.type === 'image' ? await duomiProvider.createImage(task, refs, hooks) : await createVideo(task, refs, hooks);
      if (result?.pending) return;
      if (!result.url) throw new Error('模型任务完成，但没有返回结果地址');
      await completeGenerationResult(userId, task, result);
    } catch (error) {
      if (error.submissionUncertain) {
        generationLifecycle.markSubmissionUncertain(task, error);
        console.error('[video] async provider submission outcome is uncertain; no refund issued', { generationId: task.id, provider: task.provider, message: error.message });
      } else if ((task.type === 'image' || task.provider === 'duomi' || task.routeId || ['ttapi', 'cntcn', 'autodl'].includes(task.provider)) && task.providerTaskId && !error.upstreamTerminal) {
        generationLifecycle.markProviderTaskPaused(task, error);
        console.error('[video] async provider task paused without refund', { generationId: task.id, provider: task.provider, providerTaskId: task.providerTaskId, message: error.message });
      } else {
        await failGeneration(userId, task, error);
      }
    } finally {
      generationLifecycle.markFinished(task);
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
function resumeOaiGeneration(userId, task, options = {}) {
  return generationRecovery.resume(userId, task, {
    ...options,
    startPhase: 'oai-recovery-running',
    finalPhase: 'oai-recovery-final',
    useRetryForStart: true,
    poll: ({ pollOnce }) => oaiProvider.pollVideo(task, oaiPersistenceHooks(userId, task), { immediate:true, allowExpiredFinalCheck:true, pollOnce }),
    missingUrlMessage: 'OAI 视频任务完成，但没有返回结果地址',
    pauseMessage: error => `任务恢复暂时中断，将继续由持久化任务恢复：${error.message}`,
    logContext: () => ({ providerTaskId:task.providerTaskId }),
  });
}
function resumeDuomiImageGeneration(userId, task, options = {}) {
  return generationRecovery.resume(userId, task, {
    ...options,
    startPhase: 'duomi-image-recovery-running',
    finalPhase: 'duomi-image-recovery-final',
    useRetryForStart: true,
    poll: ({ pollOnce }) => duomiProvider.pollImage(task.providerTaskId, duomiImagePersistenceHooks(userId, task), videoPollStartedAt(task), { immediate:true, allowExpiredFinalCheck:true, pollOnce }),
    missingUrlMessage: '图片任务完成，但没有返回结果地址',
    logScope: 'image',
    logContext: () => ({ providerTaskId:task.providerTaskId }),
  });
}
function resumeDuomiVideoGeneration(userId, task, options = {}) {
  return generationRecovery.resume(userId, task, {
    ...options,
    startPhase: 'duomi-video-recovery-running',
    finalPhase: 'duomi-video-recovery-final',
    useRetryForStart: true,
    poll: ({ pollOnce }) => duomiProvider.pollVideo(task, duomiVideoPersistenceHooks(userId, task), videoPollStartedAt(task), { immediate:true, allowExpiredFinalCheck:true, pollOnce }),
    logContext: () => ({ providerTaskId:task.providerTaskId }),
  });
}
function resumeTtapiGeneration(userId, task, options = {}) {
  return generationRecovery.resume(userId, task, {
    ...options,
    finalPhase: 'ttapi-recovery-final',
    poll: ({ pollOnce }) => ttapiProvider.pollVideo(task.providerTaskId, ttapiPersistenceHooks(userId, task), videoPollStartedAt(task), { immediate:true, pollOnce }),
  });
}
function resumeCntcnGeneration(userId, task, options = {}) {
  return generationRecovery.resume(userId, task, {
    ...options,
    finalPhase: 'cntcn-recovery-final',
    poll: ({ pollOnce }) => cntcnProvider.pollVideo(task.providerTaskId, cntcnPersistenceHooks(userId, task), videoPollStartedAt(task), { immediate:true, pollOnce }),
  });
}
function resumeRoutedGeneration(userId, task, options = {}) {
  return generationRecovery.resume(userId, task, {
    ...options,
    finalPhase: 'routed-recovery-final',
    poll: ({ pollOnce }) => routedProvider.pollVideo(task, routedPersistenceHooks(userId, task), { immediate:true, pollOnce }),
    logContext: () => ({ routeId:task.routeId }),
  });
}
function resumeAutodlGeneration(userId, task, options = {}) {
  return generationRecovery.resume(userId, task, {
    ...options,
    finalPhase: 'autodl-recovery-final',
    poll: ({ pollOnce }) => autodlProvider.pollVideo(task.providerTaskId, autodlPersistenceHooks(userId, task), { startedAt: videoPollStartedAt(task), pollOnce }),
    logContext: () => ({ providerTaskId:task.providerTaskId }),
  });
}
function resumeGenerationArchive(userId, task) {
  if (activeGenerations.has(task.id)) return activeGenerations.get(task.id);
  const promise = (async () => {
    try {
      await archiveGenerationWithRetry(userId, task);
      task.creditStatus = 'charged';
    } finally {
      Object.assign(task, findGeneration(userId, task.id) || task);
      generationLifecycle.markArchivePending(task);
      try { await saveGenerationWithRetry(userId, task, 'archive-recovery-final'); }
      finally { activeGenerations.delete(task.id); }
    }
  })();
  activeGenerations.set(task.id, promise);
  return promise;
}

async function reconcileMissingProviderTaskId(userId, task) {
  task.status = 'running';
  task.finishedAt = null;
  task.creditStatus = 'charged';
  task.submissionUncertain = true;
  task.submissionUncertainAt ||= task.updatedAt || task.createdAt || now();
  task.error ||= '服务中断时未能确认上游任务 ID，任务保留待核对且不会自动退款';
  if (providerTaskIdTimedOut(task)) {
    await failMissingProviderTaskId(userId, task);
    return;
  }
  await saveGenerationWithRetry(userId, task, 'provider-task-id-reconciliation');
  scheduleProviderTaskIdTimeout(userId, task);
}

async function failUnsupportedGenerationRecovery(userId, task) {
  await failGeneration(userId, task, new Error(task.error || `任务恢复时不支持供应商 ${task.provider || 'unknown'}`));
  task.finishedAt = now();
  await saveGenerationWithRetry(userId, task, 'unsupported-recovery-provider');
}

async function reconcileGenerationRefund(userId, task) {
  if (task.status !== 'failed' || task.creditStatus !== 'refund_failed') return;
  assertGenerationJobLease(task);
  try {
    await refundGenerationMicro(userId, task.id, task.creditCostMicro ?? creditsToMicro(task.creditCost));
    task.creditStatus = 'refunded';
    task.error = String(task.error || '').replace(/；自动退款失败：.*$/, '');
    await saveGenerationWithRetry(userId, task, 'refund-reconcile-completed');
  } catch (error) {
    task.creditStatus = 'refund_failed';
    task.error = `${String(task.error || '').replace(/；自动退款失败：.*$/, '')}；自动退款失败：${error.message}`;
    await saveGenerationWithRetry(userId, task, 'refund-reconcile-deferred');
    throw error;
  }
}

function processGenerationTask(userId, task, kind = 'generation') {
  if (kind === 'refund_reconcile') return reconcileGenerationRefund(userId, task);
  if (kind === 'archive') return resumeGenerationArchive(userId, task);
  if (kind === 'reconcile_submission') return reconcileMissingProviderTaskId(userId, task);
  if (task.awaitingReferences) return Promise.resolve();
  if (task.archivePending && task.sourceUrl && !task.localReadyAt) return resumeGenerationArchive(userId, task);
  const pollOnce = kind === 'poll' || Boolean(task.providerTaskId);
  if (task.status === 'queued' && !task.awaitingReferences) return startGeneration(userId, task, { deferPolling:true });
  if (task.type === 'image' && task.provider === 'duomi' && task.providerTaskId) return resumeDuomiImageGeneration(userId, task, { pollOnce });
  if (task.type === 'video' && task.provider === 'duomi' && task.providerTaskId) return resumeDuomiVideoGeneration(userId, task, { pollOnce });
  if (task.provider === 'oai' && task.providerTaskId) return resumeOaiGeneration(userId, task, { pollOnce });
  if (task.routeId && task.providerTaskId) return resumeRoutedGeneration(userId, task, { pollOnce });
  if (task.provider === 'ttapi' && task.providerTaskId) return resumeTtapiGeneration(userId, task, { pollOnce });
  if (task.provider === 'cntcn' && task.providerTaskId) return resumeCntcnGeneration(userId, task, { pollOnce });
  if (task.provider === 'autodl' && task.providerTaskId) return resumeAutodlGeneration(userId, task, { pollOnce });
  if (!task.providerTaskId) return reconcileMissingProviderTaskId(userId, task);
  return failUnsupportedGenerationRecovery(userId, task);
}

const generationPollInterval = generationJobPolicy.pollInterval;
const generationJobNextRunAt = generationJobPolicy.nextRunAt;
const generationRecoveryKind = generationJobPolicy.recoveryKind;

async function runGenerationJob(job) {
  const heartbeatMs = Math.max(5_000, Math.floor(generationJobLeaseMs / 3));
  const heartbeat = setInterval(() => {
    if (!renewGenerationJobLease({ id:job.id, owner:generationJobOwner, leaseToken:job.leaseToken, leaseUntil:Date.now() + generationJobLeaseMs })) {
      runtimeMetrics.generationJobLeaseRenewalFailures++;
      console.error('[generation-job] lease renewal failed', { jobId:job.id, generationId:job.generationId });
    }
  }, heartbeatMs);
  heartbeat.unref();
  let task = null;
  try {
    task = findGeneration(job.userId, job.generationId);
    if (task) {
      generationJobGuards.set(task.id, { id:job.id, owner:generationJobOwner, leaseToken:job.leaseToken });
      if (!(job.kind === 'refund_reconcile'
        ? task.status !== 'failed' || task.creditStatus !== 'refund_failed'
        : (['completed', 'failed'].includes(task.status) && !task.archivePending))) {
        await processGenerationTask(job.userId, task, job.kind);
      }
    }
  } catch (error) {
    runtimeMetrics.generationJobExecutionFailures++;
    console.error('[generation-job] execution failed', { jobId:job.id, generationId:job.generationId, message:error.message });
  } finally {
    clearInterval(heartbeat);
    if (task) generationJobGuards.delete(task.id);
    const persistedTask = findGeneration(job.userId, job.generationId);
    if (job.kind === 'refund_reconcile') {
      if (!persistedTask || persistedTask.creditStatus === 'refunded') {
        if (completeGenerationJob({ id:job.id, owner:generationJobOwner, leaseToken:job.leaseToken })) runtimeMetrics.generationJobsCompleted++;
      } else if (rescheduleGenerationJob({ id:job.id, owner:generationJobOwner, leaseToken:job.leaseToken, kind:'refund_reconcile', nextRunAt:Date.now() + archiveRescheduleMs, errorCode:'REFUND_PENDING', errorMessage:persistedTask.error || '退款待重试' })) {
        runtimeMetrics.generationJobsRescheduled++;
      }
    } else if (!persistedTask || (['completed', 'failed'].includes(persistedTask.status) && !persistedTask.archivePending)) {
      if (completeGenerationJob({ id:job.id, owner:generationJobOwner, leaseToken:job.leaseToken })) runtimeMetrics.generationJobsCompleted++;
    } else if (persistedTask.awaitingReferences) {
      if (completeGenerationJob({ id:job.id, owner:generationJobOwner, leaseToken:job.leaseToken })) runtimeMetrics.generationJobsCompleted++;
    } else {
      const nextKind = generationRecoveryKind(persistedTask);
      const nextRunAt = nextKind === 'archive' && !persistedTask.archiveFailureCount
        ? Math.max(generationJobNextRunAt(persistedTask, nextKind), Date.parse(persistedTask.localDeliveryDeadlineAt || '') || 0)
        : generationJobNextRunAt(persistedTask, nextKind);
      if (rescheduleGenerationJob({
        id:job.id,
        owner:generationJobOwner,
        leaseToken:job.leaseToken,
        kind:nextKind,
        nextRunAt,
        errorCode: persistedTask.lastSubmissionError ? 'SUBMISSION_UNCERTAIN' : null,
        errorMessage: persistedTask.lastSubmissionError || persistedTask.error || null,
      })) runtimeMetrics.generationJobsRescheduled++;
    }
  }
}

function drainGenerationJobs() {
  if (serverDraining) return;
  const capacity = generationJobConcurrency - activeGenerationJobs.size;
  if (capacity <= 0) return;
  const jobs = claimGenerationJobs({ owner:generationJobOwner, limit:capacity, leaseMs:generationJobLeaseMs, excludeGenerationIds:[...activeGenerationIds] });
  runtimeMetrics.generationJobsClaimed += jobs.length;
  for (const job of jobs) {
    activeGenerationIds.add(job.generationId);
    const promise = runtimeLifecycle.track(runGenerationJob(job));
    activeGenerationJobs.set(job.id, promise);
    void promise.finally(() => {
      activeGenerationJobs.delete(job.id);
      activeGenerationIds.delete(job.generationId);
      drainGenerationJobs();
    }).catch(error => console.error('[generation-job] cleanup failed', error));
  }
}

/** Resume durable generation work after a process restart without depending on any browser session. */
async function recoverPendingGenerations() {
  runtimeMetrics.recoveryRuns++;
  const startedAt = Date.now();
  const pending = listPendingGenerations();
  let scheduled = 0;
  let refundReconciliations = 0;
  let awaitingReconciliation = 0;

  for (const { userId, task } of pending) {
    if (task.creditStatus === 'refund_failed') {
      enqueueGenerationJob({ userId, generationId:task.id, kind:'refund_reconcile', nextRunAt:Date.now(), preserveScheduledTime:true });
      refundReconciliations++;
    } else if (task.awaitingReferences) {
      continue;
    } else {
      const kind = generationRecoveryKind(task);
      const nextRunAt = kind === 'archive' ? generationJobNextRunAt(task, kind) : Date.now();
      enqueueGenerationJob({ userId, generationId:task.id, kind, nextRunAt, preserveScheduledTime:true });
      scheduled++;
      if (!task.providerTaskId) awaitingReconciliation++;
    }
  }

  drainGenerationJobs();

  if (pending.length) {
    console.log(`[recovery] 待恢复 ${pending.length} 已入队 ${scheduled} 待核对 ${awaitingReconciliation} 退款对账 ${refundReconciliations} 耗时 ${Date.now() - startedAt}ms`);
  }
}

function startGenerationRecoverySweeper() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await recoverPendingGenerations();
    } catch (error) {
      console.error('[recovery] scheduled sweep failed', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, generationRecoverySweepMs);
  timer.unref();
  runtimeLifecycle.registerTimer(timer);
  void run();
  return timer;
}

function startGenerationJobPoller() {
  const timer = setInterval(drainGenerationJobs, generationJobPollMs);
  timer.unref();
  runtimeLifecycle.registerTimer(timer);
  drainGenerationJobs();
  return timer;
}

function websiteApiAllowed(pathname) {
  return pathname.startsWith('/api/auth/')
    || pathname === '/api/credits'
    || pathname === '/api/payments/alipay/orders'
    || /^\/api\/payments\/alipay\/orders\/[A-Za-z0-9_-]+(?:\/(?:query|close|refunds)(?:\/[A-Za-z0-9_-]+)?)?$/.test(pathname);
}

function metricsText() {
  const queue = generationQueueStats();
  const values = {
    ...runtimeMetrics,
    ...queue,
    activeGenerations: activeGenerations.size,
    activeGenerationJobs: activeGenerationJobs.size,
  };
  return Object.entries(values)
    .map(([name, value]) => `gugu_${name} ${Number(value) || 0}`)
    .join('\n') + '\n';
}

let serverDraining = false;
let shuttingDown = false;
let generationRecoverySweeper = null;
let generationJobPoller = null;
const systemRoute = createSystemRouteHandler({
  sendJson,
  sendText,
  isDraining:() => serverDraining,
  checkReady:() => sql('SELECT 1 AS ready').get(),
  queueStats:generationQueueStats,
  metricsText,
});
const authRoute = createAuthRouteHandler({
  bodyJson,
  sendJson,
  clientIp,
  normalizePhoneNumber,
  captchaStore,
  smsConfig,
  smsSendLimiter,
  smsVerifyLimiter,
  sendSmsVerifyCode,
  checkSmsVerifyCode,
  findUserByPhoneNumber,
  createSmsUser,
  hashPassword,
  randomId:randomUUID,
  randomSecret:() => randomBytes(32).toString('base64url'),
  ensureUserDirs,
  createSession,
  setSessionCookie,
  publicUser,
  now,
  registerUser,
  findUserByLogin,
  loginLimiter,
  verifyPassword,
  currentUser,
  requireUser,
  updateUserProfile,
  parseCookies,
  deleteSession,
  tokenHash,
  clearSessionCookie,
  profileNicknamePattern,
});
const accountRoute = createAccountRouteHandler({
  bodyForm,
  bodyJson,
  sendJson,
  sendText,
  requireUser,
  currentUser,
  port,
  publicReturnUrl,
  publicNotifyUrl,
  handleAlipayNotification,
  paymentReturnPage,
  queryPaymentOrder,
  paymentOrderForUser,
  createPaymentOrder,
  closePaymentOrder,
  refundPaymentOrder,
  queryPaymentRefund,
  configState,
  walletOf,
  currentPricing,
  recentCreditEntries,
  publicCreditEntry,
  creditPricing,
  llmRates,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
});
const dramaRoute = createDramaRouteHandler({
  bodyJson,
  sendJson,
  requireUser,
  requireDesktopWorkspaceScope,
  listDramaProjects,
  deleteDramaProject,
  setPageHeaders,
  publicDramaProject,
  normalizeDramaProject,
  parseLimit,
  randomId:randomUUID,
  createDefaultDramaShot,
  saveDramaProject,
  latestDramaProject,
  loadDramaProject,
  findDramaProject,
  findGeneration,
  safeId,
  dramaStepOrder,
  reconcileDramaProjectGenerationReferences,
  isLlmConfigured,
  llmConfig,
  runSmartDirector,
  deleteGenerationRecord,
  activeGenerations,
  now,
  charLength,
  analyzeScript,
  createStoryboard,
});
const filesRoute = createFilesRouteHandler({
  bodyJson,
  bodyBuffer,
  sendJson,
  serveFile,
  requireUser,
  requireDesktopWorkspaceScope,
  normalizeDeviceId,
  listAssetChanges,
  listPendingAssetDeliveries,
  findCloudAssets,
  markAssetDeliveryPending,
  publicAsset,
  parseLimit,
  encodeCursor,
  decodeCursor,
  findAsset,
  listAssets,
  setPageHeaders,
  supportLogStorageReady,
  supportLogRateAllowed,
  supportLogMime:SUPPORT_LOG_MIME,
  supportLogMaxBytes,
  supportLogObjectKey,
  putSupportLogObject,
  appendSystemEvent,
  directUploadEnabled,
  r2Configured,
  uploadInitRateAllowed,
  uploadMaxPendingPerUser,
  uploadIntentExpiresSeconds,
  uploadUrlExpiresSeconds,
  countActiveUploadIntents,
  normalizeUploadMime,
  imageTypes,
  videoTypes,
  audioTypes,
  uploadSizeLimit,
  findAssetBySha256,
  uploadKind,
  randomId:randomUUID,
  pendingUploadKey,
  finalUploadKey,
  now,
  createUploadIntent,
  signedUploadUrl,
  findUploadIntent,
  expireUploadIntent,
  deleteObject,
  claimUploadIntent,
  verifyUploadedObject,
  promoteUploadedObject,
  uploadExtension,
  completeUploadIntentWithAsset,
  markUploadIntentFailed,
  assetFilesDir,
  assetPreviewCacheSeconds,
  fs,
  signedAssetUrl,
  localReadyBatchLimit,
  applyLocalReadyAcknowledgement,
  requestGenerationArchive,
  servePendingGenerationSource,
  safeId,
  saveAsset,
  findGeneration,
  activeGenerations,
  deleteGenerationRecord,
  deleteAssetRecord,
});
const generationRoute = createGenerationRouteHandler({
  bodyJson,
  sendJson,
  requireUser,
  requireDesktopWorkspaceScope,
  findGeneration,
  listGenerations,
  setPageHeaders,
  parseLimit,
  safeId,
  publicGeneration,
  publicDramaProject,
  loadDramaProject,
  validateVideoRequest,
  validateReferenceAssets,
  referenceAssetCounts,
  normalizeQuoteReferenceCounts,
  assertReferenceCountsWithinLimits,
  selectModelRoute,
  publicRoutePriceVersion,
  currentPricing,
  pricingSnapshot,
  staticPriceVersion:request => `v1-${createHash('sha256').update(`gugu-price:static:${request.modelId}:${request.quality}:${request.duration}`).digest('hex').slice(0, 32)}`,
  creditsToMicro,
  charLength,
  walletOf,
  chargeGenerationMicro,
  chargeGenerationBatchMicro,
  createGenerationRequest,
  findGenerationRequest,
  generationRequestFingerprint,
  enqueueGenerationJob,
  saveGeneration,
  failGeneration,
  deleteGenerationRecord,
  saveDramaProject,
  ensureUserDirs,
  randomId:randomUUID,
  now,
  resolveVideoPrompt,
  buildShotVideoPrompt,
  isModelEnabled,
  fixedModels,
  imageSizes,
  videoModelIds:VIDEO_MODEL_IDS,
  legacyVideoModelIds:LEGACY_VIDEO_MODEL_IDS,
  storyboardEngineVersion:STORYBOARD_ENGINE_VERSION,
  r2ReferenceConfigured,
  r2ReferencePublicBaseUrl,
  providerAvailability:{
    duomi:Boolean(process.env.DUOMI_API_KEY),
    ttapi:ttapiConfigured,
    cntcn:cntcnConfigured,
    autodl:autodlConfigured,
    oai:oaiConfigured,
    oaiVeo:oaiVeoConfigured,
    oaiMinimax:oaiMinimaxConfigured,
  },
  runtimeMetrics,
  activeGenerations,
});

export const __test = { requestGenerationArchive, applyLocalReadyAcknowledgement, archiveGenerationWithRetry, servePendingGenerationSource, hashPassword, verifyPassword, parseCookies, tokenHash, charLength, normalizeInviteCode, isKnownInviteCode, generationCost, errorMessage, videoProgress, downloadErrorDetail, assetObjectKey, pendingUploadKey, finalUploadKey, r2ReferenceImageKey, r2ReferenceImagePrefix, r2ReferenceImageTtlMs, normalizeUploadMime, magicMatches, imageSizes, videoAspectRatios, videoDurations, fixedModels, createDefaultDramaShot, normalizeDramaProject, buildOaiVideoPayload, buildAutodlPayload, routedVideoPayload, publicPlatformPrices, publicModelPriceState, normalizeQuoteReferenceCounts, assertReferenceCountsWithinLimits, autodlRetryableResponseError, pollAutodlVideo, createAutodlVideo, pollDuomiImage, createImage, trackProviderSubmission, waitForProviderSubmissions, recoverPendingGenerations, generationFailureCode, generationFailure, publicGeneration, publicAsset, publicDramaProject, publicHttpErrorMessage, publicHttpErrorBody, saveGenerationAsset, archiveGenerationResult, publicCreditEntry, publicLlmUsage, generationSourceHeaders, generationAssetExtension, generationAssetName, resolveVideoPrompt, providerTaskIdDeadline, awaitingProviderTaskId, providerTaskIdTimedOut, routedVideoSubmitTimeoutMs, providerSubmissionShutdownGraceMs, imageMaxPollDurationMs, videoMaxPollDurationMs, oaiMaxPollDurationMs, oaiMaxPolls, autodlMaxPollDurationMs, videoPollTimeoutError, videoPollStartedAt, websiteApiAllowed, staticEntryFile, staticCacheControl };
const server = http.createServer(async (req, res) => {
  let finishRequest;
  const requestWork = runtimeLifecycle.track(new Promise(resolve => { finishRequest = resolve; }));
  const requestToken = { requestWork };
  activeRequests.add(requestToken);
  let released = false;
  const releaseRequest = () => {
    if (released) return;
    released = true;
    activeRequests.delete(requestToken);
    finishRequest();
  };
  res.once('finish', releaseRequest);
  res.once('close', releaseRequest);
  const requestId = requestTraceId(req);
  res.setHeader('X-Request-Id', requestId);
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (await systemRoute(req, res, url)) return;
    if (!mutationAllowed(req)) return sendJson(res, 403, { error: '请求来源不允许' });
    if (url.pathname.startsWith('/api/admin/')) return await handleAdminRequest(req, res);
    if (url.pathname === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); return res.end(); }
    if (await accountRoute(req, res, url, { publicOnly:true })) return;
    // Public pricing data intentionally sits before the desktop-only API
    // guard so website visitors can inspect prices before signing in.
    if (url.pathname === '/api/public/model-prices' && req.method === 'GET') return sendJson(res, 200, publicModelPriceState());
    if (url.pathname === '/api/public/credit-packages' && req.method === 'GET') return sendJson(res, 200, publicCreditPackages());
    if (desktopAppOnly && url.pathname.startsWith('/api/') && !isDesktopRequest(req) && !websiteApiAllowed(url.pathname)) return sendJson(res, 404, { error: '请使用 GuGu AI 客户端' });
    if (await authRoute(req, res, url)) return;
    if (await accountRoute(req, res, url)) return;

    // Older desktop clients did not record a workspace origin on server
    // metadata. Claim only records whose asset IDs are already present in the
    // current local library; this does not download or move any file.
    if (url.pathname === '/api/workspaces/claim-legacy' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return;
      const scope = requireDesktopWorkspaceScope(req, res); if (!scope) return;
      const input = await bodyJson(req, 200_000);
      const assetIds = [...new Set((Array.isArray(input.assetIds) ? input.assetIds : [])
        .map(value => String(value || '').trim().slice(0, 200))
        .filter(Boolean))].slice(0, 5000);
      const result = claimLegacyWorkspace(user.id, { deviceId:scope.deviceId, workspaceId:scope.workspaceId, assetIds });
      return sendJson(res, 200, { ok:true, ...result });
    }

    if (await dramaRoute(req, res, url)) return;

    if (await generationRoute(req, res, url)) return;
    if (await filesRoute(req, res, url)) return;


    const downloadMatch = url.pathname.match(/^\/downloads\/(mac|windows)$/);
    if (downloadMatch && req.method === 'GET') {
      const target = publicDownloadUrls[downloadMatch[1]];
      if (!target) return sendJson(res, 404, { error: '该平台客户端尚未发布' });
      res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return await serveStatic(res, url.pathname, req, { publicDir, appOnly:desktopAppOnly, sendJson });
  } catch (error) { if (!error.statusCode || error.statusCode >= 500) console.error({ requestId, url:req.url, code:error.code, message:error.message }); if (res.headersSent) return res.end(); const isAdminRequest = String(req.url || '').split('?')[0].startsWith('/api/admin/'); const message = isAdminRequest ? (error.message || '服务错误') : publicHttpErrorMessage(error); return sendJson(res, error.statusCode || (error.code === 'ENOENT' ? 404 : 500), publicHttpErrorBody(error, message)); }
});

// Importing server helpers from a test must never open the production port.
// NODE_ENV is a deployment setting, not a reliable main-module check: running
// `node --test test/auth.test.mjs` directly does not set it automatically.
async function shutdownServer() {
  if (shuttingDown) return;
  shuttingDown = true;
  serverDraining = true;
  clearInterval(sessionSweeper);
  clearInterval(uploadSweeper);
  if (generationRecoverySweeper) clearInterval(generationRecoverySweeper);
  if (generationJobPoller) clearInterval(generationJobPoller);
  for (const timer of generationRetryTimers.values()) clearTimeout(timer);
  for (const timer of providerTaskIdTimeoutTimers.values()) clearTimeout(timer);
  for (const timer of r2ReferenceImageCleanupTimers.values()) clearTimeout(timer);
  generationRetryTimers.clear();
  providerTaskIdTimeoutTimers.clear();
  r2ReferenceImageCleanupTimers.clear();
  const serverClosed = new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  const forceExitTimer = setTimeout(() => process.exit(0), providerSubmissionShutdownGraceMs + 5_000);
  try {
    const [runtimeResult, providerResult] = await Promise.all([
      runtimeLifecycle.drain({ timeoutMs:providerSubmissionShutdownGraceMs }),
      providerTransport.waitForProviderSubmissions(providerSubmissionShutdownGraceMs),
      serverClosed,
    ]);
    if (runtimeResult.timedOut || providerResult.timedOut || activeRequests.size) {
      console.warn('[shutdown] 优雅退出达到预算', { jobs:runtimeResult.pending, submissions:providerResult.pending, requests:activeRequests.size });
    }
  } catch (error) {
    console.error('[shutdown] 等待上游任务号落库失败', error);
  }
  try { closeDatabase(); } catch (error) { console.error('关闭数据库失败', error); }
  clearTimeout(forceExitTimer);
  process.exit(0);
}

if (isMainModule && process.env.NODE_ENV !== 'test') {
  process.once('SIGINT', shutdownServer);
  process.once('SIGTERM', shutdownServer);
  server.listen(port, '127.0.0.1', () => {
    console.log(`GuGu AI: http://127.0.0.1:${port}`);
    // Recovery runs after the port is open so a backlog never delays startup.
    generationRecoverySweeper = startGenerationRecoverySweeper();
    generationJobPoller = startGenerationJobPoller();
    startModelRouteMonitor();
  });
}
