const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("manualChat", {
  submit: (text) => ipcRenderer.invoke("manual-input:submit", text),
  close: () => ipcRenderer.invoke("manual-input:close"),
});
