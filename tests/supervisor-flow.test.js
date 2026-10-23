import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatgptSupervisor } from "../src/supervision/chatgpt-supervisor.js";

function createSupervisor() {
  const bridge = {
    on() {},
    off() {}
  };
  const supervisor = new ChatgptSupervisor({
    bridge,
    options: {
      enabled: true,
      codexAdapterName: "codex",
      supervisorFrom: "chatgpt_supervisor",
      monitorTelegramBotToken: "test-bot-token",
      monitorTelegramChatId: "10001"
    }
  });
  return supervisor;
}

test("loop prompt uses short QA gatekeeper reminder", () => {
  const supervisor = createSupervisor();
  const prompt = supervisor.buildPrompt("## Progress Summary\n- Completed: A", "sup_prompt_case");

  assert.match(prompt, /当前 bridge 会话: sup_prompt_case/);
  assert.match(prompt, /QA gatekeeper/);
  assert.match(prompt, /验收质量、风险和剩余问题/);
  assert.match(prompt, /大步推进、不要跑偏、必须自测/);
  assert.match(prompt, /Progress Summary/);
  assert.match(prompt, /\[Codex 输出开始\]/);
  assert.match(prompt, /\[Codex 输出结束\]/);
  assert.equal(prompt.includes("你现在不是写代码的人"), false);
  assert.equal(prompt.includes("你的职责只有三件事"), false);
});

test("CODEX_FINAL uses expected injected phase", async () => {
  const supervisor = createSupervisor();
  const pushed = [];
  supervisor.logEvent = async () => {};
  supervisor.notifyMonitor = async (kind, payload) => {
    pushed.push({ kind, payload });
  };
  supervisor.runChatgptAndInject = async () => {};

  supervisor.threadExpectingCodex.set("sup_case_phase", true);
  supervisor.threadExpectedPhase.set("sup_case_phase", "kickoff");

  await supervisor.onBridgeMessage({
    threadId: "sup_case_phase",
    from: "codex",
    role: "assistant",
    type: "text",
    text: "FINAL_OK",
    meta: { phase: "final_answer" }
  });

  const codexFinal = pushed.find((item) => item.kind === "CODEX_FINAL");
  assert.ok(codexFinal, "CODEX_FINAL should be emitted");
  assert.equal(codexFinal.payload.phase, "kickoff");
});

test("stop state keeps final observable and emits STOPPED_AFTER_FINAL", async () => {
  const supervisor = createSupervisor();
  const pushed = [];
  let reinjectCount = 0;

  supervisor.logEvent = async () => {};
  supervisor.notifyMonitor = async (kind, payload) => {
    pushed.push({ kind, payload });
  };
  supervisor.runChatgptAndInject = async () => {
    reinjectCount += 1;
  };

  supervisor.monitorStopped = true;
  supervisor.threadExpectingCodex.set("sup_case_stop", true);
  supervisor.threadExpectedPhase.set("sup_case_stop", "loop");

  await supervisor.onBridgeMessage({
    threadId: "sup_case_stop",
    from: "codex",
    role: "assistant",
    type: "text",
    text: "FINAL_WHILE_STOPPED",
    meta: { phase: "final_answer" }
  });

  const kinds = pushed.map((item) => item.kind);
  assert.ok(kinds.includes("CODEX_FINAL"), "final should still be visible");
  assert.ok(kinds.includes("STOPPED_AFTER_FINAL"), "stop terminal event should be emitted");
  assert.equal(reinjectCount, 0, "stopped supervisor must not re-inject new turns");
});

test("stopAfterCodexFinals stops after visible final without asking ChatGPT again", async () => {
  const supervisor = createSupervisor();
  const pushed = [];
  const events = [];
  let reinjectCount = 0;

  supervisor.logEvent = async (kind, payload = {}) => {
    events.push({ kind, payload });
  };
  supervisor.notifyMonitor = async (kind, payload) => {
    pushed.push({ kind, payload });
  };
  supervisor.runChatgptAndInject = async () => {
    reinjectCount += 1;
  };

  supervisor.threadExpectingCodex.set("sup_case_final_limit", true);
  supervisor.threadExpectedPhase.set("sup_case_final_limit", "loop");
  supervisor.threadStopAfterCodexFinals.set("sup_case_final_limit", 1);
  supervisor.threadCodexFinalCount.set("sup_case_final_limit", 0);

  await supervisor.onBridgeMessage({
    threadId: "sup_case_final_limit",
    from: "codex",
    role: "assistant",
    type: "text",
    text: "FINAL_FOR_LIMIT",
    meta: { phase: "final_answer" }
  });

  assert.ok(pushed.some((item) => item.kind === "CODEX_FINAL"), "final should be pushed first");
  assert.ok(pushed.some((item) => item.kind === "STOPPED_AFTER_FINAL"), "limit stop should be visible");
  assert.ok(
    events.some((event) => event.kind === "supervisor.stopped_after_codex_finals"),
    "limit stop should be logged"
  );
  assert.equal(reinjectCount, 0, "final limit must not ask ChatGPT again");
});

