import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { BaseAdapter } from "./base-adapter.js";

export class CodexAppServerAdapter extends BaseAdapter {
  constructor(name, options = {}) {
    super(name, options);
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["app-server"];
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.env = { ...process.env, ...(options.env ?? {}) };

    this.model = options.model ?? "gpt-5.4";
    this.personality = options.personality ?? "friendly";
    this.approvalPolicy = options.approvalPolicy ?? "never";
    this.serviceName = options.serviceName ?? "codex_bridge_complete";
    const rawSandboxPolicy = options.sandboxPolicy ?? {
      type: "workspaceWrite",
      writableRoots: [this.cwd],
      networkAccess: false
    };
    this.sandboxPolicy = {
      ...rawSandboxPolicy,
      writableRoots: (rawSandboxPolicy.writableRoots ?? [this.cwd]).map((root) => path.resolve(root))
    };

    this.child = null;
    this.rl = null;
    this.requestId = 1;
    this.pending = new Map();
    this.threadQueues = new Map();
    this.pendingThreadCreates = new Map();
    this.agentBuffers = new Map();
    this.turnWaiters = new Map();
    this.resumedThreads = new Set();
  }

  isRecoverableThreadError(errorOrMessage) {
    const message = String(errorOrMessage?.message ?? errorOrMessage ?? "").toLowerCase();
    return (
      message.includes("thread not found") ||
      message.includes("no rollout found") ||
      message.includes("context window exceeded") ||
      message.includes("contextwindowexceeded")
    );
  }

