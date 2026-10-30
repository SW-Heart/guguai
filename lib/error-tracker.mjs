// 统一收集服务端、网页端和桌面端的错误，写入 system_events 并汇总成问题。
//
// 服务端：接管 console.error（原样输出到终端，同时入库），并监听未捕获异常。
// 前端：POST /api/errors 批量上报，按 IP 限流，用户无感知。
import { appendSystemEvent } from './audit.mjs';
import { stackLocation } from './error-issues.mjs';
import { bodyJson, sendJson } from '../server/http-protocol.mjs';

const MAX_DETAILS_CHARS = 8_000;
let capturing = false;

function boundedDetails(value) {
  if (value === null || value === undefined) return null;
  try {
    const text = JSON.stringify(value);
    if (!text || text === '{}') return null;
    return text.length <= MAX_DETAILS_CHARS ? value : { truncated: true, preview: text.slice(0, MAX_DETAILS_CHARS) };
  } catch { return { preview: String(value).slice(0, MAX_DETAILS_CHARS) }; }
}

function errorFields(error) {
  if (!error || typeof error !== 'object') return {};
  return Object.fromEntries(['name', 'code', 'statusCode', 'status', 'cause'].filter(key => error[key] !== undefined && error[key] !== null)
    .map(key => [key, key === 'cause' ? String(error.cause?.message || error.cause).slice(0, 500) : error[key]]));
}

function record(entry) {
  if (capturing) return null;
  capturing = true;
  try { return appendSystemEvent(entry); }
  catch { return null; }
  finally { capturing = false; }
}

/** 把一次 console.error 的参数整理成一条错误记录。 */
export function consoleErrorEntry(args) {
  const parts = [];
  const details = {};
  let error = null;
  let category = 'server';
  const pick = {};
  args.forEach((arg, index) => {
    if (arg instanceof Error) { error ||= arg; parts.push(arg.message); return; }
    if (arg && typeof arg === 'object') {
      for (const key of ['requestId', 'userId', 'modelId', 'generationId']) if (arg[key] && !pick[key]) pick[key] = String(arg[key]).slice(0, 200);
      if (arg.error instanceof Error) error ||= arg.error;
      if (typeof arg.message === 'string') parts.push(arg.message);
      Object.assign(details, Object.fromEntries(Object.entries(arg).filter(([, value]) => !(value instanceof Error))));
      return;
    }
    let text = String(arg);
    if (index === 0) {
      const tag = text.match(/^\[([\w.:-]{1,40})\]\s*/);
      if (tag) { category = `server.${tag[1]}`; text = text.slice(tag[0].length); }
    }
    if (text) parts.push(text);
  });
  const message = [...new Set(parts.filter(Boolean))].join('：').slice(0, 1000) || '服务端错误';
  if (error) Object.assign(details, errorFields(error), { stack: String(error.stack || '').slice(0, 4000) });
  return { level: 'error', category, message, ...pick, details: boundedDetails(details), location: error ? stackLocation(error.stack) : '' };
}

/** 直接上报一个错误：终端打印简短一行，库里保留完整堆栈。 */
export function reportServerError(error, { category = 'server', level = 'error', requestId = null, userId = null, modelId = null, generationId = null, details = null, log = true } = {}) {
  const message = String(error?.message || error || '服务端错误').slice(0, 1000);
  if (log) (originalConsoleError || console.error)(`[${category}]`, { requestId, generationId, code: error?.code, message });
  return record({
    level, category, message, requestId, userId, modelId, generationId,
    details: boundedDetails({ ...(details || {}), ...errorFields(error), stack: String(error?.stack || '').slice(0, 4000) }),
    location: stackLocation(error?.stack),
  });
}

