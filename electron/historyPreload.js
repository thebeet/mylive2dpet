const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dialogueHistory", {
  getEntries: () => ipcRenderer.invoke("pet:get-dialogue-history"),
});
