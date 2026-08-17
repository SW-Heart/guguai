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
import { conservativeInputTokenUpperBound, llmRatesFromEnv, llmReservationMicro, normalizeWallet } from './lib/billing.mjs';
import { closeDatabase, migrationCompleted, openDatabase, resolveDbFile } from './lib/db.mjs';
import { chargeGeneration, configureLedger, grantSignupBonus, markLlmBillingReconcile, recentCreditEntries, refundGeneration, releaseLlmCredits, reserveLlmCredits, settleLlmCredits, walletOf } from './lib/ledger.mjs';
import { configureCursors, createSessionRecord, deleteAsset, deleteGeneration, deleteSession, findAsset, findDramaProject, findGeneration, findUserByUsername, latestDramaProject, listAssets, listDramaProjects, listGenerations, listPendingGenerations, parseLimit, purgeExpiredSessions, registerUser, saveAssetRecord, saveDramaProjectRecord, saveGenerationRecord, userForSession } from './lib/store.mjs';
import { analyzeDirectorPlanRecovery, analyzeDirectorShotShortage, buildDirectorPackageRepairPrompt, buildDirectorShotCompletionPrompt, buildDirectorShotRepairPrompt, directorPackageJsonSchema, directorPackageRepairSystemPrompt, directorPackageSystemPrompt, directorRecoveryDiagnostic, directorShotCompletionJsonSchema, directorShotCompletionSystemPrompt, directorShotRepairJsonSchema, directorShotRepairSystemPrompt, mergeDirectorShotCompletion, parseJsonObject, prepareDirectorPackage, replaceDirectorShots, scriptAnalysisSystemPrompt, storyboardSystemPrompt, validateDirectorPackage, validateScriptAnalysis, validateStoryboard } from './lib/drama-analysis.mjs';
import { normalizeMotionPlan, normalizeProductionScenes, productionQualitySummary, STORYBOARD_ENGINE_VERSION } from './lib/storyboard-engine.mjs';
import { callLlm, isLlmConfigured, llmConfigFromEnv } from './lib/llm-client.mjs';
import { buildVideoPayload, publicVideoCapabilities, validateVideoRequest } from './lib/video-capabilities.mjs';
import { buildShotVideoPrompt } from './public/video-prompt.js';

const scrypt = promisify(scryptCallback);
const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(here, 'data');
const legacyUsersFile = path.join(dataDir, 'users.json');
const userDataDir = path.join(dataDir, 'users');
const port = Number(process.env.PORT || 4317);
const duomiBase = (process.env.DUOMI_API_BASE || 'https://duomiapi.com').replace(/\/$/, '');
const ttapiBase = (process.env.TTAPI_API_BASE || 'https://api.ttapi.io').replace(/\/$/, '');
const ttapiConfigured = Boolean(process.env.TTAPI_API_KEY);
const llmConfig = llmConfigFromEnv();
const llmRates = llmRatesFromEnv();
const ossPrefix = String(process.env.ALIYUN_OSS_PREFIX || 'model-studio').replace(/^\/+|\/+$/g, '');
const ossConfigured = Boolean(process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET && process.env.ALIYUN_OSS_ENDPOINT && process.env.ALIYUN_OSS_BUCKET);
const oss = ossConfigured ? new OSS({ accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, endpoint: process.env.ALIYUN_OSS_ENDPOINT, bucket: process.env.ALIYUN_OSS_BUCKET, secure: true }) : null;
const sessionMaxAge = 60 * 60 * 24 * 14;
const maxUploadBytes = 25 * 1024 * 1024;
const maxReferenceImageBytes = 10 * 1024 * 1024;
const activeGenerations = new Map();
const loginAttempts = new Map();
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const videoTypes = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const imageSizes = new Set(['1:1', '3:2', '2:3', '16:9', '9:16', '1:2', '2:1', '4:3', '3:4', '5:4', '4:5']);
const videoAspectRatios = new Set(['2:3', '3:2', '1:1', '9:16', '16:9']);
const videoDurations = new Set([4, 6, 8, 10, 15, 20, 30]);
const dramaVideoDurations = new Set([4, 6, 8, 10, 15, 20, 30]);
const dramaStepOrder = ['script', 'resources', 'storyboard', 'video'];
const fixedModels = Object.freeze({ image: 'gpt-image-2' });
const invitationCodes = new Set([
  'STUDIO-7K3M-P9QX', 'STUDIO-4N8R-V2CW', 'STUDIO-6T5Y-H7JD',
  'STUDIO-9B2F-M4LA', 'STUDIO-3W7P-K8NE', 'STUDIO-5C9H-R6TU',
  'STUDIO-8L4D-X3VG', 'STUDIO-2Q6A-J9MS', 'STUDIO-7V5E-N2BK',
  'STUDIO-4R8G-T6YP', 'STUDIO-9M3K-C7FH', 'STUDIO-6P2X-W5DA',
]);
const creditPricing = Object.freeze({ image: 1, videoPerSecond: 1, signupBonus: 50 });

