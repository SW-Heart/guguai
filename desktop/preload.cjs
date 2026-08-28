const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('guguDesktop', Object.freeze({
  isDesktop: true,
  getInfo: () => invoke('desktop:get-info'),
  setApiBase: value => invoke('desktop:set-api-base', value),
  setUpdateUrl: value => invoke('desktop:set-update-url', value),
  retry: () => invoke('desktop:retry'),
  window: Object.freeze({
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    isMaximized: () => invoke('window:is-maximized'),
    isFullScreen: () => invoke('window:is-fullscreen'),
    setModalState: active => invoke('window:set-modal-state', Boolean(active)),
    close: () => invoke('window:close'),
    onState: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('desktop:window-state', listener);
      return () => ipcRenderer.removeListener('desktop:window-state', listener);
    },
  }),
  updates: Object.freeze({
    check: () => invoke('updates:check'),
    getStatus: () => invoke('updates:get-status'),
    install: () => invoke('updates:install'),
    onStatus: callback => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('desktop:update-status', listener);
      return () => ipcRenderer.removeListener('desktop:update-status', listener);
    },
  }),
  workspace: Object.freeze({
    get: () => invoke('workspace:get'),
    choose: () => invoke('workspace:choose'),
    open: () => invoke('workspace:open'),
  }),
  media: Object.freeze({
    chooseAndImport: () => invoke('media:choose-and-import'),
    listLocal: () => invoke('media:list-local'),
    downloadRemote: payload => invoke('media:download-remote', payload),
    syncLocal: payload => invoke('media:sync-local', payload),
    renameLocal: payload => invoke('media:rename-local', payload),
    removeLocal: assetId => invoke('media:remove-local', assetId),
    saveLocalAs: payload => invoke('media:save-local-as', payload),
    url: assetId => invoke('media:url', assetId),
    showInFolder: assetId => invoke('media:show-in-folder', assetId),
  }),
}));
