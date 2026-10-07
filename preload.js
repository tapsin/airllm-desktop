const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('airllm', {
  start: (model, token) => ipcRenderer.invoke('start-model', { model, token }),
  stop: () => ipcRenderer.invoke('stop-model'),
  settings: () => ipcRenderer.invoke('get-settings'),
  save: data => ipcRenderer.invoke('save-settings', data),
  onStatus: callback => ipcRenderer.on('status', (_event, data) => callback(data)),
});
