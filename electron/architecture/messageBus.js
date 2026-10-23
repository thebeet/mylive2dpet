/**
 * Small in-process async message bus for the Electron main process.
 * Subscribers run in registration order so each pipeline stage can publish
 * the next message and preserve a predictable order.
 */
class MessageBus {
  constructor() {
    this.listeners = new Map();
    this.queues = new Map();
  }

  subscribe(type, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("message handler must be a function");
    }
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);

    return () => {
      const current = this.listeners.get(type);
      if (!current) return;
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.listeners.delete(type);
    };
  }

  async publish(type, payload) {
    const handlers = [...(this.listeners.get(type) || [])];
    for (const handler of handlers) {
      await handler(payload);
    }
  }

  enqueue(queue, message) {
    const messages = this.queues.get(queue) || [];
    messages.push(message);
    this.queues.set(queue, messages);
    return messages.length;
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
}

module.exports = { MessageBus };
