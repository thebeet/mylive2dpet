const path = require("path");

function createMemoryViewer(context, { getSnapshot, isAvailable, correctProfile, deleteQuestion, deleteAnswer }) {
  let win = null;
  let viewTab = "recent";
  function close() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  function requireSender(event) {
    if (!isAvailable() || !win || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error("记忆窗口已关闭或请求来源无效");
    }
  }
  const unregisterIpc = context.ipc?.handle("snapshot", (event) => {
    requireSender(event);
    return { ...getSnapshot(), viewTab };
  }) || (() => {});
  const unregisterCorrection = correctProfile ? context.ipc?.handle("correct-profile", (event, input) => {
    requireSender(event);
    if (!input || typeof input.id !== "string" || typeof input.text !== "string") throw new Error("画像修正内容无效");
    return correctProfile(input.id, input.text);
  }) || (() => {}) : () => {};
  const unregisterDeleteQuestion = deleteQuestion ? context.ipc?.handle("delete-question", (event, id) => {
    requireSender(event);
    if (typeof id !== "string" || !id) throw new Error("问题 ID 无效");
    return deleteQuestion(id);
  }) || (() => {}) : () => {};
  const unregisterDeleteAnswer = deleteAnswer ? context.ipc?.handle("delete-answer", (event, input) => {
    requireSender(event);
    if (!input || typeof input.questionId !== "string" || typeof input.answerId !== "string" || !input.questionId || !input.answerId) throw new Error("答案 ID 无效");
    return deleteAnswer(input.questionId, input.answerId);
  }) || (() => {}) : () => {};

  function show(tab) {
    if (!isAvailable()) return;
    const explicitTab = typeof tab === "string" && ["recent", "long", "work", "question-history"].includes(tab);
    if (explicitTab) viewTab = tab;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (explicitTab) win.webContents.send?.("memory:select-tab", viewTab);
      return;
    }
    if (!explicitTab) viewTab = "recent";
    const created = context.windows.create({
      width: 680, height: 760, minWidth: 440, minHeight: 480,
      title: "当前记忆", show: false, autoHideMenuBar: true, backgroundColor: "#10131a",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    win = created;
    created.once("ready-to-show", () => {
      if (isAvailable() && win === created && !created.isDestroyed()) created.show();
    });
    created.once("closed", () => { if (win === created) win = null; });
    void created.loadFile(path.join(__dirname, "window.html")).catch((error) => {
      context.logger.error("memory window failed:", error);
      if (!created.isDestroyed()) created.destroy();
    });
  }

  return { show, close, dispose() { close(); unregisterIpc(); unregisterCorrection(); unregisterDeleteQuestion(); unregisterDeleteAnswer(); } };
}

module.exports = { createMemoryViewer };
