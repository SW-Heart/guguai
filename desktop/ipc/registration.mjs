function frameUrl(event) {
  return String(event?.senderFrame?.url || event?.sender?.getURL?.() || '');
}

function trustedFrame(event, { mainWindow, paymentWindow, trustedOrigin, allowPaymentWindow = false }) {
  const sender = event?.sender;
  const isMainWindow = Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents);
  const isPaymentWindow = Boolean(allowPaymentWindow && paymentWindow && !paymentWindow.isDestroyed() && sender === paymentWindow.webContents);
  if (!isMainWindow && !isPaymentWindow) return false;
  if (event?.senderFrame && sender?.mainFrame && event.senderFrame !== sender.mainFrame) return false;
  if (isPaymentWindow) return true;
  const source = frameUrl(event);
  if (source.startsWith('file:')) return true;
  try { return Boolean(trustedOrigin) && new URL(source).origin === trustedOrigin; } catch { return false; }
}

export function ipcRecord(value, label = '参数') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效`);
  return value;
}

export function ipcId(value, label = '资源标识') {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error(`${label}无效`);
  return id;
}

export function ipcIdList(value, label = '资源标识列表') {
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${label}无效`);
  return value.map(item => ipcId(item, label));
}

export function ipcText(value, maxLength, label = '参数') {
  const text = String(value || '');
  if (text.length > maxLength) throw new Error(`${label}过长`);
  return text;
}

export function createIpcRegistrar({ ipcMain, getMainWindow, getPaymentWindow, getTrustedOrigin }) {
  return (channel, handler, { allowPaymentWindow = false, validateArgs = null } = {}) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedFrame(event, {
        mainWindow: getMainWindow(),
        paymentWindow: getPaymentWindow(),
        trustedOrigin: getTrustedOrigin(),
        allowPaymentWindow,
      })) throw new Error('无效的 IPC 来源');
      const validated = validateArgs ? validateArgs(args) : args;
      return handler(event, ...validated);
    });
  };
}