test("monitor pushes full supervisor flow events by default and records delivery", async () => {
  const supervisor = createSupervisor();
  const events = [];
  const telegramCalls = [];

  supervisor.logEvent = async (kind, payload = {}) => {
    events.push({ kind, payload });
  };
  supervisor.monitorApiCall = async (method, body) => {
    telegramCalls.push({ method, body });
    return {};
  };

  assert.equal(supervisor.monitorIncludeChatgptEvents, true);

  await supervisor.notifyMonitor("SEND_TO_CHATGPT", {
    threadId: "sup_monitor_case",
    autoTurn: 1,
    phase: "kickoff",
    text: "prompt"
  });
  await supervisor.notifyMonitor("CHATGPT_REPLY", {
    threadId: "sup_monitor_case",
    autoTurn: 1,
    phase: "kickoff",
    text: "reply"
  });
  await supervisor.notifyMonitor("PREPARE_INJECT_TO_CODEX", {
    threadId: "sup_monitor_case",
    autoTurn: 1,
    phase: "kickoff",
    text: "reply"
  });

  assert.equal(telegramCalls.length, 3);
  assert.deepEqual(
    telegramCalls.map((call) => call.method),
    ["sendMessage", "sendMessage", "sendMessage"]
  );
  assert.equal(events.filter((event) => event.kind === "monitor.telegram.queued").length, 3);
  assert.equal(events.filter((event) => event.kind === "monitor.telegram.sent").length, 3);
});

test("ChatGPT reply is not duplicated in Codex injection monitor notification", async () => {
  const supervisor = createSupervisor();
  const pushed = [];
  const sent = [];

  supervisor.logEvent = async () => {};
  supervisor.askChatgpt = async () => ({
    reply: "FULL_CHATGPT_REPLY_FOR_CODEX",
    stdout: "",
    stderr: ""
  });
  supervisor.notifyMonitor = async (kind, payload) => {
    pushed.push({ kind, payload });
  };
  supervisor.bridge.send = async (message) => {
    sent.push(message);
  };

  await supervisor.runChatgptAndInject({
    threadId: "sup_no_duplicate_monitor_case",
    turn: 1,
    prompt: "PROMPT_FOR_CHATGPT",
    phase: "kickoff"
  });

  const replyPush = pushed.find((item) => item.kind === "CHATGPT_REPLY");
  const injectPush = pushed.find((item) => item.kind === "PREPARE_INJECT_TO_CODEX");

  assert.equal(replyPush.payload.text, "FULL_CHATGPT_REPLY_FOR_CODEX");
  assert.notEqual(injectPush.payload.text, "FULL_CHATGPT_REPLY_FOR_CODEX");
  assert.match(injectPush.payload.text, /replyLen=28/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "FULL_CHATGPT_REPLY_FOR_CODEX");
});

test("monitor delivery logs keep event kind separate from pushed flow kind", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-monitor-"));
  const eventsFile = path.join(tmpDir, "events.jsonl");
  const supervisor = new ChatgptSupervisor({
    bridge: {
      on() {},
      off() {}
    },
    options: {
      enabled: true,
      codexAdapterName: "codex",
      supervisorFrom: "chatgpt_supervisor",
      monitorTelegramBotToken: "test-bot-token",
      monitorTelegramChatId: "10001",
      eventsFile
    }
  });
  supervisor.monitorApiCall = async () => ({});

  await supervisor.notifyMonitor("SEND_TO_CHATGPT", {
    threadId: "sup_monitor_file_case",
    autoTurn: 1,
    phase: "kickoff",
    text: "prompt"
  });

  const lines = (await fs.readFile(eventsFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.deepEqual(
    lines.map((event) => event.kind),
    ["monitor.telegram.queued", "monitor.telegram.sent"]
  );
  assert.deepEqual(
    lines.map((event) => event.monitorKind),
    ["SEND_TO_CHATGPT", "SEND_TO_CHATGPT"]
  );
});