await fs.mkdir(userDataDir, { recursive: true });

// Metadata lives in SQLite; only media binaries stay on disk (plus OSS).
openDatabase({ verbose: true });

// Refuse to start on a half-migrated data directory, otherwise the server would
// silently serve an empty database while the real records sit in JSON files.
if (!migrationCompleted()) {
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
const publicUser = user => ({ id: user.id, username: user.username, role: user.role || 'user', credits: normalizeWallet(user).balance, createdAt: user.createdAt });
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
function configState() { return { duomi: Boolean(process.env.DUOMI_API_KEY), ttapi: ttapiConfigured, oss: ossConfigured, llm: isLlmConfigured(llmConfig), videoCapabilities: publicVideoCapabilities() }; }

function errorMessage(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => errorMessage(item)).filter(Boolean).join('；');
  if (value && typeof value === 'object') return errorMessage(value.message || value.msg || value.detail || value.error || value.errors || value.code) || fallback;
  return fallback;
}
async function fetchJson(url, options = {}) { const response = await fetch(url, options); const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = { raw: text }; } if (!response.ok) throw new Error(`${response.status} ${errorMessage(value, text.slice(0, 300))}`); return value; }
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
    if (taskId && error.fallbackEligible === undefined) error = Object.assign(new Error(error.message), { provider: 'duomi', providerTaskId: taskId, fallbackEligible: true });
    throw error;
  }
}
async function createTtapiVideo(task, refs) {
  const payload = { prompt: task.prompt, model: task.model, aspect_ratio: task.aspectRatio, video_length: String(task.duration), resolution_name: '720p' };
  if (refs.length) payload.refer_images = refs.slice(0, task.maxReferenceImages || 7);
  const created = await fetchJson(`${ttapiBase}/grok/generations`, { method: 'POST', headers: { 'TT-API-KEY': process.env.TTAPI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const taskId = created.data?.jobId || created.jobId;
  if (!taskId) throw Object.assign(new Error('TTAPI 视频任务没有返回任务 ID'), { provider: 'ttapi' });
  for (let i = 0; i < 160; i++) {
    await sleep(8000);
    const state = await fetchJson(`${ttapiBase}/grok/fetch?jobId=${encodeURIComponent(taskId)}`, { headers: { 'TT-API-KEY': process.env.TTAPI_API_KEY } });
    const videoUrl = state.data?.videoUrl;
    if (videoUrl) return { provider: 'ttapi', taskId, url: videoUrl };
    const status = String(state.status || state.data?.status || '').toUpperCase();
    if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status)) throw Object.assign(new Error(errorMessage(state, 'TTAPI 视频生成失败')), { provider: 'ttapi', providerTaskId: taskId });
  }
  throw Object.assign(new Error('TTAPI 视频任务等待超时'), { provider: 'ttapi', providerTaskId: taskId });
}
async function createVideo(task, refs) {
  if (task.provider === 'ttapi') {
    if (!ttapiConfigured) throw new Error('TTAPI 视频服务尚未配置');
    return createTtapiVideo(task, refs);
  }
  if (task.provider === 'duomi') return createDuomiVideo(task, refs);
  throw new Error(`不支持的视频供应商：${task.provider || '未指定'}`);
}
function downloadErrorDetail(error) { const cause = error?.cause; return [cause?.code, cause?.message || error?.message].filter(Boolean).join(' · ') || '未知网络错误'; }
async function downloadToFile(url, target, attempts = 4) {
  const partial = `${target}.part`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'Model-Studio/1.0', Accept: '*/*' } });
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
function saveDramaProject(userId, project) { project.updatedAt = now(); return saveDramaProjectRecord(userId, project); }
function publicDramaProject(project) { const { ownerId, ...value } = project; return value; }
function normalizeDramaProject(project) {
  const legacyMaxStep = !dramaStepOrder.includes(project.maxStep);
  project.schemaVersion = 5; project.workflowVersion = Number(project.workflowVersion) || 1; project.mode ||= 'smart';
  if (project.mode === 'professional' && project.workflowVersion < 2) project.workflowVersion = 2;
  project.step ||= project.storyboard ? 'storyboard' : 'script'; project.input ||= project.script || '';
  project.synopsis ||= project.analysis?.logline || '';
  project.settings = { shotCount:Math.max(1, Math.min(120, Number(project.settings?.shotCount) || project.storyboard?.shots?.length || 5)), totalDuration:Math.max(6, Math.min(3600, Number(project.settings?.totalDuration) || (project.storyboard?.shots?.length || 5) * 6)), shotDuration:dramaVideoDurations.has(Number(project.settings?.shotDuration)) ? Number(project.settings.shotDuration) : 6, aspectRatio:videoAspectRatios.has(project.settings?.aspectRatio) ? project.settings.aspectRatio : '9:16' };
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
    return { id:shot.id || randomUUID(), shotNumber:index + 1, sceneNumber:Math.max(1,Number(shot.sceneNumber)||Math.max(1,project.scenes.findIndex(scene=>scene.id===shot.sceneId)+1)), sceneId:String(shot.sceneId || project.scenes[Math.max(0,(Number(shot.sceneNumber)||1)-1)]?.id || project.scenes[0]?.id || ''), title:String(shot.title || `分镜 ${index + 1}`), sourceBeatIds:Array.isArray(shot.sourceBeatIds)?shot.sourceBeatIds.map(String):[], script:String(shot.script || ''), prompt:String(shot.prompt || shot.visualDirection || ''), visualDirection:String(shot.visualDirection || shot.prompt || ''), narrativeFunction:String(shot.narrativeFunction || ''), shotSize:String(shot.shotSize || '中景'), cameraMovement:String(shot.cameraMovement || '固定'), framing:String(shot.framing || ''), startStateId:String(shot.startStateId || ''), startState:String(shot.startState || ''), action:String(shot.action || shot.script || ''), endStateId:String(shot.endStateId || ''), endState:String(shot.endState || ''), continuityNotes:String(shot.continuityNotes || ''), sound:String(shot.sound || ''), negativePrompt:String(shot.negativePrompt || '禁止人物变脸、服装变化、道具消失、空间轴线跳变'), motionPlan:normalizeMotionPlan(shot.motionPlan), duration:dramaVideoDurations.has(Number(shot.duration)) ? Number(shot.duration) : project.settings.shotDuration, aspectRatio:videoAspectRatios.has(shot.aspectRatio) ? shot.aspectRatio : project.settings.aspectRatio, resourceIds:Array.isArray(shot.resourceIds) ? shot.resourceIds : [], referenceAssetIds, professionalAssets, pendingImageGenerations, generation:{ type:generationType, firstFrameAssetId, lastFrameAssetId, referenceAssetIds:generationReferenceAssetIds, quality:['720p','1080p','4k'].includes(shot.generation?.quality) ? shot.generation.quality : '720p' }, lifecycle:{ status:String(shot.lifecycle?.status || (shot.selectedVideoTaskId ? 'generated' : 'draft')), revision:Math.max(1,Number(shot.lifecycle?.revision)||1), staleReasons:Array.isArray(shot.lifecycle?.staleReasons) ? shot.lifecycle.staleReasons.map(String) : [] }, videoVersions:Array.isArray(shot.videoVersions) ? shot.videoVersions : [], selectedVideoTaskId:String(shot.selectedVideoTaskId || ''), tailFrameAssetId:String(shot.tailFrameAssetId || '') };
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
function publicAsset(asset) { return { ...asset, url: `/api/files/${asset.id}/content` }; }
function ossObjectKey(userId, storageName) { const extension = path.extname(storageName).toLowerCase().replace(/[^a-z0-9.]/g, ''); const base = safeId(path.basename(storageName, path.extname(storageName))); return [ossPrefix, safeId(userId), `${base}${extension}`].filter(Boolean).join('/'); }
async function uploadAssetToOss(userId, asset) {
  if (!oss) throw Object.assign(new Error('文件存储服务尚未配置'), { statusCode: 503 });
  const key = asset.ossKey || ossObjectKey(userId, asset.storageName);
  await oss.put(key, path.join(assetFilesDir(userId), asset.storageName), { headers: { 'Content-Type': asset.mimeType } });
  asset.ossKey = key; asset.ossUploadedAt = now();
  await saveAsset(userId, asset);
  return key;
}
async function signedOssUrl(key, expires = 3600) { return oss.signatureUrl(key, { expires, method: 'GET' }); }
async function resolveRefs(userId, ids) { const refs = []; for (const id of ids.slice(0, 7)) { const asset = findAsset(userId, id); if (!asset || asset.kind !== 'image') continue; const key = asset.ossKey || await uploadAssetToOss(userId, asset); refs.push(await signedOssUrl(key)); } return refs; }
async function validateReferenceAssets(userId, value) {
  if (value !== undefined && !Array.isArray(value)) throw Object.assign(new Error('参考图 image_urls 必须使用数组格式'), { statusCode: 400 });
  const ids = [...new Set((value || []).map(safeId).filter(Boolean))];
  if (ids.length > 7) throw Object.assign(new Error('参考图最多支持 7 张'), { statusCode: 400 });
  for (const id of ids) {
    const asset = findAsset(userId, id);
    if (!asset || asset.kind !== 'image') throw Object.assign(new Error('参考图不存在或不是图片'), { statusCode: 400 });
    if (Number(asset.size) > maxReferenceImageBytes) throw Object.assign(new Error(`参考图“${asset.name}”超过 10 MB`), { statusCode: 400 });
  }
  return ids;
}
async function archiveGenerationResult(userId, task, resultUrl) {
  const assetId = randomUUID();
  const extension = task.type === 'image' ? '.png' : '.mp4';
  const storageName = `${assetId}${extension}`;
  const localFile = path.join(assetFilesDir(userId), storageName);
  const saved = await downloadToFile(resultUrl, localFile);
  const asset = { id: assetId, ownerId: userId, name: `${task.type === 'image' ? '生成图片' : '生成视频'} ${new Date().toLocaleString('zh-CN')}${extension}`, kind: task.type, mimeType: saved.contentType, size: saved.size, storageName, source: 'generation', sourceGenerationId: task.id, sourceUrl: resultUrl, createdAt: now(), updatedAt: now() };
  try { await uploadAssetToOss(userId, asset); } catch (error) { await fs.unlink(localFile).catch(() => {}); throw error; }
  task.assetId = assetId;
  task.status = 'completed';
  task.error = '';
}
async function archiveLocalAsset(userId, sourceFile, { name, kind, mimeType, source, projectId }) {
  const id = randomUUID(); const extension = path.extname(sourceFile); const storageName = `${id}${extension}`; const target = path.join(assetFilesDir(userId), storageName);
  await fs.rename(sourceFile, target); const stat = await fs.stat(target);
  const asset = { id, ownerId:userId, name, kind, mimeType, size:stat.size, storageName, source, projectId, sourceGenerationId:'', sourceUrl:'', createdAt:now(), updatedAt:now() };
  try { await uploadAssetToOss(userId, asset); } catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
  return asset;
}
async function extractVideoTailFrame(userId, project, shot) {
  const task = findGeneration(userId, shot.selectedVideoTaskId); const video = task?.assetId ? findAsset(userId, task.assetId) : null;
  if (!video || video.kind !== 'video') throw Object.assign(new Error('请先选择一个已完成的分镜视频'), { statusCode:400 });
  const source = path.join(assetFilesDir(userId), video.storageName); const temp = path.join(assetFilesDir(userId), `.tail-${randomUUID()}.jpg`);
  await execFile('ffmpeg', ['-y','-sseof','-0.08','-i',source,'-frames:v','1','-q:v','2',temp], { timeout:120_000 });
  const asset = await archiveLocalAsset(userId, temp, { name:`${project.title} · 分镜 ${shot.shotNumber} 尾帧.jpg`, kind:'image', mimeType:'image/jpeg', source:'drama_tail_frame', projectId:project.id });
  shot.tailFrameAssetId = asset.id; await saveDramaProject(userId, project); return asset;
}
async function assembleDramaProject(userId, project) {
  if (!project.shots.length) throw Object.assign(new Error('项目还没有分镜'), { statusCode:400 });
  if (project.mode === 'professional' && project.shots.length < 2) throw Object.assign(new Error('专业编辑项目至少需要 2 个分镜才能合成'), { statusCode:400 });
  const sources = [];
  for (const shot of project.shots) { const task = findGeneration(userId, shot.selectedVideoTaskId); const asset = task?.assetId ? findAsset(userId, task.assetId) : null; if (!asset || asset.kind !== 'video') throw Object.assign(new Error(`分镜 ${shot.shotNumber} 还没有选择完成的视频`), { statusCode:400 }); sources.push(path.join(assetFilesDir(userId), asset.storageName)); }
  const concatFile = path.join(assetFilesDir(userId), `.concat-${randomUUID()}.txt`); const temp = path.join(assetFilesDir(userId), `.final-${randomUUID()}.mp4`);
  await fs.writeFile(concatFile, sources.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'));
  try { await execFile('ffmpeg', ['-y','-f','concat','-safe','0','-i',concatFile,'-c:v','libx264','-preset','medium','-crf','20','-c:a','aac','-movflags','+faststart',temp], { timeout:900_000, maxBuffer:10_000_000 }); }
  finally { await fs.unlink(concatFile).catch(() => {}); }
  const asset = await archiveLocalAsset(userId, temp, { name:`${project.title} · 完整成片.mp4`, kind:'video', mimeType:'video/mp4', source:'drama_final', projectId:project.id });
  project.finalAssetId = asset.id; project.step = 'video'; project.status = 'completed'; await saveDramaProject(userId, project); return asset;
}
async function startGeneration(userId, task) { const promise = (async () => { try { task.status = 'running'; await saveGeneration(userId, task); const refs = await resolveRefs(userId, task.referenceAssetIds); const result = task.type === 'image' ? await createImage(task, refs) : await createVideo(task, refs); if (!result.url) throw new Error('模型任务完成，但没有返回结果地址'); task.provider = result.provider || (task.type === 'image' ? 'duomi' : 'duomi'); task.providerTaskId = result.taskId; task.sourceUrl = result.url; await saveGeneration(userId, task); await archiveGenerationResult(userId, task, result.url); task.creditStatus = 'charged'; } catch (error) { task.status = 'failed'; task.error = error.message; if (task.providerTaskId && task.sourceUrl) { task.creditStatus = 'charged'; task.error += '；模型已生成成功，系统将继续恢复成品归档'; } else { try { await refundGeneration(userId, task.id, task.creditCost); task.creditStatus = 'refunded'; } catch (refundError) { task.creditStatus = 'refund_failed'; task.error += `；自动退款失败：${refundError.message}`; } } } finally { task.finishedAt = now(); await saveGeneration(userId, task); activeGenerations.delete(task.id); } })(); activeGenerations.set(task.id, promise); }

/**
 * Startup recovery for tasks left mid-flight by a restart.
 *
 * Selection is by status via the partial index idx_gen_pending, so the cost is
 * proportional to the pending set rather than the whole history. The previous
 * implementation walked every generation record of every user and matched on
 * `error` text, which both scaled with total volume and missed tasks whose
 * failure message did not happen to contain the expected substring.
 */
async function recoverPendingGenerations() {
  const startedAt = Date.now();
  const pending = listPendingGenerations();
  if (!pending.length) return;

  let archived = 0;
  let refunded = 0;
  let failed = 0;
  const concurrency = 5;
  let cursor = 0;

  const worker = async () => {
    while (cursor < pending.length) {
      const { userId, task } = pending[cursor++];
      try {
        if (task.providerTaskId && task.sourceUrl && !task.assetId) {
          // The provider finished; only our archiving step was interrupted.
          task.status = 'running'; task.error = '模型已完成，正在恢复成品归档';
          saveGeneration(userId, task);
          await archiveGenerationResult(userId, task, task.sourceUrl);
          task.recoveredAt = now();
          task.creditStatus = 'charged';
          archived++;
        } else if (!task.providerTaskId) {
          // Never reached the provider, so the charge has to come back.
          task.status = 'failed';
          task.error = task.error || '服务重启时任务尚未提交到模型服务，已自动退款';
          try { await refundGeneration(userId, task.id, task.creditCost); task.creditStatus = 'refunded'; refunded++; }
          catch (refundError) { task.creditStatus = 'refund_failed'; task.error += `；自动退款失败：${refundError.message}`; failed++; }
        } else {
          // Submitted but no result URL captured: cannot resume the poll loop
          // across a restart, so fail it and return the credits.
          task.status = 'failed';
          task.error = task.error || '服务重启中断了模型任务轮询，已自动退款';
          try { await refundGeneration(userId, task.id, task.creditCost); task.creditStatus = 'refunded'; refunded++; }
          catch (refundError) { task.creditStatus = 'refund_failed'; task.error += `；自动退款失败：${refundError.message}`; failed++; }
        }
      } catch (error) {
        task.status = 'failed'; task.error = error.message; failed++;
      } finally {
        task.finishedAt = now();
        try { saveGeneration(userId, task); } catch (error) { console.error('恢复任务写回失败', task.id, error); }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  console.log(`[recovery] 待恢复 ${pending.length} 归档成功 ${archived} 退款 ${refunded} 失败 ${failed} 耗时 ${Date.now() - startedAt}ms`);
}

async function streamUpload(req, target, limit = maxUploadBytes) { const handle = await fs.open(target, 'w'); let size = 0; try { for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error(limit === maxReferenceImageBytes ? '单张图片不能超过 10 MB' : '文件不能超过 25 MB'), { statusCode: 413 }); await handle.write(chunk); } } catch (error) { await handle.close(); await fs.unlink(target).catch(() => {}); throw error; } await handle.close(); return size; }
async function serveFile(res, file, mimeType, downloadName = '', cacheControl = 'private, max-age=3600') { const stat = await fs.stat(file); const headers = { 'Content-Type': mimeType, 'Content-Length': stat.size, 'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff' }; if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`; res.writeHead(200, headers); createReadStream(file).pipe(res); }
async function serveStatic(res, pathname) { const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const file = path.resolve(publicDir, relative); if (!file.startsWith(`${publicDir}${path.sep}`) && file !== path.join(publicDir, 'index.html')) return sendJson(res, 403, { error: '禁止访问' }); const ext = path.extname(file); const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream'; try { await serveFile(res, file, mime, '', 'no-cache'); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return sendJson(res, 404, { error: '静态文件不存在' }); throw error; } }

export const __test = { hashPassword, verifyPassword, parseCookies, tokenHash, charLength, normalizeInviteCode, isKnownInviteCode, generationCost, errorMessage, downloadErrorDetail, ossObjectKey, imageSizes, videoAspectRatios, videoDurations, fixedModels, normalizeDramaProject };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!mutationAllowed(req)) return sendJson(res, 403, { error: '请求来源不允许' });
    if (url.pathname === '/favicon.ico') { res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' }); return res.end(); }

    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      const input = await bodyJson(req); const username = String(input.username || '').trim().toLowerCase(); const password = String(input.password || ''); const inviteCode = normalizeInviteCode(input.inviteCode);
      if (!/^[a-z0-9_]{3,24}$/.test(username)) return sendJson(res, 400, { error: '账号需为 3–24 位字母、数字或下划线' });
      if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: '密码长度需为 8–128 位' });
      if (!inviteCode) return sendJson(res, 400, { error: '请输入邀请码' });
      if (!isKnownInviteCode(inviteCode)) return sendJson(res, 400, { error: '邀请码无效' });
      // Password hashing is deliberately outside the transaction: scrypt takes
      // tens of milliseconds and must not be held across a write lock.
      const passwordHash = await hashPassword(password);
      const user = { id: randomUUID(), username, role: 'user', credits: 0, creditBalanceMicro: 0, creditHeldMicro: 0, passwordHash, inviteCode, createdAt: now() };
      // The invite code is burnt in the same transaction that creates the user,
      // so concurrent registrations on one code cannot both win.
      const result = registerUser({ user, inviteCode, signupBonus: creditPricing.signupBonus, grantBonus: grantSignupBonus });
      if (result.error) return sendJson(res, result.status, { error: result.error });
      await ensureUserDirs(result.user.id);
      const token = createSession(result.user.id); setSessionCookie(res, token); return sendJson(res, 201, { user: publicUser(result.user) });
    }
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const key = req.socket.remoteAddress || 'local'; const attempt = loginAttempts.get(key); if (attempt && attempt.count >= 8 && Date.now() - attempt.startedAt < 15 * 60_000) return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' });
      const input = await bodyJson(req); const username = String(input.username || '').trim().toLowerCase(); const user = findUserByUsername(username); const valid = user ? await verifyPassword(String(input.password || ''), user.passwordHash) : false;
      if (!valid) { const current = !attempt || Date.now() - attempt.startedAt >= 15 * 60_000 ? { count: 0, startedAt: Date.now() } : attempt; current.count++; loginAttempts.set(key, current); return sendJson(res, 401, { error: '账号或密码不正确' }); }
      loginAttempts.delete(key); await ensureUserDirs(user.id); const token = createSession(user.id); setSessionCookie(res, token); return sendJson(res, 200, { user: publicUser(user) });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { const token = parseCookies(req.headers.cookie).studio_session; if (token) deleteSession(tokenHash(token)); clearSessionCookie(res); return sendJson(res, 200, { ok: true }); }
    if (url.pathname === '/api/auth/me' && req.method === 'GET') { const user = currentUser(req); return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: '未登录' }); }
    if (url.pathname === '/api/config' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; return sendJson(res, 200, configState()); }
    if (url.pathname === '/api/credits' && req.method === 'GET') { const user = requireUser(req, res); if (!user) return; const wallet = walletOf(user.id); const transactions = recentCreditEntries(user.id, 20); return sendJson(res, 200, { ...wallet, pricing: { ...creditPricing, llmInputYuanPerMillion: llmRates.inputYuanPerMillion, llmOutputYuanPerMillion: llmRates.outputYuanPerMillion, yuanPerCredit: llmRates.yuanPerCredit }, transactions }); }

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
      return sendJson(res, 200, page.items);
    }
    if (url.pathname === '/api/generations' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return; const input = await bodyJson(req); const type = input.type;
      if (!['image', 'video'].includes(type)) return sendJson(res, 400, { error: '只支持图片或视频生成' }); let prompt = String(input.prompt || ''); if (!prompt.trim()) return sendJson(res, 400, { error: '请输入提示词' });
      await ensureUserDirs(user.id);
      let dramaProjectId = ''; let dramaShotId = '';
      if (type === 'video' && input.dramaProjectId && input.dramaShotId) { dramaProjectId=safeId(input.dramaProjectId);dramaShotId=safeId(input.dramaShotId);const dramaProject=await loadDramaProject(user.id,dramaProjectId);const dramaShot=dramaProject?.shots.find(shot=>shot.id===dramaShotId);if(!dramaProject||!dramaShot)return sendJson(res,404,{error:'短剧项目或分镜不存在'});if(dramaProject.workflowVersion>=STORYBOARD_ENGINE_VERSION&&!dramaProject.productionQuality?.passed){const first=dramaProject.productionQuality?.gates?.find(gate=>!gate.ok)?.problems?.[0]||'分镜方案未通过质量检查';return sendJson(res,409,{error:`不能生成视频：${first}`});}const scene=dramaProject.scenes.find(item=>item.id===dramaShot.sceneId);const resources=(dramaShot.resourceIds||[]).map(id=>dramaProject.resources.find(item=>item.id===id)).filter(Boolean);prompt=buildShotVideoPrompt({project:dramaProject,shot:dramaShot,scene,resources}); }
      if (type === 'video' && charLength(prompt) > 4096) return sendJson(res, 400, { error: '视频提示词不能超过 4096 个字符' });
      const referenceAssetIds = await validateReferenceAssets(user.id, input.referenceAssetIds);
      const size = type === 'image' ? String(input.size || '16:9') : null;
      if (type === 'image' && !imageSizes.has(size)) return sendJson(res, 400, { error: '不支持的图片比例' });
      let aspectRatio = null; let duration = null; let videoRequest = null;
      if (type === 'video') { videoRequest = validateVideoRequest(input, referenceAssetIds.length); aspectRatio = videoRequest.aspectRatio; duration = videoRequest.duration; }
      const provider = type === 'image' ? 'duomi' : videoRequest.provider;
      if (provider === 'duomi' && !configState().duomi) return sendJson(res, 503, { error: 'Duomi 模型服务尚未配置' });
      if (provider === 'ttapi' && !ttapiConfigured) return sendJson(res, 503, { error: 'TTAPI 模型服务尚未配置' });
      const task = { id: randomUUID(), ownerId: user.id, type, prompt, referenceAssetIds, provider, model: type === 'video' ? videoRequest.model : fixedModels.image, size, quality: type === 'image' ? String(input.quality || 'medium') : videoRequest.quality, aspectRatio, duration, ...(type === 'video' ? { generationType:videoRequest.generationType, videoProfile:videoRequest.profileKey, maxReferenceImages:videoRequest.maxImages, dramaProjectId, dramaShotId } : {}), creditCost: generationCost(type, duration), creditStatus: 'charged', status: 'queued', providerTaskId: '', assetId: '', error: '', createdAt: now(), updatedAt: now(), finishedAt: null };
      const charged = await chargeGeneration(user.id, task.id, task.creditCost); if (charged.error) return sendJson(res, charged.status, { error: charged.error, balance: charged.balance });
      try { await saveGeneration(user.id, task); } catch (error) { await refundGeneration(user.id, task.id, task.creditCost); throw error; }
      startGeneration(user.id, task); return sendJson(res, 202, { ...task, balance: charged.balance });
    }
    const generationMatch = url.pathname.match(/^\/api\/generations\/([\w-]+)$/);
    if (generationMatch && req.method === 'DELETE') {
      const user = await requireUser(req, res); if (!user) return; const id = safeId(generationMatch[1]);
      if (activeGenerations.has(id)) return sendJson(res, 409, { error: '任务正在生成中，完成后才能删除' });
      const task = findGeneration(user.id, id); if (!task) return sendJson(res, 404, { error: '生成记录不存在' });
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
    if (url.pathname === '/api/files/upload' && req.method === 'POST') {
      const user = await requireUser(req, res); if (!user) return; if (!ossConfigured) return sendJson(res, 503, { error: '文件存储服务尚未配置' }); const mimeType = String(req.headers['content-type'] || '').split(';')[0]; if (![...imageTypes, ...videoTypes].includes(mimeType)) return sendJson(res, 415, { error: '只支持 PNG、JPEG、WebP、MP4、WebM 或 MOV' }); const isImage = imageTypes.has(mimeType); const uploadLimit = isImage ? maxReferenceImageBytes : maxUploadBytes; const declaredSize = Number(req.headers['content-length'] || 0); if (declaredSize > uploadLimit) return sendJson(res, 413, { error: isImage ? '单张图片不能超过 10 MB' : '文件不能超过 25 MB' }); const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).replace(/[\r\n]/g, '').slice(0, 160); const extension = path.extname(rawName).toLowerCase() || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' }[mimeType]); const id = randomUUID(); const storageName = `${id}${extension}`; await ensureUserDirs(user.id); const localFile = path.join(assetFilesDir(user.id), storageName); const size = await streamUpload(req, localFile, uploadLimit); if (!size) return sendJson(res, 400, { error: '文件为空' }); const width = Math.max(0, Math.min(100000, Math.round(Number(req.headers['x-image-width'] || 0)))); const height = Math.max(0, Math.min(100000, Math.round(Number(req.headers['x-image-height'] || 0)))); const asset = { id, ownerId: user.id, name: rawName || storageName, kind: isImage ? 'image' : 'video', mimeType, size, ...(isImage && width && height ? { width, height } : {}), storageName, source: 'upload', sourceGenerationId: '', sourceUrl: '', createdAt: now(), updatedAt: now() }; try { await uploadAssetToOss(user.id, asset); } catch (error) { await fs.unlink(localFile).catch(() => {}); throw Object.assign(new Error(`文件上传失败：${error.message}`), { statusCode: 502 }); } return sendJson(res, 201, publicAsset(asset));
    }
    const fileMatch = url.pathname.match(/^\/api\/files\/([\w-]+)(?:\/(content|download))?$/);
    if (fileMatch) { const user = await requireUser(req, res); if (!user) return; const asset = findAsset(user.id, fileMatch[1]); if (!asset) return sendJson(res, 404, { error: '文件不存在' }); if (req.method === 'GET' && fileMatch[2]) { const localFile = path.join(assetFilesDir(user.id), asset.storageName); if (await fs.access(localFile).then(() => true).catch(() => false)) return serveFile(res, localFile, asset.mimeType, fileMatch[2] === 'download' ? asset.name : ''); if (asset.ossKey) { res.writeHead(302, { Location: await signedOssUrl(asset.ossKey), 'Cache-Control': 'private, no-store' }); return res.end(); } return sendJson(res, 404, { error: '文件内容不存在' }); } if (req.method === 'PATCH' && !fileMatch[2]) { const input = await bodyJson(req); const name = String(input.name || '').trim().replace(/[\r\n]/g, '').slice(0, 160); if (!name) return sendJson(res, 400, { error: '文件名不能为空' }); asset.name = name; await saveAsset(user.id, asset); return sendJson(res, 200, publicAsset(asset)); } if (req.method === 'DELETE' && !fileMatch[2]) { await deleteAssetRecord(user.id, asset); return sendJson(res, 200, { ok: true }); } }

    return await serveStatic(res, url.pathname);
  } catch (error) { console.error(error); if (res.headersSent) return res.end(); return sendJson(res, error.statusCode || (error.code === 'ENOENT' ? 404 : 500), { error: error.message || '服务错误', ...(error.publicData && typeof error.publicData === 'object' ? error.publicData : {}) }); }
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
      server.close(() => {
        try { closeDatabase(); } catch (error) { console.error('关闭数据库失败', error); }
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}
