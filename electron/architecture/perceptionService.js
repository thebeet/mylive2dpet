const EVENTS = require("./events");
const { createObservation } = require("./contracts");
const { retryable } = require("./failures");

/** Bounded ingress and resource release, independent of observation modalities. */
function createPerceptionService(bus, { getPolicy = () => ({}) } = {}) {
  const sources = new Map();
  const attempts = new WeakMap();
  const rejected = [];
  const policy = () => {
    const config = getPolicy();
    return { maxPending: 128, maxBatch: 16, maxRetries: 2, ...config,
      perSource: { screen: 6, "audio-output": 20, "manual-input": 100, ...config.perSource } };
  };
  const queue = EVENTS.PERCEPTION_OBSERVATION;

  async function release(observations, reason) {
    for (const observation of observations) {
      attempts.delete(observation);
      await bus.notify(EVENTS.PERCEPTION_OBSERVATION_RELEASED, { observation, reason });
    }
  }

  async function submit(input, queueOptions = {}) {
    const observation = createObservation(input);
    const config = policy();
    const pending = bus.takeAll(queue);
    const expired = pending.filter((item) => item.expiresAt != null && item.expiresAt <= Date.now());
    const expiredSet = new Set(expired);
    const kept = pending.filter((item) => !expiredSet.has(item));
    const sourceLimit = Math.min(config.perSource?.[observation.source] || 32, queueOptions.maxMatching ?? Infinity);
    const dropped = [];
    if (observation.role === "user" && (kept.filter((item) => item.source === observation.source).length >= sourceLimit ||
        (kept.length >= config.maxPending && kept.every((item) => item.role === "user")))) {
      bus.requeue(queue, kept);
      await release(expired, "expired");
      throw new Error("待处理消息过多，请等待当前对话结束后重试");
    }
    if (observation.role !== "user") {
      while (kept.filter((item) => item.source === observation.source).length >= sourceLimit) {
        const index = kept.findIndex((item) => item.source === observation.source && item.role !== "user");
        if (index < 0) break;
        dropped.push(...kept.splice(index, 1));
      }
      if (kept.filter((item) => item.source === observation.source).length >= sourceLimit) {
        bus.requeue(queue, kept);
        await release(expired, "expired");
        await release(dropped, "capacity");
        throw new Error("该来源的观察队列已满");
      }
    }
    while (kept.length >= config.maxPending) {
      const index = kept.findIndex((item) => item.role !== "user");
      if (index < 0) {
        bus.requeue(queue, kept);
        await release(expired, "expired");
        await release(dropped, "capacity");
        throw new Error("观察队列已满");
      }
      dropped.push(...kept.splice(index, 1));
    }
    kept.push(observation);
    bus.requeue(queue, kept);
    await release(expired, "expired");
    await release(dropped, "capacity");
    await bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, { observation, pendingCount: kept.length });
    return observation;
  }

  async function takeBatch() {
    const all = bus.takeAll(queue);
    const expired = all.filter((item) => item.expiresAt != null && item.expiresAt <= Date.now());
    const expiredSet = new Set(expired);
    const available = all.filter((item) => !expiredSet.has(item));
    const time = (item) => Date.parse(item.capturedAt) || 0;
    const selected = [...available].sort((a, b) =>
      Number(b.role === "user") - Number(a.role === "user") || time(a) - time(b)).slice(0, policy().maxBatch);
    const batch = new Set(selected);
    bus.requeue(queue, available.filter((item) => !batch.has(item)));
    await release(expired, "expired");
    return selected.sort((a, b) => time(a) - time(b));
  }

  async function fail(observations, error, { cancelled = false } = {}) {
    const retry = [];
    const dropped = [];
    for (const observation of observations) {
      const previous = attempts.get(observation) || 0;
      const badObservation = error?.observationId === observation.id;
      const unrelated = error?.observationId && !badObservation;
      const count = previous + (cancelled || unrelated ? 0 : 1);
      if (!badObservation && (cancelled || unrelated || retryable(error)) && count <= policy().maxRetries &&
          (observation.expiresAt == null || observation.expiresAt > Date.now())) {
        attempts.set(observation, count);
        retry.push(observation);
      } else {
        dropped.push(observation);
        rejected.push({ observation, error: String(error?.message || error), at: Date.now() });
        if (rejected.length > 100) rejected.shift();
      }
    }
    bus.requeue(queue, retry);
    await release(dropped, "failed");
    return { retried: retry.length, rejected: dropped.length };
  }

  async function discard(predicate, reason = "discarded") {
    const all = bus.takeAll(queue);
    const dropped = all.filter(predicate);
    const droppedSet = new Set(dropped);
    bus.requeue(queue, all.filter((item) => !droppedSet.has(item)));
    await release(dropped, reason);
    return dropped.length;
  }

  function registerSource(name, capture) {
    if (typeof name !== "string" || !name || typeof capture !== "function") {
      throw new TypeError("perception source requires a name and a capture handler");
    }
    if (sources.has(name)) throw new Error(`感知来源已注册: ${name}`);
    sources.set(name, capture);
    return () => { if (sources.get(name) === capture) sources.delete(name); };
  }

  async function capture(name, request = {}) {
    const handler = sources.get(name);
    if (!handler) throw new Error(`感知插件未加载: ${name}`);
    return handler(request);
  }

  return { submit, takeBatch, fail, release, discard, registerSource, capture,
    hasSource: (name) => sources.has(name),
    getRejected: () => rejected.map((item) => ({ ...item })),
    pendingCount: () => bus.queueSize(queue),
    hasPendingUser: () => bus.peek(queue).some((item) => item.role === "user") };
}

module.exports = { createPerceptionService };
