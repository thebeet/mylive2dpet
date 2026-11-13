const video = document.querySelector("video");
const status = document.querySelector("#status");
const toggle = document.querySelector("#toggle");
const label = document.querySelector("#label");
const canvas = document.createElement("canvas");
let stream = null, state = null, closed = false, version = 0;
let initialized = Promise.resolve();

function stopStream() {
  stream?.getTracks().forEach(track => track.stop());
  stream = null; video.srcObject = null;
}
async function enumerate() {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
    await window.camera.devices(devices.map(device => ({ deviceId: device.deviceId, label: device.label })));
  } catch (error) { status.textContent = `设备枚举失败：${error.message}`; }
}
function applyState(next) {
  if (closed || JSON.stringify(state) === JSON.stringify(next)) return;
  state = next;
  const token = ++version;
  stopStream();
  if (state.mode === "discovery") {
    initialized = enumerate();
    navigator.mediaDevices.addEventListener("devicechange", enumerate);
    return;
  }
  label.textContent = state.options.label || "摄像头画面";
  toggle.hidden = false;
  toggle.textContent = state.enabled ? "关闭感知" : "开启感知";
  toggle.setAttribute("aria-pressed", String(state.enabled));
  status.textContent = state.enabled ? "正在连接摄像头…" : "感知已关闭";
  if (!state.enabled) { initialized = Promise.resolve(); return; }
  initialized = (async () => {
    const options = state.options;
    const current = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      deviceId: { exact: options.deviceId }, width: { ideal: options.width }, height: { ideal: options.height },
    } });
    if (closed || token !== version) { current.getTracks().forEach(track => track.stop()); return; }
    stream = current; video.srcObject = current;
    await video.play();
    if (token === version) status.textContent = "感知已开启，关闭预览不影响后台采集";
  })().catch(error => {
    if (token === version) status.textContent = `无法采集：${error.message}`;
    throw error;
  });
  void initialized.catch(() => {});
}
window.camera.onState(applyState);
window.camera.onCapture(async id => {
  if (closed) return;
  const token = version;
  let frame;
  try {
    await initialized;
    if (closed || !state.enabled || token !== version) throw new Error("摄像头采集已停止");
    if (!video.videoWidth || !video.videoHeight || stream?.getVideoTracks()[0]?.readyState !== "live") throw new Error("摄像头没有可用画面");
    const options = state.options;
    const scale = Math.min(1, options.width / video.videoWidth, options.height / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.8));
    if (!blob) throw new Error("摄像头图片编码失败");
    frame = { id, data: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height,
      device: stream?.getVideoTracks()[0]?.label || "" };
    if (token === version) status.textContent = `感知已开启 · 已采集：${new Date().toLocaleTimeString()}`;
  } catch (error) {
    if (token === version) status.textContent = `无法采集：${error.message}`;
    frame = { id, error: error.message };
  }
  if (!closed) await window.camera.frame(frame).catch(() => {});
});
toggle.addEventListener("click", async () => {
  toggle.disabled = true;
  try { await window.camera.toggle(); }
  catch (error) { status.textContent = error.message; }
  finally { toggle.disabled = false; }
});
void window.camera.options().then(applyState).then(() => window.camera.ready());
window.addEventListener("beforeunload", () => { closed = true; version++; stopStream(); });
