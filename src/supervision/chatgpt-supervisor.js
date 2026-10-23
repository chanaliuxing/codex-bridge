import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function ensureText(value) {
  return String(value ?? "").trim();
}

function positiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeCommandText(text) {
  const raw = ensureText(text);
  if (!raw.startsWith("/")) {
    return raw.toLowerCase();
  }
  const [first] = raw.split(/\s+/, 1);
  const withoutSlash = first.replace(/^\//, "");
  const [name] = withoutSlash.split("@");
  return `/${name.toLowerCase()}`;
}

function runExecFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (typeof options.onSpawn === "function") {
      options.onSpawn(child);
    }

    let stdout = "";
    let stderr = "";
    const maxBuffer = 10 * 1024 * 1024;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk ?? "");
      if (stdout.length > maxBuffer) {
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk ?? "");
      if (stderr.length > maxBuffer) {
        child.kill("SIGTERM");
      }
    });

    child.on("error", (error) => {
      const detail = [error.message, stderr].filter(Boolean).join("\n");
      reject(new Error(detail));
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        return;
      }
      const detail = [
        `process exited with code=${String(code)} signal=${String(signal ?? "")}`,
        stderr
      ]
        .filter(Boolean)
        .join("\n");
      reject(new Error(detail));
    });
  });
}

