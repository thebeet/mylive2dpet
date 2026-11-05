const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rawLog", {
  listTabs: () => ipcRenderer.invoke("raw-log:listTabs"),
  listWebSearch: (options = {}) => ipcRenderer.invoke("raw-log:listWebSearch", options),
  getWebSearch: (id) => ipcRenderer.invoke("raw-log:getWebSearch", id),
  listRss: (options = {}) => ipcRenderer.invoke("raw-log:listRss", options),
  getRss: (id) => ipcRenderer.invoke("raw-log:getRss", id),
  list: (options = {}) => ipcRenderer.invoke("raw-log:list", options),
  get: (id) => ipcRenderer.invoke("raw-log:get", id),
  listGroups: (options = {}) => ipcRenderer.invoke("raw-log:listGroups", options),
  getGroup: (id) => ipcRenderer.invoke("raw-log:getGroup", id),
  listScreenshots: (options = {}) => ipcRenderer.invoke("raw-log:listScreenshots", options),
  getScreenshot: (id) => ipcRenderer.invoke("raw-log:getScreenshot", id),
  clear: () => ipcRenderer.invoke("raw-log:clear"),
});
