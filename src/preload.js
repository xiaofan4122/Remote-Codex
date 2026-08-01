const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('codexShell', {
  start: (cwd) => ipcRenderer.invoke('session:start', cwd),
  chooseDirectory: () => ipcRenderer.invoke('session:choose-directory'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  setUiLanguage: (language) => ipcRenderer.invoke('ui:set-language', language),
  completeOnboarding: (reason) => ipcRenderer.invoke('ui:onboarding-complete', reason),
  startFeishuConnect: (config) => ipcRenderer.invoke('feishu:connect-start', config),
  resetFeishuConnection: () => ipcRenderer.invoke('feishu:connection-reset'),
  cancelFeishuConnect: () => ipcRenderer.invoke('feishu:connect-cancel'),
  getFeishuConnectStatus: () => ipcRenderer.invoke('feishu:connect-status'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getUpdateStatus: () => ipcRenderer.invoke('updates:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  write: (data) => ipcRenderer.send('terminal:input', data),
  resize: (size) => ipcRenderer.send('terminal:resize', size),
  snapshot: (text) => ipcRenderer.send('terminal:snapshot', text),
  onData: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onCwd: (callback) => {
    const listener = (_event, cwd) => callback(cwd);
    ipcRenderer.on('session:cwd', listener);
    return () => ipcRenderer.removeListener('session:cwd', listener);
  },
  onConfigUpdated: (callback) => {
    const listener = (_event, config) => callback(config);
    ipcRenderer.on('config:updated', listener);
    return () => ipcRenderer.removeListener('config:updated', listener);
  },
  onFeishuConnectStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('feishu:connect-status', listener);
    return () => ipcRenderer.removeListener('feishu:connect-status', listener);
  },
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  }
});
