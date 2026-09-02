import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, protocol, session, shell, Tray, WebContentsView } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { fetchRemoteMedia } from './media-download.mjs';
import { accountWorkspacePath, configuredWorkspaceRoot, normalizeAccountId } from './workspace-scope.mjs';
import {
  claimLocalAssetByPath,
  closeLocalLibrary,
  countLocalAssets,
  deleteLocalAsset,
  findLocalAssetByCloudId,
  findLocalAssetByDigest,
  getLocalAsset,
  listLocalAssets as queryLocalAssets,
  listLocalAssetsByCloudIds,
  openLocalLibrary,
  upsertLocalAsset,
} from './local-library.mjs';
import { macDmgInstallerLauncher, macDmgUpdateFile } from './manual-update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, 'renderer');
const productName = 'GuGu AI';
const defaultApiBase = 'http://127.0.0.1:4317';
const settingsFileName = 'desktop-settings.json';
let autoUpdater;
let autoUpdaterConfigPromise;
let settingsReadyResolve;
const settingsReady = new Promise(resolve => { settingsReadyResolve = resolve; });
const startupStartedAt = Date.now();
function startupTrace(stage) {
  if (!app.isPackaged || process.env.GUGU_STARTUP_LOG === '1') {
    console.info(`[desktop-startup] ${stage} +${Date.now() - startupStartedAt}ms`);
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'gugu-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow;
let paymentWindow;
let paymentView;
let tray;
let isQuitting = false;
let settings;
let workspace;
let workspaceRoot;
let workspaceAccountId = '';
let workspaceEpoch = 0;
let trustedOrigin;
let packageMetadata = {};
let updateConfigured = false;
let macUpdateDownloadPromise;
let downloadedMacUpdatePath = '';
let downloadedMacUpdateVersion = '';
let macUpdateInstallStarted = false;
let desktopRequestHeaderInstalled = false;
let downloadedUpdatePath = '';
let downloadedUpdateVersion = '';
let updateInstallStarted = false;
let currentUpdateStatus = { status: 'idle' };
let windowFullscreenTransition = false;
const remoteDownloadLocks = new Map();
const paymentToolbarHeight = 64;

const windowsTitleBarOverlayHeight = 56;
const windowsTitleBarOverlay = {
  color: '#ffffff',
  symbolColor: '#667085',
  height: windowsTitleBarOverlayHeight,
};
const windowsModalTitleBarOverlay = {
  // The HTML dialog backdrop must remain visible beneath the native caption
  // buttons. Native WCO is outside the renderer's z-index stack, so make its
  // surface and symbols transparent while the modal is active.
  color: 'rgba(0, 0, 0, 0)',
  symbolColor: 'rgba(255, 255, 255, 0)',
  height: windowsTitleBarOverlayHeight,
};

function commandLineApiBase() {
  const value = process.argv.find(argument => argument.startsWith('--api-base='));
  return value ? value.slice('--api-base='.length) : '';
}

function normalizeBaseUrl(value, fallback = defaultApiBase) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return fallback;
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

function isLoopbackBase(value) {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function configuredApiBase() {
  // Ignore the localhost value written by older bundled-server builds when a
  // packaged client now has an online endpoint in its package metadata.
  const savedBase = app.isPackaged && isLoopbackBase(settings?.apiBase) ? '' : settings?.apiBase;
  const configured = commandLineApiBase() || savedBase || packageMetadata?.guguApiBase || process.env.GUGU_API_BASE || '';
  return normalizeBaseUrl(configured, app.isPackaged ? '' : defaultApiBase);
}

function safeName(value, fallback = '未命名文件') {
  const name = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return (name || fallback).slice(0, 180);
}

function isInside(parent, target) {
  const root = path.resolve(parent);
  const candidate = path.resolve(target);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function persistSettings() {
  await writeJson(path.join(app.getPath('userData'), settingsFileName), settings);
}

function syncOriginKey() {
  try { return new URL(configuredApiBase()).origin; } catch { return ''; }
}

function syncCursor() {
  const origin = syncOriginKey();
  if (!origin || !workspaceAccountId) return '';
  const originCursors = settings?.assetSyncCursors?.[origin];
  if (!originCursors || typeof originCursors !== 'object' || Array.isArray(originCursors)) return '';
  return String(originCursors[workspaceAccountId] || '');
}

async function ensureWorkspace(root) {
  const resolved = path.resolve(root);
  await fs.mkdir(resolved, { recursive: true });
  for (const folder of ['.gugu', '.gugu/transfers', '.gugu/cache', '.gugu/logs', 'library', 'projects', 'exports']) {
    await fs.mkdir(path.join(resolved, folder), { recursive: true });
  }
  return resolved;
}

async function ensureWorkspaceRoot(root) {
  const resolved = path.resolve(root);
  await fs.mkdir(path.join(resolved, 'accounts'), { recursive: true, mode: 0o700 });
  return resolved;
}

function activeWorkspaceInfo() {
  return {
    path: workspace || workspaceRoot || '',
    rootPath: workspaceRoot || '',
    accountId: workspaceAccountId,
    cursor: syncCursor(),
    deviceId: settings?.deviceId || '',
  };
}

async function setWorkspaceRoot(root, { persist = true } = {}) {
  const resolved = await ensureWorkspaceRoot(root);
  workspaceRoot = resolved;
  if (workspaceAccountId) {
    await activateWorkspaceAccount(workspaceAccountId, { persist: false });
  } else {
    workspaceEpoch += 1;
    remoteDownloadLocks.clear();
    closeLocalLibrary();
    workspace = '';
  }
  if (persist) {
    settings.workspaceRootPath = workspaceRoot;
    settings.workspacePath = workspace || workspaceRoot;
    await persistSettings();
  }
  return activeWorkspaceInfo();
}

async function activateWorkspaceAccount(accountId, { persist = true } = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!workspaceRoot) {
    workspaceRoot = configuredWorkspaceRoot(settings, path.join(app.getPath('documents'), 'GuGu AI Projects'));
  }
  const accountRoot = accountWorkspacePath(workspaceRoot, normalizedAccountId);
  workspaceEpoch += 1;
  remoteDownloadLocks.clear();
  closeLocalLibrary();
  workspace = await ensureWorkspace(accountRoot);
  workspaceAccountId = normalizedAccountId;
  openLocalLibrary(workspace);
  if (persist) {
    settings.workspaceRootPath = workspaceRoot;
    settings.workspacePath = workspace;
    settings.workspaceAccountId = workspaceAccountId;
    await persistSettings();
  }
  return activeWorkspaceInfo();
}

async function deactivateWorkspaceAccount({ persist = true } = {}) {
  workspaceEpoch += 1;
  remoteDownloadLocks.clear();
  closeLocalLibrary();
  workspace = '';
  workspaceAccountId = '';
  if (persist) {
    settings.workspaceRootPath ||= workspaceRoot || '';
    settings.workspacePath = workspaceRoot || '';
    settings.workspaceAccountId = '';
    await persistSettings();
  }
  return activeWorkspaceInfo();
}

function assertActiveWorkspace(expectedWorkspace, expectedEpoch) {
  if (!workspace || !workspaceAccountId || workspace !== expectedWorkspace || workspaceEpoch !== expectedEpoch) {
    throw new Error('本地工作区已切换，请重试');
  }
}

function libraryAsset(assetId) {
  return getLocalAsset(String(assetId || ''));
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => { size += chunk.length; hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), size };
}

function mimeFromName(name) {
  const extension = path.extname(name).toLowerCase();
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.weba': 'audio/webm',
  }[extension] || 'application/octet-stream';
}

function localMediaMimeType(asset, target) {
  const stored = String(asset?.mimeType || '').split(';')[0].trim().toLowerCase();
  if (stored && stored !== 'application/octet-stream') return stored;
  const named = mimeFromName(asset?.name || '');
  return named !== 'application/octet-stream' ? named : mimeFromName(target);
}

function ffmpegExecutableCandidates() {
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return [
    String(process.env.GUGU_FFMPEG_PATH || '').trim(),
    app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg', executable) : '',
    app.isPackaged ? path.join(process.resourcesPath, executable) : '',
  ].filter(Boolean);
}

async function resolveFfmpegExecutable() {
  const candidates = ffmpegExecutableCandidates();
  try {
    const module = await import('ffmpeg-static');
    const bundled = String(module.default || module || '').trim();
    if (bundled) {
      candidates.push(bundled);
      // Native executables cannot be spawned from inside an ASAR archive.
      candidates.push(bundled.replace(/\.asar([\\/])/i, '.asar.unpacked$1'));
    }
  } catch {
    // The dependency is present in packaged builds; leave development builds
    // usable when node_modules has not been installed yet.
  }
  for (const candidate of [...new Set(candidates)]) {
    if (await fs.access(candidate, fs.constants?.X_OK).then(() => true).catch(() => false)) return candidate;
  }
  // The development environment normally supplies ffmpeg through PATH. A
  // packaged build should use the static binary bundled by electron-builder;
  // keeping PATH as a fallback also makes local development straightforward.
  return 'ffmpeg';
}

function runFfmpeg(args, { cwd, timeoutMs = 900_000 } = {}) {
  return resolveFfmpegExecutable().then(command => new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`本地视频处理超时：${stderr.trim().slice(-800) || 'FFmpeg 未在规定时间内完成'}`));
    }, timeoutMs);
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') reject(new Error('本地视频处理需要 FFmpeg，请重新安装客户端或配置 GUGU_FFMPEG_PATH'));
      else reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`本地视频处理失败（${signal || `退出码 ${code}`}）：${stderr.trim().slice(-1200) || 'FFmpeg 未返回错误信息'}`));
    });
  }));
}

