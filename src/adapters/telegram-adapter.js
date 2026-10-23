import { BaseAdapter } from "./base-adapter.js";

function ensureText(value) {
  return String(value ?? "").trim();
}

function isCommandText(text) {
  return typeof text === "string" && text.startsWith("/");
}

function commandName(rawCommand) {
  const withoutSlash = ensureText(rawCommand).replace(/^\//, "");
  const [name] = withoutSlash.split("@");
  return name.toLowerCase();
}

function shortId(id, max = 12) {
  const text = ensureText(id);
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

export class TelegramAdapter extends BaseAdapter {
  constructor(name, options = {}) {
    super(name, options);
    this.token = ensureText(options.token ?? process.env.TELEGRAM_BOT_TOKEN);
    this.allowedChatId = ensureText(options.chatId ?? process.env.TELEGRAM_CHAT_ID);
    this.threadId = ensureText(options.threadId ?? "tg_default");
    this.sessionThreadPrefix = ensureText(options.sessionThreadPrefix ?? "tg_");
    this.supervisorThreadPrefix = ensureText(options.supervisorThreadPrefix ?? "sup_");
    this.outboundThreadPrefix = ensureText(options.outboundThreadPrefix ?? this.sessionThreadPrefix);
    this.defaultTo = options.defaultTo ?? null;
    this.codexAdapterName = ensureText(options.codexAdapterName ?? "codex");
    this.pollIntervalMs = Number(options.pollIntervalMs ?? 500);
    this.pollTimeoutSec = Number(options.pollTimeoutSec ?? 25);
    this.drainOnStart = options.drainOnStart === true;
    this.maxSessionButtons = Number(options.maxSessionButtons ?? 12);

    this.running = false;
    this.loopPromise = null;
    this.nextOffset = 0;
    this.lastPollingStatePersistedAt = 0;
    this.baseUrl = this.token ? `https://api.telegram.org/bot${this.token}` : null;

    this.selectedCodexThreadId = null;
    this.selectedBridgeThreadId = null;
  }

  validateConfig() {
    if (!this.token) {
      throw new Error(`[${this.name}] TELEGRAM_BOT_TOKEN is required`);
    }
    if (!this.allowedChatId) {
      throw new Error(`[${this.name}] TELEGRAM_CHAT_ID is required`);
    }
  }

  async start() {
    this.validateConfig();
    await this.loadSelectionState();
    await this.setupCommands();

    this.running = true;
    if (this.drainOnStart) {
      await this.drainPendingUpdates();
    }
    this.loopPromise = this.pollLoop();
  }

  async stop() {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise.catch(() => {});
      this.loopPromise = null;
    }
  }

  async loadSelectionState() {
    const saved = await this.bridge.store.getAdapterState(this.threadId, this.name);
    this.selectedCodexThreadId = ensureText(saved.selectedCodexThreadId || "") || null;
    this.selectedBridgeThreadId = ensureText(saved.selectedBridgeThreadId || "") || null;
    const nextOffset = Number(saved.nextOffset ?? 0);
    if (Number.isFinite(nextOffset) && nextOffset > 0) {
      this.nextOffset = nextOffset;
    }
  }

  async persistSelectionState() {
    await this.bridge.store.setAdapterState(this.threadId, this.name, {
      selectedCodexThreadId: this.selectedCodexThreadId,
      selectedBridgeThreadId: this.selectedBridgeThreadId,
      nextOffset: this.nextOffset
    });
  }

  async persistPollingState(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPollingStatePersistedAt < 1000) {
      return;
    }
    await this.bridge.store.setAdapterState(this.threadId, this.name, {
      selectedCodexThreadId: this.selectedCodexThreadId,
      selectedBridgeThreadId: this.selectedBridgeThreadId,
      nextOffset: this.nextOffset
    });
    this.lastPollingStatePersistedAt = now;
  }

  isSupervisorBridgeThread(threadId) {
    const tid = ensureText(threadId);
    return Boolean(this.supervisorThreadPrefix && tid.startsWith(this.supervisorThreadPrefix));
  }

  bridgeThreadForSession(codexThreadId) {
    return `${this.sessionThreadPrefix}${codexThreadId}`;
  }

  currentBridgeThreadId() {
    return this.selectedBridgeThreadId || this.threadId;
  }

  async setupCommands() {
    await this.apiCall("setMyCommands", {
      commands: [
        { command: "sessions", description: "List sessions and choose one" },
        { command: "use", description: "Use a session: /use <session_id>" },
        { command: "current", description: "Show current selected session" },
        { command: "runtime", description: "Show current model + effort" },
        { command: "model", description: "Set model: /model <name>" },
        { command: "effort", description: "Set effort: /effort low|medium|high|xhigh" },
        { command: "reset", description: "Reset and start a fresh session" },
        { command: "help", description: "Show command help" }
      ]
    });
  }

  async apiCall(method, body) {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {})
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`[${this.name}] Telegram HTTP ${response.status}: ${detail}`);
    }

    const payload = await response.json();
    if (!payload.ok) {
      throw new Error(`[${this.name}] Telegram API error: ${payload.description ?? "unknown"}`);
    }
    return payload.result;
  }

  async getUpdates(timeoutSec) {
    return this.apiCall("getUpdates", {
      timeout: timeoutSec,
      offset: this.nextOffset || undefined,
      allowed_updates: ["message", "callback_query"]
    });
  }

  async drainPendingUpdates() {
    const updates = await this.getUpdates(0);
    let maxId = null;
    for (const item of updates ?? []) {
      if (Number.isFinite(item.update_id)) {
        maxId = maxId === null ? item.update_id : Math.max(maxId, item.update_id);
      }
    }
    if (maxId !== null) {
      this.nextOffset = maxId + 1;
    }
  }

  shouldAcceptChat(chatId) {
    return ensureText(chatId) === this.allowedChatId;
  }

  async sendText(text, extra = {}) {
    const message = ensureText(text);
    if (!message) {
      return;
    }
    await this.apiCall("sendMessage", {
      chat_id: this.allowedChatId,
      text: message,
      ...extra
    });
  }

  async sendHelp() {
    await this.sendText(
      [
        "Commands:",
        "/sessions - list available session ids and choose one",
        "/use <session_id> - switch to a specific session",
        "/current - show current bound session",
        "/runtime - show current model + effort",
        "/model <name> - set model for current conversation",
        "/effort <low|medium|high|xhigh> - set reasoning effort",
        "/reset - clear current binding and start fresh",
        "",
        "After choosing a session, normal messages continue in that session."
      ].join("\n")
    );
  }

  async listCodexSessions(limit = 30) {
    const codexAdapter = this.bridge.getAdapter(this.codexAdapterName);
    if (!codexAdapter || typeof codexAdapter.call !== "function") {
      return [];
    }

    const response = await codexAdapter.call("thread/list", {
      archived: false,
      limit,
      sortKey: "updated_at"
    });
    return Array.isArray(response?.data) ? response.data : [];
  }

  async findOtherBindings(codexThreadId, currentBridgeThreadId) {
    const target = ensureText(codexThreadId);
    if (!target) {
      return [];
    }
    const threads = await this.bridge.store.listThreads();
    const others = [];
    for (const threadId of threads) {
      if (threadId === currentBridgeThreadId) {
        continue;
      }
      const state = await this.bridge.store.getAdapterState(threadId, this.codexAdapterName);
      if (state?.codexThreadId === target) {
        others.push(threadId);
      }
    }
    return others;
  }

  async bindSession(codexThreadId) {
    const target = ensureText(codexThreadId);
    if (!target) {
      throw new Error("session id is required");
    }

    const bridgeThreadId = this.bridgeThreadForSession(target);
    const conflicts = await this.findOtherBindings(target, bridgeThreadId);
    if (conflicts.length > 0) {
      throw new Error(
        `session already bound by other thread(s): ${conflicts.join(", ")}`
      );
    }

    let codexCwd = null;
    const codexAdapter = this.bridge.getAdapter(this.codexAdapterName);
    if (codexAdapter && typeof codexAdapter.call === "function") {
      try {
        const read = await codexAdapter.call("thread/read", {
          threadId: target,
          includeTurns: false
        });
        codexCwd = ensureText(read?.thread?.cwd ?? read?.cwd ?? "") || null;
      } catch {
        codexCwd = null;
      }
    }

    await this.bridge.store.setAdapterState(bridgeThreadId, this.codexAdapterName, {
      codexThreadId: target,
      codexCwd
    });

    this.selectedCodexThreadId = target;
    this.selectedBridgeThreadId = bridgeThreadId;
    await this.persistSelectionState();
    return { codexThreadId: target, bridgeThreadId, codexCwd };
  }

  async clearBinding() {
    this.selectedCodexThreadId = null;
    this.selectedBridgeThreadId = null;
    await this.persistSelectionState();
  }

  async getCurrentRuntime() {
    const codexState = await this.bridge.store.getAdapterState(this.currentBridgeThreadId(), this.codexAdapterName);
    const codexAdapter = this.bridge.getAdapter(this.codexAdapterName);
    const defaultModel = codexAdapter?.model ?? "gpt-5.4";
    return {
      model: ensureText(codexState?.runtimeModel || "") || defaultModel,
      effort: ensureText(codexState?.runtimeEffort || "") || "medium"
    };
  }

  async setCurrentRuntime(partial) {
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(partial, "model")) {
      const model = ensureText(partial.model);
      if (!model) {
        throw new Error("model cannot be empty");
      }
      patch.runtimeModel = model;
    }
    if (Object.prototype.hasOwnProperty.call(partial, "effort")) {
      const effort = ensureText(partial.effort).toLowerCase();
      const allowed = new Set(["low", "medium", "high", "xhigh"]);
      if (!allowed.has(effort)) {
        throw new Error("effort must be one of: low, medium, high, xhigh");
      }
      patch.runtimeEffort = effort;
    }

    await this.bridge.store.setAdapterState(this.currentBridgeThreadId(), this.codexAdapterName, patch);
    return this.getCurrentRuntime();
  }

  async showCurrentBinding() {
    if (!this.selectedCodexThreadId) {
      await this.sendText("Current session: fresh (not bound). Send message to start a new session.");
      return;
    }

    const codexState = await this.bridge.store.getAdapterState(this.currentBridgeThreadId(), this.codexAdapterName);
    await this.sendText(
      `Current session:\n${this.selectedCodexThreadId}\nBridge thread: ${this.currentBridgeThreadId()}\nCWD: ${codexState?.codexCwd ?? "(default)"}`
    );
  }

  async showRuntime() {
    const runtime = await this.getCurrentRuntime();
    await this.sendText(`Runtime:\nmodel: ${runtime.model}\neffort: ${runtime.effort}`);
  }

  async showSessionMenu() {
    const sessions = await this.listCodexSessions();
    if (sessions.length === 0) {
      await this.sendText("No sessions found.");
      return;
    }

    const top = sessions.slice(0, this.maxSessionButtons);
    const inlineKeyboard = top.map((session) => {
      const id = ensureText(session.id);
      const name = ensureText(session.name || "");
      const label = name ? `${name.slice(0, 24)} · ${shortId(id)}` : shortId(id);
      return [{ text: label, callback_data: `use:${id}` }];
    });

    await this.sendText("Select a session:", {
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
  }

  async handleCommand(text) {
    const [rawCommand, ...args] = ensureText(text).split(/\s+/);
    const cmd = commandName(rawCommand);

    if (cmd === "help" || cmd === "start") {
      await this.sendHelp();
      return;
    }

    if (cmd === "sessions") {
      await this.showSessionMenu();
      return;
    }

    if (cmd === "use") {
      const sessionId = ensureText(args[0]);
      if (!sessionId) {
        await this.sendText("Usage: /use <session_id>");
        return;
      }
      const selected = await this.bindSession(sessionId);
      await this.sendText(
        `Switched to session:\n${selected.codexThreadId}\nBridge thread: ${selected.bridgeThreadId}\nCWD: ${selected.codexCwd ?? "(default)"}`
      );
      return;
    }

    if (cmd === "current") {
      await this.showCurrentBinding();
      return;
    }

    if (cmd === "runtime") {
      await this.showRuntime();
      return;
    }

    if (cmd === "model") {
      const model = args.join(" ").trim();
      if (!model) {
        await this.sendText("Usage: /model <name>");
        return;
      }
      const runtime = await this.setCurrentRuntime({ model });
      await this.sendText(`Updated runtime:\nmodel: ${runtime.model}\neffort: ${runtime.effort}`);
      return;
    }

    if (cmd === "effort") {
      const effort = ensureText(args[0]).toLowerCase();
      if (!effort) {
        await this.sendText("Usage: /effort <low|medium|high|xhigh>");
        return;
      }
      const runtime = await this.setCurrentRuntime({ effort });
      await this.sendText(`Updated runtime:\nmodel: ${runtime.model}\neffort: ${runtime.effort}`);
      return;
    }

    if (cmd === "reset") {
      await this.clearBinding();
      await this.sendText("Session binding cleared. Next message will use a fresh session.");
      return;
    }

    await this.sendText("Unknown command. Use /help.");
  }

  async safeAnswerCallbackQuery(callbackQueryId, text) {
    try {
      await this.apiCall("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text
      });
    } catch (error) {
      const message = String(error?.message ?? "");
      if (message.includes("query is too old")) {
        return;
      }
      throw error;
    }
  }

  async handleCallbackQuery(callbackQuery) {
    const chatId = ensureText(callbackQuery?.message?.chat?.id);
    if (!this.shouldAcceptChat(chatId)) {
      return;
    }

    const data = ensureText(callbackQuery?.data);
    if (data.startsWith("use:")) {
      const sessionId = ensureText(data.slice(4));
      try {
        const selected = await this.bindSession(sessionId);
        await this.safeAnswerCallbackQuery(callbackQuery.id, `Using ${shortId(selected.codexThreadId, 20)}`);
        await this.sendText(
          `Switched to session:\n${selected.codexThreadId}\nBridge thread: ${selected.bridgeThreadId}\nCWD: ${selected.codexCwd ?? "(default)"}`
        );
      } catch (error) {
        await this.safeAnswerCallbackQuery(callbackQuery.id, "Failed to switch session");
        await this.sendText(`Failed to switch session: ${error.message}`);
      }
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQuery.id, "Unsupported action");
  }

  async forwardUserMessage(text, chatId, messageId) {
    const threadId = this.currentBridgeThreadId();
    const supervisorKickoffOnly = this.isSupervisorBridgeThread(threadId);
    await this.emitMessage({
      threadId,
      from: this.name,
      to: supervisorKickoffOnly ? null : this.defaultTo,
      role: "user",
      type: "text",
      text,
      meta: {
        telegramChatId: chatId,
        telegramMessageId: messageId ?? null,
        replyTo: this.name,
        telegramSelectedCodexThreadId: this.selectedCodexThreadId,
        supervisorKickoffOnly
      }
    });
  }

  async handleMessage(message) {
    if (!message || message.from?.is_bot === true) {
      return;
    }

    const chatId = ensureText(message.chat?.id);
    if (!this.shouldAcceptChat(chatId)) {
      return;
    }

    const text = ensureText(message.text ?? message.caption);
    if (!text) {
      return;
    }

    if (isCommandText(text)) {
      try {
        await this.handleCommand(text);
      } catch (error) {
        await this.sendText(`Command failed: ${error.message}`);
      }
      return;
    }

    await this.forwardUserMessage(text, chatId, message.message_id);
  }

  async handleUpdate(update) {
    if (update?.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    if (update?.message) {
      await this.handleMessage(update.message);
    }
  }

  async pollLoop() {
    while (this.running) {
      try {
        const updates = await this.getUpdates(this.pollTimeoutSec);
        for (const update of updates ?? []) {
          if (Number.isFinite(update.update_id)) {
            this.nextOffset = Math.max(this.nextOffset, update.update_id + 1);
            await this.persistPollingState();
          }
          try {
            await this.handleUpdate(update);
          } catch (error) {
            console.error(`[${this.name}] update failed`, error);
          }
        }
      } catch (error) {
        console.error(`[${this.name}] poll failed`, error);
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }

  async send(message) {
    const text = ensureText(message.text);
    if (!text) {
      return;
    }
    const phase = ensureText(message?.meta?.phase || "").toLowerCase();
    const status = ensureText(message?.meta?.status || "").toLowerCase();

    const isFinal = phase === "final_answer";
    const isFailed = status === "failed" || text.startsWith("Codex turn failed:");
    const hasPhase = phase.length > 0;

    // Suppress in-progress assistant pushes; only notify on final completion/failure.
    if (message?.from === this.codexAdapterName && hasPhase && !isFinal && !isFailed) {
      return;
    }
    if (message?.from === this.codexAdapterName && this.outboundThreadPrefix) {
      const threadId = ensureText(message?.threadId || "");
      if (!threadId.startsWith(this.outboundThreadPrefix)) {
        return;
      }
    }

    await this.sendText(text);
  }
}