function extractAskReply(stdout) {
  const raw = String(stdout ?? "");
  const marker = "===== ASSISTANT REPLY =====";
  const idx = raw.lastIndexOf(marker);
  if (idx >= 0) {
    return raw.slice(idx + marker.length).trim();
  }
  return raw.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ChatgptSupervisor {
  constructor({ bridge, options = {} }) {
    this.bridge = bridge;
    this.enabled = options.enabled === true;
    this.threadId = ensureText(options.threadId || "");
    this.threadPrefix = ensureText(options.threadPrefix || "");
    this.codexAdapterName = ensureText(options.codexAdapterName || "codex");
    this.supervisorFrom = ensureText(options.supervisorFrom || "chatgpt_supervisor");
    this.pythonCommand = ensureText(options.pythonCommand || "python3");
    this.toolDir = path.resolve(options.toolDir || "./browser-chat-vision-tool");
    this.toolConfig = path.resolve(this.toolDir, options.toolConfig || "config.json");
    this.initialPromptFile = path.resolve(options.initialPromptFile || "./supervisor/initial_chatgpt_prompt.txt");
    this.promptPrefix = ensureText(options.promptPrefix || process.env.SUPERVISOR_PROMPT_PREFIX || "");
    this.maxAutoTurnsPerThread = Number(options.maxAutoTurnsPerThread ?? 30);
    this.eventsFile = path.resolve(options.eventsFile || "./data/supervisor_events.jsonl");
    this.stopOnCodexFailure = options.stopOnCodexFailure !== false;
    this.stopOnUsageLimit = options.stopOnUsageLimit !== false;
    this.autoReleaseOnHalt = options.autoReleaseOnHalt !== false;
    this.autoReleaseClearRuntime = options.autoReleaseClearRuntime === true;
    this.autoTakeoverSupervisorSession = options.autoTakeoverSupervisorSession !== false;
    this.monitorIncludeChatgptEvents = options.monitorIncludeChatgptEvents !== false;

    this.monitorTelegramBotToken = ensureText(
      options.monitorTelegramBotToken || process.env.MONITOR_TELEGRAM_BOT_TOKEN || ""
    );
    this.monitorTelegramChatId = ensureText(
      options.monitorTelegramChatId || process.env.MONITOR_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || ""
    );
    this.monitorTelegramEnabled = Boolean(this.monitorTelegramBotToken && this.monitorTelegramChatId);
    this.monitorThreadId = ensureText(options.monitorThreadId || "");
    this.monitorPollIntervalMs = Number(options.monitorPollIntervalMs ?? 1200);
    this.monitorMaxRetries = Number(options.monitorMaxRetries ?? 5);
    this.monitorRetryDelayMs = Number(options.monitorRetryDelayMs ?? 1200);
    this.monitorFailedFile = path.resolve(options.monitorFailedFile || "./data/monitor_undelivered.jsonl");
    this.monitorOffsetFile = path.resolve(options.monitorOffsetFile || "./data/monitor_offset.json");
    this.monitorStateFile = path.resolve(options.monitorStateFile || "./data/supervisor_state.json");

    this.threadTurnCount = new Map();
    this.threadQueues = new Map();
    this.haltedThreads = new Map();
    this.threadExpectingCodex = new Map();
    this.threadExpectedPhase = new Map();
    this.threadStopAfterCodexFinals = new Map();
    this.threadCodexFinalCount = new Map();
    this.askQueue = Promise.resolve();
    this.monitorQueue = Promise.resolve();
    this.monitorSeq = 0;
    this.monitorPolling = false;
    this.monitorStopped = false;
    this.monitorUpdateOffset = 0;
    this.lastMonitorOffsetPersistedAt = 0;
    this.monitorDedup = new Map();
    this.activeAsk = null;

    this.boundOnMessage = (message) => {
      this.onBridgeMessage(message).catch((error) => {
        console.error("[supervisor] message handling failed", error);
        this.logEvent("supervisor.error", {
          threadId: message?.threadId ?? null,
          error: String(error?.message ?? error)
        }).catch(() => {});
      });
    };
  }

  async start() {
    if (!this.enabled) {
      return;
    }
    await this.loadMonitorState();
    await this.loadMonitorOffset();
    await this.syncMonitorOffsetOnStart();
    this.bridge.on("message", this.boundOnMessage);
    console.log(`[supervisor] enabled toolDir=${this.toolDir}`);
    await this.logEvent("supervisor.start", {
      toolDir: this.toolDir,
      toolConfig: this.toolConfig,
      initialPromptFile: this.initialPromptFile,
      monitorTelegramEnabled: this.monitorTelegramEnabled,
      monitorOffsetFile: this.monitorOffsetFile,
      monitorStateFile: this.monitorStateFile
    });
    await this.replayUndeliveredMonitorEvents();
    await this.startMonitorPolling();
    if (this.monitorTelegramEnabled) {
      try {
        await this.sendMonitorTelegram(`Supervisor started. state=${this.monitorStopped ? "stopped" : "running"}`);
      } catch (error) {
        await this.logEvent("monitor.startup_notice.failed", {
          error: String(error?.message ?? error)
        });
        console.warn("[supervisor] startup notice failed", error);
      }
    }
  }

  async stop() {
    this.bridge.off("message", this.boundOnMessage);
    await this.cancelActiveAsk("supervisor_stop");
    await this.stopMonitorPolling();
    await this.drainMonitorQueue();
    if (this.autoReleaseOnHalt) {
      const threadIds = [...this.threadTurnCount.keys()];
      for (const threadId of threadIds) {
        await this.releaseThreadBinding(threadId, "supervisor_stop");
      }
    }
    await this.saveMonitorState();
    await this.saveMonitorOffset({ force: true });
    await this.logEvent("supervisor.stop");
  }

  async monitorApiCall(method, body) {
    const url = `https://api.telegram.org/bot${this.monitorTelegramBotToken}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {})
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`telegram monitor api failed: ${method} ${response.status} ${detail}`);
    }
    const data = await response.json();
    if (!data?.ok) {
      throw new Error(`telegram monitor api error: ${method}`);
    }
    return data.result;
  }

  async startMonitorPolling() {
    if (!this.monitorTelegramEnabled || this.monitorPolling) {
      return;
    }
    this.monitorPolling = true;
    this.monitorPollLoopPromise = this.pollMonitorCommands().catch(async (error) => {
      await this.logEvent("monitor.polling.failed", {
        error: String(error?.message ?? error)
      });
    });
  }

  async stopMonitorPolling() {
    this.monitorPolling = false;
    if (this.monitorPollLoopPromise) {
      await this.monitorPollLoopPromise;
      this.monitorPollLoopPromise = null;
    }
  }

  async pollMonitorCommands() {
    while (this.monitorPolling) {
      try {
        const updates = await this.monitorApiCall("getUpdates", {
          offset: this.monitorUpdateOffset,
          timeout: 20,
          allowed_updates: ["message"]
        });
        for (const update of updates ?? []) {
          const nextOffset = Number(update?.update_id ?? 0) + 1;
          if (nextOffset > this.monitorUpdateOffset) {
            this.monitorUpdateOffset = nextOffset;
            await this.saveMonitorOffset();
          }
          await this.handleMonitorUpdate(update);
        }
      } catch (error) {
        await this.logEvent("monitor.poll.error", {
          error: String(error?.message ?? error)
        });
        await sleep(this.monitorPollIntervalMs);
      }
    }
  }

  async handleMonitorUpdate(update) {
    const msg = update?.message;
    if (!msg) {
      return;
    }
    const chatId = ensureText(msg?.chat?.id);
    if (chatId !== ensureText(this.monitorTelegramChatId)) {
      return;
    }
    const cmd = normalizeCommandText(msg?.text);
    if (cmd === "/stop") {
      this.monitorStopped = true;
      await this.saveMonitorState();
      await this.cancelActiveAsk("monitor_stop_command");
      for (const threadId of this.threadTurnCount.keys()) {
        this.haltThread(threadId, "monitor_stop_command");
        if (this.autoReleaseOnHalt) {
          await this.releaseThreadBinding(threadId, "monitor_stop_command");
        }
      }
      await this.logEvent("supervisor.halted", {
        reason: "monitor_stop_command",
        threadCount: this.threadTurnCount.size
      });
      await this.sendMonitorTelegram("Supervisor stopped by /stop. No more auto-injection will run.");
      return;
    }
    if (cmd === "/resume") {
      this.monitorStopped = false;
      await this.saveMonitorState();
      await this.logEvent("supervisor.resumed", {
        reason: "monitor_resume_command"
      });
      await this.sendMonitorTelegram("Supervisor resumed by /resume.");
      return;
    }
    if (cmd === "/status") {
      await this.sendMonitorTelegram(
        `Supervisor status: ${this.monitorStopped ? "stopped" : "running"}; queued_threads=${this.threadQueues.size}; known_threads=${this.threadTurnCount.size}; halted_threads=${this.haltedThreads.size}`
      );
    }
  }

  splitTelegramText(text, maxLen = 3500) {
    const raw = String(text ?? "");
    if (!raw) {
      return [""];
    }
    const parts = [];
    for (let i = 0; i < raw.length; i += maxLen) {
      parts.push(raw.slice(i, i + maxLen));
    }
    return parts;
  }

  enqueueMonitor(task) {
    const previous = this.monitorQueue ?? Promise.resolve();
    const next = previous.then(task, task);
    this.monitorQueue = next.catch(() => {});
    return next;
  }

  async drainMonitorQueue() {
    try {
      await (this.monitorQueue ?? Promise.resolve());
    } catch (error) {
      await this.logEvent("monitor.queue.drain_failed", {
        error: String(error?.message ?? error)
      });
    }
  }

  async appendUndelivered(event) {
    await fs.mkdir(path.dirname(this.monitorFailedFile), { recursive: true });
    await fs.appendFile(this.monitorFailedFile, `${JSON.stringify(event)}\n`, "utf8");
  }

  async sendMonitorWithRetry(event) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.monitorMaxRetries; attempt++) {
      try {
        await this.sendMonitorTelegram(String(event.text ?? ""));
        await this.logEvent("monitor.telegram.sent", {
          monitorKind: event.kind,
          seq: event.seq,
          threadId: event.threadId,
          turn: event.turn,
          attempt
        });
        return true;
      } catch (error) {
        lastError = error;
        await this.logEvent("monitor.telegram.retry", {
          monitorKind: event.kind,
          seq: event.seq,
          threadId: event.threadId,
          turn: event.turn,
          attempt,
          error: String(error?.message ?? error)
        });
        if (attempt < this.monitorMaxRetries) {
          await sleep(this.monitorRetryDelayMs);
        }
      }
    }
    const undelivered = {
      ts: Date.now(),
      monitorKind: event.kind,
      seq: event.seq,
      threadId: event.threadId,
      turn: event.turn,
      error: String(lastError?.message ?? lastError ?? "unknown"),
      text: String(event.text ?? "")
    };
    await this.logEvent("monitor.telegram.failed", undelivered);
    return false;
  }

  async replayUndeliveredMonitorEvents() {
    if (!this.monitorTelegramEnabled) {
      return;
    }
    let raw = "";
    try {
      raw = await fs.readFile(this.monitorFailedFile, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await this.logEvent("monitor.replay.read_failed", {
          error: String(error?.message ?? error)
        });
      }
      return;
    }

    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return;
    }

    await this.logEvent("monitor.replay.start", { count: lines.length });
    const remaining = [];
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const ok = await this.sendMonitorWithRetry({
        kind: ensureText(event.kind || "REPLAY"),
        seq: Number(event.seq ?? 0),
        threadId: ensureText(event.threadId || "-"),
        turn: Number(event.turn ?? 0),
        text: String(event.text ?? "")
      });
      if (!ok) {
        remaining.push(line);
      }
    }

    if (remaining.length === 0) {
      await fs.rm(this.monitorFailedFile, { force: true });
      await this.logEvent("monitor.replay.done", { deliveredAll: true });
      return;
    }

    await fs.mkdir(path.dirname(this.monitorFailedFile), { recursive: true });
    await fs.writeFile(this.monitorFailedFile, `${remaining.join("\n")}\n`, "utf8");
    await this.logEvent("monitor.replay.done", {
      deliveredAll: false,
      remaining: remaining.length
    });
  }

  async sendMonitorTelegram(text) {
    if (!this.monitorTelegramEnabled) {
      return;
    }
    const chunks = this.splitTelegramText(text, 3500);
    for (const chunk of chunks) {
      await this.monitorApiCall("sendMessage", {
        chat_id: this.monitorTelegramChatId,
        text: chunk
      });
    }
  }

  async notifyMonitor(kind, payload = {}) {
    if (!this.monitorTelegramEnabled) {
      return;
    }
    const threadId = ensureText(payload.threadId || "-");
    if (this.monitorThreadId && threadId !== this.monitorThreadId) {
      return;
    }
    const seq = ++this.monitorSeq;
    await this.enqueueMonitor(async () => {
      const turn = Number(payload.autoTurn ?? 0);
      const phase = ensureText(payload.phase || "");
      const text = ensureText(payload.text || "");
      const digest = createHash("sha1").update(text).digest("hex");
      const dedupKey = `${kind}|${threadId}|${turn}|${phase}|${digest}`;
      const now = Date.now();
      const lastTs = this.monitorDedup.get(dedupKey) ?? 0;
      if (now - lastTs < 5 * 60 * 1000) {
        await this.logEvent("monitor.telegram.duplicate_suppressed", {
          monitorKind: kind,
          threadId,
          turn
        });
        return;
      }
      this.monitorDedup.set(dedupKey, now);
      if (this.monitorDedup.size > 2000) {
        for (const [key, ts] of this.monitorDedup) {
          if (now - ts > 20 * 60 * 1000) {
            this.monitorDedup.delete(key);
          }
        }
      }
      const flowLabel =
        kind === "CODEX_FINAL"
          ? "[CODEX->SUPERVISOR][FINAL]"
          : kind === "SEND_TO_CHATGPT"
            ? "[SUPERVISOR->CHATGPT][SEND]"
            : kind === "CHATGPT_REPLY"
              ? "[CHATGPT->SUPERVISOR][FINAL]"
              : kind === "PREPARE_INJECT_TO_CODEX"
                ? "[SUPERVISOR->CODEX][PREPARE]"
                : kind === "STOPPED_AFTER_FINAL"
                  ? "[SUPERVISOR][STOPPED_AFTER_FINAL]"
                : `[SUPERVISOR][${kind}]`;
      const header = `${flowLabel} seq=${seq} thread=${threadId}${turn ? ` turn=${turn}` : ""}`;
      const body = text ? `\n\n${text}` : "";
      const message = `${header}${body}`;
      await this.logEvent("monitor.telegram.queued", {
        monitorKind: kind,
        seq,
        threadId,
        turn,
        textLen: message.length
      });
      const ok = await this.sendMonitorWithRetry({
        kind,
        seq,
        threadId,
        turn,
        text: message
      });
      if (!ok) {
        await this.appendUndelivered({
          ts: Date.now(),
          kind,
          seq,
          threadId,
          turn,
          text: message
        });
      }
    });
  }

  async logEvent(kind, payload = {}) {
    const event = {
      ts: Date.now(),
      kind,
      ...payload
    };
    await fs.mkdir(path.dirname(this.eventsFile), { recursive: true });
    await fs.appendFile(this.eventsFile, `${JSON.stringify(event)}\n`, "utf8");
  }

  shouldHandleThread(threadId) {
    if (this.threadId && threadId === this.threadId) {
      return true;
    }
    if (this.threadPrefix && threadId.startsWith(this.threadPrefix)) {
      return true;
    }
    if (!this.threadId && !this.threadPrefix) {
      return true;
    }
    return false;
  }

  isCodexFinalMessage(message) {
    if (message.from !== this.codexAdapterName) {
      return false;
    }
    const phase = ensureText(message.meta?.phase || "").toLowerCase();
    const status = ensureText(message.meta?.status || "").toLowerCase();
    if (status === "failed") {
      return true;
    }
    return phase === "final_answer";
  }

  isCodexFailedMessage(message) {
    const status = ensureText(message.meta?.status || "").toLowerCase();
    return status === "failed" || String(message.text ?? "").startsWith("Codex turn failed:");
  }

  shouldStopForLimits(message) {
    const haystack = `${ensureText(message.text)} ${ensureText(message.meta?.error || "")}`.toLowerCase();
    return (
      haystack.includes("usage limit") ||
      haystack.includes("rate limit") ||
      haystack.includes("quota") ||
      haystack.includes("context window exceeded") ||
      haystack.includes("contextwindowexceeded")
    );
  }

  isUserKickoffMessage(message) {
    if (!message || !message.threadId) {
      return false;
    }
    if (message.from === this.codexAdapterName || message.from === this.supervisorFrom) {
      return false;
    }
    if (ensureText(message.role || "user").toLowerCase() !== "user") {
      return false;
    }
    if (ensureText(message.type || "text").toLowerCase() !== "text") {
      return false;
    }
    if (!ensureText(message.text)) {
      return false;
    }
    return true;
  }

  haltThread(threadId, reason) {
    if (!threadId) {
      return;
    }
    this.threadExpectingCodex.delete(threadId);
    this.threadExpectedPhase.delete(threadId);
    this.threadStopAfterCodexFinals.delete(threadId);
    this.threadCodexFinalCount.delete(threadId);
    this.haltedThreads.set(threadId, {
      ts: Date.now(),
      reason: ensureText(reason || "halted")
    });
  }

  async releaseThreadBinding(threadId, reason = "halted") {
    if (!threadId) {
      return;
    }
    try {
      const adapter = this.bridge.getAdapter(this.codexAdapterName);
      if (!adapter || typeof adapter.releaseBridgeThread !== "function") {
        return;
      }
      const released = await adapter.releaseBridgeThread(threadId, {
        clearRuntime: this.autoReleaseClearRuntime
      });
      const codexThreadId = ensureText(released?.codexThreadId || "");
      if (!codexThreadId) {
        return;
      }
      await this.logEvent("supervisor.binding_released", {
        threadId,
        reason,
        codexThreadId
      });
    } catch (error) {
      await this.logEvent("supervisor.binding_release_failed", {
        threadId,
        reason,
        error: String(error?.message ?? error).slice(0, 800)
      });
    }
  }

  async haltWithReason(threadId, reason, extra = {}) {
    this.haltThread(threadId, reason);
    if (this.autoReleaseOnHalt) {
      await this.releaseThreadBinding(threadId, reason);
    }
    await this.logEvent("supervisor.halted", {
      threadId,
      reason,
      ...extra
    });
    const errorText = ensureText(extra.error || extra.text || "");
    await this.notifyMonitor("HALTED", {
      threadId,
      autoTurn: Number(extra.autoTurn ?? 0),
      text: errorText ? `reason=${reason}\n\n${errorText.slice(0, 3000)}` : `reason=${reason}`
    });
  }

  enqueueThread(threadId, task) {
    const previous = this.threadQueues.get(threadId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.threadQueues.set(
      threadId,
      next.finally(() => {
        if (this.threadQueues.get(threadId) === next) {
          this.threadQueues.delete(threadId);
        }
      })
    );
    return next;
  }

  isThreadAborted(threadId) {
    if (this.monitorStopped) {
      return true;
    }
    return this.haltedThreads.has(threadId);
  }

  async loadMonitorOffset() {
    if (!this.monitorTelegramEnabled) {
      return;
    }
    try {
      const raw = await fs.readFile(this.monitorOffsetFile, "utf8");
      const parsed = JSON.parse(raw);
      const offset = Number(parsed?.offset ?? 0);
      if (Number.isFinite(offset) && offset > 0) {
        this.monitorUpdateOffset = offset;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await this.logEvent("monitor.offset.load_failed", {
          error: String(error?.message ?? error)
        });
      }
    }
  }

  async loadMonitorState() {
    if (!this.monitorTelegramEnabled) {
      return;
    }
    try {
      const raw = await fs.readFile(this.monitorStateFile, "utf8");
      const parsed = JSON.parse(raw);
      this.monitorStopped = parsed?.monitorStopped === true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        await this.logEvent("monitor.state.load_failed", {
          error: String(error?.message ?? error)
        });
      }
    }
  }

  async saveMonitorState() {
    if (!this.monitorTelegramEnabled) {
      return;
    }
    await fs.mkdir(path.dirname(this.monitorStateFile), { recursive: true });
    await fs.writeFile(
      this.monitorStateFile,
      JSON.stringify({ monitorStopped: this.monitorStopped, ts: Date.now() }),
      "utf8"
    );
  }

  async saveMonitorOffset({ force = false } = {}) {
    if (!this.monitorTelegramEnabled) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastMonitorOffsetPersistedAt < 1000) {
      return;
    }
    await fs.mkdir(path.dirname(this.monitorOffsetFile), { recursive: true });
    await fs.writeFile(
      this.monitorOffsetFile,
      JSON.stringify({ offset: this.monitorUpdateOffset, ts: Date.now() }),
      "utf8"
    );
    this.lastMonitorOffsetPersistedAt = now;
  }

  async syncMonitorOffsetOnStart() {
    if (!this.monitorTelegramEnabled) {
      return;
    }
    try {
      const updates = await this.monitorApiCall("getUpdates", {
        offset: this.monitorUpdateOffset || undefined,
        timeout: 0,
        allowed_updates: ["message"]
      });
      let maxOffset = this.monitorUpdateOffset;
      for (const update of updates ?? []) {
        const next = Number(update?.update_id ?? 0) + 1;
        if (next > maxOffset) {
          maxOffset = next;
        }
      }
      if (maxOffset > this.monitorUpdateOffset) {
        this.monitorUpdateOffset = maxOffset;
        await this.saveMonitorOffset();
      }
    } catch (error) {
      await this.logEvent("monitor.offset.sync_failed", {
        error: String(error?.message ?? error)
      });
    }
  }

  enqueueAsk(task) {
    const previous = this.askQueue ?? Promise.resolve();
    const next = previous.then(task, task);
    this.askQueue = next.catch(() => {});
    return next;
  }

  nextTurnCount(threadId) {
    const current = this.threadTurnCount.get(threadId) ?? 0;
    const next = current + 1;
    this.threadTurnCount.set(threadId, next);
    return next;
  }

  buildPrompt(codexText, threadId) {
    const parts = [];
    if (this.promptPrefix) {
      parts.push(this.promptPrefix);
    }
    parts.push(`当前 bridge 会话: ${threadId}`);
    parts.push(
      "请基于 Codex 上一轮输出做 QA gatekeeper：判断验收质量、风险和剩余问题，然后只输出下一轮给 Codex 的简洁执行指令。"
    );
    parts.push("要求 Codex 大步推进、不要跑偏、必须自测并在结尾给 Progress Summary。");
    parts.push("[Codex 输出开始]");
    parts.push(codexText);
    parts.push("[Codex 输出结束]");
    return parts.join("\n\n");
  }

  async loadInitialPromptTemplate() {
    try {
      return await fs.readFile(this.initialPromptFile, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      return (
        "当前 bridge 会话: {{thread_id}}\n\n" +
        "这是本轮用户给你的启动信息：\n{{seed_text}}\n\n" +
        "请输出下一步给 Codex 的可执行指令。"
      );
    }
  }

  async buildInitialPrompt(threadId, seedText) {
    const template = await this.loadInitialPromptTemplate();
    return template
      .replaceAll("{{thread_id}}", ensureText(threadId))
      .replaceAll("{{seed_text}}", ensureText(seedText));
  }

  async resolveCodexCwd(sessionId, fallbackCwd = null) {
    const explicit = ensureText(fallbackCwd);
    if (explicit) {
      return explicit;
    }
    const adapter = this.bridge.getAdapter(this.codexAdapterName);
    if (!adapter || typeof adapter.call !== "function") {
      return null;
    }
    try {
      const read = await adapter.call("thread/read", {
        threadId: sessionId,
        includeItems: false,
        includeTurns: false
      });
      return ensureText(read?.thread?.cwd ?? read?.cwd ?? "") || null;
    } catch {
      return null;
    }
  }

  async bindCodexSessionForThread(threadId, sessionId, cwd = null, runtimeModel = null, runtimeEffort = null) {
    const codexThreadId = ensureText(sessionId);
    if (!codexThreadId) {
      return false;
    }
    let conflicts = await this.findOtherSessionBindings(threadId, codexThreadId);
    if (conflicts.length > 0 && this.autoTakeoverSupervisorSession) {
      for (const conflictThreadId of conflicts) {
        if (!this.isSupervisorThread(conflictThreadId)) {
          continue;
        }
        this.haltThread(conflictThreadId, "session_taken_over");
        await this.releaseThreadBinding(conflictThreadId, "session_taken_over");
      }
      conflicts = await this.findOtherSessionBindings(threadId, codexThreadId);
    }
    if (conflicts.length > 0) {
      throw new Error(`session already bound by other thread(s): ${conflicts.join(", ")}`);
    }
    const resolvedCwd = await this.resolveCodexCwd(codexThreadId, cwd);
    await this.bridge.store.setAdapterState(threadId, this.codexAdapterName, {
      codexThreadId,
      ...(resolvedCwd ? { codexCwd: resolvedCwd } : {}),
      ...(ensureText(runtimeModel) ? { runtimeModel: ensureText(runtimeModel) } : {}),
      ...(ensureText(runtimeEffort) ? { runtimeEffort: ensureText(runtimeEffort) } : {})
    });
    await this.logEvent("supervisor.session_bound", {
      threadId,
      codexThreadId,
      codexCwd: resolvedCwd,
      runtimeModel: ensureText(runtimeModel) || null,
      runtimeEffort: ensureText(runtimeEffort) || null
    });
    return true;
  }

  async findOtherSessionBindings(currentThreadId, codexThreadId) {
    const target = ensureText(codexThreadId);
    if (!target) {
      return [];
    }
    const threads = await this.bridge.store.listThreads();
    const conflicts = [];
    for (const threadId of threads) {
      if (threadId === currentThreadId) {
        continue;
      }
      const state = await this.bridge.store.getAdapterState(threadId, this.codexAdapterName);
      if (ensureText(state?.codexThreadId) === target) {
        conflicts.push(threadId);
      }
    }
    return conflicts;
  }

  isSupervisorThread(threadId) {
    const tid = ensureText(threadId);
    if (!tid) {
      return false;
    }
    if (this.threadId && tid === this.threadId) {
      return true;
    }
    if (this.threadPrefix && tid.startsWith(this.threadPrefix)) {
      return true;
    }
    return tid.startsWith("sup_");
  }

  async askChatgpt(prompt) {
    const args = ["run.py", "--config", this.toolConfig, "ask", "--text", prompt];
    const result = await runExecFile(this.pythonCommand, args, {
      cwd: this.toolDir,
      onSpawn: (child) => {
        this.activeAsk = {
          child,
          startedAt: Date.now(),
          promptLen: String(prompt ?? "").length
        };
      }
    });
    this.activeAsk = null;
    const reply = extractAskReply(result.stdout);
    if (!reply) {
      throw new Error("ChatGPT reply is empty");
    }
    return { reply, stdout: result.stdout, stderr: result.stderr };
  }

  async runChatgptAndInject({ threadId, turn, prompt, phase }) {
    if (this.isThreadAborted(threadId)) {
      await this.logEvent("supervisor.inject.skipped", {
        threadId,
        autoTurn: turn,
        phase,
        reason: "thread_aborted_before_chatgpt"
      });
      return;
    }
    if (this.monitorIncludeChatgptEvents) {
      await this.notifyMonitor("SEND_TO_CHATGPT", {
        threadId,
        autoTurn: turn,
        phase,
        text: prompt
      });
    }

    let chatgpt;
    try {
      chatgpt = await this.enqueueAsk(async () => {
        await this.logEvent("chatgpt.ask.started", {
          threadId,
          autoTurn: turn,
          phase
        });
        try {
          return await this.askChatgpt(prompt);
        } finally {
          this.activeAsk = null;
        }
      });
    } catch (error) {
      if (this.isThreadAborted(threadId)) {
        await this.logEvent("supervisor.inject.skipped", {
          threadId,
          autoTurn: turn,
          phase,
          reason: "thread_aborted_during_chatgpt_ask"
        });
        return;
      }
      throw error;
    }

    const chatgptReplyText = String(chatgpt.reply ?? "");

    await this.logEvent("chatgpt.reply_received", {
      threadId,
      autoTurn: turn,
      phase,
      replyLen: chatgptReplyText.length
    });
    if (this.monitorIncludeChatgptEvents) {
      await this.notifyMonitor("CHATGPT_REPLY", {
        threadId,
        autoTurn: turn,
        phase,
        text: chatgptReplyText
      });
    }

    if (this.isThreadAborted(threadId)) {
      await this.logEvent("supervisor.inject.skipped", {
        threadId,
        autoTurn: turn,
        phase,
        reason: "thread_aborted_before_codex_send"
      });
      return;
    }

    await this.logEvent("codex.turn_injected", {
      threadId,
      autoTurn: turn,
      phase
    });
    if (this.monitorIncludeChatgptEvents) {
      await this.notifyMonitor("PREPARE_INJECT_TO_CODEX", {
        threadId,
        autoTurn: turn,
        phase,
        text: `Prepared ChatGPT reply for Codex injection. replyLen=${chatgptReplyText.length}`
      });
    }

    this.threadExpectingCodex.set(threadId, true);
    this.threadExpectedPhase.set(threadId, phase);

    await this.bridge.send({
      threadId,
      from: this.supervisorFrom,
      to: this.codexAdapterName,
      role: "user",
      type: "text",
      text: chatgptReplyText,
      meta: {
        replyTo: "console",
        supervisor: "chatgpt",
        autoTurn: turn,
        phase
      }
    });
  }

  async onBridgeMessage(message) {
    if (!this.enabled) {
      return;
    }
    if (!this.shouldHandleThread(message.threadId)) {
      return;
    }

    const isCodexFinal = this.isCodexFinalMessage(message);

    if (!isCodexFinal && (this.monitorStopped || this.haltedThreads.has(message.threadId))) {
      return;
    }

    if (this.isUserKickoffMessage(message)) {
      await this.enqueueThread(message.threadId, async () => {
        if ((this.threadTurnCount.get(message.threadId) ?? 0) > 0) {
          await this.logEvent("supervisor.kickoff.ignored", {
            threadId: message.threadId,
            reason: "already_started"
          });
          return;
        }

        const turn = this.nextTurnCount(message.threadId);
        if (turn > this.maxAutoTurnsPerThread) {
          await this.haltWithReason(message.threadId, "max_auto_turns_reached", { autoTurn: turn });
          return;
        }

        try {
          const stopAfterCodexFinals = positiveInt(
            message.meta?.stopAfterCodexFinals ?? message.meta?.maxCodexFinals
          );
          if (stopAfterCodexFinals) {
            this.threadStopAfterCodexFinals.set(message.threadId, stopAfterCodexFinals);
            this.threadCodexFinalCount.set(message.threadId, 0);
          }

          const incomingSessionId = ensureText(message.meta?.codexThreadId || message.meta?.sessionId || "");
          if (incomingSessionId) {
            const runtimeModel = ensureText(message.meta?.runtimeModel || "");
            const runtimeEffort = ensureText(message.meta?.runtimeEffort || "");
            await this.bindCodexSessionForThread(
              message.threadId,
              incomingSessionId,
              message.meta?.codexCwd ?? null,
              runtimeModel,
              runtimeEffort
            );
          }

          const initialPrompt = await this.buildInitialPrompt(message.threadId, String(message.text ?? ""));
          await this.logEvent("supervisor.kickoff", {
            threadId: message.threadId,
            autoTurn: turn,
            seedLen: String(message.text ?? "").length
          });
          await this.runChatgptAndInject({
            threadId: message.threadId,
            turn,
            prompt: initialPrompt,
            phase: "kickoff"
          });
        } catch (error) {
          await this.haltWithReason(message.threadId, "supervisor_kickoff_failed", {
            autoTurn: turn,
            error: String(error?.message ?? error).slice(0, 1000)
          });
        }
      });
      return;
    }

    if (!isCodexFinal) {
      return;
    }

    if (!this.threadExpectingCodex.get(message.threadId)) {
      await this.logEvent("codex.final_ignored", {
        threadId: message.threadId,
        reason: "unexpected_codex_final_without_supervisor_injection"
      });
      return;
    }

    if (this.stopOnCodexFailure && this.isCodexFailedMessage(message)) {
      await this.haltWithReason(message.threadId, "codex_failed", {
        text: ensureText(message.text).slice(0, 500)
      });
      return;
    }

    if (this.stopOnUsageLimit && this.shouldStopForLimits(message)) {
      await this.haltWithReason(message.threadId, "usage_or_rate_limit", {
        text: ensureText(message.text).slice(0, 500)
      });
      return;
    }

    await this.enqueueThread(message.threadId, async () => {
      const turn = this.nextTurnCount(message.threadId);
      const expectedPhase = ensureText(this.threadExpectedPhase.get(message.threadId) || "unknown");
      if (turn > this.maxAutoTurnsPerThread) {
        console.warn(`[supervisor] thread=${message.threadId} reached max auto turns`);
        await this.haltWithReason(message.threadId, "max_auto_turns_reached", { autoTurn: turn });
        return;
      }

      console.log(`[supervisor] thread=${message.threadId} sending codex output to ChatGPT`);

      await this.logEvent("codex.final_received", {
        threadId: message.threadId,
        autoTurn: turn,
        textLen: String(message.text ?? "").length,
        meta: message.meta ?? {}
      });
      await this.notifyMonitor("CODEX_FINAL", {
        threadId: message.threadId,
        autoTurn: turn,
        phase: expectedPhase,
        text: String(message.text ?? "")
      });

      this.threadExpectingCodex.set(message.threadId, false);

      const finalCount = (this.threadCodexFinalCount.get(message.threadId) ?? 0) + 1;
      this.threadCodexFinalCount.set(message.threadId, finalCount);
      const stopAfterFinals = this.threadStopAfterCodexFinals.get(message.threadId) ?? 0;
      if (stopAfterFinals > 0 && finalCount >= stopAfterFinals) {
        this.haltThread(message.threadId, "stop_after_codex_finals_reached");
        if (this.autoReleaseOnHalt) {
          await this.releaseThreadBinding(message.threadId, "stop_after_codex_finals_reached");
        }
        await this.logEvent("supervisor.stopped_after_codex_finals", {
          threadId: message.threadId,
          autoTurn: turn,
          finalCount,
          stopAfterFinals
        });
        await this.notifyMonitor("STOPPED_AFTER_FINAL", {
          threadId: message.threadId,
          autoTurn: turn,
          phase: expectedPhase,
          text: `reason=stop_after_codex_finals_reached finalCount=${finalCount}`
        });
        return;
      }

      if (this.isThreadAborted(message.threadId)) {
        const stopReason =
          this.haltedThreads.get(message.threadId)?.reason ?? (this.monitorStopped ? "monitor_stopped" : "aborted");
        await this.logEvent("supervisor.final_after_stop", {
          threadId: message.threadId,
          autoTurn: turn,
          reason: stopReason
        });
        await this.notifyMonitor("STOPPED_AFTER_FINAL", {
          threadId: message.threadId,
          autoTurn: turn,
          phase: expectedPhase,
          text: `reason=${stopReason}`
        });
        return;
      }

      const prompt = this.buildPrompt(message.text, message.threadId);

      try {
        await this.runChatgptAndInject({
          threadId: message.threadId,
          turn,
          prompt,
          phase: "loop"
        });
      } catch (error) {
        await this.haltWithReason(message.threadId, "supervisor_ask_failed", {
          autoTurn: turn,
          error: String(error?.message ?? error).slice(0, 1000)
        });
      }
    });
  }

  async cancelActiveAsk(reason = "cancelled") {
    const active = this.activeAsk;
    if (!active?.child || active.child.killed) {
      return;
    }
    try {
      active.child.kill("SIGTERM");
      await this.logEvent("chatgpt.ask.cancelled", {
        reason,
        startedAt: active.startedAt ?? null,
        promptLen: active.promptLen ?? null
      });
    } catch (error) {
      await this.logEvent("chatgpt.ask.cancel_failed", {
        reason,
        error: String(error?.message ?? error)
      });
    }
  }
}
