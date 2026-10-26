const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { createProcessRunner } = require("./processRunner");

function sanitize(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function createSystemTts({ platform = process.platform, spawnImpl } = {}) {
  const runner = createProcessRunner({ spawnImpl });
  const controllers = new Set();
  const tasks = new Set();

  async function synthesize(text, { rate, signal } = {}) {
    signal?.throwIfAborted();
    const cleaned = sanitize(text);
    if (!cleaned) throw new Error("empty tts text");
    const base = path.join(os.tmpdir(), `mylive2dpet-tts-${randomUUID()}`);
    const output = `${base}.${platform === "darwin" ? "aiff" : "wav"}`;
    const txtPath = `${base}.txt`;
    let completed = false;
    try {
      if (platform === "win32") {
        fs.writeFileSync(txtPath, cleaned, "utf8");
        const txtLit = txtPath.replace(/'/g, "''");
        const wavLit = output.replace(/'/g, "''");
        const ps = [
          "Add-Type -AssemblyName System.Speech",
          "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
          `$s.Rate = ${Math.max(-10, Math.min(10, Number(rate) || 0))}`,
          `$s.SetOutputToWaveFile('${wavLit}')`,
          `$t = Get-Content -LiteralPath '${txtLit}' -Encoding UTF8 -Raw`,
          "$s.Speak($t)", "$s.Dispose()",
        ].join("; ");
        await runner.run("powershell.exe", [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps,
        ], { signal });
      } else if (platform === "darwin") {
        const args = ["-o", output];
        if (rate != null && Number.isFinite(Number(rate))) {
          args.push("-r", String(Math.round(175 + Number(rate) * 15)));
        }
        args.push(cleaned);
        await runner.run("say", args, { signal });
      } else {
        try {
          await runner.run("espeak-ng", ["-w", output, cleaned], { signal });
        } catch (error) {
          signal?.throwIfAborted();
          await runner.run("espeak", ["-w", output, cleaned], { signal });
        }
      }
      signal?.throwIfAborted();
      if (!fs.existsSync(output) || fs.statSync(output).size < 44) {
        throw new Error("system tts produced empty audio");
      }
      completed = true;
      return { path: output, deleteAfter: true };
    } finally {
      try { fs.unlinkSync(txtPath); } catch { /* No text file on this platform. */ }
      if (!completed) {
        try { fs.unlinkSync(output); } catch { /* No output or already removed. */ }
      }
    }
  }

  function synthesizeToFile(text, options = {}) {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    controllers.add(controller);
    const task = Promise.resolve().then(() => synthesize(text, { ...options, signal }))
      .finally(() => { controllers.delete(controller); tasks.delete(task); });
    tasks.add(task);
    return task;
  }

  function stop() {
    for (const controller of controllers) controller.abort();
    return Promise.allSettled([runner.stop(), ...tasks]);
  }

  return { synthesizeToFile, stop };
}

module.exports = { createSystemTts, sanitize };
