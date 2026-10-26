const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

/** Only sink monitors are accepted; never fall back to the default microphone. */
async function resolveMonitorSource(source = "default", { run = execFileAsync } = {}) {
  const { stdout } = await run("pactl", ["--format=json", "list", "sources"], {
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  const sources = JSON.parse(stdout);
  const monitors = sources.filter((item) =>
    item.properties?.["device.class"] === "monitor" ||
    (typeof item.monitor_source === "string" && item.monitor_source !== "n/a" && item.monitor_source !== "") ||
    (item.monitor_of_sink != null && item.monitor_of_sink !== "" &&
      item.monitor_of_sink !== "n/a" && Number(item.monitor_of_sink) !== 4294967295 &&
      Number(item.monitor_of_sink) !== -1),
  );
  let name = source;
  if (source === "default") {
    const result = await run("pactl", ["get-default-sink"], { timeout: 5000 });
    name = `${result.stdout.trim()}.monitor`;
  }
  const monitor = monitors.find((item) => item.name === name);
  if (!monitor) throw new Error(`未找到音频输出监视源：${name}。可用源：${monitors.map((item) => item.name).join(", ") || "无"}`);
  return monitor.name;
}

function startLinuxCapture(source, options, { onData, onError }) {
  const proc = spawn("parec", [
    `--device=${source}`, "--raw", "--format=s16le",
    `--rate=${options.sampleRate}`, "--channels=1", "--latency-msec=100",
    "--client-name=mylive2dpet-audio", "--stream-name=System output perception",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stopped = false;
  let closed = false;
  let killTimer;
  let resolveClosed;
  const completion = new Promise((resolve) => { resolveClosed = resolve; });
  let reported = false;
  let stderr = "";
  const fail = (error) => {
    if (stopped || reported) return;
    reported = true;
    onError(error);
  };
  proc.stdout.on("data", (chunk) => {
    if (!stopped) onData(chunk);
  });
  proc.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-1000);
  });
  proc.on("error", (error) => fail(new Error(`无法启动系统音频采集：${error.message}`)));
  proc.on("close", (code) => {
    closed = true;
    clearTimeout(killTimer);
    resolveClosed();
    fail(new Error(`系统音频采集已退出 (${code})：${stderr.trim()}`));
  });
  return {
    stop() {
      stopped = true;
      proc.stdout.removeAllListeners("data");
      if (!closed && !killTimer) {
        try { proc.kill(); } catch { /* Already exited. */ }
        killTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* Already exited. */ }
        }, 1000);
        killTimer.unref?.();
      }
      return completion;
    },
  };
}

module.exports = { resolveMonitorSource, startLinuxCapture };
