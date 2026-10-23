import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server-adapter.js";
import { ChatgptSupervisor } from "../src/supervision/chatgpt-supervisor.js";

class MockStore {
  constructor() {
    this.states = new Map();
  }

  key(threadId, adapterName) {
    return `${threadId}:${adapterName}`;
  }

  async getAdapterState(threadId, adapterName) {
    return this.states.get(this.key(threadId, adapterName)) ?? {};
  }

  async setAdapterState(threadId, adapterName, partialState) {
    const key = this.key(threadId, adapterName);
    const next = {
      ...(this.states.get(key) ?? {}),
      ...(partialState ?? {})
    };
    this.states.set(key, next);
    return next;
  }

  async listThreads() {
    return [...new Set([...this.states.keys()].map((key) => key.split(":")[0]))];
  }
}

class BridgeHarness {
  constructor(store) {
    this.store = store;
    this.adapters = new Map();
    this.listeners = new Set();
  }

  registerAdapter(adapter) {
    this.adapters.set(adapter.name, adapter);
    adapter.attach(this);
  }

  on(event, handler) {
    if (event === "message") {
      this.listeners.add(handler);
    }
  }

  off(event, handler) {
    if (event === "message") {
      this.listeners.delete(handler);
    }
  }

  getAdapter(name) {
    return this.adapters.get(name) ?? null;
  }

  async handleIncoming(message) {
    for (const listener of this.listeners) {
      await listener(message);
    }
  }

  async send(message) {
    const adapter = this.getAdapter(message.to);
    if (!adapter) {
      throw new Error(`adapter not found: ${message.to}`);
    }
    return adapter.send(message);
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for condition");
}

test("Supervisor two-turn flow keeps recovered thread when stale sessionBind repeats", async () => {
  const store = new MockStore();
  const bridge = new BridgeHarness(store);
  const adapter = new CodexAppServerAdapter("codex", {
    cwd: "/tmp/default",
    model: "gpt-5.4"
  });
  bridge.registerAdapter(adapter);

  const supervisor = new ChatgptSupervisor({
    bridge,
    options: {
      enabled: true,
      codexAdapterName: "codex",
      supervisorFrom: "chatgpt_supervisor",
      monitorTelegramBotToken: "",
      monitorTelegramChatId: "",
      maxAutoTurnsPerThread: 2,
      autoReleaseOnHalt: false
    }
  });

  supervisor.logEvent = async () => {};
  supervisor.notifyMonitor = async () => {};
  supervisor.askChatgpt = async () => ({ reply: "execute", stdout: "", stderr: "" });

  const calls = [];
  let turnIndex = 0;
  adapter.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/read") {
      return { thread: { cwd: "/tmp/project-c" } };
    }
    if (method === "thread/resume" && params.threadId === "old-thread") {
      throw new Error("thread/resume failed: no rollout found for thread id old-thread");
    }
    if (method === "thread/start") {
      return { thread: { id: "new-thread" } };
    }
    if (method === "turn/start") {
      turnIndex += 1;
      const itemId = `item-${turnIndex}`;
      const finalText = `final-${turnIndex}`;
      setImmediate(() => {
        adapter.handleServerMessage({
          method: "item/completed",
          params: {
            threadId: params.threadId,
            item: {
              id: itemId,
              type: "agentMessage",
              text: finalText,
              phase: "final_answer"
            }
          }
        });
        adapter.handleServerMessage({
          method: "turn/completed",
          params: { threadId: params.threadId, turn: { status: "completed" } }
        });
      });
      return {};
    }
    throw new Error(`unexpected call ${method}`);
  };

  const originalSend = bridge.send.bind(bridge);
  bridge.send = async (message) => {
    if (message.to === "codex") {
      return originalSend({
        ...message,
        meta: {
          ...(message.meta ?? {}),
          sessionBind: true,
          codexThreadId: "old-thread"
        }
      });
    }
    return originalSend(message);
  };

  await supervisor.start();
  await supervisor.onBridgeMessage({
    threadId: "sup_recovery_case",
    from: "user_adapter",
    to: "chatgpt_supervisor",
    role: "user",
    type: "text",
    text: "start",
    meta: {
      sessionBind: true,
      codexThreadId: "old-thread",
      runtimeModel: "gpt-5.3-codex",
      runtimeEffort: "medium"
    }
  });

  await waitFor(() => calls.filter((call) => call.method === "turn/start").length === 2);

  const finalState = await store.getAdapterState("sup_recovery_case", "codex");
  assert.equal(finalState.codexThreadId, "new-thread");

  const threadStartCalls = calls.filter((call) => call.method === "thread/start");
  const oldThreadResumes = calls.filter(
    (call) => call.method === "thread/resume" && call.params.threadId === "old-thread"
  );
  const turnStartCalls = calls.filter((call) => call.method === "turn/start");

  assert.equal(threadStartCalls.length, 1, "should recover by creating exactly one live thread");
  assert.equal(oldThreadResumes.length, 1, "stale thread resume should happen only once");
  assert.equal(turnStartCalls.length, 2, "bridge two-turn flow should execute exactly twice");
  assert.equal(turnStartCalls[0].params.threadId, "new-thread");
  assert.equal(turnStartCalls[1].params.threadId, "new-thread");
});
