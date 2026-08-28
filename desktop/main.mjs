import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import updater from 'electron-updater';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchRemoteMedia } from './media-download.mjs';
import { macDmgInstallerLauncher, macDmgUpdateFile } from './manual-update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, 'renderer');
const productName = 'GuGu AI';
const defaultApiBase = 'http://127.0.0.1:4317';
const settingsFileName = 'desktop-settings.json';
const localIndexName = 'library-index.json';
const { autoUpdater } = updater;

protocol.registerSchemesAsPrivileged([
  { scheme: 'gugu-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow;
let settings;
let workspace;
let libraryIndex;
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

async function persistLibrary() {
  if (!workspace) return;
  await writeJson(path.join(workspace, '.gugu', localIndexName), libraryIndex);
}

async function ensureWorkspace(root) {
  const resolved = path.resolve(root);
  await fs.mkdir(resolved, { recursive: true });
  for (const folder of ['.gugu', '.gugu/transfers', '.gugu/cache', '.gugu/logs', 'library', 'projects', 'exports']) {
    await fs.mkdir(path.join(resolved, folder), { recursive: true });
  }
  return resolved;
}

async function setWorkspace(root, { persist = true } = {}) {
  workspace = await ensureWorkspace(root);
  libraryIndex = await readJson(path.join(workspace, '.gugu', localIndexName), { version: 1, assets: [] });
  if (!Array.isArray(libraryIndex.assets)) libraryIndex.assets = [];
  if (persist) {
    settings.workspacePath = workspace;
    await persistSettings();
  }
  return workspace;
}

function libraryAsset(assetId) {
  return libraryIndex?.assets.find(item => item.id === assetId) || null;
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

async function importFile(filePath) {
  if (!workspace) throw new Error('工作区尚未初始化');
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('选择的路径不是文件');
  const digest = await hashFile(filePath);
  const existing = libraryIndex.assets.find(item => item.sha256 === digest.sha256 && item.size === digest.size);
  if (existing) return { ...existing, reused: true };

  const originalName = safeName(path.basename(filePath));
  const extension = path.extname(originalName).toLowerCase();
  const targetName = `${digest.sha256.slice(0, 16)}-${originalName}`;
  const relativePath = path.join('library', targetName);
  const target = path.join(workspace, relativePath);
  const temporary = `${target}.${process.pid}.${randomUUID()}.part`;
  await fs.copyFile(filePath, temporary);
  await fs.rename(temporary, target);
  const asset = {
    id: `local_${randomUUID()}`,
    name: originalName,
    relativePath,
    mimeType: mimeFromName(originalName),
    extension,
    size: digest.size,
    sha256: digest.sha256,
    createdAt: new Date().toISOString(),
    sourcePath: filePath,
    remoteStatus: 'pending',
  };
  libraryIndex.assets.unshift(asset);
  await persistLibrary();
  return { ...asset, reused: false };
}

async function chooseAndImportFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入素材到 GuGu AI',
    properties: ['openFile', 'multiSelections'],
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

async function syncLocalAsset({ assetId }) {
  const asset = libraryAsset(String(assetId || ''));
  if (!asset) throw new Error('本地素材不存在');
  if (asset.cloudAssetId) { asset.localStatus = 'saved'; return { ...asset, url: localMediaUrl(asset.id), reused: true }; }
  const source = path.resolve(workspace, asset.relativePath);
  if (!isInside(workspace, source)) throw new Error('本地素材路径不受信任');
  const payload = JSON.stringify({ name: asset.name, mimeType: asset.mimeType, size: asset.size, sha256: asset.sha256 });
  let initResponse = await cloudRequest('/api/files/uploads/init', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  if (initResponse.status === 503) {
    const bytes = await fs.readFile(source);
    const fallbackResponse = await cloudRequest('/api/files/upload', {
      method: 'POST',
      headers: { 'Content-Type': asset.mimeType, 'X-File-Name': encodeURIComponent(asset.name), 'X-File-SHA256': asset.sha256 },
      body: bytes,
    });
    if (!fallbackResponse.ok) throw new Error(`素材上传失败（${fallbackResponse.status}）`);
    const fallbackAsset = await fallbackResponse.json();
    asset.cloudAssetId = fallbackAsset.id;
    asset.remoteStatus = 'ready';
    asset.localStatus = 'saved';
    await persistLibrary();
    return { ...asset, cloudAsset: fallbackAsset, url: localMediaUrl(asset.id), reused: false };
  }
  if (!initResponse.ok) throw new Error(`上传初始化失败（${initResponse.status}）`);
  const intent = await initResponse.json();
  if (intent.mode === 'reuse' && intent.asset) {
    asset.cloudAssetId = intent.asset.id;
    asset.remoteStatus = 'ready';
    asset.localStatus = 'saved';
    await persistLibrary();
    return { ...asset, cloudAsset: intent.asset, url: localMediaUrl(asset.id), reused: true };
  }
  const bytes = await fs.readFile(source);
  const method = String(intent.method || 'POST').toUpperCase();
  let uploadBody = new Blob([bytes], { type: asset.mimeType });
  const uploadHeaders = {};
  if (method === 'POST') {
    const form = new FormData();
    for (const [key, value] of Object.entries(intent.fields || {})) form.append(key, value);
    form.append('file', uploadBody, asset.name);
    uploadBody = form;
  } else {
    Object.assign(uploadHeaders, intent.headers || {});
  }
  const storageResponse = await net.fetch(intent.uploadUrl, { method, headers: uploadHeaders, body: uploadBody });
  if (!storageResponse.ok) throw new Error(`云端上传失败（${storageResponse.status}）`);
  const completeResponse = await cloudRequest(`/api/files/uploads/${encodeURIComponent(intent.uploadId)}/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!completeResponse.ok) throw new Error(`上传校验失败（${completeResponse.status}）`);
  const cloudAsset = await completeResponse.json();
  asset.cloudAssetId = cloudAsset.id || intent.assetId;
  asset.remoteStatus = 'ready';
  asset.localStatus = 'saved';
  await persistLibrary();
  return { ...asset, cloudAsset, url: localMediaUrl(asset.id), reused: false };
}

async function downloadRemoteAsset({ assetId, url, name, kind, mimeType }) {
  if (!workspace) throw new Error('工作区尚未初始化');
  const cloudAssetId = String(assetId || '').trim();
  if (!cloudAssetId) throw new Error('缺少云端素材 ID');
  const existing = libraryIndex.assets.find(item => item.cloudAssetId === cloudAssetId);
  if (existing) {
    const existingPath = path.resolve(workspace, existing.relativePath);
    if (isInside(workspace, existingPath) && await fs.access(existingPath).then(() => true).catch(() => false)) {
      existing.localStatus = 'saved';
      await persistLibrary();
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
  const temporary = path.join(workspace, '.gugu', 'transfers', `${cloudAssetId}.${randomUUID()}.part`);
  const output = path.join(workspace, 'library');
  await fs.mkdir(output, { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const digestTransform = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(response.body), digestTransform, createWriteStream(temporary, { mode: 0o600 }));
    const sha256 = hash.digest('hex');
    const targetName = `${sha256.slice(0, 16)}-${originalName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')}${extension && !path.extname(originalName) ? extension : ''}`;
    const relativePath = path.join('library', targetName);
    const target = path.join(workspace, relativePath);
    await fs.rename(temporary, target);
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
    if (existing) Object.assign(existing, asset);
    else libraryIndex.assets.unshift(asset);
    await persistLibrary();
    return { ...asset, url: localMediaUrl(asset.id), reused: false };
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function renameLocalAsset({ assetId, name }) {
  const asset = libraryAsset(String(assetId || ''));
  if (!asset) throw new Error('本地素材不存在');
  const nextName = safeName(name, asset.name);
  if (!nextName) throw new Error('文件名不能为空');
  asset.name = nextName;
  await persistLibrary();
  return { ...asset, url: localMediaUrl(asset.id) };
}

async function removeLocalAsset(assetId) {
  const index = libraryIndex.assets.findIndex(item => item.id === String(assetId || ''));
  if (index < 0) throw new Error('本地素材不存在');
  const [asset] = libraryIndex.assets.splice(index, 1);
  const target = path.resolve(workspace, asset.relativePath);
  if (!isInside(workspace, target)) throw new Error('本地素材路径不受信任');
  await fs.unlink(target).catch(() => {});
  await persistLibrary();
  return true;
}

async function saveLocalAssetAs({ assetId }) {
  const asset = libraryAsset(String(assetId || ''));
  if (!asset) throw new Error('本地素材不存在');
  const source = path.resolve(workspace, asset.relativePath);
  if (!isInside(workspace, source)) throw new Error('本地素材路径不受信任');
  const result = await dialog.showSaveDialog(mainWindow, { title: '保存素材副本', defaultPath: path.join(app.getPath('downloads'), asset.name), buttonLabel: '保存' });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.copyFile(source, result.filePath);
  return { canceled: false, path: result.filePath };
}

function localMediaUrl(assetId) {
  if (!libraryAsset(assetId)) return '';
  return `gugu-media://asset/${encodeURIComponent(assetId)}`;
}

async function serveLocalMedia(request) {
  const url = new URL(request.url);
  const assetId = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const asset = libraryAsset(assetId);
  if (!asset || !workspace) return new Response('Not Found', { status: 404 });
  const target = path.resolve(workspace, asset.relativePath);
  if (!isInside(workspace, target)) return new Response('Forbidden', { status: 403 });
  try { await fs.access(target); } catch { return new Response('Not Found', { status: 404 }); }
  return net.fetch(pathToFileURL(target).toString());
}

async function openOfflinePage(message = '') {
  if (!mainWindow) return;
  if (process.platform === 'win32') {
    mainWindow.setTitleBarOverlay({ color: '#10171b', symbolColor: '#9baaa5', height: 56 });
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
  if (macUpdateDownloadPromise) return macUpdateDownloadPromise;
  const promise = downloadMacUpdate(updateInfo)
    .catch(error => { sendUpdateStatus('error', { message: error.message }); return false; })
    .finally(() => { if (macUpdateDownloadPromise === promise) macUpdateDownloadPromise = undefined; });
  macUpdateDownloadPromise = promise;
  return promise;
}

async function launchDownloadedUpdateInstaller() {
  if (updateInstallStarted) return true;
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
  if (!app.isPackaged) return;
  const url = updateFeedUrl();
  if (!url) { sendUpdateStatus('unconfigured'); return; }
  try {
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
}
async function checkForUpdates() {
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
      mainWindow.setTitleBarOverlay({ color: '#ffffff', symbolColor: '#667085', height: 56 });
    }
    const response = await fetch(`${apiBase}/healthz`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`服务返回 ${response.status}`);
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

function registerIpc() {
  ipcMain.handle('desktop:get-info', () => ({
    productName,
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    nativeWindowControls: process.platform === 'win32',
    apiBase: configuredApiBase(),
    workspacePath: workspace,
    updateUrl: updateFeedUrl(),
  }));
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
  ipcMain.handle('window:close', event => {
    if (!isMainWindowEvent(event)) return false;
    mainWindow.close();
    return true;
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
  ipcMain.handle('workspace:get', () => ({ path: workspace, assetCount: libraryIndex.assets.length }));
  ipcMain.handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择 GuGu AI 工作区', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    await setWorkspace(result.filePaths[0]);
    return { canceled: false, path: workspace };
  });
  ipcMain.handle('workspace:open', async () => {
    if (!workspace) return false;
    await shell.openPath(workspace);
    return true;
  });
  ipcMain.handle('media:choose-and-import', chooseAndImportFiles);
  ipcMain.handle('media:list-local', () => libraryIndex.assets.map(item => ({ ...item, url: localMediaUrl(item.id) })));
  ipcMain.handle('media:download-remote', (_event, payload) => downloadRemoteAsset(payload || {}));
  ipcMain.handle('media:sync-local', (_event, payload) => syncLocalAsset(payload || {}));
  ipcMain.handle('media:rename-local', (_event, payload) => renameLocalAsset(payload || {}));
  ipcMain.handle('media:remove-local', (_event, assetId) => removeLocalAsset(assetId));
  ipcMain.handle('media:save-local-as', (_event, payload) => saveLocalAssetAs(payload || {}));
  ipcMain.handle('media:url', (_event, assetId) => localMediaUrl(String(assetId || '')));
  ipcMain.handle('media:show-in-folder', async (_event, assetId) => {
    const asset = libraryAsset(String(assetId || ''));
    if (!asset || !workspace) return false;
    const target = path.resolve(workspace, asset.relativePath);
    if (!isInside(workspace, target)) return false;
    shell.showItemInFolder(target);
    return true;
  });
}

async function createWindow() {
  const usesNativeMacTitlebar = process.platform === 'darwin';
  const usesNativeWindowsControls = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: productName,
    backgroundColor: '#f7f7f8',
    frame: usesNativeMacTitlebar || usesNativeWindowsControls,
    ...(usesNativeMacTitlebar ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 8, y: 18 },
    } : {}),
    ...(usesNativeWindowsControls ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#ffffff', symbolColor: '#667085', height: 56 },
    } : {}),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
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
  await loadStudio();
  sendWindowState();
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function bootstrap() {
  packageMetadata = await readJson(path.join(app.getAppPath(), 'package.json'), {});
  settings = await readJson(path.join(app.getPath('userData'), settingsFileName), {});
  // Production builds receive their online API endpoint through package metadata.
  // Keep the localhost fallback only for an unpackaged development run.
  if (!settings.apiBase && !app.isPackaged && process.env.GUGU_API_BASE) settings.apiBase = process.env.GUGU_API_BASE;
  const preferredWorkspace = settings.workspacePath || path.join(app.getPath('documents'), 'GuGu AI Projects');
  await setWorkspace(preferredWorkspace, { persist: false });
  await persistSettings();
  protocol.handle('gugu-media', serveLocalMedia);
  registerIpc();
  configureAutoUpdater();
  // This is a web-based studio inside Electron, so the browser-style default
  // application menu is noise rather than a useful part of the client UI.
  Menu.setApplicationMenu(null);
  await createWindow();
}

app.whenReady().then(bootstrap).catch(async error => {
  console.error('[desktop] 启动失败', error);
  if (mainWindow) await openOfflinePage(`客户端启动失败：${error.message}`);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
