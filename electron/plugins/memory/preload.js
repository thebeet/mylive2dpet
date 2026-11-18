const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petMemory", {
  getSnapshot: (input) => ipcRenderer.invoke("memory:snapshot", input),
  readMemory: (id) => ipcRenderer.invoke("memory:read-memory", id),
  correctMemory: (id, text, pinned) => ipcRenderer.invoke("memory:correct-memory", { id, text, pinned }),
  forgetMemory: (id) => ipcRenderer.invoke("memory:forget-memory", id),
  correctProfile: (id, text) => ipcRenderer.invoke("memory:correct-profile", { id, text }),
  deleteQuestion: (id) => ipcRenderer.invoke("memory:delete-question", id),
  deleteAnswer: (questionId, answerId) => ipcRenderer.invoke("memory:delete-answer", { questionId, answerId }),
  onSelectTab: (callback) => {
    const handler = (_event, tab) => callback(tab);
    ipcRenderer.on("memory:select-tab", handler);
    return () => ipcRenderer.removeListener("memory:select-tab", handler);
  },
});
