import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapter } from "../src/adapters/telegram-adapter.js";

function createAdapter() {
  const adapter = new TelegramAdapter("telegram", {
    token: "bot-token",
    chatId: "chat-1",
    defaultTo: "codex",
    supervisorThreadPrefix: "sup_"
  });
  return adapter;
}

test("forwardUserMessage routes supervised threads to supervisor kickoff only", async () => {
  const adapter = createAdapter();
  const emitted = [];
  adapter.emitMessage = async (message) => {
    emitted.push(message);
  };

  adapter.selectedBridgeThreadId = "sup_case_1";
  await adapter.forwardUserMessage("hello", "chat-1", 1);

  adapter.selectedBridgeThreadId = "tg_case_1";
  await adapter.forwardUserMessage("hello", "chat-1", 2);

  assert.equal(emitted.length, 2);
  assert.equal(emitted[0].to, null);
  assert.equal(emitted[0].meta.supervisorKickoffOnly, true);
  assert.equal(emitted[1].to, "codex");
  assert.equal(emitted[1].meta.supervisorKickoffOnly, false);
});

test("persistPollingState is throttled and can be forced", async () => {
  const adapter = createAdapter();
  const writes = [];
  adapter.bridge = {
    store: {
      setAdapterState: async (_threadId, _name, payload) => {
        writes.push(payload);
      },
      getAdapterState: async () => ({})
    }
  };
  adapter.nextOffset = 123;

  await adapter.persistPollingState(false);
  await adapter.persistPollingState(false);
  await adapter.persistPollingState(true);

  assert.equal(writes.length, 2);
  assert.equal(writes[0].nextOffset, 123);
  assert.equal(writes[1].nextOffset, 123);
});
