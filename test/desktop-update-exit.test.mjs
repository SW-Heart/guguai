import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopUpdateExit } from '../public/platform/desktop-update-exit.js';

function setup({ platform = 'win32', version = '0.7.2', unlock = async () => true, install = async () => true } = {}) {
  const calls = [];
  const controller = createDesktopUpdateExit({
    getInfo: () => ({ platform, version }),
    getBridge: () => ({
      window: { setModalState: async active => { calls.push(['modal', active]); return unlock(); } },
      updates: { install: async () => { calls.push(['install']); return install(); } },
    }),
    closeWindow: () => calls.push(['close']),
  });
  return { controller, calls };
}

test('old Windows install waits for native unlock and suppresses modal relocking while waiting', async () => {
  let acknowledge;
  const { controller, calls } = setup({ unlock: () => new Promise(resolve => { acknowledge = resolve; }) });
  const installing = controller.install();
  assert.equal(controller.pending, true);
  assert.deepEqual(calls, [['modal', false]]);
  await controller.install();
  assert.equal(calls.length, 1);
  acknowledge(true);
  await installing;
  assert.deepEqual(calls, [['modal', false], ['install']]);
});

test('failed native unlock does not start installer and permits retry', async () => {
  const { controller, calls } = setup({ unlock: async () => false });
  await assert.rejects(controller.install(), /暂时无法重启/);
  assert.equal(controller.pending, false);
  assert.deepEqual(calls, [['modal', false]]);
});

test('installer failure releases pending state so a subsequent click can retry', async () => {
  const { controller } = setup({ install: async () => false });
  await assert.rejects(controller.install(), /尚未准备好/);
  assert.equal(controller.pending, false);
});

test('reloaded old Windows page resumes an already requested exit without starting another helper', async () => {
  const { controller, calls } = setup();
  assert.equal(await controller.resume('downloaded'), false);
  assert.equal(await controller.resume('installing'), true);
  assert.deepEqual(calls, [['modal', false], ['close']]);
  assert.equal(await controller.resume('installing'), false);
});

test('recovery cannot close a window when native unlock fails', async () => {
  const { controller, calls } = setup({ unlock: async () => false });
  await assert.rejects(controller.resume('installing'));
  assert.equal(controller.pending, false);
  assert.deepEqual(calls, [['modal', false]]);
});

test('fixed Windows and macOS clients do not use legacy window-close recovery', async () => {
  for (const info of [{ version: '0.7.3' }, { version: '0.8.0' }, { version: '1.0.0' }, { platform: 'darwin' }]) {
    const { controller, calls } = setup(info);
    assert.equal(await controller.resume('installing'), false);
    assert.deepEqual(calls, []);
  }
  const { controller, calls } = setup({ platform: 'darwin' });
  await controller.install();
  assert.deepEqual(calls, [['install']]);
});
