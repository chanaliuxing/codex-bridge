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

function attachAdapter(adapter, store, emitted = []) {
  const bridge = {
    store,
    async handleIncoming(message) {
      emitted.push(message);
    },
    getAdapter(name) {
      return name === adapter.name ? adapter : null;
    }
  };
  adapter.attach(bridge);
  return bridge;
}

test("Codex app adapter recreates a missing session in the saved cwd", async () => {
  const store = new MockStore();
  await store.setAdapterState("bridge-1", "codex", {
    codexThreadId: "old-thread",
    codexCwd: "/tmp/project-a",
    runtimeModel: "gpt-5.3-codex",
    runtimeEffort: "medium"
  });

  const adapter = new CodexAppServerAdapter("codex", {
    cwd: "/tmp/default",
    model: "gpt-5.4"
  });
  attachAdapter(adapter, store);

  const calls = [];
  adapter.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume" && params.threadId === "old-thread") {
      throw new Error("thread/resume failed: no rollout found for thread id old-thread");
    }
    if (method === "thread/start") {
      assert.equal(params.cwd, "/tmp/project-a");
      return { thread: { id: "new-thread" } };
    }
    if (method === "turn/start") {
      assert.equal(params.threadId, "new-thread");
      assert.equal(params.cwd, "/tmp/project-a");
      setImmediate(() => {
        adapter.handleServerMessage({
          method: "turn/completed",
          params: { threadId: "new-thread", turn: { status: "completed" } }
        });
      });
      return {};
    }
    throw new Error(`unexpected call ${method}`);
  };

  await adapter.send({
    threadId: "bridge-1",
    from: "chatgpt_supervisor",
    to: "codex",
    role: "user",
    type: "text",
    text: "hello from chatgpt",
    meta: {}
  });

  const finalState = await store.getAdapterState("bridge-1", "codex");
  assert.equal(finalState.codexThreadId, "new-thread");
  assert.equal(finalState.codexCwd, "/tmp/project-a");
  assert.ok(calls.some((call) => call.method === "thread/resume" && call.params.threadId === "old-thread"));
  assert.ok(calls.some((call) => call.method === "thread/start"));
  assert.ok(calls.some((call) => call.method === "turn/start" && call.params.threadId === "new-thread"));
});

test("Codex app adapter preserves recovered thread across turn two and avoids duplicate execution", async () => {
  const store = new MockStore();
  await store.setAdapterState("bridge-3", "codex", {
    codexThreadId: "old-thread",
    codexCwd: "/tmp/project-b",
    runtimeModel: "gpt-5.3-codex",
    runtimeEffort: "medium"
  });

  const adapter = new CodexAppServerAdapter("codex", {
    cwd: "/tmp/default",
    model: "gpt-5.4"
  });
  attachAdapter(adapter, store);

  const calls = [];
  adapter.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume" && params.threadId === "old-thread") {
      throw new Error("thread/resume failed: no rollout found for thread id old-thread");
    }
    if (method === "thread/start") {
      return { thread: { id: "new-thread" } };
    }
    if (method === "turn/start") {
      setImmediate(() => {
        adapter.handleServerMessage({
          method: "turn/completed",
          params: { threadId: params.threadId, turn: { status: "completed" } }
        });
      });
      return {};
    }
    throw new Error(`unexpected call ${method}`);
  };

  const firstTurnMessage = {
    threadId: "bridge-3",
    from: "chatgpt_supervisor",
    to: "codex",
    role: "user",
    type: "text",
    text: "turn one",
    meta: {
      sessionBind: true,
      codexThreadId: "old-thread"
    }
  };
  await adapter.send(firstTurnMessage);

  const secondTurnMessage = {
    ...firstTurnMessage,
    text: "turn two"
  };
  await adapter.send(secondTurnMessage);

  const finalState = await store.getAdapterState("bridge-3", "codex");
  assert.equal(finalState.codexThreadId, "new-thread");

  const threadStartCalls = calls.filter((call) => call.method === "thread/start");
  const turnStartCalls = calls.filter((call) => call.method === "turn/start");
  const oldThreadResumes = calls.filter(
    (call) => call.method === "thread/resume" && call.params.threadId === "old-thread"
  );

  assert.equal(threadStartCalls.length, 1, "recovery thread should be created once");
  assert.equal(turnStartCalls.length, 2, "exactly one execution per turn");
  assert.equal(
    turnStartCalls[0].params.threadId,
    "new-thread",
    "first post-recovery execution should use recovered thread"
  );
  assert.equal(
    turnStartCalls[1].params.threadId,
    "new-thread",
    "second turn should continue recovered thread without rebinding stale session id"
  );
  assert.equal(oldThreadResumes.length, 1, "stale session should be retried only once");
});

test("Codex app adapter routes agent messages back to the bound bridge thread", async () => {
  const store = new MockStore();
  const emitted = [];
  await store.setAdapterState("bridge-2", "codex", { codexThreadId: "codex-thread-2" });
  const adapter = new CodexAppServerAdapter("codex", { cwd: "/tmp/default" });
  attachAdapter(adapter, store, emitted);

  await adapter.handleServerMessage({
    method: "item/completed",
    params: {
      threadId: "codex-thread-2",
      item: {
        id: "item-1",
        type: "agentMessage",
        text: "codex final text",
        phase: "final_answer"
      }
    }
  });

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].threadId, "bridge-2");
  assert.equal(emitted[0].from, "codex");
  assert.equal(emitted[0].text, "codex final text");
  assert.equal(emitted[0].meta.codexThreadId, "codex-thread-2");
});

test("Supervisor resolves cwd when binding an existing Codex session", async () => {
  const store = new MockStore();
  const codexAdapter = {
    name: "codex",
    call: async (method, params) => {
      assert.equal(method, "thread/read");
      assert.equal(params.threadId, "codex-session-1");
      return { thread: { cwd: "/tmp/session-cwd" } };
    }
  };
  const supervisor = new ChatgptSupervisor({
    bridge: {
      store,
      getAdapter(name) {
        return name === "codex" ? codexAdapter : null;
      }
    },
    options: {
      enabled: true,
      codexAdapterName: "codex",
      monitorTelegramBotToken: "",
      monitorTelegramChatId: ""
    }
  });
  supervisor.logEvent = async () => {};

  await supervisor.bindCodexSessionForThread("sup-bridge", "codex-session-1", null, "gpt-5.3-codex", "medium");

  const state = await store.getAdapterState("sup-bridge", "codex");
  assert.equal(state.codexThreadId, "codex-session-1");
  assert.equal(state.codexCwd, "/tmp/session-cwd");
  assert.equal(state.runtimeModel, "gpt-5.3-codex");
  assert.equal(state.runtimeEffort, "medium");
});
