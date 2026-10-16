const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("regionSelect", {
  onInit: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("region:init", handler);
    return () => ipcRenderer.removeListener("region:init", handler);
  },
  onIdle: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("region:idle", handler);
    return () => ipcRenderer.removeListener("region:idle", handler);
  },
  complete: (region) => {
    ipcRenderer.send("region:complete", region);
  },
  cancel: () => {
    ipcRenderer.send("region:cancel");
  },
});
