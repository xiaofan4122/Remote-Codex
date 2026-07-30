const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexShell', {
  start: (cwd) => ipcRenderer.invoke('session:start', cwd),
  chooseDirectory: () => ipcRenderer.invoke('session:choose-directory'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  startFeishuConnect: (config) => ipcRenderer.invoke('feishu:connect-start', config),
  cancelFeishuConnect: () => ipcRenderer.invoke('feishu:connect-cancel'),
  getFeishuConnectStatus: () => ipcRenderer.invoke('feishu:connect-status'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
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
  }
});
