'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const on = (ch, cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };
contextBridge.exposeInMainWorld('ndnl', {
  info: () => ipcRenderer.invoke('app:info'),
  listDisks: () => ipcRenderer.invoke('disks:list'),
  relaunchAdmin: () => ipcRenderer.invoke('app:relaunch-admin'),
  readSmart: n => ipcRenderer.invoke('smart:read', n),
  startExam: opts => ipcRenderer.invoke('exam:start', opts),
  cancelExam: () => ipcRenderer.invoke('exam:cancel'),
  saveReport: diskNumber => ipcRenderer.invoke('report:save', { diskNumber }),
  repair: opts => ipcRenderer.invoke('repair:start', opts),
  cancelRepair: () => ipcRenderer.invoke('repair:cancel'),
  onExamProgress: cb => on('exam:progress', cb),
  onRepairProgress: cb => on('repair:progress', cb),
});
