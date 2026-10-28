const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("petQuestions", {
  current: () => ipcRenderer.invoke("questions:current"),
  answer: (input) => ipcRenderer.invoke("questions:answer", input),
});
