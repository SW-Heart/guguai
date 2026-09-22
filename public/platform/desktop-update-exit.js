export function createDesktopUpdateExit({ getBridge, getInfo }) {
  let pending = false;
  const isLegacyWindows = () => {
    const info = getInfo();
    const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(info?.version || ''));
    return info?.platform === 'win32' && Boolean(version)
      && (Number(version[1]) === 0 && (Number(version[2]) < 7 || (Number(version[2]) === 7 && Number(version[3]) < 3)));
  };
  const unlock = async bridge => {
    if (getInfo()?.platform !== 'win32') return;
    if (await bridge?.window?.setModalState?.(false) !== true) {
      throw new Error('暂时无法重启更新，请稍后重试。');
    }
  };
  return {
    get pending() { return pending; },
    isLegacyWindows,
    async install() {
      if (pending) return;
      pending = true;
      try {
        const bridge = getBridge();
        // Old clients cannot quit while a renderer dialog disables SC_CLOSE.
        // Await the IPC acknowledgement before asking that client to install.
        await unlock(bridge);
        if (!await bridge?.updates?.install?.()) throw new Error('更新安装包尚未准备好，请稍后再试');
      } catch (error) {
        pending = false;
        throw error;
      }
    },
  };
}
