# Codex Bridge Complete

[English](README.md) | [简体中文](README_CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg?logo=node.js)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-14%20passed-success.svg)]()
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen.svg)]()

---

> [!IMPORTANT]
> **Release & Commercial Notice**
>
> - **Open Source Baseline**: The code in this public repository represents a functional baseline release from approximately **12 months ago**, shared for academic research, technical study, and architectural reference.
> - **Commercial & Production Edition**: Advanced industrial-grade features, enhanced reliability, and ongoing evolutions are part of our **proprietary commercial suite**. For commercial inquiries or enterprise deployments, please contact the team.

---



> **Lightweight local message bus and bridge connecting Codex CLI, tools, Telegram, and web UI with zero external databases or queues.**

### Quick Start:
```bash
npm start
```



A small local bridge that can:

- read and send messages to Codex through `codex app-server`
- wire other tools with a very simple standard
- let tools talk to each other through one hub
- keep only recent chat plus a compact local summary
- expose a tiny browser UI
- work with **folder tools** or **stdio tools**
- give you tiny Node and Python SDK helpers so new tools are easy to connect

## Design goal

Keep it simple.

You do **not** need a database.
You do **not** need a queue system.
You do **not** need a full agent platform.

This project uses:

- plain Node.js
- local JSON files
- one normalized message format
- one bridge process
- thin adapters

## Message standard

Every adapter uses this envelope:

```json
{
  "id": "msg_123",
  "threadId": "demo",
  "from": "user",
  "to": "codex",
  "role": "user",
  "type": "text",
  "text": "hello",
  "ts": 1770000000,
  "hops": 0,
  "maxHops": 8,
  "tags": [],
  "meta": {
    "replyTo": "console"
  }
}
```

### Important fields

- `threadId`: bridge conversation id
- `from`: sender adapter name
- `to`: direct destination adapter name
- `meta.replyTo`: where a tool should send its reply
- `hops` and `maxHops`: loop protection
- `tags`: optional routing tags

## Tool standards

### 1) Folder tool

The bridge writes JSON files into a tool `inbox/`.
The tool writes reply JSON files into its `outbox/`.

This is the easiest integration method for any language.

### 2) STDIO tool

The bridge spawns a tool process.
The bridge writes one JSON message per line to `stdin`.
The tool writes one JSON message per line to `stdout`.

This is better for long-running tools.

## Project layout

```text
src/
  adapters/
  cli/
  core/
  public/
  server/
sdk/
  node/
  python/
examples/
data/
mailboxes/
```

## Requirements

- Node.js 18+
- Python 3 optional, only for Python examples
- Codex CLI optional if you want the Codex adapter

## Environment

This project auto-loads `.env` at startup.

For Telegram integration, set:

```bash
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Only `TELEGRAM_CHAT_ID` is accepted for inbound commands. Messages from any other chat id are ignored.

## Quick start without Codex

```bash
BRIDGE_CONFIG=bridge.nocodex.config.json npm start
```

Open:

```text
http://127.0.0.1:43188
```

Or send from CLI:

```bash
npm run send -- --thread demo --to stdio_upper --text "hello world" --reply-to console
```

## Quick start with Codex

```bash
npm start
```

Then:

```bash
npm run send -- --thread demo --to codex --text "Say hello in one short sentence"
```

## Telegram to Codex

`bridge.config.json` already includes a `telegram` adapter:

- inbound Telegram messages -> Codex
- Codex replies -> Telegram
- same replies still go to console for local debugging

After setting `.env`, start bridge:

```bash
npm start
```

Then send a message to your bot from the allowed chat id.

Telegram commands:

- `/sessions` list available session ids and choose from menu buttons
- `/use <session_id>` switch to a specific session id
- `/current` show the currently selected session
- `/runtime` show current model + effort
- `/model <name>` set model for current chat session
- `/effort <low|medium|high|xhigh>` set reasoning effort
- `/reset` clear session binding and start fresh
- `/help` show command help

After selecting a session, normal chat messages continue in that same session until you switch/reset.

## ChatGPT Supervised Loop (Codex <-> ChatGPT)

This repo now includes an optional supervisor loop:

1. listen for Codex final reply on selected threads
2. send that reply to ChatGPT web via `browser-chat-vision-tool`
3. send ChatGPT reply back to Codex automatically

Configure in `bridge.config.json`:

```json
"supervisor": {
  "enabled": true,
  "threadPrefix": "sup_",
  "toolDir": "./browser-chat-vision-tool-optimized",
  "toolConfig": "config.json",
  "stopOnCodexFailure": true,
  "stopOnUsageLimit": true,
  "promptPrefix": "your strict supervisor prompt"
}
```

`promptPrefix` can also come from `.env` via `SUPERVISOR_PROMPT_PREFIX`.

Supervisor Telegram monitor (second bot, same chat id):

- set `MONITOR_TELEGRAM_BOT_TOKEN` in `.env`
- keep `MONITOR_TELEGRAM_CHAT_ID` empty to reuse `TELEGRAM_CHAT_ID`, or set it explicitly
- supervisor default monitor push: `INJECT_TO_CODEX`, `CODEX_FINAL`, `HALTED`
- set `supervisor.monitorIncludeChatgptEvents=true` to include ChatGPT-side events (`SEND_TO_CHATGPT`, `CHATGPT_REPLY`)
- monitor bot commands:
  - `/stop` global stop for supervisor auto-injection
  - `/resume` resume supervisor auto-injection
  - `/status` show running/stopped state
- push is serialized with sequence ids and retry; hard failures are written to `data/monitor_undelivered.jsonl`
- on startup, supervisor replays `data/monitor_undelivered.jsonl` in-order and keeps only still-failed records

The vision tool now supports:

- auto ensure Chrome + ChatGPT tab
- down-arrow click before copy detection
- reply-ready detection: stop disappears -> scroll down if needed -> copy appears

Isolation model (independent channels):

- Telegram control channel uses threads prefixed with `tg_`
- ChatGPT supervisor channel uses threads prefixed with `sup_`
- Telegram outbound only forwards Codex results from `tg_` threads

This keeps Telegram and Supervisor fully independent and parallel.

### Channel isolation (important)

There are 3 independent lines:

1. Main Telegram Bot (direct control)
- Purpose: chat with Codex directly
- Typical threads: `tg_*`
- Not part of ChatGPT supervisor loop

2. Supervisor line (ChatGPT -> Codex)
- Purpose: ChatGPT supervises and drives Codex automatically
- Triggered only by `sup_*` threads

3. Monitor Telegram Bot (second bot)
- Purpose: monitor supervisor events + supervisor control commands
- Commands: `/stop`, `/resume`, `/status`
- Does **not** act as direct Codex chat channel

### Run a supervisor test thread

Start bridge:

```bash
cd .
npm run start
```

In another terminal, send a supervisor seed message:

```bash
cd .
npm run send -- --from telegram --thread sup_rerun_1775704590 --text "RERUN_NOW"
```

If you already have a Codex session id (from Codex app), you can pass it directly and skip manual thread naming:

```bash
npm run send -- --from telegram --session 019d7001-dfde-7821-b324-e0258f2fd007 --text "RERUN_NOW"
```

This will:

- auto-generate a **new** `sup_session_<session_id>_<timestamp>_<rand>` thread id (default)
- bind that supervisor thread to the provided Codex session id
- avoid old thread binding conflicts by default
- default Codex runtime for this kickoff: `gpt-5.3-codex` + `medium`

Override model/effort in command:

```bash
npm run send -- --from telegram --session 019d7001-dfde-7821-b324-e0258f2fd007 --model gpt-5.4 --effort high --text "RERUN_NOW"
```

If you explicitly want to reuse one stable session-thread id:

```bash
npm run send -- --from telegram --session 019d7001-dfde-7821-b324-e0258f2fd007 --reuse-session-thread true --text "RERUN_NOW"
```

`threadId` format for supervisor should start with `sup_`, for example:

- `sup_rerun_1775704590`
- `sup_test_001`

### Run supervisor continuously

If `bridge.config.json` has `"supervisor": { "enabled": true }`, running bridge means supervisor is always on:

```bash
cd .
npm run start
```

This keeps running until:

- you press `Ctrl+C` in that terminal, or
- you send `/stop` to the **monitor Telegram bot** (same allowed chat id).

To resume after monitor stop, send `/resume` to monitor bot.

Important:
- `npm run start` only starts the service.
- It does **not** automatically create a new supervisor conversation.
- You must send a kickoff message on a `sup_*` thread (or use `--session`, which auto-generates a `sup_session_*` thread).

Trigger supervisor after start:

```bash
cd .
npm run send -- --from telegram --thread sup_rerun_1775704590 --text "RERUN_NOW"
```

Or with known Codex session id:

```bash
cd .
npm run send -- --from telegram --session 019d7001-dfde-7821-b324-e0258f2fd007 --text "RERUN_NOW"
```

Supervisor thread lifecycle defaults:

- on halt (`codex_failed`, limit, `/stop`) supervisor auto-releases thread->session binding
- on bridge shutdown (`Ctrl+C`) supervisor also auto-releases active supervisor thread bindings
- this only affects supervisor `sup_*` flow; `tg_*` direct Telegram chat remains unchanged

### Edit the first prompt sent to ChatGPT

Two places control prompt text:

1. First-turn template file (recommended for kickoff content):
`supervisor/initial_chatgpt_prompt.txt`
2. Global strict prefix (prepended on each supervisor ask):
`bridge.config.json` -> `supervisor.promptPrefix`

Observability files:

- vision detection/events: `browser-chat-vision-tool-optimized/data/vision_events.jsonl`
- supervisor pipeline events: `data/supervisor_events.jsonl`
- auto error screenshots: `browser-chat-vision-tool-optimized/debug/error_*.png`

Stop behavior:

- when Codex returns a failed turn, supervisor halts that thread automatically
- when Codex reports usage/rate/quota/context-limit style errors, supervisor halts that thread automatically
- halt events are written to `data/supervisor_events.jsonl`

## Route rules

Routes are in `bridge.config.json`.

Simple rule example:

```json
{ "from": "local_inbox", "contains": "#upper", "to": "stdio_upper" }
```

If a message arrives from `local_inbox` and its text contains `#upper`, the bridge sends it to `stdio_upper`.