function localAssetPath(asset, targetWorkspace = workspace) {
  if (!asset || !targetWorkspace || !asset.relativePath) throw new Error('本地素材记录不完整');
  const target = path.resolve(targetWorkspace, asset.relativePath);
  if (!isInside(targetWorkspace, target)) throw new Error('本地素材路径不受信任');
  return target;
}

async function localAssetResult(asset, { name = '', source = '', projectId = '' } = {}) {
  if (!asset) throw new Error('本地素材未生成');
  if (name) asset.name = safeName(name, asset.name);
  if (source) asset.source = source;
  if (projectId) asset.projectId = String(projectId);
  asset.localStatus = 'saved';
  asset.remoteStatus = 'local_only';
  upsertLocalAsset(asset);
  return { ...asset, localId: asset.id, localOnly: true, url: localMediaUrl(asset.id) };
}

async function extractLocalTailFrame({ assetId, name = '尾帧', projectId = '' } = {}) {
  const targetWorkspace = workspace;
  const targetEpoch = workspaceEpoch;
  const sourceAsset = libraryAsset(String(assetId || ''));
  if (!sourceAsset || sourceAsset.kind !== 'video') throw new Error('选中的分镜视频不在本地文件库中');
  const source = localAssetPath(sourceAsset, targetWorkspace);
  if (!await fs.stat(source).then(stat => stat.isFile()).catch(() => false)) throw new Error('选中的分镜视频本地文件不存在');
  const transferDir = path.join(targetWorkspace, '.gugu', 'transfers');
  const output = path.join(transferDir, `tail-${randomUUID()}.jpg`);
  await fs.mkdir(transferDir, { recursive: true, mode: 0o700 });
  try {
    await runFfmpeg(['-y', '-sseof', '-0.08', '-i', source, '-frames:v', '1', '-q:v', '2', output], { cwd: targetWorkspace, timeoutMs: 120_000 });
    assertActiveWorkspace(targetWorkspace, targetEpoch);
    const imported = await importFile(output);
    return localAssetResult(imported, { name: `${name} · 尾帧.jpg`, source: 'drama_tail_frame', projectId });
  } finally {
    await fs.unlink(output).catch(() => {});
  }
}

