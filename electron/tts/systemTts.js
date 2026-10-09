const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let currentProc = null;
let currentTmp = null;

function cleanupTmp() {
  if (!currentTmp) return;
  try {
    fs.unlinkSync(currentTmp);
  } catch {
    /* ignore */
  }
  currentTmp = null;
}

function stop() {
  if (currentProc && !currentProc.killed) {
    try {
      currentProc.kill();
    } catch {
      /* ignore */
    }
  }
  currentProc = null;
  cleanupTmp();
}

function sanitize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function runProc(command, args, { stdinText } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio:
        stdinText != null ? ["pipe", "ignore", "pipe"] : ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    currentProc = proc;

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      if (currentProc === proc) currentProc = null;
      cleanupTmp();
      reject(err);
    });

    proc.on("close", (code, signal) => {
      if (currentProc === proc) currentProc = null;
      cleanupTmp();
      // 被 stop() kill 时不算失败
      if (code === 0 || signal || code === null) resolve();
      else reject(new Error(`tts exited ${code}: ${stderr.slice(0, 200)}`));
    });

    if (stdinText != null) {
      proc.stdin.end(stdinText, "utf8");
    }
  });
}

function speakWindows(text, { rate = 0 } = {}) {
  const clampedRate = Math.max(-10, Math.min(10, Number(rate) || 0));
  const tmp = path.join(
    os.tmpdir(),
    `mylive2dpet-tts-${process.pid}-${Date.now()}.txt`,
  );
  fs.writeFileSync(tmp, text, "utf8");
  currentTmp = tmp;

  const literal = tmp.replace(/'/g, "''");
  const ps = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$s.Rate = ${clampedRate}`,
    `$t = Get-Content -LiteralPath '${literal}' -Encoding UTF8 -Raw`,
    "$s.Speak($t)",
  ].join("; ");

  return runProc("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    ps,
  ]);
}

function speakMac(text, { rate } = {}) {
  const args = [];
  if (rate != null && Number.isFinite(Number(rate))) {
    const wordsPerMin = Math.round(175 + Number(rate) * 15);
    args.push("-r", String(wordsPerMin));
  }
  args.push(text);
  return runProc("say", args);
}

function speakLinux(text) {
  return runProc("espeak-ng", [text]).catch(() =>
    runProc("espeak", [text]).catch(() => runProc("spd-say", [text])),
  );
}

/**
 * 系统 TTS 朗读。可被 stop() 打断。
 * @param {string} text
 * @param {{ rate?: number }} [options]
 */
async function speak(text, options = {}) {
  const cleaned = sanitize(text);
  if (!cleaned) return;

  stop();

  if (process.platform === "win32") {
    await speakWindows(cleaned, options);
    return;
  }
  if (process.platform === "darwin") {
    await speakMac(cleaned, options);
    return;
  }
  await speakLinux(cleaned);
}

module.exports = { speak, stop };
