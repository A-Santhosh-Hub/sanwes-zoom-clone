const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('viewer', { last: () => ipcRenderer.invoke('viewer:last'), open: (link) => ipcRenderer.invoke('viewer:open', link) });