  normalizeSandboxMode(rawMode) {
    if (!rawMode) {
      return "workspace-write";
    }
    const text = String(rawMode).trim();
    const normalized = text.toLowerCase().replace(/[_\s]+/g, "-");
    const map = {
      "readonly": "read-only",
      "read-only": "read-only",
      "workspacewrite": "workspace-write",
      "workspace-write": "workspace-write",
      "dangerfullaccess": "danger-full-access",
      "danger-full-access": "danger-full-access"
    };
    const compact = normalized.replace(/-/g, "");
    return map[normalized] ?? map[compact] ?? "workspace-write";
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "inherit"]
    });

    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const message = JSON.parse(line);
        this.handleServerMessage(message).catch((error) => {
          console.error(`[${this.name}] failed handling server message`, error);
        });
      } catch (error) {
        console.error(`[${this.name}] invalid JSON from Codex app-server`, error, line);
      }
    });

    this.child.on("error", (error) => {
      console.error(`[${this.name}] process error`, error);
    });

    await this.call("initialize", {
      clientInfo: {
        name: "codex_bridge_complete",
        title: "Codex Bridge Complete",
        version: "0.2.0"
      }
    });

    this.sendRpc({
      method: "initialized",
      params: {}
    });
  }

  async stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  sendRpc(payload) {
    if (!this.child?.stdin) {
      throw new Error("Codex app-server is not running");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}
`);
  }

  call(method, params) {
    const id = this.requestId++;
    this.sendRpc({ method, id, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  async handleServerMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const method = message.method;
    const params = message.params ?? {};

    if (method === "item/agentMessage/delta") {
      const itemId = params.itemId ?? params.item?.id;
      const delta = params.delta ?? params.textDelta ?? "";
      if (itemId) {
        const current = this.agentBuffers.get(itemId) ?? "";
        this.agentBuffers.set(itemId, current + delta);
      }
      return;
    }

    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const item = params.item;
      const buffered = this.agentBuffers.get(item.id) ?? "";
      const text = item.text ?? buffered;
      this.agentBuffers.delete(item.id);

      const codexThreadId = params.threadId ?? params.turn?.threadId ?? null;
      const bridgeThreadId = await this.findBridgeThreadByCodexThreadId(codexThreadId);

      await this.emitMessage({
        threadId: bridgeThreadId ?? "default",
        from: this.name,
        role: "assistant",
        text,
        meta: {
          codexThreadId,
          phase: item.phase ?? null
        }
      });
      return;
    }

    if (method === "item/commandExecution/requestApproval") {
      this.respondToServerRequest(message, "decline");
      return;
    }

    if (method === "item/fileChange/requestApproval") {
      this.respondToServerRequest(message, "decline");
      return;
    }

    if (method === "tool/requestUserInput") {
      this.respondToServerRequest(message, {
        content: [{ type: "text", text: "No user input is available from this bridge." }]
      });
      return;
    }

    if (method === "turn/completed") {
      const hadWaiter = this.resolveTurnWaiter(params.threadId ?? null, params.turn ?? {});

      if (params.turn?.status === "failed" && !hadWaiter) {
        const bridgeThreadId = await this.findBridgeThreadByCodexThreadId(params.threadId ?? null);
        await this.emitMessage({
          threadId: bridgeThreadId ?? "default",
          from: this.name,
          role: "assistant",
          text: `Codex turn failed: ${params.turn?.error?.message ?? "unknown error"}`,
          meta: {
            codexThreadId: params.threadId ?? null,
            status: "failed"
          }
        });
      }
    }
  }

  respondToServerRequest(message, result) {
    this.sendRpc({ id: message.id, result });
  }

  async getOrCreateCodexThreadId(bridgeThreadId) {
    const saved = await this.bridge.store.getAdapterState(bridgeThreadId, this.name);
    if (saved.codexThreadId) {
      return saved.codexThreadId;
    }

    if (this.pendingThreadCreates.has(bridgeThreadId)) {
      return this.pendingThreadCreates.get(bridgeThreadId);
    }

    const promise = (async () => {
      const sandboxMode = this.normalizeSandboxMode(this.sandboxPolicy?.type);
      const runtime = await this.getThreadRuntimeOptions(bridgeThreadId);
      const result = await this.call("thread/start", {
        model: runtime.model,
        cwd: runtime.cwd,
        approvalPolicy: this.approvalPolicy,
        personality: this.personality,
        serviceName: this.serviceName,
        sandbox: sandboxMode
      });

      const codexThreadId = result?.thread?.id;
      if (!codexThreadId) {
        throw new Error("thread/start returned no thread id");
      }

      await this.bridge.store.setAdapterState(bridgeThreadId, this.name, { codexThreadId });
      this.resumedThreads.add(codexThreadId);
      return codexThreadId;
    })();

    this.pendingThreadCreates.set(bridgeThreadId, promise);
    try {
      return await promise;
    } finally {
      this.pendingThreadCreates.delete(bridgeThreadId);
    }
  }

  async findBridgeThreadByCodexThreadId(codexThreadId) {
    if (!codexThreadId) {
      return null;
    }

    const threads = await this.bridge.store.listThreads();
    for (const threadId of threads) {
      const state = await this.bridge.store.getAdapterState(threadId, this.name);
      if (state.codexThreadId === codexThreadId) {
        return threadId;
      }
    }
    return null;
  }

  async findBridgeThreadsByCodexThreadId(codexThreadId) {
    if (!codexThreadId) {
      return [];
    }
    const threads = await this.bridge.store.listThreads();
    const matches = [];
    for (const threadId of threads) {
      const state = await this.bridge.store.getAdapterState(threadId, this.name);
      if (state.codexThreadId === codexThreadId) {
        matches.push(threadId);
      }
    }
    return matches;
  }

  async assertUniqueBinding(bridgeThreadId, codexThreadId) {
    const matches = await this.findBridgeThreadsByCodexThreadId(codexThreadId);
    const others = matches.filter((id) => id !== bridgeThreadId);
    if (others.length > 0) {
      throw new Error(
        `codex session ${codexThreadId} is already bound by other thread(s): ${others.join(", ")}`
      );
    }
  }

  addTurnWaiter(codexThreadId) {
    if (!codexThreadId) {
      return Promise.resolve(null);
    }
    let resolveFn = null;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const queue = this.turnWaiters.get(codexThreadId) ?? [];
    queue.push(resolveFn);
    this.turnWaiters.set(codexThreadId, queue);
    return promise;
  }

  resolveTurnWaiter(codexThreadId, turn) {
    if (!codexThreadId) {
      return false;
    }
    const queue = this.turnWaiters.get(codexThreadId);
    if (!queue || queue.length === 0) {
      return false;
    }
    const resolve = queue.shift();
    if (queue.length === 0) {
      this.turnWaiters.delete(codexThreadId);
    } else {
      this.turnWaiters.set(codexThreadId, queue);
    }
    resolve(turn);
    return true;
  }

  abortTurnWaiters(codexThreadId, reason = "aborted") {
    if (!codexThreadId) {
      return 0;
    }
    const queue = this.turnWaiters.get(codexThreadId);
    if (!queue || queue.length === 0) {
      this.turnWaiters.delete(codexThreadId);
      return 0;
    }
    this.turnWaiters.delete(codexThreadId);
    const turn = {
      status: "failed",
      error: {
        message: String(reason || "aborted")
      }
    };
    for (const resolve of queue) {
      try {
        resolve(turn);
      } catch {}
    }
    return queue.length;
  }

  async ensureThreadResumed(codexThreadId) {
    if (!codexThreadId || this.resumedThreads.has(codexThreadId)) {
      return;
    }
    await this.call("thread/resume", { threadId: codexThreadId });
    this.resumedThreads.add(codexThreadId);
  }

  async resetMissingCodexThread(bridgeThreadId, codexThreadId, reason) {
    if (codexThreadId) {
      this.resumedThreads.delete(codexThreadId);
      this.abortTurnWaiters(codexThreadId, reason);
    }
    await this.bridge.store.setAdapterState(bridgeThreadId, this.name, { codexThreadId: null });
  }

  async releaseBridgeThread(bridgeThreadId, options = {}) {
    const clearRuntime = options?.clearRuntime === true;
    const state = await this.bridge.store.getAdapterState(bridgeThreadId, this.name);
    const codexThreadId = String(state?.codexThreadId ?? "").trim() || null;
    if (codexThreadId) {
      this.resumedThreads.delete(codexThreadId);
      this.abortTurnWaiters(codexThreadId, "bridge thread released");
    }
    const nextState = {
      codexThreadId: null
    };
    if (clearRuntime) {
      nextState.codexCwd = null;
      nextState.runtimeModel = null;
      nextState.runtimeEffort = null;
    }
    await this.bridge.store.setAdapterState(bridgeThreadId, this.name, nextState);
    return {
      bridgeThreadId,
      codexThreadId
    };
  }

  async getThreadRuntimeOptions(bridgeThreadId) {
    const state = await this.bridge.store.getAdapterState(bridgeThreadId, this.name);
    const configuredCwd = state?.codexCwd ? path.resolve(state.codexCwd) : this.cwd;
    const configuredModel = state?.runtimeModel ? String(state.runtimeModel).trim() : this.model;
    const configuredEffort = state?.runtimeEffort ? String(state.runtimeEffort).trim() : "medium";
    const basePolicy = this.sandboxPolicy ?? {};
    const roots = new Set(
      (basePolicy.writableRoots ?? [this.cwd]).map((root) => path.resolve(root))
    );
    roots.add(configuredCwd);
    return {
      cwd: configuredCwd,
      model: configuredModel,
      effort: configuredEffort,
      sandboxPolicy: {
        ...basePolicy,
        writableRoots: [...roots]
      }
    };
  }

  enqueueForThread(bridgeThreadId, task) {
    const previous = this.threadQueues.get(bridgeThreadId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.threadQueues.set(
      bridgeThreadId,
      next.finally(() => {
        if (this.threadQueues.get(bridgeThreadId) === next) {
          this.threadQueues.delete(bridgeThreadId);
        }
      })
    );
    return next;
  }

  async send(message) {
    return this.enqueueForThread(message.threadId, async () => {
      let codexThreadId = null;
      let completion = null;
      const maxAttempts = 2;
      try {
        const allowSessionBind = message?.meta?.sessionBind === true;
        const requestedCodexThreadId = String(
          allowSessionBind ? (message?.meta?.codexThreadId ?? message?.meta?.sessionId ?? "") : ""
        ).trim();
        if (requestedCodexThreadId) {
          const currentState = await this.bridge.store.getAdapterState(message.threadId, this.name);
          const currentCodexThreadId = String(currentState?.codexThreadId ?? "").trim();
          const shouldBindRequestedThread =
            !currentCodexThreadId || currentCodexThreadId === requestedCodexThreadId;
          if (shouldBindRequestedThread) {
            await this.assertUniqueBinding(message.threadId, requestedCodexThreadId);
            await this.bridge.store.setAdapterState(message.threadId, this.name, {
              codexThreadId: requestedCodexThreadId,
              ...(message?.meta?.codexCwd ? { codexCwd: String(message.meta.codexCwd).trim() } : {})
            });
          } else if (message?.meta?.codexCwd) {
            await this.bridge.store.setAdapterState(message.threadId, this.name, {
              codexCwd: String(message.meta.codexCwd).trim()
            });
          }
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            codexThreadId = await this.getOrCreateCodexThreadId(message.threadId);
            await this.assertUniqueBinding(message.threadId, codexThreadId);
            await this.ensureThreadResumed(codexThreadId);
            const runtime = await this.getThreadRuntimeOptions(message.threadId);
            completion = this.addTurnWaiter(codexThreadId);
            await this.call("turn/start", {
              threadId: codexThreadId,
              input: [{ type: "text", text: message.text }],
              cwd: runtime.cwd,
              approvalPolicy: this.approvalPolicy,
              sandboxPolicy: runtime.sandboxPolicy,
              model: runtime.model,
              personality: this.personality,
              summary: "concise",
              effort: runtime.effort
            });
            const turn = await completion;
            completion = null;
            if (turn?.status !== "failed") {
              return;
            }

            throw new Error(turn?.error?.message ?? "unknown error");
          } catch (attemptError) {
            if (codexThreadId && completion) {
              this.resolveTurnWaiter(codexThreadId, {
                status: "failed",
                error: { message: attemptError?.message ?? "unknown error" }
              });
              completion = null;
            }
            if (attempt < maxAttempts && this.isRecoverableThreadError(attemptError)) {
              await this.resetMissingCodexThread(
                message.threadId,
                codexThreadId,
                attemptError?.message ?? "recoverable thread error"
              );
              codexThreadId = null;
              continue;
            }
            throw attemptError;
          }
        }
      } catch (error) {
        if (codexThreadId && completion) {
          this.resolveTurnWaiter(codexThreadId, {
            status: "failed",
            error: { message: error?.message ?? "unknown error" }
          });
        }

        if (this.isRecoverableThreadError(error)) {
          await this.resetMissingCodexThread(message.threadId, codexThreadId, error?.message ?? "recoverable thread error");
        }

        await this.emitMessage({
          threadId: message.threadId,
          from: this.name,
          role: "assistant",
          text: `Codex turn failed: ${error?.message ?? "unknown error"}`,
          meta: {
            codexThreadId,
            status: "failed"
          }
        });
      }
    });
  }
}
