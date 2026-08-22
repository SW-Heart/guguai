import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
const node = process.execPath;
const children = [];
const defaultApiBase = 'http://127.0.0.1:4317';
const apiBaseArgument = process.argv.find(argument => argument.startsWith('--api-base='));
const apiBase = apiBaseArgument ? apiBaseArgument.slice('--api-base='.length).replace(/\/$/, '') : defaultApiBase;

function start(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...options.env } });
  children.push(child);
  return child;
}

async function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`等待服务启动超时：${url}`);
}

let server = null;
let ownsServer = false;

try {
  try {
    const response = await fetch(`${apiBase}/healthz`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) throw new Error(`服务返回 ${response.status}`);
  } catch {
    if (apiBase !== defaultApiBase) throw new Error(`无法连接指定服务：${apiBase}`);
    server = start(node, ['--env-file=.env', 'server.mjs'], { env: { NODE_ENV: 'development' } });
    ownsServer = true;
    server.once('exit', code => { if (code && !process.exitCode) process.exitCode = code; });
  }
  await waitForServer(`${apiBase}/healthz`);
  const client = start(electronBinary, [path.join(root, 'desktop', 'main.mjs'), `--api-base=${apiBase}`]);
  client.once('exit', code => { process.exitCode = code || 0; cleanup(); });
} catch (error) {
  console.error(`[desktop-dev] ${error.message}`);
  process.exitCode = 1;
  cleanup();
}

function cleanup() {
  for (const child of children) {
    if (child === server && !ownsServer) continue;
    if (!child.killed) child.kill('SIGTERM');
  }
}

process.once('SIGINT', () => { cleanup(); process.exit(130); });
process.once('SIGTERM', () => { cleanup(); process.exit(143); });
