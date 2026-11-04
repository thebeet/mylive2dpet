const { randomUUID } = require("node:crypto");

// Recheck wall-clock time at least every 30 seconds, including after sleep or a clock change.
const CHECK_INTERVAL_MS = 30000;

function createScheduleScheduler({ storage, submit, options, logger = console,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const tasks = storage.collection("schedule.tasks");
  let running = false;
  let timer = null;
  let flight = null;
  // If saving an ingress result fails, retry that write before any further submission.
  const pendingWrites = new Map();

  const list = () => tasks.list().map(({ value }) => value)
    .sort((a, b) => a.scheduledAt - b.scheduledAt || a.id.localeCompare(b.id));

  function clearWakeup() {
    if (timer != null) clearTimer(timer);
    timer = null;
  }

  function arm(minDelay = 0) {
    clearWakeup();
    if (!running || flight) return;
    let delay = CHECK_INTERVAL_MS;
    try {
      for (const task of list()) {
        if (task.status === "pending" || pendingWrites.has(task.id)) {
          delay = Math.min(delay, Math.max(0, task.nextAttemptAt - now()));
        }
      }
    } catch (error) { logger.error("schedule read failed:", error); }
    timer = setTimer(() => {
      timer = null;
      void drain().catch((error) => logger.error("schedule delivery failed:", error));
    }, Math.max(delay, minDelay));
    timer?.unref?.();
  }

  function requireRunning() {
    if (!running) throw new Error("定时通知插件已停止");
  }

  function insert(input = {}, id = randomUUID(), origin = {}) {
    requireRunning();
    const text = typeof input?.text === "string" ? input.text.trim() : "";
    if (!text || text.length > 4000) throw new Error("通知内容须为 1～4000 个字符");
    // Accept an epoch millisecond timestamp or ISO time with an explicit offset.
    const rawTime = input.scheduledAt;
    const scheduledAt = typeof rawTime === "number" ? rawTime
      : typeof rawTime === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(rawTime) ? Date.parse(rawTime) : NaN;
    if (!Number.isSafeInteger(scheduledAt) || scheduledAt > 8640000000000000 || scheduledAt <= now()) {
      throw new Error("请选择未来的有效时间（时间戳或带时区的 ISO 时间）");
    }
    const task = {
      id, text, scheduledAt, createdAt: now(), status: "pending", ...origin,
      attempts: 0, nextAttemptAt: scheduledAt,
    };
    tasks.set(task.id, task);
    arm();
    return task;
  }

  function create(input) { return insert(input); }

  function createFromDecision(input, decisionId, effectIndex) {
    requireRunning();
    if (typeof decisionId !== "string" || !decisionId || !Number.isSafeInteger(effectIndex) || effectIndex < 0) {
      throw new Error("定时 effect 缺少有效的决策标识");
    }
    const id = `effect:${decisionId}:${effectIndex}`;
    // Check first, so redelivery remains harmless even after the target time passed.
    const existing = tasks.get(id);
    return existing || insert(input, id, { decisionId, effectIndex });
  }

  function cancel(id) {
    requireRunning();
    const task = tasks.get(id);
    if (!task) throw new Error("定时通知不存在");
    if (task.status === "cancelled") return task;
    if (task.status !== "pending" || pendingWrites.has(id)) throw new Error("仅待入队的通知可以取消");
    const cancelled = { ...task, status: "cancelled", cancelledAt: now() };
    tasks.set(id, cancelled);
    arm();
    return cancelled;
  }

  async function deliver(task) {
    const submitting = { ...task, status: "submitting", attempts: task.attempts + 1 };
    tasks.set(task.id, submitting);
    const submittedAt = now();
    let observation;
    try {
      observation = await submit({
        id: `schedule:${task.id}`, source: "schedule", role: "context", trigger: "scheduled",
        capturedAt: new Date(submittedAt).toISOString(),
        ...(options.observationTtlMs > 0 ? { expiresAt: submittedAt + options.observationTtlMs } : {}),
        content: [{ type: "text", text: `定时通知已到期（原定时间：${new Date(task.scheduledAt).toISOString()}）：\n${task.text}` }],
        metadata: { label: "定时通知", taskId: task.id, scheduledAt: new Date(task.scheduledAt).toISOString(),
          originalRequest: task.text, delayMs: Math.max(0, submittedAt - task.scheduledAt) },
      });
    } catch (error) {
      const failed = { ...submitting, status: submitting.attempts > options.maxRetries ? "failed" : "pending",
        lastError: String(error?.message || error), nextAttemptAt: now() + options.retryDelayMs };
      pendingWrites.set(task.id, failed);
      tasks.set(task.id, failed);
      pendingWrites.delete(task.id);
      logger.warn("schedule ingress failed:", error);
      return;
    }
    const queued = { ...submitting, status: "queued", queuedAt: submittedAt,
      observationId: observation?.id || `schedule:${task.id}`, lastError: null };
    pendingWrites.set(task.id, queued);
    tasks.set(task.id, queued);
    pendingWrites.delete(task.id);
  }

  function drain() {
    if (flight) return flight;
    if (!running) return Promise.resolve();
    clearWakeup();
    // Defer work so flight is set before any asynchronous submission begins.
    let failed = false;
    flight = Promise.resolve().then(async () => {
      for (const [id, update] of pendingWrites) {
        tasks.set(id, update);
        pendingWrites.delete(id);
      }
      for (const entry of list()) {
        if (!running) break;
        const task = tasks.get(entry.id);
        if (task?.status === "pending" && task.nextAttemptAt <= now()) await deliver(task);
      }
    }).catch((error) => { failed = true; throw error; })
      .finally(() => { flight = null; arm(failed ? CHECK_INTERVAL_MS : 0); });
    return flight;
  }

  function start() {
    if (running) return;
    // Interrupted ingress may have reached the old process's volatile queue.
    // Recover it with the same observation ID; crash recovery is at-least-once.
    storage.transaction(() => {
      for (const task of list()) {
        if (task.status === "submitting" && !pendingWrites.has(task.id)) {
          tasks.set(task.id, { ...task, status: "pending", nextAttemptAt: now() });
        }
      }
    });
    running = true;
    arm();
  }

  async function stop() {
    running = false;
    clearWakeup();
    await flight;
  }

  return { create, createFromDecision, list, cancel, start, stop };
}

module.exports = { createScheduleScheduler, CHECK_INTERVAL_MS };
