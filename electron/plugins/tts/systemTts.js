const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const playWav = require("./playWav");

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
  playWav.stop();
}

function sanitize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function runProc(command, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    currentProc = proc;

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      if (currentProc === proc) currentProc = null;
      reject(err);
    });

    proc.on("close", (code, signal) => {
      if (currentProc === proc) currentProc = null;
      if (code === 0 || signal || code === null) resolve();
      else reject(new Error(`tts exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

/**
 * 合成到本地音频文件（不播放）。
 * @param {string} text
 * @param {{ rate?: number }} [options]
 * @returns {Promise<{ path: string, deleteAfter: boolean }>}
 */
async function synthesizeToFile(text, options = {}) {
  const cleaned = sanitize(text);
  if (!cleaned) {
    throw new Error("empty tts text");
  }

  if (process.platform === "win32") {
    const clampedRate = Math.max(-10, Math.min(10, Number(options.rate) || 0));
    const txtPath = path.join(
      os.tmpdir(),
      `mylive2dpet-tts-${process.pid}-${Date.now()}.txt`,
    );
    const wavPath = path.join(
      os.tmpdir(),
      `mylive2dpet-tts-${process.pid}-${Date.now()}.wav`,
    );
    fs.writeFileSync(txtPath, cleaned, "utf8");
    currentTmp = txtPath;

    const txtLit = txtPath.replace(/'/g, "''");
    const wavLit = wavPath.replace(/'/g, "''");
    const ps = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      `$s.Rate = ${clampedRate}`,
      `$s.SetOutputToWaveFile('${wavLit}')`,
      `$t = Get-Content -LiteralPath '${txtLit}' -Encoding UTF8 -Raw`,
      "$s.Speak($t)",
      "$s.Dispose()",
    ].join("; ");

    try {
      await runProc("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        ps,
      ]);
    } finally {
      try {
        fs.unlinkSync(txtPath);
      } catch {
        /* ignore */
      }
      if (currentTmp === txtPath) currentTmp = null;
    }

    if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 44) {
      throw new Error("system tts produced empty wav");
    }
    return { path: wavPath, deleteAfter: true };
  }

  if (process.platform === "darwin") {
    const aiffPath = path.join(
      os.tmpdir(),
      `mylive2dpet-tts-${process.pid}-${Date.now()}.aiff`,
    );
    const args = ["-o", aiffPath];
    if (options.rate != null && Number.isFinite(Number(options.rate))) {
      const wordsPerMin = Math.round(175 + Number(options.rate) * 15);
      args.push("-r", String(wordsPerMin));
    }
    args.push(cleaned);
    await runProc("say", args);
    return { path: aiffPath, deleteAfter: true };
  }

  const wavPath = path.join(
    os.tmpdir(),
    `mylive2dpet-tts-${process.pid}-${Date.now()}.wav`,
  );
  await runProc("espeak-ng", ["-w", wavPath, cleaned]).catch(() =>
    runProc("espeak", ["-w", wavPath, cleaned]),
  );
  return { path: wavPath, deleteAfter: true };
}

/**
 * 合成并播放（兼容旧调用）。
 * @param {string} text
 * @param {{ rate?: number }} [options]
 */
async function speak(text, options = {}) {
  stop();
  const prepared = await synthesizeToFile(text, options);
  await playWav.play(prepared.path, { deleteAfter: prepared.deleteAfter });
}

module.exports = { speak, stop, synthesizeToFile, sanitize };
