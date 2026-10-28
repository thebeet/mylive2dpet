const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petMemory", {
  getSnapshot: () => ipcRenderer.invoke("memory:snapshot"),
  correctProfile: (id, text) => ipcRenderer.invoke("memory:correct-profile", { id, text }),
});
