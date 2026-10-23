# Vision Template Matching Notes

This document records the rules for ChatGPT UI template matching. Keep the system flow unchanged; only fix the vision layer when matching fails.

## Core Rule

Baseline templates must come from the same screenshot pipeline used at runtime.

Use:

- `pyautogui` / `mss` capture from this tool
- crop templates from that captured image
- runtime screenshots from the same tool

Do not use macOS `Command + Shift + 4` for production templates. macOS screenshots can differ in Retina scale, display scale, image processing, and crop dimensions.

## Standard Capture Workflow

1. Bring Chrome ChatGPT to the required state.
2. Use this tool to capture the screen/window.
3. Crop templates from that captured image at original pixel size.
4. Save templates as PNG.
5. Run matching against a fresh runtime capture.
6. Generate an annotated image and verify every box visually.

## Retina And Coordinates

On macOS, screen coordinates and screenshot pixels can differ.

- Matching happens in screenshot pixels.
- Clicking happens in screen coordinates.
- The click path must convert frame coordinates back to screen coordinates.

This is why templates must be cropped from the same capture method.

## Template Crop Rules

Good templates:

- stable UI icon or label
- target plus a little stable surrounding background
- PNG, original size, no compression

Bad templates:

- cursor
- timestamps
- spinner animation
- dynamic text
- user-specific IDs
- changing message content
- highlight/focus states unless that state is always present

## ROI Rules

ROI is useful for avoiding false positives, but it can cause misses when layout changes.

Rules:

- First validate new templates with whole-screen matching.
- Add ROI only after the hit is visually correct.
- If a template is visible to the eye but not detected, test whole-screen before recapturing.
- For ChatGPT layout changes, `input`, `voice`, and `send` can move enough that old ROI fails.

## Detector Requirements

The detector must support the current config format:

- `path` as string or list
- `gray`, `gray_blur`, and `edge` preprocess modes
- scale matching
- `post_filter.min_w`
- `post_filter.min_h`
- `post_filter.center_region`
- score diagnostics for each template

Do not change supervisor orchestration to fix vision problems.

## Debugging Checklist

When matching fails:

1. Generate a fresh runtime debug screenshot.
2. Draw all detections on the screenshot.
3. Check whether the screenshot is actually Chrome ChatGPT.
4. Check whether Chrome is on the expected display.
5. Check browser zoom and system display scale.
6. Check whether ROI excludes the visible target.
7. Check best scores and thresholds.
8. Only recrop templates if the target is genuinely different.

## Current Known Failure

After rollback, runtime `config.json` used newer matching fields while `detector.py` was old.

The old detector did not support:

- `path: [...]`
- `gray_blur`
- `post_filter`
- `soft_threshold`

Result: templates could be missing or matching in wrong places even though screenshots were same-source.

Fix: keep system flow unchanged and update only `TemplateDetector` to support the config format.

## Final Runtime Fix Applied

The final fix is not "match the exact pixel more strictly". The final fix is:

- same-source templates
- noise-tolerant preprocessing
- broad ROI
- post-filter by target region
- visually inspect annotated screenshots

Changes applied:

- `TemplateDetector` supports `path` as a list.
- `TemplateDetector` supports `gray_blur`.
- `TemplateDetector` supports `post_filter.min_w`, `post_filter.min_h`, and `post_filter.center_region`.
- `TemplateDetector` exposes `best_scores()` for diagnostics.
- Input/composer templates search a broad composer area, not a tiny hard-coded ROI.
- `send_button` and `voice_button` are separated by threshold and better templates because both are black circular buttons.
- Low scale factors like `0.45`, `0.5`, and `0.55` must stay in current runtime config. Real supervisor subprocess captures can differ from manual/direct captures by 1x vs 2x even when templates are same-source. Use ROI and `post_filter` to control false positives instead of removing these scales.

## Mistakes We Made

1. Treating "same looking to the eye" as "same pixels".
2. Mixing old detector code with newer config fields.
3. Searching tiny or stale ROIs before first validating whole-screen matching.
4. Accepting a high score without drawing the box on the screenshot.
5. Letting `send_button` match the black voice circle because the outer shape was too similar.
6. Relying on a single marker for state when the UI can show input, voice, send, stop, or copy depending on state.
7. Assuming same-source templates remove all scale variance. Real runs still showed 1x/2x capture differences across process paths.
8. Treating the blue voice-recording `End` button as a ChatGPT waiting `stop_button`. It is not a valid waiting marker and must not be added to `waiting_markers`.
9. Comparing copied text only against the previous clipboard. If the previous clipboard already contained the same reply, copy looked like it failed. Use a unique sentinel before clicking copy.
10. Assuming `wait_for_reply_done()` must personally observe `WAITING_REPLY`. `wait_for_waiting_started()` may already consume that state, so done detection must also handle `down_arrow`/`copy_button` directly.

## Required Debug Output

Every time matching is adjusted, generate an annotated image.

Required checks:

- box is on the visible target, not merely high score
- `send_button` only matches the arrow send button
- `voice_button` only matches the voice button
- empty composer can still become `READY_TO_SEND`
- typed composer can detect `send_button`
- waiting state detects `stop_button`
- completed reply can detect `copy_button`

Current verified initial-state artifact:

- `browser-chat-vision-tool-optimized/debug/current_live_final.png`

## Current Runtime Notes

`browser-chat-vision-tool-optimized/config.json` is ignored by git in this repository, but it is the runtime config used by `run.py`.

Important current config decisions:

- `page_chatgpt.threshold = 0.78` because the current ChatGPT sidebar header scores around `0.80` with the same-source template.
- `input_box.threshold = 0.88` and `typebox.threshold = 0.88` after recropping from the current same-source empty composer. Empty composer scores `1.0`; typed composer drops to roughly `0.64`, so paste verification can still detect that the placeholder disappeared.
- `send_button.threshold = 0.95` to prevent the send arrow template from matching the black voice circle.
- `voice_button.threshold = 0.97` with `voice_button_full.png` to prevent the voice template from matching the send arrow.
- composer templates use broad ROI plus center post-filter rather than exact narrow ROI.
- global scale factors include `0.45`, `0.5`, and `0.55` because real supervisor captures can be 1x while direct/manual validation can be 2x.
- `stop_button_end.png` is a debug/template artifact for the blue voice-recording End control. It must not be used as a ChatGPT `stop_button`.

## 2026-05-03 Supervisor Fix Notes

Verified real chain after the vision/state-machine fix:

- service start with `npm start` did not bring Chrome to front by itself
- supervisor kickoff brought Chrome to front only when the ChatGPT vision flow started
- input was found through `typebox.fallback` from the composer button when `typebox/input_box` missed at 1x
- paste was confirmed by placeholder disappearance
- `send_button` was found, then Enter submitted
- `stop_button/stop_button_with_mic` marked `WAITING_REPLY`
- completion showed `down_arrow`; the bot clicked it, pressed `End`, then found `copy_button`
- copy succeeded with `reply_len=3613`
- supervisor logged `chatgpt.reply_received` and `codex.turn_injected`

State-machine requirements from this run:

- Empty composer ready state may be anchored by `voice_button`; do not click `voice_button` as send.
- Typed composer should wait up to `send_button_wait_timeout_sec` for `send_button`; if absent, press Enter anyway.
- After sending, `stop_button` means reply is still running.
- If `stop_button` is gone and `voice_button` is visible, reply can be considered complete.
- Before copying, if `down_arrow` is visible, click it and press `End`; if not visible, assume already at bottom and search `copy_button`.
- Copy confirmation must use a unique sentinel clipboard value, then accept any non-sentinel copied reply.
