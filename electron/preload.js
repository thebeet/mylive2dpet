const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("petDesktop", {
  isElectron: true,
  moveWindow: (dx, dy) => {
    ipcRenderer.send("pet:move-window", dx, dy);
  },
  forcePaint: () => {
    ipcRenderer.send("pet:force-paint");
  },
  captureScreenshot: () => ipcRenderer.invoke("pet:capture-screenshot"),
  chatNow: () => ipcRenderer.invoke("pet:chat-now"),
  openContextMenu: (pos) => {
    ipcRenderer.send("pet:context-menu", pos || {});
  },
  onBubble: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("pet:bubble", handler);
    return () => ipcRenderer.removeListener("pet:bubble", handler);
  },
  onGlobalPointerMove: (callback) => {
    const handler = (_event, position) => callback(position);
    ipcRenderer.on("pet:global-pointer", handler);
    ipcRenderer.send("pet:request-global-pointer");
    return () => ipcRenderer.removeListener("pet:global-pointer", handler);
  },
});
