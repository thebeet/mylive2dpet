const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rawLog", {
  list: (options = {}) => ipcRenderer.invoke("raw-log:list", options),
  get: (id) => ipcRenderer.invoke("raw-log:get", id),
});
