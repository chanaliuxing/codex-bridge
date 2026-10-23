# Supervisor Quickstart Guide

[English](SUPERVISOR_QUICKSTART.md) | [简体中文](SUPERVISOR_QUICKSTART_CN.md)

This document covers the 4 most critical supervisor workflows:

1. Binding and updating Session IDs
2. Automatic working directory (`cwd`) alignment
3. Customizing the prompt prefix dispatched to ChatGPT
4. Supervisor startup and shutdown controls

---

## 1. Binding a Session ID

We recommend binding dynamically via the HTTP API instead of modifying code:

```bash
curl -sS -X POST http://127.0.0.1:43188/api/codex/bind-thread \
  -H "Content-Type: application/json" \
  -d '{
    "adapter": "codex",
    "bridgeThreadId": "sup_demo",
    "sessionId": "019d4790-1c2e-7cf3-aef3-af5396a127f7"
  }'
```

- `bridgeThreadId`: The bridge conversation thread monitored by the supervisor (prefix with `sup_` recommended).
- `sessionId`: The session UUID inside the Codex App.

---

## 2. Automatic Working Directory (`cwd`) Resolution

The `bind-thread` API automatically triggers `thread/read` to read the session's active `cwd` and caches it into the bridge state.

Subsequent `turn/start` invocations automatically target the correct workspace directory without manual intervention.

---

## 3. Customizing the Prompt Prefix

You can customize the prompt prefix in `bridge.config.json`:
- `bridge.config.json` -> `supervisor.promptPrefix`

Or override it via environment variables:
- `.env` -> `SUPERVISOR_PROMPT_PREFIX`

---

## 4. Starting and Stopping the Supervisor

```bash
# Start bridge and supervisor
npm start

# Run tests
npm test
```
