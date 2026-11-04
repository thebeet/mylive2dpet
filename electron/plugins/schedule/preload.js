const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("schedule", {
  create: (task) => ipcRenderer.invoke("schedule:create", task),
  list: () => ipcRenderer.invoke("schedule:list"),
  cancel: (id) => ipcRenderer.invoke("schedule:cancel", id),
});
