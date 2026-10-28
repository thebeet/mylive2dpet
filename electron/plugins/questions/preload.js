const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("petQuestions", {
  current: () => ipcRenderer.invoke("questions:current"),
  activity: () => ipcRenderer.invoke("questions:activity"),
  answer: (input) => ipcRenderer.invoke("questions:answer", input),
});
