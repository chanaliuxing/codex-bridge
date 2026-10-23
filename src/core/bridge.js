import { EventEmitter } from "node:events";
import { normalizeMessage } from "./normalize.js";

export class Bridge extends EventEmitter {
  constructor({ store, router }) {
    super();
    this.store = store;
    this.router = router;
    this.adapters = new Map();
  }

  registerAdapter(adapter) {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Duplicate adapter name: ${adapter.name}`);
    }
    adapter.attach(this);
    this.adapters.set(adapter.name, adapter);
    return adapter;
  }

  getAdapter(name) {
    return this.adapters.get(name);
  }

  listAdapters() {
    return [...this.adapters.keys()].sort();
  }

  async start() {
    await this.store.init();
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stop() {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  async handleIncoming(rawMessage, sourceAdapterName) {
    const message = normalizeMessage(rawMessage, { from: sourceAdapterName });

    if (message.hops > message.maxHops) {
      console.warn(`[bridge] drop ${message.id}: hops ${message.hops} > maxHops ${message.maxHops}`);
      return;
    }

    await this.store.appendRecent(message.threadId, message);
    this.emit("message", message);

    const destinations = this.router.resolveDestinations(message);
    if (destinations.length === 0) {
      return;
    }

    for (const destinationName of destinations) {
      if (!destinationName || destinationName === message.from) {
        continue;
      }

      const adapter = this.adapters.get(destinationName);
      if (!adapter) {
        console.warn(`[bridge] unknown destination adapter: ${destinationName}`);
        continue;
      }

      const outbound = normalizeMessage(
        {
          ...message,
          to: destinationName,
          hops: message.hops + 1
        },
        {}
      );

      await adapter.send(outbound);
    }
  }

  async send(payload) {
    await this.handleIncoming(payload, payload.from ?? "user");
  }
}
