# Supervisor Critical TODO

1. Enforce foreground gate in supervisor loop
- For each `chatgpt.ask.started` cycle, require a correlated `bring_to_front.attempt ok=true` event within a short timeout.
- If missing, hard-fail the turn with explicit reason and do not continue silently.

2. Add per-turn correlation id across supervisor and vision logs
- Add a shared `turn_id` into supervisor events and pass it into vision `ask/send/copy` logs.
- This allows one-to-one audit between supervisor step and UI automation step.

3. Add visibility proof logging
- Log frontmost app name and front tab URL snapshot before `send.start` and before `copy.start`.
- If app/tab mismatch, stop immediately.

4. Add watchdog for stale startup ordering
- Do not consume kickoff messages before supervisor handlers are fully attached.
- Queue incoming kickoff messages until supervisor `ready` state is reached.
