// Async network/stream callbacks can outlive their window. Sending progress
// must never throw back into Electron's event handler or a stream transform.
export function sendToWindow(window, channel, payload) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
  try {
    window.webContents.send(channel, payload);
    return true;
  } catch (error) {
    console.warn(`[desktop] 窗口消息发送失败：${channel}`, error);
    return false;
  }
}

export function runDesktopAction(label, action) {
  const failed = error => {
    console.warn(`[desktop] ${label}失败`, error);
    return false;
  };
  try { return Promise.resolve(action()).catch(failed); }
  catch (error) { return Promise.resolve(failed(error)); }
}
