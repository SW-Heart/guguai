import test from 'node:test';
import assert from 'node:assert/strict';

import { createIpcRegistrar, ipcId, ipcIdList, ipcRecord, ipcText } from '../desktop/ipc/registration.mjs';

function windowFor(url) {
  const webContents = {
    mainFrame: {},
    getURL: () => url,
  };
  return { webContents, isDestroyed: () => false };
}

test('IPC registrar accepts only the trusted main frame', async () => {
  const handlers = new Map();
  const mainWindow = windowFor('https://studio.example.test/');
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const register = createIpcRegistrar({
    ipcMain,
    getMainWindow: () => mainWindow,
    getPaymentWindow: () => null,
    getTrustedOrigin: () => 'https://studio.example.test',
  });
  register('test', (_event, value) => value, { validateArgs: ([value]) => [ipcText(value, 10)] });

  const handler = handlers.get('test');
  const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
  assert.equal(await handler(event, 'ok'), 'ok');
  await assert.rejects(handler({ sender: mainWindow.webContents, senderFrame: {} }, 'ok'), /无效的 IPC 来源/);
  await assert.rejects(handler({ sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame, }, 'too long value'), /参数过长/);
  await assert.rejects(handler({ sender: { getURL: () => 'https://studio.example.test/' } }, 'ok'), /无效的 IPC 来源/);
});

test('IPC registrar keeps payment-shell access separate from the main window', async () => {
  const handlers = new Map();
  const mainWindow = windowFor('file:///app/startup.html');
  const paymentWindow = windowFor('data:text/html,payment');
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const register = createIpcRegistrar({
    ipcMain,
    getMainWindow: () => mainWindow,
    getPaymentWindow: () => paymentWindow,
    getTrustedOrigin: () => 'https://studio.example.test',
  });
  register('payment-close', event => event.sender === paymentWindow.webContents, { allowPaymentWindow: true });
  const handler = handlers.get('payment-close');
  assert.equal(await handler({ sender: paymentWindow.webContents, senderFrame: paymentWindow.webContents.mainFrame }), true);
  await assert.rejects(handler({ sender: { getURL: () => 'data:text/html,payment' }, senderFrame: {} }), /无效的 IPC 来源/);
});

test('IPC argument helpers reject paths and oversized collections', () => {
  assert.equal(ipcId('asset_123'), 'asset_123');
  assert.deepEqual(ipcIdList(['asset_1', 'asset_2']), ['asset_1', 'asset_2']);
  assert.deepEqual(ipcRecord({ ok: true }), { ok: true });
  assert.equal(ipcText('value', 10), 'value');
  assert.throws(() => ipcId('../outside'), /无效/);
  assert.throws(() => ipcIdList(new Array(501).fill('asset')), /无效/);
  assert.throws(() => ipcRecord([]), /格式无效/);
  assert.throws(() => ipcText('1234', 3), /过长/);
});
