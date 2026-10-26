const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dialogueHistory", {
  getEntries: (options = {}) => ipcRenderer.invoke("dialogue-history:list", options),
});
