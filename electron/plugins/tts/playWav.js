const { spawn } = require("child_process");
const fs = require("fs");

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

/**
 * 同步播放本地 wav，播完 resolve；stop() 可打断。
 * @param {string} filePath
 * @param {{ deleteAfter?: boolean }} [options]
 */
function play(filePath, options = {}) {
  const deleteAfter = options.deleteAfter !== false;

  return new Promise((resolve, reject) => {
    if (currentProc && !currentProc.killed) {
      try {
        currentProc.kill();
      } catch {
        /* ignore */
      }
    }
    currentProc = null;
    cleanupTmp();
    if (deleteAfter) currentTmp = filePath;

    let command;
    let args;

    if (process.platform === "win32") {
      const literal = filePath.replace(/'/g, "''");
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        `$p = New-Object System.Media.SoundPlayer '${literal}'`,
        "$p.PlaySync()",
      ].join("; ");
      command = "powershell.exe";
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        ps,
      ];
    } else if (process.platform === "darwin") {
      command = "afplay";
      args = [filePath];
    } else {
      command = "aplay";
      args = [filePath];
    }

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
      cleanupTmp();
      reject(err);
    });

    proc.on("close", (code, signal) => {
      if (currentProc === proc) currentProc = null;
      cleanupTmp();
      if (code === 0 || signal || code === null) resolve();
      else reject(new Error(`wav play exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

module.exports = { play, stop };
