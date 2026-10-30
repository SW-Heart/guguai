// 主进程错误上报：把 console.error、未捕获异常和渲染进程崩溃发到服务端 /api/errors，
// 和网页端错误一起汇总到后台异常中心。
//
// 只做旁路记录：连不上服务时先排队，下次再发；超出上限直接丢弃，不影响客户端本身。
import { format } from 'node:util';

const MAX_REPORTS_PER_SESSION = 30;
const MAX_QUEUE = 30;
const FLUSH_DELAY_MS = 5_000;
// Node 每次启动都会提示 node:sqlite 仍属实验特性，与用户问题无关。
const IGNORED_MESSAGES = [/ExperimentalWarning: SQLite/, /net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT)|ABORTED)/i, /fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i];

export function mainErrorReport(args, kind = 'main') {
  const error = args.find(arg => arg instanceof Error) || args.find(arg => arg?.error instanceof Error)?.error || null;
  const message = format(...args).split('\n')[0].trim().slice(0, 1000);
  return { kind, message, stack: String(error?.stack || '').slice(0, 4000) };
}

export function createMainErrorReporter({ send, meta = () => ({}), flushDelayMs = FLUSH_DELAY_MS, maxReports = MAX_REPORTS_PER_SESSION } = {}) {
  const seen = new Set();
  let queue = [];
  let accepted = 0;
  let timer = null;
  let sending = false;

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (sending || !queue.length || typeof send !== 'function') return;
    sending = true;
    const reports = queue.slice(0, 10);
    const info = meta() || {};
    let delivered = false;
    try { delivered = Boolean(await send({ reports, appVersion: info.appVersion || '', platform: info.platform || '' })); }
    catch { delivered = false; }
    sending = false;
    if (delivered) queue = queue.slice(reports.length);
    if (queue.length) schedule(delivered ? flushDelayMs : flushDelayMs * 6);
  }

  function schedule(delay = flushDelayMs) {
    if (timer) return;
    timer = setTimeout(() => { void flush(); }, delay);
    timer.unref?.();
  }

  function report({ kind = 'main', message, stack = '' }) {
    const text = String(message || '').trim().slice(0, 1000);
    if (!text || IGNORED_MESSAGES.some(pattern => pattern.test(text))) return false;
    const key = `${kind}|${text}|${String(stack).split('\n').slice(0, 3).join('|')}`;
    if (seen.has(key) || accepted >= maxReports) return false;
    seen.add(key);
    accepted += 1;
    queue.push({ kind, message: text, stack: String(stack || '').slice(0, 4000), page: 'main' });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    schedule(kind === 'crash' ? 0 : flushDelayMs);
    return true;
  }

  /** 接管 console.error 并旁观未捕获异常；不改变 Electron 默认的崩溃行为。 */
  function install({ consoleImpl = console, processImpl = process } = {}) {
    const original = consoleImpl.error;
    let reporting = false;
    consoleImpl.error = (...args) => {
      original.apply(consoleImpl, args);
      if (reporting) return;
      reporting = true;
      try { report(mainErrorReport(args)); } catch {} finally { reporting = false; }
    };
    const onFatal = error => { try { report(mainErrorReport([error], 'crash')); void flush(); } catch {} };
    const onRejection = reason => { try { report(mainErrorReport([reason], 'unhandledrejection')); } catch {} };
    processImpl.on('uncaughtExceptionMonitor', onFatal);
    processImpl.on('unhandledRejection', onRejection);
    return () => {
      consoleImpl.error = original;
      processImpl.off('uncaughtExceptionMonitor', onFatal);
      processImpl.off('unhandledRejection', onRejection);
    };
  }

  return Object.freeze({ install, report, flush, pending: () => queue.length });
}