Direct `to` always wins.

## Web UI

The browser UI lets you:

- view adapters
- view threads
- watch live messages
- send messages to any adapter
- inspect recent summary and state

## Bind existing Codex App session

If you already have a Codex App session id and want this bridge thread to continue in that same session:

```bash
curl -sS -X POST http://127.0.0.1:43188/api/codex/bind-thread \
  -H "Content-Type: application/json" \
  -d '{
    "bridgeThreadId": "demo",
    "sessionId": "019d4790-1c2e-7cf3-aef3-af5396a127f7"
  }'
```

You can also send `codexThreadId` instead of `sessionId`.

## Local storage

The bridge keeps local state only:

- `data/threads/<threadId>/recent.json`
- `data/threads/<threadId>/summary.json`
- `data/threads/<threadId>/state.json`

It does **not** keep a full archive by default.

## Add your own tool fast

### Node stdio tool

Copy `examples/node-stdio-uppercase-tool.js`.

### Python stdio tool

Copy `examples/python_stdio_tool.py`.

### Node folder tool

Copy `examples/node-file-reverse-tool.js`.

### Python folder tool

Copy `examples/python_folder_tool.py`.

## Sample commands

Show a thread:

```bash
npm run show:thread -- --thread demo
```

List known threads:

```bash
npm run list:threads
```

Send to Python folder tool:

```bash
npm run send -- --thread demo --to python_folder --text "abcdef" --reply-to console
```

## Notes

- The Codex adapter is included in the project.
- The project can run fully without Codex by using `bridge.nocodex.config.json`.
- The included summary compaction is simple and local. It is rule-based, not model-generated.
