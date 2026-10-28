const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petMemory", {
  getSnapshot: () => ipcRenderer.invoke("memory:snapshot"),
  correctProfile: (id, text) => ipcRenderer.invoke("memory:correct-profile", { id, text }),
  onSelectTab: (callback) => {
    const handler = (_event, tab) => callback(tab);
    ipcRenderer.on("memory:select-tab", handler);
    return () => ipcRenderer.removeListener("memory:select-tab", handler);
  },
});