let originalConsoleError = null;
/** 接管 console.error 并监听进程级未捕获异常；返回撤销函数（测试用）。 */
export function installServerErrorCapture({ consoleImpl = console, processImpl = process } = {}) {
  const original = consoleImpl.error.bind(consoleImpl);
  originalConsoleError = original;
  consoleImpl.error = (...args) => {
    original(...args);
    if (capturing) return;
    try { record(consoleErrorEntry(args)); } catch {}
  };
  // monitor 只旁路观察，不改变 Node 默认的崩溃行为，systemd 照常拉起服务。
  const onFatal = (error, origin) => {
    record({
      level: 'critical',
      category: origin === 'unhandledRejection' ? 'server.unhandled_rejection' : 'server.uncaught_exception',
      message: String(error?.message || error || '进程异常退出').slice(0, 1000),
      details: boundedDetails({ ...errorFields(error), stack: String(error?.stack || '').slice(0, 4000) }),
      location: stackLocation(error?.stack),
    });
  };
  processImpl.on('uncaughtExceptionMonitor', onFatal);
  return () => {
    consoleImpl.error = original;
    originalConsoleError = null;
    processImpl.off('uncaughtExceptionMonitor', onFatal);
  };
}

/* ---------- 前端上报 ---------- */

const CLIENT_WINDOW_MS = 10 * 60_000;
const CLIENT_REPORTS_PER_WINDOW = 60;
const clientBuckets = new Map();
const IGNORED_CLIENT_MESSAGES = [/^Script error\.?$/i, /ResizeObserver loop/i, /ExperimentalWarning: SQLite/, /^(?:TypeError: )?(?:Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i];
const IGNORED_CLIENT_SOURCES = /^(?:chrome|moz|safari|safari-web)-extension:/i;

function allowClientReports(key, count, at = Date.now()) {
  let bucket = clientBuckets.get(key);
  if (!bucket || at - bucket.start >= CLIENT_WINDOW_MS) {
    if (clientBuckets.size > 10_000) clientBuckets.clear();
    bucket = { start: at, count: 0 };
    clientBuckets.set(key, bucket);
  }
  const allowed = Math.max(0, Math.min(count, CLIENT_REPORTS_PER_WINDOW - bucket.count));
  bucket.count += allowed;
  return allowed;
}
export function resetClientReportLimits() { clientBuckets.clear(); }

const text = (value, max) => String(value ?? '').slice(0, max);

export function clientErrorEntries(input, { source = 'web', userId = null } = {}) {
  const reports = Array.isArray(input?.reports) ? input.reports.slice(0, 10) : [];
  const meta = { appVersion: text(input?.appVersion, 40), platform: text(input?.platform, 40) };
  return reports.flatMap(report => {
    if (!report || typeof report !== 'object') return [];
    const message = text(report.message, 1000).trim();
    const stack = text(report.stack, 4000);
    const file = text(report.source, 300);
    if (!message || IGNORED_CLIENT_MESSAGES.some(pattern => pattern.test(message)) || IGNORED_CLIENT_SOURCES.test(file) || IGNORED_CLIENT_SOURCES.test(stack)) return [];
    const kind = ['error', 'unhandledrejection', 'console', 'main', 'crash', 'boot'].includes(report.kind) ? report.kind : 'error';
    const fileLocation = file ? file.replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+\//, '') : '';
    return [{
      source, level: kind === 'crash' ? 'critical' : 'error', category: `${source}.${kind}`, message, userId,
      location: stackLocation(stack) || fileLocation,
      details: boundedDetails({ ...meta, page: text(report.page, 300), source: file, line: Number(report.line) || undefined, column: Number(report.column) || undefined, stack, userAgent: text(report.userAgent, 300) }),
    }];
  });
}

export async function handleClientErrorReport(req, res, { user = null, desktop = false, ip = '' } = {}) {
  const input = await bodyJson(req, 64_000);
  const source = desktop ? 'desktop' : 'web';
  const entries = clientErrorEntries(input, { source, userId: user?.id || null });
  const allowed = allowClientReports(ip || 'unknown', entries.length);
  for (const entry of entries.slice(0, allowed)) record(entry);
  return sendJson(res, 200, { ok: true });
}
