import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('importing server helpers without NODE_ENV=test does not start an HTTP listener', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'server-import-'));
  let child;
  t.after(() => {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  });

  const env = { ...process.env, DATA_DIR:dataDir, PORT:'4317' };
  delete env.NODE_ENV;
  child = spawn(process.execPath, ['--input-type=module', '--eval', "await import('./server.mjs')"], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server.mjs 被 import 后未及时退出，可能误启动了 HTTP 监听')), 3000);
    timer.unref();
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /\[db\] file=:memory:/);
  assert.doesNotMatch(stdout, /GuGu AI:/);
});
