// The only things the control panel and the share picker may ask the main process to do.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('studio', {
  state: () => ipcRenderer.invoke('state'),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onMeetingClosed: (cb) => ipcRenderer.on('meeting-closed', () => cb()),
  copy: (text) => ipcRenderer.invoke('copy', text),
  openMeeting: () => ipcRenderer.invoke('open-meeting'),
  tunnel: (on) => ipcRenderer.invoke('tunnel', on),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  meetingInfo: () => ipcRenderer.invoke('meeting-info'),
  meetingSize: (large) => ipcRenderer.invoke('meeting-size', large),
  meetingMinimized: () => ipcRenderer.invoke('meeting-minimized'),
  onAutoRecord: (cb) => ipcRenderer.on('auto-record', (_e, m) => cb(m)),
  autoStatus: (body) => ipcRenderer.invoke('auto:status', body),
  rec: {
    begin: (kinds) => ipcRenderer.invoke('rec:begin', { kinds }),
    write: (id, bytes) => ipcRenderer.invoke('rec:write', id, bytes),
    end: (id) => ipcRenderer.invoke('rec:end', id),
    flag: (v) => ipcRenderer.invoke('rec:flag', v),
    folder: (dir) => ipcRenderer.invoke('rec:folder', dir),
  },
  picker: { items: () => ipcRenderer.invoke('picker:items'), choose: (c) => ipcRenderer.send('picker:choose', c) },
});