async function assembleLocalVideos({ assetIds = [], name = '完整成片', projectId = '' } = {}) {
  const targetWorkspace = workspace;
  const targetEpoch = workspaceEpoch;
  const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(value => String(value || '')).filter(Boolean))];
  if (!ids.length) throw new Error('没有可拼接的本地分镜视频');
  const sources = ids.map(id => {
    const asset = libraryAsset(id);
    if (!asset || asset.kind !== 'video') throw new Error('存在不在本地文件库中的分镜视频');
    return localAssetPath(asset, targetWorkspace);
  });
  for (const source of sources) {
    if (!await fs.stat(source).then(stat => stat.isFile()).catch(() => false)) throw new Error('存在缺失的本地分镜视频');
  }
  const transferDir = path.join(targetWorkspace, '.gugu', 'transfers');
  const concatFile = path.join(transferDir, `concat-${randomUUID()}.txt`);
  const output = path.join(transferDir, `final-${randomUUID()}.mp4`);
  await fs.mkdir(transferDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(concatFile, sources.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'), { mode: 0o600 });
  try {
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatFile, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', output], { cwd: targetWorkspace });
    assertActiveWorkspace(targetWorkspace, targetEpoch);
    const imported = await importFile(output);
    return localAssetResult(imported, { name: `${name} · 完整成片.mp4`, source: 'drama_final', projectId });
  } finally {
    await Promise.all([fs.unlink(concatFile).catch(() => {}), fs.unlink(output).catch(() => {})]);
  }
}

async function importFile(filePath) {
  if (!workspace) throw new Error('工作区尚未初始化');
  const targetWorkspace = workspace;
  const targetEpoch = workspaceEpoch;
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('选择的路径不是文件');
  const digest = await hashFile(filePath);
  assertActiveWorkspace(targetWorkspace, targetEpoch);
  const existing = findLocalAssetByDigest(digest.sha256, digest.size);
  if (existing) return { ...existing, reused: true };

  const originalName = safeName(path.basename(filePath));
  const extension = path.extname(originalName).toLowerCase();
  const mimeType = mimeFromName(originalName);
  const kind = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'image';
  const targetName = `${digest.sha256.slice(0, 16)}-${originalName}`;
  const relativePath = path.join('library', targetName);
  const target = path.join(workspace, relativePath);
  const temporary = `${target}.${process.pid}.${randomUUID()}.part`;
  await fs.copyFile(filePath, temporary);
  await fs.rename(temporary, target);
  assertActiveWorkspace(targetWorkspace, targetEpoch);
  const asset = {
    id: `local_${randomUUID()}`,
    name: originalName,
    relativePath,
    mimeType,
    kind,
    extension,
    size: digest.size,
    sha256: digest.sha256,
    createdAt: new Date().toISOString(),
    sourcePath: filePath,
    remoteStatus: 'pending',
  };
  upsertLocalAsset(asset);
  return { ...asset, reused: false };
}

async function chooseAndImportFiles({ multiple = true } = {}) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入素材到 GuGu AI',
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [
      { name: '媒体文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'weba'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return [];
  const imported = [];
  for (const filePath of result.filePaths) {
    try {
      const mimeType = mimeFromName(filePath);
      if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/') && !mimeType.startsWith('audio/')) throw new Error('只支持图片、视频或音频文件');
      imported.push(await importFile(filePath));
    }
    catch (error) { imported.push({ filePath, error: error.message }); }
  }
  return imported;
}

function trustedMediaDownloadUrl(value) {
  const raw = new URL(String(value || ''), trustedOrigin || defaultApiBase);
  if (!['http:', 'https:'].includes(raw.protocol) || !trustedOrigin || raw.origin !== trustedOrigin) throw new Error('媒体下载地址不受信任');
  if (!raw.pathname.startsWith('/api/files/')) throw new Error('媒体下载路径不受信任');
  return raw.toString();
}

async function cloudCookies(url) {
  const cookies = await session.defaultSession.cookies.get({ url });
  return cookies.length ? { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } : {};
}

async function cloudRequest(pathname, options = {}) {
  if (!trustedOrigin) throw new Error('云端服务尚未连接');
  const url = new URL(pathname, `${trustedOrigin}/`).toString();
  return net.fetch(url, { ...options, headers: { ...(await cloudCookies(url)), 'X-GuGu-Desktop': '1', ...(options.headers || {}) } });
}

async function completeCloudUpload(uploadId) {
  let response = await cloudRequest(`/api/files/uploads/${encodeURIComponent(uploadId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`上传校验失败（${response.status}）`);
  let result = await response.json();
  if (response.status !== 202 && result.status !== 'verifying') return result;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, Math.min(1500, 300 * (attempt + 1))));
    response = await cloudRequest(`/api/files/uploads/${encodeURIComponent(uploadId)}`);
    if (!response.ok) throw new Error(`上传状态查询失败（${response.status}）`);
    result = await response.json();
    if (result.status === 'completed' && result.asset) return result.asset;
    if (result.status === 'failed') throw new Error('文件验证失败，请重新选择文件');
    if (result.status === 'expired') throw new Error('上传凭证已过期，请重新选择文件');
  }
  throw new Error('文件仍在验证中，请稍后重试');
}

async function syncLocalAsset({ assetId, uploadForReference = false }) {
  const targetWorkspace = workspace;
  const targetEpoch = workspaceEpoch;
  const asset = libraryAsset(String(assetId || ''));
  if (!asset) throw new Error('本地素材不存在');
  const source = path.resolve(targetWorkspace, asset.relativePath);
  if (!isInside(targetWorkspace, source)) throw new Error('本地素材路径不受信任');
  const payload = JSON.stringify({ name: asset.name, mimeType: asset.mimeType, size: asset.size, sha256: asset.sha256 });
  if (asset.cloudAssetId && !uploadForReference) {
    const verifyResponse = await cloudRequest(`/api/files/${encodeURIComponent(asset.cloudAssetId)}/local-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mimeType: asset.mimeType, size: asset.size, sha256: asset.sha256, deviceId: settings.deviceId }),
    });
    if (verifyResponse.ok) {
      const cloudAsset = await verifyResponse.json();
      assertActiveWorkspace(targetWorkspace, targetEpoch);
      asset.remoteStatus = 'ready';
      asset.localStatus = 'saved';
      upsertLocalAsset(asset);
      return { ...asset, cloudAsset, url: localMediaUrl(asset.id), reused: true };
    }
    if (verifyResponse.status !== 404) throw new Error(`云端素材校验失败（${verifyResponse.status}）`);
    assertActiveWorkspace(targetWorkspace, targetEpoch);
    asset.cloudAssetId = '';
    asset.remoteStatus = 'pending';
    upsertLocalAsset(asset);
  }
  const initResponse = await cloudRequest('/api/files/uploads/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  if (!initResponse.ok) throw new Error(`上传初始化失败（${initResponse.status}）`);
  const intent = await initResponse.json();
  assertActiveWorkspace(targetWorkspace, targetEpoch);
  if (intent.mode === 'reuse' && intent.asset) {
    if (!uploadForReference) {
      asset.cloudAssetId = intent.asset.id;
      asset.remoteStatus = 'ready';
      asset.localStatus = 'saved';
      upsertLocalAsset(asset);
    }
    return { ...asset, cloudAsset: intent.asset, url: localMediaUrl(asset.id), reused: true };
  }
  if (String(intent.method || '').toUpperCase() !== 'PUT' || !intent.uploadUrl || !intent.uploadId) {
    throw new Error('上传协议无效，仅支持 PUT');
  }
  const bytes = await fs.readFile(source);
  assertActiveWorkspace(targetWorkspace, targetEpoch);
  const storageResponse = await net.fetch(intent.uploadUrl, {
    method: 'PUT',
    headers: intent.headers || {},
    body: new Blob([bytes], { type: asset.mimeType }),
  });
  if (!storageResponse.ok) throw new Error(`云端上传失败（${storageResponse.status}）`);
  const cloudAsset = await completeCloudUpload(intent.uploadId);
  if (!cloudAsset?.id) throw new Error('云端素材记录创建失败');
  assertActiveWorkspace(targetWorkspace, targetEpoch);
  if (!uploadForReference) {
    asset.cloudAssetId = cloudAsset.id;
    asset.remoteStatus = 'ready';
    asset.localStatus = 'saved';
    upsertLocalAsset(asset);
  }
  return { ...asset, cloudAsset, url: localMediaUrl(asset.id), reused: false };
}

