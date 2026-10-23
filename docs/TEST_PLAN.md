# Test Plan

## Goal
Validate the bridge in three dimensions:
- Core flow correctness (`Telegram A -> Supervisor -> Codex -> Supervisor -> ChatGPT`)
- Monitoring correctness (`Telegram B` ordering, stop/resume behavior, terminal status visibility)
- Runtime resilience (restart recovery, offset/state persistence, duplicate suppression)

## Scope
- In scope:
  - `src/supervision/chatgpt-supervisor.js`
  - `src/adapters/telegram-adapter.js`
  - `src/index.js` bootstrap guards
- Out of scope:
  - Visual matching quality of browser vision tool templates
  - External network/provider reliability (Telegram/OpenAI/Codex service uptime)

## Test Layers
1. Static checks
- `node --check` for all `src/**/*.js`

2. Unit tests
- `tests/supervisor-flow.test.js`
  - `CODEX_FINAL` phase is derived from real injected phase
  - `/stop` keeps in-flight final observable and prevents re-injection
- `tests/telegram-adapter.test.js`
  - `sup_` threads route to supervisor kickoff (no direct codex target)
  - polling offset persistence throttling works and force flush works

3. Smoke runtime
- Start service with real config:
  - `npm run start`
- Validate:
  - process starts and lock guard works
  - monitor startup message reaches Telegram B
  - `/status`, `/stop`, `/resume` commands work

## Manual E2E Checklist
1. In Telegram A, choose a `sup_` thread and send one seed message.
2. Confirm Telegram B receives ordered events:
   - `SEND_TO_CHATGPT`
   - `CHATGPT_REPLY`
   - `PREPARE_INJECT_TO_CODEX`
   - `CODEX_FINAL`
3. Send `/stop` in Telegram B during an active codex turn.
4. Confirm Telegram B receives:
   - current `CODEX_FINAL` (if already in-flight)
   - `STOPPED_AFTER_FINAL`
   - no further re-injection events
5. Send `/resume` and verify loop continues on next incoming trigger.
6. Restart service and verify:
   - monitor stop state persists
   - Telegram A/B offsets prevent replaying old commands

## Pass/Fail Criteria
- Pass:
  - all unit tests green
  - no duplicate monitor push for same event in normal run
  - stop/resume semantics match expected behavior
  - restart does not replay stale Telegram commands
- Fail:
  - event order regression
  - missing terminal status after stop
  - replayed old Telegram commands after restart

## Commands
- Fast local check:
  - `bash scripts/test.sh`
- npm entrypoints:
  - `npm test`
  - `npm run test:ci`
