// 客户端诊断日志。
//
// 打包后的客户端只把日志写到 stdout，用户机器上出问题时我们什么都拿不到。
// 这里把主进程 console 与渲染进程转发过来的日志落到磁盘（带轮转），并提供
// 「打包成 gzip」的入口，让用户一键把日志交给我们排查。
//
// 落盘刻意保持简单：小批量缓冲 + 同步追加。日志量远低于需要异步流的量级，
// 换来的是不会出现轮转与写入交错的竞态。
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { format, promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const LOG_FILE_NAME = 'client.log';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// client.log 之外再保留两份归档，最差情况约 6 MB 纯文本。
const ARCHIVE_COUNT = 2;
const MAX_LINE_LENGTH = 4000;
const FLUSH_DELAY_MS = 250;
const MAX_BUFFERED_BYTES = 64 * 1024;
// 打包时最多带走这么多纯文本；超出则只保留最近的部分。
const MAX_BUNDLE_TEXT_BYTES = 12 * 1024 * 1024;

let logDir = '';
let logFile = '';
let currentBytes = 0;
let installed = false;
const buffered = [];
let bufferedBytes = 0;
let flushTimer = null;

// 日志会被上传到我们的存储，因此写盘前先把签名 URL、令牌一类的凭证抹掉。
const redactionPatterns = [
  /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|token|access_token|access_key_id|signature)=)[^&\s"']+/gi,
  /("?(?:authorization|password|secret|apiKey|api_key|accessKeySecret)"?\s*[:=]\s*"?)[^\s",}]+/gi,
];

function redact(text) {
  let value = text;
  for (const pattern of redactionPatterns) value = value.replace(pattern, '$1[已隐藏]');
  return value;
}

function normalizeLevel(level) {
  const value = String(level || '').toLowerCase();
  if (['error', 'warn', 'warning', 'info', 'debug', 'log', 'verbose'].includes(value)) {
    return value === 'warning' ? 'warn' : value === 'log' ? 'info' : value;
  }
  return 'info';
}

function fileFor(index) {
  return index === 0 ? logFile : path.join(logDir, `${LOG_FILE_NAME}.${index}`);
}

function rotate() {
  try { rmSync(fileFor(ARCHIVE_COUNT), { force: true }); } catch {}
  for (let index = ARCHIVE_COUNT - 1; index >= 0; index -= 1) {
    try { renameSync(fileFor(index), fileFor(index + 1)); } catch {}
  }
  currentBytes = 0;
}

function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!logFile || !buffered.length) return;
  const chunk = buffered.join('');
  buffered.length = 0;
  bufferedBytes = 0;
  try {
    appendFileSync(logFile, chunk);
    currentBytes += Buffer.byteLength(chunk);
    if (currentBytes >= MAX_FILE_BYTES) rotate();
  } catch {
    // 日志写不进去不能影响客户端本身，这里只能放弃这一批。
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, FLUSH_DELAY_MS);
  flushTimer.unref?.();
}

/** 写一行日志。任何阶段调用都安全：初始化之前的调用会被直接丢弃。 */
export function appendDesktopLog({ level = 'info', scope = 'main', message = '' } = {}) {
  if (!logFile) return false;
  const text = redact(String(message ?? '')).replace(/\r?\n/g, '\n    ').slice(0, MAX_LINE_LENGTH);
  if (!text) return false;
  const line = `${new Date().toISOString()} [${normalizeLevel(level)}] [${String(scope || 'main').slice(0, 24)}] ${text}\n`;
  buffered.push(line);
  bufferedBytes += line.length;
  if (bufferedBytes >= MAX_BUFFERED_BYTES) flushNow();
  else scheduleFlush();
  return true;
}

export function desktopLogDirectory() {
  return logDir;
}

export function flushDesktopLog() {
  flushNow();
}

/**
 * 接管主进程 console 并开始落盘。必须在其它模块产生日志之前调用。
 * 不注册 uncaughtException 处理器：那会吞掉 Electron 默认的崩溃行为，
 * 这里只用 monitor 版本旁观。
 */
export function initDesktopLogging({ dir, header = {} } = {}) {
  if (installed) return desktopLogDirectory();
  const resolved = path.resolve(String(dir || ''));
  if (!resolved) return '';
  try {
    mkdirSync(resolved, { recursive: true });
  } catch {
    return '';
  }
  logDir = resolved;
  logFile = path.join(resolved, LOG_FILE_NAME);
  try { currentBytes = statSync(logFile).size; } catch { currentBytes = 0; }
  if (currentBytes >= MAX_FILE_BYTES) rotate();
  installed = true;

  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try { appendDesktopLog({ level: method, scope: 'main', message: format(...args) }); } catch {}
    };
  }
  process.on('uncaughtExceptionMonitor', error => {
    appendDesktopLog({ level: 'error', scope: 'crash', message: `uncaughtException ${error?.stack || error?.message || error}` });
    flushNow();
  });
  process.on('unhandledRejection', reason => {
    appendDesktopLog({ level: 'error', scope: 'crash', message: `unhandledRejection ${reason?.stack || reason?.message || reason}` });
  });
  process.on('exit', flushNow);

  appendDesktopLog({ level: 'info', scope: 'session', message: `=== 客户端启动 ${JSON.stringify(header)} ===` });
  return logDir;
}

function readLogSection(file) {
  try {
    const size = statSync(file).size;
    return { name: path.basename(file), size, text: readFileSync(file, 'utf8') };
  } catch {
    return null;
  }
}

/**
 * 把诊断信息与全部日志文件打包成一个 gzip。返回的 bytes 可以直接经 IPC
 * 交给渲染进程 PUT 上传，不需要落临时文件。
 */
export async function collectDesktopLogBundle({ diagnostics = {} } = {}) {
  flushNow();
  const sections = [];
  // 归档在前、当前日志在后，读起来就是时间顺序。
  for (let index = ARCHIVE_COUNT; index >= 0; index -= 1) {
    const section = logDir ? readLogSection(fileFor(index)) : null;
    if (section) sections.push(section);
  }
  const head = [
    '===== GuGu AI 客户端诊断信息 =====',
    `生成时间: ${new Date().toISOString()}`,
    `日志目录: ${logDir || '（未启用）'}`,
    redact(JSON.stringify(diagnostics, null, 2)),
    '',
  ].join('\n');
  const body = sections.length
    ? sections.map(section => `\n===== ${section.name} (${section.size} 字节) =====\n${section.text}`).join('\n')
    : '\n（本机暂无日志文件）\n';
  let text = `${head}${body}`;
  if (Buffer.byteLength(text) > MAX_BUNDLE_TEXT_BYTES) {
    text = `${head}\n（日志过长，仅保留最近部分）\n${text.slice(-MAX_BUNDLE_TEXT_BYTES)}`;
  }
  const compressed = await gzipAsync(Buffer.from(text, 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    fileName: `gugu-client-logs-${stamp}.log.gz`,
    mimeType: 'application/gzip',
    size: compressed.length,
    sections: sections.map(section => ({ name: section.name, size: section.size })),
    bytes: new Uint8Array(compressed),
  };
}
