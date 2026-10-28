const status = document.getElementById("status");
const entries = document.getElementById("entries");
const labels = { disabled: "语音监听未开启", starting: "正在连接监听设备…",
  listening: "正在监听 · 转写完成后显示内容", suppressed: "桌宠语音播放期间暂停监听", error: "监听异常" };

const unsubscribe = window.liveAudio.onContent(({ state, entries: transcripts }) => {
  status.dataset.status = state.status;
  status.textContent = state.error || labels[state.status] || state.status;
  entries.replaceChildren();
  if (!transcripts.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.status === "disabled" ? "请先在菜单中开启语音监听。" : "等待识别到语音…";
    entries.appendChild(empty);
  }
  for (const transcript of transcripts) {
    const card = document.createElement("article");
    const time = document.createElement("time");
    time.textContent = new Date(transcript.capturedAt).toLocaleTimeString("zh-CN");
    const text = document.createElement("p");
    text.className = "text";
    text.textContent = transcript.text;
    card.append(time, text);
    entries.appendChild(card);
  }
  entries.scrollTop = entries.scrollHeight;
});

document.getElementById("close").addEventListener("click", () => {
  void window.liveAudio.close().catch((error) => { status.textContent = error.message || String(error); });
});
window.addEventListener("beforeunload", unsubscribe, { once: true });
