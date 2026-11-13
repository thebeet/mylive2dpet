const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("camera", {
  options: () => ipcRenderer.invoke("camera-perception:options"),
  ready: () => ipcRenderer.invoke("camera-perception:ready"),
  frame: frame => ipcRenderer.invoke("camera-perception:frame", frame),
  devices: devices => ipcRenderer.invoke("camera-perception:devices", devices),
  toggle: () => ipcRenderer.invoke("camera-perception:toggle"),
  onState(callback) { ipcRenderer.on("camera-perception:state", (_event, state) => callback(state)); },
  onCapture(callback) { ipcRenderer.on("camera-perception:capture", (_event, id) => callback(id)); },
});
