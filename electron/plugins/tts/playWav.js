const fs = require("fs");
const { createProcessRunner } = require("./processRunner");

function createAudioPlayer({ platform = process.platform, spawnImpl } = {}) {
  const runner = createProcessRunner({ spawnImpl });
  let generation = 0;
  const tasks = new Set();

  function stop() {
    generation += 1;
    return Promise.allSettled([runner.stop(), ...tasks]);
  }

  function play(filePath, { deleteAfter = true, signal, onStart } = {}) {
    const previous = stop();
    const myGeneration = generation;
    const task = (async () => {
      try {
        await previous;
        signal?.throwIfAborted();
        if (myGeneration !== generation) return;
        let command;
        let args;
        if (platform === "win32") {
          const literal = filePath.replace(/'/g, "''");
          command = "powershell.exe";
          args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", [
            "Add-Type -AssemblyName System.Windows.Forms",
            `$p = New-Object System.Media.SoundPlayer '${literal}'`, "$p.PlaySync()",
          ].join("; ")];
        } else if (platform === "darwin") {
          command = "afplay";
          args = [filePath];
        } else {
          command = "aplay";
          args = [filePath];
        }
        await runner.run(command, args, { signal, onStart });
      } finally {
        // An old process must never delete a newer playback's file.
        if (deleteAfter) {
          try { fs.unlinkSync(filePath); } catch { /* Already removed. */ }
        }
      }
    })().finally(() => tasks.delete(task));
    tasks.add(task);
    return task;
  }

  return { play, stop };
}

module.exports = { createAudioPlayer };
