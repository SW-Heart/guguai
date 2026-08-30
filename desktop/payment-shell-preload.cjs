const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('guguPaymentShell', Object.freeze({
  close: () => ipcRenderer.invoke('payments:close-alipay'),
  onLoadError: callback => {
    const listener = (_event, message) => callback(String(message || '支付宝收银台加载失败'));
    ipcRenderer.on('payment:load-error', listener);
    return () => ipcRenderer.removeListener('payment:load-error', listener);
  },
}));
