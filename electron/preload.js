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
  getAvatarConfig: () => ipcRenderer.invoke("pet:avatar-config"),
  avatarReady: revision => ipcRenderer.send("pet:avatar-ready", revision),
  onAvatarChanged: callback => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("pet:avatar-changed", handler);
    return () => ipcRenderer.removeListener("pet:avatar-changed", handler);
  },
  onAvatarCommand: callback => {
    const handler = (_event, command) => callback(command);
    ipcRenderer.on("pet:avatar-command", handler);
    return () => ipcRenderer.removeListener("pet:avatar-command", handler);
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
