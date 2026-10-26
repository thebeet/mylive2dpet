/**
 * Small in-process async message bus for the Electron main process.
 * Subscribers run in registration order so each pipeline stage can publish
 * the next message and preserve a predictable order.
 */
class MessageBus {
  constructor({ logger = console } = {}) {
    this.listeners = new Map();
    this.queues = new Map();
    this.logger = logger;
  }

  subscribe(type, handler, { owner } = {}) {
    if (typeof handler !== "function") {
      throw new TypeError("message handler must be a function");
    }
    const handlers = this.listeners.get(type) || [];
    const subscription = { handler, owner };
    handlers.push(subscription);
    this.listeners.set(type, handlers);

    return () => {
      const current = this.listeners.get(type);
      if (!current) return;
      const index = current.indexOf(subscription);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.listeners.delete(type);
    };
  }

  async publish(type, payload) {
    const handlers = [...(this.listeners.get(type) || [])];
    for (const { handler } of handlers) {
      await handler(payload);
    }
  }

  /** Notifications preserve ordering, but one failed observer cannot block others. */
  async notify(type, payload) {
    const handlers = [...(this.listeners.get(type) || [])];
    for (const { handler, owner } of handlers) {
      try {
        await handler(payload);
      } catch (error) {
        const label = owner || handler.name || "anonymous";
        const message = `[message-bus:${type}] subscriber=${label} failed:`;
        try {
          const write = this.logger?.error || console.error;
          await write.call(this.logger || console, message, error);
        } catch (reportError) {
          // Do not publish another event: failure observers may themselves fail.
          try {
            console.error(message, error, "error reporting failed:", reportError);
          } catch { /* Reporting must not interrupt notification delivery. */ }
        }
      }
    }
  }

  enqueue(queue, message, { maxMatching = Infinity, matches = () => true } = {}) {
    let messages = this.queues.get(queue) || [];
    messages.push(message);
    let excess = Number.isFinite(maxMatching) ? messages.filter(matches).length - maxMatching : 0;
    if (excess > 0) {
      messages = messages.filter((item) => {
        if (excess > 0 && matches(item)) {
          excess -= 1;
          return false;
        }
        return true;
      });
    }
    this.queues.set(queue, messages);
    return messages.length;
  }

  discard(queue, predicate) {
    const messages = this.queues.get(queue) || [];
    const kept = messages.filter((message) => !predicate(message));
    if (kept.length) this.queues.set(queue, kept);
    else this.queues.delete(queue);
    return messages.length - kept.length;
  }

  takeAll(queue) {
    const messages = this.queues.get(queue) || [];
    this.queues.delete(queue);
    return messages;
  }

  requeue(queue, messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const pending = this.queues.get(queue) || [];
    this.queues.set(queue, [...messages, ...pending]);
  }

  queueSize(queue) {
    return (this.queues.get(queue) || []).length;
  }

  peek(queue) {
    return [...(this.queues.get(queue) || [])];
  }
}

module.exports = { MessageBus };
