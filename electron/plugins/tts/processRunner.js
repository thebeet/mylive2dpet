const { spawn } = require("child_process");

/** Each process owns its cancellation listeners and completion promise. */
function createProcessRunner({ spawnImpl = spawn } = {}) {
  const jobs = new Set();

  function run(command, args, { signal, onStart } = {}) {
    signal?.throwIfAborted();
    let proc;
    let killTimer;
    let stderr = "";
    let processError = null;
    let settled = false;
    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const job = { done, cancel };

    function cancel() {
      if (settled || !proc) return;
      try { proc.kill(); } catch { /* The process may already have exited. */ }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* Already exited. */ }
        }, 1000);
        killTimer.unref?.();
      }
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", cancel);
      jobs.delete(job);
      if (signal?.aborted) rejectDone(signal.reason);
      else if (error) rejectDone(error);
      else resolveDone();
    }

    try {
      proc = spawnImpl(command, args, {
        stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
      });
      jobs.add(job);
      proc.stderr?.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-1000); });
      proc.once("error", (error) => {
        processError = error;
        if (proc.pid == null) finish(error);
        else cancel();
      });
      proc.once("close", (code, exitSignal) => finish(
        processError || (code === 0 || exitSignal || code === null ? null
          : new Error(`${command} exited ${code}: ${stderr.slice(0, 200)}`)),
      ));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      else onStart?.();
    } catch (error) {
      processError = error;
      if (!proc || proc.pid == null) finish(error);
      else cancel();
    }
    return done;
  }

  function stop() {
    const pending = [...jobs];
    for (const job of pending) job.cancel();
    return Promise.allSettled(pending.map(({ done }) => done));
  }

  return { run, stop };
}

module.exports = { createProcessRunner };
