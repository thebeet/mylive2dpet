const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liveAudio", {
  onContent(callback) {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("audio-output-perception:live-content", handler);
    return () => ipcRenderer.removeListener("audio-output-perception:live-content", handler);
  },
  close: () => ipcRenderer.invoke("audio-output-perception:hide-live-content"),
});
