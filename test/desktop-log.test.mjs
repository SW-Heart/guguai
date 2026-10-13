import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { collectDesktopLogBundle, flushDesktopLog, initDesktopLogging } from '../desktop/desktop-log.mjs';

test('uploads only the last 24 hours across archives, preserving complete records and local files', async t => {
  const now = Date.parse('2026-10-13T08:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const dir = mkdtempSync(path.join(tmpdir(), 'gugu-log-test-'));
  t.after(() => { flushDesktopLog(); rmSync(dir, { recursive: true, force: true }); });
  initDesktopLogging({ dir });
  flushDesktopLog();
  const fixtures = {
    'client.log.2': '2026-10-11T08:00:00.000Z [error] [main] too old\n    old stack\n',
    'client.log.1': [
      '    orphaned stack',
      '2026-10-12T07:59:59.999Z [error] [main] outside boundary',
      '    excluded stack',
      '2026-10-12T08:00:00.000Z [error] [main] exact boundary',
      '    boundary stack',
      '2026-10-12T20:00:00.000Z [info] [main] recent archive',
      '',
    ].join('\n'),
    'client.log': [
      '2026-10-13T07:00:00.000Z [error] [renderer] recent error',
      '    Error: example',
      '        at example.js:1:1',
      '2026-10-13T08:00:00.000Z [info] [main] exact now',
      '2026-10-13T08:00:00.001Z [error] [main] future record',
      '    future stack',
      '',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(fixtures)) writeFileSync(path.join(dir, name), text);
  const bundle = await collectDesktopLogBundle({ diagnostics: { version: 'test' } });
  const text = gunzipSync(bundle.bytes).toString('utf8');
  assert.deepEqual(bundle.sections.map(section => section.name), ['client.log.1', 'client.log']);
  assert.match(text, /exact boundary\n    boundary stack/);
  assert.match(text, /recent error\n    Error: example\n        at example.js:1:1/);
  assert.match(text, /exact now/);
  assert.match(text, /"version": "test"/);
  assert.match(text, /最近 24 小时/);
  assert.doesNotMatch(text, /too old|old stack|outside boundary|excluded stack|orphaned stack|future record|future stack/);
  assert.ok(text.indexOf('recent archive') < text.indexOf('recent error'));
  for (const [name, original] of Object.entries(fixtures)) {
    assert.equal(readFileSync(path.join(dir, name), 'utf8'), original);
  }

  // 没有近期记录时仍可上传诊断信息，不回退到旧日志。
  writeFileSync(path.join(dir, 'client.log.1'), fixtures['client.log.2']);
  writeFileSync(path.join(dir, 'client.log'), fixtures['client.log.2']);
  const empty = await collectDesktopLogBundle({ diagnostics: { version: 'test' } });
  assert.deepEqual(empty.sections, []);
  const emptyText = gunzipSync(empty.bytes).toString('utf8');
  assert.match(emptyText, /最近 24 小时暂无日志记录/);
  assert.match(emptyText, /"version": "test"/);
  assert.doesNotMatch(emptyText, /too old|old stack/);
});