async function downloadRemoteAssetInternal({ assetId, url, name, kind, mimeType }) {
  if (!workspace) throw new Error('工作区尚未初始化');
  const targetWorkspace = workspace;
  const targetEpoch = workspaceEpoch;
  const cloudAssetId = String(assetId || '').trim();
  if (!cloudAssetId) throw new Error('缺少云端素材 ID');
  const existing = findLocalAssetByCloudId(cloudAssetId);
  if (existing) {
    const existingPath = path.resolve(targetWorkspace, existing.relativePath);
    if (isInside(targetWorkspace, existingPath) && await fs.access(existingPath).then(() => true).catch(() => false)) {
      assertActiveWorkspace(targetWorkspace, targetEpoch);
      existing.localStatus = 'saved';
      upsertLocalAsset(existing);
      return { ...existing, url: localMediaUrl(existing.id), reused: true };
    }
  }
  const targetUrl = trustedMediaDownloadUrl(url);
  const response = await fetchRemoteMedia(session.defaultSession, targetUrl);
  if (response.status === 404) {
    return { unavailable: true, status: 404, cloudAssetId };
  }
  if (!response.ok || !response.body) throw new Error(`媒体下载失败（${response.status}）`);
  const originalName = safeName(name, `${kind === 'video' ? '生成视频' : '生成图片'}-${cloudAssetId}`);
  const extension = path.extname(originalName).toLowerCase() || ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.weba', 'audio/flac': '.flac' }[mimeType] || '');
  const temporary = path.join(targetWorkspace, '.gugu', 'transfers', `${cloudAssetId}.${randomUUID()}.part`);
  const output = path.join(targetWorkspace, 'library');
  assertActiveWorkspace(targetWorkspace, targetEpoch);
  await fs.mkdir(output, { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const digestTransform = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(response.body), digestTransform, createWriteStream(temporary, { mode: 0o600 }));
    const sha256 = hash.digest('hex');
    const targetName = `${sha256.slice(0, 16)}-${originalName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}${extension && !path.extname(originalName) ? extension : ''}`;
    const relativePath = path.join('library', targetName);
    const target = path.join(targetWorkspace, relativePath);
    assertActiveWorkspace(targetWorkspace, targetEpoch);
    await fs.rename(temporary, target);
    // 同内容同名的云端素材会算出同一个 relativePath；若已被别的本地记录占用，复用那条记录，
    // 否则插入新行会撞 assets.relative_path 唯一约束，导致该素材永远无法接收。
    assertActiveWorkspace(targetWorkspace, targetEpoch);
    const claimed = claimLocalAssetByPath({ relativePath, cloudAssetId, sha256, size, previousId: existing?.id || '' });
    if (claimed) return { ...claimed, url: localMediaUrl(claimed.id), reused: true };
    const asset = {
      ...(existing || {}),
      id: existing?.id || `local_${randomUUID()}`,
      cloudAssetId,
      name: originalName,
      relativePath,
      mimeType: mimeType || response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
      kind: kind || 'image',
      size,
      sha256,
      createdAt: existing?.createdAt || new Date().toISOString(),
      remoteStatus: 'ready',
      localStatus: 'saved',
    };
    assertActiveWorkspace(targetWorkspace, targetEpoch);
    upsertLocalAsset(asset);
    return { ...asset, url: localMediaUrl(asset.id), reused: false };
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function downloadRemoteAsset(payload = {}) {
  const cloudAssetId = String(payload.assetId || '').trim();
  if (!cloudAssetId) return downloadRemoteAssetInternal(payload);
  const inFlight = remoteDownloadLocks.get(cloudAssetId);
  if (inFlight) return inFlight;
  let task;
  task = downloadRemoteAssetInternal(payload).finally(() => {
    if (remoteDownloadLocks.get(cloudAssetId) === task) remoteDownloadLocks.delete(cloudAssetId);
  });
  remoteDownloadLocks.set(cloudAssetId, task);
  return task;
}

async function renameLocalAsset({ assetId, name }) {
  const asset = libraryAsset(String(assetId || ''));
  if (!asset) throw new Error('本地素材不存在');
  const nextName = safeName(name, asset.name);
  if (!nextName) throw new Error('文件名不能为空');
  asset.name = nextName;
  upsertLocalAsset(asset);
  return { ...asset, url: localMediaUrl(asset.id) };
}

async function removeLocalAsset(assetId) {
  const targetWorkspace = workspace;
  const targetEpoch = workspaceEpoch;
  const asset = libraryAsset(String(assetId || ''));
  if (!asset) throw new Error('本地素材不存在');
  const target = path.resolve(targetWorkspace, asset.relativePath);
  if (!isInside(targetWorkspace, target)) throw new Error('本地素材路径不受信任');
  await fs.unlink(target).catch(() => {});
  assertActiveWorkspace(targetWorkspace, targetEpoch);
  deleteLocalAsset(asset.id);
  return true;
}

function localMediaUrl(assetId) {
  if (!libraryAsset(assetId)) return '';
  return `gugu-media://asset/${encodeURIComponent(assetId)}`;
}

function parseLocalMediaRange(value, size) {
  const raw = String(value || '');
  if (!raw) return null;
  if (!/^bytes=/i.test(raw) || !Number.isSafeInteger(size) || size <= 0) return { unsatisfiable: true };
  const spec = raw.slice(6).split(',')[0].trim();
  const separator = spec.indexOf('-');
  if (separator < 0) return { unsatisfiable: true };
  const startText = spec.slice(0, separator).trim();
  const endText = spec.slice(separator + 1).trim();
  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return { unsatisfiable: true };
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function materializeLocalAssets(items) {
  const targetWorkspace = workspace;
  const targetEpoch = workspaceEpoch;
  const assets = await Promise.all(items.map(async item => {
    const relativePath = String(item?.relativePath || '');
    if (!relativePath) return null;
    const target = path.resolve(targetWorkspace, relativePath);
    if (!isInside(targetWorkspace, target)) return null;
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) return null;
    return { ...item, localStatus: 'saved', url: `gugu-media://asset/${encodeURIComponent(item.id)}` };
  }));
  if (targetWorkspace !== workspace || targetEpoch !== workspaceEpoch) return [];
  return assets.filter(Boolean);
}

async function listLocalAssets(options = {}) {
  if (!workspace) return { items: [], total: 0, nextCursor: '' };
  const page = Array.isArray(options.cloudAssetIds)
    ? { items: listLocalAssetsByCloudIds(options.cloudAssetIds), total: options.cloudAssetIds.length, nextCursor: '' }
    : queryLocalAssets(options);
  return { items: await materializeLocalAssets(page.items), total: page.total, nextCursor: page.nextCursor };
}

async function serveLocalMedia(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const url = new URL(request.url);
  const assetId = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const targetWorkspace = workspace;
  const targetEpoch = workspaceEpoch;
  const asset = libraryAsset(assetId);
  if (!asset || !targetWorkspace || !workspaceAccountId) return new Response('Not Found', { status: 404 });
  const target = path.resolve(targetWorkspace, asset.relativePath);
  if (!isInside(targetWorkspace, target)) return new Response('Forbidden', { status: 403 });
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile() || targetWorkspace !== workspace || targetEpoch !== workspaceEpoch) return new Response('Not Found', { status: 404 });

  const range = parseLocalMediaRange(request.headers.get('range'), stat.size);
  if (range?.unsatisfiable) return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${stat.size}` } });
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, stat.size - 1);
  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Length': String(Math.max(0, end - start + 1)),
    'Content-Type': localMediaMimeType(asset, target),
    'X-Content-Type-Options': 'nosniff',
  };
  const status = range ? 206 : 200;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  if (request.method === 'HEAD' || stat.size === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(createReadStream(target, { start, end }));
  return new Response(body, { status, headers });
}

async function openOfflinePage(message = '') {
  if (!mainWindow) return;
  if (process.platform === 'win32') {
    setWindowsModalState(false);
    mainWindow.setTitleBarOverlay(windowsTitleBarOverlay);
  }
  await mainWindow.loadFile(path.join(rendererDir, 'offline.html'), { query: { message } });
}

function updateFeedUrl() {
  const value = settings?.updateUrl || packageMetadata?.guguUpdateUrl || process.env.GUGU_UPDATE_URL || '';
  return String(value || '').trim().replace(/\/$/, '');
}
function sendUpdateStatus(status, extra = {}) {
  currentUpdateStatus = { status, currentVersion: app.getVersion(), ...extra };
  mainWindow?.webContents.send('desktop:update-status', currentUpdateStatus);
}

async function macUpdateDigest(filePath) {
  const hash = createHash('sha512');
  let size = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', chunk => { size += chunk.length; hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { size, sha512: hash.digest('base64') };
}

async function launchMacUpdateInstaller() {
  if (macUpdateInstallStarted) return true;
  if (!downloadedMacUpdatePath) return false;
  await fs.access(downloadedMacUpdatePath);
  const launcher = macDmgInstallerLauncher(downloadedMacUpdatePath);
  const child = spawn(launcher.command, launcher.args, { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  macUpdateInstallStarted = true;
  sendUpdateStatus('installing', { version: downloadedMacUpdateVersion });
  app.quit();
  return true;
}

function macUpdateReady(filePath, version) {
  downloadedMacUpdatePath = filePath;
  downloadedMacUpdateVersion = version;
  sendUpdateStatus('downloaded', { version });
  return true;
}

async function downloadMacUpdate(updateInfo) {
  const file = macDmgUpdateFile(updateInfo, updateFeedUrl());
  if (!file.sha512 || !Number.isFinite(Number(file.size)) || Number(file.size) <= 0) throw new Error('DMG 更新清单缺少完整性校验信息');
  const updateDir = path.join(app.getPath('cache'), 'gugu-ai-updates');
  const target = path.join(updateDir, safeName(file.fileName, `GuGu-AI-${updateInfo.version}.dmg`));
  const temporary = `${target}.${process.pid}.${randomUUID()}.part`;
  await fs.mkdir(updateDir, { recursive: true });
  try {
    const cached = await macUpdateDigest(target).catch(() => null);
    if (cached?.size === Number(file.size) && cached.sha512 === file.sha512) return macUpdateReady(target, updateInfo.version);
    const response = await net.fetch(file.downloadUrl, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`更新安装包下载失败（${response.status}）`);
    const hash = createHash('sha512');
    const total = Number(file.size);
    let transferred = 0;
    let lastPercent = -1;
    const digestTransform = new Transform({ transform(chunk, _encoding, callback) {
      transferred += chunk.length;
      hash.update(chunk);
      const percent = Math.min(100, Math.floor((transferred / total) * 100));
      if (percent !== lastPercent) {
        lastPercent = percent;
        sendUpdateStatus('downloading', { percent, transferred, total });
      }
      callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), digestTransform, createWriteStream(temporary, { mode: 0o600 }));
    const sha512 = hash.digest('base64');
    if (transferred !== total || sha512 !== file.sha512) throw new Error('更新安装包完整性校验失败');
    await fs.rm(target, { force: true });
    await fs.rename(temporary, target);
    return macUpdateReady(target, updateInfo.version);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function startMacUpdateDownload(updateInfo) {
  if (!macUpdateDownloadPromise) {
    const promise = downloadMacUpdate(updateInfo)
      .catch(error => { sendUpdateStatus('error', { message: error.message }); return false; })
      .finally(() => { if (macUpdateDownloadPromise === promise) macUpdateDownloadPromise = undefined; });
    macUpdateDownloadPromise = promise;
  }
  return macUpdateDownloadPromise;
}

async function launchDownloadedUpdateInstaller() {
  if (updateInstallStarted) return true;
  await configureAutoUpdater();
  const installerPath = downloadedUpdatePath || String(autoUpdater.installerPath || '').trim();
  if (!installerPath) throw new Error('更新安装包尚未准备好，请稍后再试');
  await fs.access(installerPath);
  if (!path.isAbsolute(installerPath) || installerPath.includes('\0')) throw new Error('更新安装包路径无效');
  const child = spawn(installerPath, [], { detached: true, stdio: 'ignore', windowsHide: false });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  updateInstallStarted = true;
  sendUpdateStatus('installing', { version: downloadedUpdateVersion });
  app.quit();
  return true;
}

function configureAutoUpdater() {
  if (!app.isPackaged) return Promise.resolve();
  if (autoUpdaterConfigPromise) return autoUpdaterConfigPromise;
  autoUpdaterConfigPromise = (async () => {
    // A user can click the startup-page update control before the asynchronous
    // settings read has completed. Do not cache an "unconfigured" result based
    // on the temporary defaults used for the first paint.
    await settingsReady;
    const url = updateFeedUrl();
    if (!url) { sendUpdateStatus('unconfigured'); return; }
    try {
      // Keep the updater out of the initial module graph. It is only needed
      // after the studio is visible or when the user explicitly checks.
      const updaterModule = await import('electron-updater');
      autoUpdater = updaterModule.autoUpdater || updaterModule.default?.autoUpdater;
      if (!autoUpdater) throw new Error('自动更新模块不可用');
      const manualMacUpdate = process.platform === 'darwin';
      autoUpdater.autoDownload = !manualMacUpdate;
      // The renderer owns the confirmation step. Closing the app must never
      // silently install an update because this client cannot complete a true
      // in-place restart/reinstall flow reliably on every platform.
      autoUpdater.autoInstallOnAppQuit = false;
      // Keep electron-updater's blockmap/range-request path enabled. If a
      // differential download cannot be assembled, electron-updater falls back
      // to the complete package automatically.
      autoUpdater.disableDifferentialDownload = false;
      autoUpdater.setFeedURL({ provider: 'generic', url: `${url}/` });
      updateConfigured = true;
      autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
      autoUpdater.on('update-available', info => {
        sendUpdateStatus('available', { version: info.version });
        if (manualMacUpdate) startMacUpdateDownload(info);
      });
      autoUpdater.on('update-not-available', info => sendUpdateStatus('current', { version: info.version }));
      autoUpdater.on('download-progress', progress => sendUpdateStatus('downloading', { percent: Math.round(progress.percent), transferred: progress.transferred, total: progress.total }));
      autoUpdater.on('update-downloaded', info => {
        if (manualMacUpdate) return;
        downloadedUpdatePath = String(info.downloadedFile || '').trim();
        downloadedUpdateVersion = info.version;
        sendUpdateStatus('downloaded', { version: info.version });
      });
      autoUpdater.on('error', error => sendUpdateStatus('error', { message: error.message }));
      setTimeout(() => autoUpdater.checkForUpdates().catch(error => sendUpdateStatus('error', { message: error.message })), 4_000);
    } catch (error) {
      sendUpdateStatus('error', { message: error.message });
    }
  })();
  return autoUpdaterConfigPromise;
}
async function checkForUpdates() {
  await configureAutoUpdater();
  if (!updateConfigured) return { status: 'unconfigured' };
  try { const result = await autoUpdater.checkForUpdates(); return { status: result?.isUpdateAvailable ? 'available' : 'current', version: result?.updateInfo?.version || '' }; }
  catch (error) { sendUpdateStatus('error', { message: error.message }); return { status: 'error', message: error.message }; }
}

async function loadStudio() {
  const apiBase = configuredApiBase();
  trustedOrigin = apiBase ? new URL(apiBase).origin : '';
  if (!apiBase) {
    await openOfflinePage('未配置线上创作服务地址，请在此填写 HTTPS API 地址，或在构建时设置 DESKTOP_API_BASE。');
    return;
  }
  if (!desktopRequestHeaderInstalled) {
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
      try {
        if (trustedOrigin && new URL(details.url).origin === trustedOrigin) details.requestHeaders['X-GuGu-Desktop'] = '1';
      } catch {}
      callback({ requestHeaders: details.requestHeaders });
    });
    desktopRequestHeaderInstalled = true;
  }
  try {
    if (process.platform === 'win32') {
      setWindowsModalState(false);
      mainWindow.setTitleBarOverlay(windowsTitleBarOverlay);
    }
    // Loading the actual page is the health check. A separate `/healthz`
    // request used to add one full network round trip before the renderer
    // could even begin loading its HTML, CSS and JavaScript.
    await mainWindow.loadURL(`${apiBase}/`);
  } catch (error) {
    await openOfflinePage(`无法连接创作服务：${error.message}`);
  }
}

function isMainWindowEvent(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event?.sender === mainWindow.webContents);
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('desktop:window-state', {
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen(),
    transitioning: windowFullscreenTransition,
  });
}

function setWindowsModalState(active) {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return false;
  const modal = Boolean(active);
  try {
    // WCO caption buttons are native and always hit-tested above the renderer.
    // Update the overlay first, then disable their commands while a renderer
    // modal is open so the backdrop owns the complete interactive surface.
    mainWindow.setTitleBarOverlay(modal ? windowsModalTitleBarOverlay : windowsTitleBarOverlay);
    mainWindow.setMinimizable(!modal);
    mainWindow.setMaximizable(!modal);
    mainWindow.setClosable(!modal);
    return true;
  } catch (error) {
    console.warn('[desktop] 更新 Windows 弹窗标题栏状态失败', error);
    return false;
  }
}

function createTrayIcon() {
  if (process.platform === 'win32') {
    // Windows' notification area is not a reliable SVG renderer. Use the
    // packaged multi-size ICO so the shell can choose the correct DPI image.
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'tray.ico')
      : path.join(here, 'assets', 'tray.ico');
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw new Error(`Windows 托盘图标加载失败：${iconPath}`);
    return image;
  }

  const isMac = process.platform === 'darwin';
  const svg = isMac
    // Keep the macOS menu-bar item consistent with the GuGu AI app logo.
    // A template icon strips the white mark and makes the old two-path icon
    // appear empty until the status item is activated, so preserve the full
    // colored mark here instead.
    ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#18181b"/><rect x="11" y="16.5" width="28" height="9" rx="3" fill="#fff" transform="rotate(-38 25 21)"/><rect x="25" y="38.5" width="28" height="9" rx="3" fill="#fff" transform="rotate(-38 39 43)"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#18181b"/><rect x="11" y="16.5" width="28" height="9" rx="3" fill="#8cf0ca" transform="rotate(-38 25 21)"/><rect x="25" y="38.5" width="28" height="9" rx="3" fill="#8cf0ca" transform="rotate(-38 39 43)"/></svg>';
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  return image.resize({ width: isMac ? 18 : 16, height: isMac ? 18 : 16 });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (process.platform === 'darwin' && mainWindow.isFullScreen()) {
    const windowToHide = mainWindow;
    const hideAfterFullscreen = () => {
      if (mainWindow === windowToHide && !windowToHide.isDestroyed()) windowToHide.hide();
    };
    windowToHide.once('leave-full-screen', hideAfterFullscreen);
    windowToHide.setFullScreen(false);
    return true;
  }
  mainWindow.hide();
  return true;
}

function closeMainWindow() {
  return hideMainWindowToTray();
}

function restoreMainWindowAfterPayment() {
  if (isQuitting) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function closePaymentWindow() {
  if (!paymentWindow || paymentWindow.isDestroyed()) return false;
  paymentWindow.close();
  return true;
}

async function closePaymentWindowBeforeReplace() {
  const existing = paymentWindow;
  if (!existing || existing.isDestroyed()) return false;
  await new Promise(resolve => {
    existing.once('closed', resolve);
    existing.close();
    if (existing.isDestroyed()) resolve();
  });
  return true;
}

function layoutPaymentView() {
  if (!paymentWindow || paymentWindow.isDestroyed() || !paymentView || paymentView.webContents.isDestroyed()) return;
  const [width, height] = paymentWindow.getContentSize();
  paymentView.setBounds({ x: 0, y: paymentToolbarHeight, width, height: Math.max(1, height - paymentToolbarHeight) });
}

async function openAlipayPaymentWindow(paymentHtml) {
  const html = String(paymentHtml || '');
  if (html.length < 100 || html.length > 100_000 || !/alipay\.trade\.page\.pay/i.test(html) || !/https:\/\/openapi(?:-sandbox\.dl)?\.alipay(?:dev)?\.com\/gateway\.do/i.test(html.replaceAll('&amp;', '&'))) {
    throw new Error('支付宝支付表单无效');
  }
  await closePaymentWindowBeforeReplace();

  paymentWindow = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 760,
    minHeight: 620,
    title: '支付宝扫码支付 · GuGu AI',
    frame: false,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: true,
    skipTaskbar: true,
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(here, 'payment-shell-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  const currentPaymentWindow = paymentWindow;
  paymentView = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const currentPaymentView = paymentView;
  currentPaymentView.setBackgroundColor('#ffffff');
  currentPaymentWindow.contentView.addChildView(currentPaymentView);
  currentPaymentWindow.on('resize', layoutPaymentView);
  currentPaymentWindow.on('closed', () => {
    if (!currentPaymentView.webContents.isDestroyed()) currentPaymentView.webContents.close();
    if (paymentWindow === currentPaymentWindow) paymentWindow = undefined;
    if (paymentView === currentPaymentView) paymentView = undefined;
    restoreMainWindowAfterPayment();
  });
  currentPaymentView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  currentPaymentView.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault();
      closePaymentWindow();
    }
  });
  currentPaymentView.webContents.on('enter-html-full-screen', () => currentPaymentWindow.setFullScreen(false));
  await currentPaymentWindow.loadFile(path.join(here, 'payment-shell.html'));
  layoutPaymentView();
  currentPaymentWindow.show();
  currentPaymentWindow.focus();
  try {
    await currentPaymentView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } catch (error) {
    if (!/ERR_ABORTED|-3/.test(String(error?.message || '')) && !currentPaymentWindow.isDestroyed()) {
      currentPaymentWindow.webContents.send('payment:load-error', error.message || '支付宝收银台加载失败');
    }
  }
  return true;
}

function createTray() {
  if (tray) return;
  tray = new Tray(createTrayIcon());
  tray.setToolTip(productName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 GuGu AI', click: showMainWindow },
    { type: 'separator' },
    { label: '退出客户端', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindow);
}

function registerIpc() {
  ipcMain.handle('desktop:get-info', () => ({
    productName,
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    nativeWindowControls: process.platform === 'win32',
    apiBase: configuredApiBase(),
    workspacePath: workspace || workspaceRoot || '',
    workspaceRootPath: workspaceRoot || '',
    workspaceAccountId,
    deviceId: settings.deviceId,
    assetSyncCursor: syncCursor(),
    updateUrl: updateFeedUrl(),
  }));
  ipcMain.handle('desktop:get-sync-state', () => ({ deviceId: settings.deviceId, cursor: syncCursor() }));
  ipcMain.handle('desktop:set-sync-cursor', async (_event, value) => {
    const cursor = String(value || '');
    if (cursor.length > 1024) throw new Error('素材同步游标无效');
    const origin = syncOriginKey();
    if (origin && workspaceAccountId) {
      settings.assetSyncCursors ||= {};
      const current = settings.assetSyncCursors[origin];
      if (!current || typeof current !== 'object' || Array.isArray(current)) settings.assetSyncCursors[origin] = {};
      settings.assetSyncCursors[origin][workspaceAccountId] = cursor;
      await persistSettings();
    }
    return { deviceId: settings.deviceId, cursor };
  });
  ipcMain.handle('desktop:set-api-base', async (_event, value) => {
    const raw = String(value || '').trim();
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error('服务地址必须是完整的 http:// 或 https:// 地址'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('服务地址必须是完整的 http:// 或 https:// 地址');
    settings.apiBase = normalizeBaseUrl(parsed.toString(), '');
    await persistSettings();
    await loadStudio();
    return { apiBase: settings.apiBase };
  });
  ipcMain.handle('desktop:set-update-url', async (_event, value) => {
    const raw = String(value || '').trim();
    if (!raw) {
      settings.updateUrl = '';
      await persistSettings();
      return { updateUrl: '', restartRequired: false };
    }
    let parsed;
    try { parsed = new URL(raw); } catch { throw new Error('更新地址必须是完整的 http:// 或 https:// 地址'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('更新地址必须是完整的 http:// 或 https:// 地址');
    settings.updateUrl = parsed.toString().replace(/\/$/, '');
    await persistSettings();
    return { updateUrl: settings.updateUrl, restartRequired: app.isPackaged };
  });
  ipcMain.handle('desktop:retry', () => loadStudio());
  ipcMain.handle('window:minimize', event => {
    if (!isMainWindowEvent(event)) return false;
    mainWindow.minimize();
    return true;
  });
  ipcMain.handle('window:toggle-maximize', event => {
    if (!isMainWindowEvent(event)) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:is-maximized', event => isMainWindowEvent(event) && mainWindow.isMaximized());
  ipcMain.handle('window:is-fullscreen', event => isMainWindowEvent(event) && mainWindow.isFullScreen());
  ipcMain.handle('window:set-modal-state', (event, active) => {
    if (!isMainWindowEvent(event)) return false;
    return setWindowsModalState(Boolean(active));
  });
  ipcMain.handle('window:close', event => {
    if (!isMainWindowEvent(event)) return false;
    return closeMainWindow();
  });
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:get-status', () => currentUpdateStatus);
  ipcMain.handle('updates:install', async () => {
    if (!updateConfigured) return false;
    if (process.platform === 'darwin') {
      return launchMacUpdateInstaller();
    }
    try {
      return await launchDownloadedUpdateInstaller();
    } catch (error) {
      sendUpdateStatus('error', { message: error.message, version: downloadedUpdateVersion });
      throw error;
    }
  });
  ipcMain.handle('payments:open-alipay', async (event, paymentHtml) => {
    if (!isMainWindowEvent(event)) throw new Error('无效的支付窗口请求');
    return openAlipayPaymentWindow(paymentHtml);
  });
  ipcMain.handle('payments:complete-alipay', async event => {
    if (!isMainWindowEvent(event)) return false;
    return closePaymentWindowBeforeReplace();
  });
  ipcMain.handle('payments:close-alipay', event => {
    if (!paymentWindow || paymentWindow.isDestroyed() || event.sender !== paymentWindow.webContents) return false;
    return closePaymentWindow();
  });
  ipcMain.handle('workspace:get', () => ({ ...activeWorkspaceInfo(), assetCount: workspace ? countLocalAssets() : 0 }));
  ipcMain.handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择 GuGu AI 工作区', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, ...(await setWorkspaceRoot(result.filePaths[0])) };
  });
  ipcMain.handle('workspace:activate-account', async (_event, accountId) => {
    return activateWorkspaceAccount(accountId);
  });
  ipcMain.handle('workspace:deactivate-account', async () => {
    return deactivateWorkspaceAccount();
  });
  ipcMain.handle('workspace:open', async () => {
    if (!workspace) return false;
    await shell.openPath(workspace);
    return true;
  });
  ipcMain.handle('media:choose-and-import', (_event, options) => chooseAndImportFiles(options));
  ipcMain.handle('media:list-local', (_event, options) => listLocalAssets(options || {}));
  ipcMain.handle('media:list-local-by-cloud-ids', async (_event, ids) => (await listLocalAssets({ cloudAssetIds: ids })).items);
  ipcMain.handle('media:download-remote', (_event, payload) => downloadRemoteAsset(payload || {}));
  ipcMain.handle('media:sync-local', (_event, payload) => syncLocalAsset(payload || {}));
  ipcMain.handle('media:extract-tail', (_event, payload) => extractLocalTailFrame(payload || {}));
  ipcMain.handle('media:assemble-videos', (_event, payload) => assembleLocalVideos(payload || {}));
  ipcMain.handle('media:rename-local', (_event, payload) => renameLocalAsset(payload || {}));
  ipcMain.handle('media:remove-local', (_event, assetId) => removeLocalAsset(assetId));
  ipcMain.handle('media:url', (_event, assetId) => localMediaUrl(String(assetId || '')));
  ipcMain.handle('media:show-in-folder', async (_event, assetId) => {
    const targetWorkspace = workspace;
    const targetEpoch = workspaceEpoch;
    const asset = libraryAsset(String(assetId || ''));
    if (!asset || !targetWorkspace || !workspaceAccountId) return false;
    const target = path.resolve(targetWorkspace, asset.relativePath);
    if (!isInside(targetWorkspace, target)) return false;
    if (!await fs.access(target).then(() => true).catch(() => false)) return false;
    if (targetWorkspace !== workspace || targetEpoch !== workspaceEpoch) return false;
    shell.showItemInFolder(target);
    return true;
  });
}

async function createWindow({ loadStudioAfter = true } = {}) {
  const usesNativeMacTitlebar = process.platform === 'darwin';
  const usesNativeWindowsControls = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: productName,
    // Render the local startup surface before doing any network work. Without
    // this, Electron paints its default white background while health checks
    // and the remote studio page are still loading.
    show: false,
    backgroundColor: '#f7f7f8',
    frame: usesNativeMacTitlebar || usesNativeWindowsControls,
    ...(usesNativeMacTitlebar ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 8, y: 18 },
    } : {}),
    ...(usesNativeWindowsControls ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: windowsTitleBarOverlay,
    } : {}),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    hideMainWindowToTray();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', event => {
    try {
      if (trustedOrigin && new URL(event.url).origin === trustedOrigin) return;
    } catch {}
    event.preventDefault();
  });
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  // macOS animates the fullscreen transition. Report the animating phase so the
  // renderer keeps its titlebar chrome untouched until the frame settles.
  windowFullscreenTransition = false;
  const markFullscreenTransition = transitioning => {
    windowFullscreenTransition = transitioning;
    sendWindowState();
  };
  mainWindow.on('will-enter-full-screen', () => markFullscreenTransition(true));
  mainWindow.on('will-leave-full-screen', () => markFullscreenTransition(true));
  mainWindow.on('enter-full-screen', () => markFullscreenTransition(false));
  mainWindow.on('leave-full-screen', () => markFullscreenTransition(false));
  await mainWindow.loadFile(path.join(rendererDir, 'startup.html'));
  mainWindow.show();
  mainWindow.focus();
  startupTrace('window-visible');
  if (loadStudioAfter) await loadStudio();
  sendWindowState();
}

async function bootstrap() {
  // Install the protocol and IPC handlers before the first renderer paint so
  // the startup page can come up while disk/database work happens in the
  // background. The temporary defaults are replaced once settings load.
  settings = { deviceId: randomUUID(), assetSyncCursors: {} };
  protocol.handle('gugu-media', serveLocalMedia);
  registerIpc();
  // This is a web-based studio inside Electron, so the browser-style default
  // application menu is noise rather than a useful part of the client UI.
  Menu.setApplicationMenu(null);
  await createWindow({ loadStudioAfter: false });

  const [loadedPackageMetadata, loadedSettings] = await Promise.all([
    readJson(path.join(app.getAppPath(), 'package.json'), {}),
    readJson(path.join(app.getPath('userData'), settingsFileName), {}),
  ]);
  packageMetadata = loadedPackageMetadata;
  settings = { ...settings, ...loadedSettings };
  settings.deviceId ||= randomUUID();
  settings.assetSyncCursors ||= {};
  // Production builds receive their online API endpoint through package metadata.
  // Keep the localhost fallback only for an unpackaged development run.
  if (!settings.apiBase && !app.isPackaged && process.env.GUGU_API_BASE) settings.apiBase = process.env.GUGU_API_BASE;
  settingsReadyResolve?.();
  settingsReadyResolve = null;
  startupTrace('settings-ready');
  workspaceRoot = configuredWorkspaceRoot(settings, path.join(app.getPath('documents'), 'GuGu AI Projects'));
  settings.workspaceRootPath = workspaceRoot;
  settings.workspacePath = workspaceRoot;
  settings.workspaceAccountId = '';
  await Promise.all([
    ensureWorkspaceRoot(workspaceRoot),
    // Persist the generated device ID without holding up workspace setup.
    persistSettings(),
  ]);
  createTray();
  await loadStudio();
  startupTrace('studio-loaded');
  // Updating is intentionally initialized after the first remote page load;
  // its network check remains delayed by configureAutoUpdater itself.
  void configureAutoUpdater();
}

app.whenReady().then(bootstrap).catch(async error => {
  console.error('[desktop] 启动失败', error);
  if (mainWindow) await openOfflinePage(`客户端启动失败：${error.message}`);
});

app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => {
  closeLocalLibrary();
  tray?.destroy();
  tray = null;
});
app.on('window-all-closed', () => {
  // Keep the process alive for the tray when the last window is hidden or
  // otherwise removed. Explicit quit and update installation still exit.
  if (isQuitting) app.quit();
});
app.on('activate', () => {
  if (!mainWindow) void createWindow();
  else showMainWindow();
});
