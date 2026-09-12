import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupUpdateGate } from '../desktop/startup-update.mjs';

function setup() {
  let timeout;
  let cancelled = false;
  const gate = createStartupUpdateGate({ schedule: fn => { timeout = fn; return 1; }, cancel: () => { cancelled = true; } });
  return { gate, expire: () => { if (!cancelled) timeout(); } };
}

for (const status of ['current', 'unconfigured', 'error']) {
  test(`startup proceeds when check returns ${status}`, async () => {
    const { gate } = setup();
    gate.onStatus(status);
    await gate.ready;
    assert.equal(gate.finished, true);
  });
}
test('slow check releases startup and late results cannot hold it again', async () => {
  const { gate, expire } = setup();
  expire();
  await gate.ready;
  gate.onStatus('available');
  assert.equal(gate.finished, true);
});
test('an offered update waits through download and errors until user continues', async () => {
  const { gate, expire } = setup();
  for (const status of ['available', 'downloading', 'error', 'downloaded']) {
    gate.onStatus(status);
    expire();
    assert.equal(gate.finished, false);
  }
  gate.finish();
  await gate.ready;
  assert.equal(gate.finished, true);
});

test('startup update check has a short default deadline', () => {
  let deadline;
  const gate = createStartupUpdateGate({ schedule: (fn, ms) => { deadline = ms; return 1; }, cancel: () => {} });
  assert.equal(deadline, 1500);
  gate.finish();
});
