from __future__ import annotations

import json
import hashlib
import platform
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import pyautogui
import pyperclip

from .detector import TemplateDetector
from .models import Detection, UiState
from .screen import ScreenCapturer
from .storage import LocalHistoryStore, VisionEventStore


class ChatVisionBot:
    def __init__(self, project_root: Path, config: dict):
        self.project_root = project_root
        self.config = config
        self.region = config["capture_region"]
        self.logic = config["logic"]
        self.timing = config["timing"]
        self.browser = config.get("browser", {})
        self.debug_dir = project_root / config.get("debug_dir", "debug")
        self.debug_dir.mkdir(parents=True, exist_ok=True)
        self._last_focus_ts = 0.0
        self._last_region_sync_ts = 0.0
        self._last_frame_shape: Optional[tuple[int, int, int]] = None
        self._capture_meta_logged = False
        self._last_send_saw_waiting = False

        self.capturer = ScreenCapturer(self.region)
        self.detector = TemplateDetector(project_root=project_root, config=config)
        self.history = LocalHistoryStore(
            project_root / "data",
            keep_last=int(config.get("history", {}).get("keep_last", 200)),
        )
        self.observability = config.get("observability", {})
        self.vision_events = VisionEventStore(
            project_root / "data",
            file_name=self.observability.get("events_file", "vision_events.jsonl"),
            keep_last=int(self.observability.get("keep_last_events", 5000)),
        )
        self.state_log_interval_sec = float(self.observability.get("state_log_interval_sec", 1.5))
        self.log_every_poll = bool(self.observability.get("log_every_poll", False))
        self.save_debug_on_error = bool(self.observability.get("save_debug_on_error", True))
        self._last_state_log_ts = 0.0

        pyautogui.FAILSAFE = True
        pyautogui.PAUSE = 0.1

    def _bring_chatgpt_to_front(self, force: bool = False) -> None:
        if not self.browser.get("auto_prepare", True):
            return
        if platform.system() != "Darwin":
            return

        min_interval = float(self.timing.get("focus_min_interval_sec", 1.2))
        now = time.time()
        if not force and (now - self._last_focus_ts) < min_interval:
            return

        target_url = self.browser.get("target_url", "https://chatgpt.com/")
        script = f'''
tell application "Google Chrome"
  activate
  set foundTab to false
  set foundWindowIndex to 0
  set foundTabIndex to 0
  set windowCount to count of windows

  if windowCount > 0 then
    repeat with wi from 1 to windowCount
      set tabCount to count of tabs of window wi
      repeat with ti from 1 to tabCount
        set u to URL of tab ti of window wi
        if (u contains "chatgpt.com") or (u contains "chat.openai.com") then
          set foundTab to true
          set foundWindowIndex to wi
          set foundTabIndex to ti
          exit repeat
        end if
      end repeat
      if foundTab then exit repeat
    end repeat
  end if

  if foundTab then
    set index of window foundWindowIndex to 1
    set active tab index of front window to foundTabIndex
  else
    if windowCount = 0 then
      make new window
    end if
    tell front window
      make new tab with properties {{URL:"{target_url}"}}
      set active tab index to (count of tabs)
    end tell
  end if
end tell
'''
        subprocess.run(["osascript", "-e", script], check=False)
        self._last_focus_ts = now

    def _state_detection_summary(self, state: UiState) -> dict:
        found = []
        missing = []
        for name, det in state.evidence.items():
            if det is None:
                missing.append(name)
            else:
                found.append(
                    {
                        "name": name,
                        "score": round(det.score, 4),
                        "roi": det.roi_name,
                        "preprocess": det.preprocess,
                    }
                )
        return {"found": found, "missing": missing}

    def _front_chrome_region(self) -> Optional[dict]:
        if platform.system() != "Darwin":
            return None

        script = '''
tell application "Google Chrome"
  if (count of windows) = 0 then
    return ""
  end if
  set b to bounds of front window
  return (item 1 of b as string) & "," & (item 2 of b as string) & "," & (item 3 of b as string) & "," & (item 4 of b as string)
end tell
'''
        try:
            proc = subprocess.run(
                ["osascript", "-e", script],
                check=False,
                capture_output=True,
                text=True,
            )
            raw = (proc.stdout or "").strip()
            if not raw:
                return None
            parts = [int(float(x.strip())) for x in raw.split(",")]
            if len(parts) != 4:
                return None
            left, top, right, bottom = parts
            width = max(1, right - left)
            height = max(1, bottom - top)
            return {
                "left": left,
                "top": top,
                "width": width,
                "height": height,
            }
        except Exception:
            return None

    def _sync_capture_region(self) -> None:
        if not self.browser.get("dynamic_capture_region", True):
            return
        min_interval = float(self.timing.get("region_sync_min_interval_sec", 0.5))
        now = time.time()
        if (now - self._last_region_sync_ts) < min_interval:
            return
        self._last_region_sync_ts = now
        region = self._front_chrome_region()
        if not region:
            return
        if region == self.region:
            return
        self.region = region
        self.capturer.set_region(region)
        self._log_event("capture_region.synced", {"region": region})

    def _read_latest_reply_via_dom(self) -> str:
        if platform.system() != "Darwin":
            return ""
        script_js = r"""(() => {
  const selectors = [
    '[data-message-author-role="assistant"]',
    'article[data-testid^="conversation-turn-"]',
    'main article'
  ];
  let nodes = [];
  for (const sel of selectors) {
    const found = Array.from(document.querySelectorAll(sel));
    if (found.length) {
      nodes = found;
      break;
    }
  }
  if (!nodes.length) return '';
  const filtered = nodes.filter((n) => {
    const t = (n.innerText || '').trim();
    if (!t) return false;
    return !/^You said:$/i.test(t);
  });
  const last = filtered.length ? filtered[filtered.length - 1] : nodes[nodes.length - 1];
  return ((last && last.innerText) || '').trim();
})()"""
        apple = f'''
tell application "Google Chrome"
  if (count of windows) = 0 then
    return ""
  end if
  return execute active tab of front window javascript {json.dumps(script_js)}
end tell
'''
        try:
            proc = subprocess.run(
                ["osascript", "-e", apple],
                check=False,
                capture_output=True,
                text=True,
            )
            return (proc.stdout or "").strip()
        except Exception:
            return ""

    def _reply_signature(self, text: str) -> str:
        normalized = (text or "").strip()
        if not normalized:
            return ""
        return hashlib.sha1(normalized.encode("utf-8")).hexdigest()

    def _has_new_reply(self, baseline_signature: str) -> bool:
        current = self._read_latest_reply_via_dom()
        if not current:
            return False
        return self._reply_signature(current) != (baseline_signature or "")

    def _log_event(self, kind: str, payload: Optional[dict] = None) -> None:
        self.vision_events.append(
            {
                "kind": kind,
                **(payload or {}),
            }
        )

    def _clear_clipboard(self, reason: str) -> None:
        try:
            pyperclip.copy("")
            self._log_event("clipboard.cleared", {"reason": reason})
        except Exception as error:
            self._log_event("clipboard.clear_failed", {"reason": reason, "error": str(error)})

    def _maybe_log_state(self, state: UiState, source: str) -> None:
        now = time.time()
        if not self.log_every_poll and (now - self._last_state_log_ts) < self.state_log_interval_sec:
            return
        self._last_state_log_ts = now
        self._log_event(
            "state",
            {
                "source": source,
                "state": state.name,
                "reason": state.reason,
                "summary": self._state_detection_summary(state),
            },
        )

    def _capture_error_artifacts(self, stage: str, error: Exception) -> str:
        stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
        path = self.save_debug_shot(f"debug/error_{stage}_{stamp}.png")
        self._log_event(
            "error",
            {
                "stage": stage,
                "error": str(error),
                "debug_image": path,
            },
        )
        return path

    def _capture_and_detect(self) -> tuple:
        if self.browser.get("force_foreground_before_capture", True):
            self._bring_chatgpt_to_front()
        self._sync_capture_region()
        frame = self.capturer.grab_bgr()
        self._last_frame_shape = frame.shape
        if not self._capture_meta_logged:
            sw, sh = pyautogui.size()
            self._log_event(
                "capture.meta",
                {
                    "screen_size": {"width": int(sw), "height": int(sh)},
                    "region": dict(self.region),
                    "frame_shape": [int(x) for x in frame.shape],
                },
            )
            self._capture_meta_logged = True
        detections = self.detector.detect_many(frame)
        return frame, detections

    def _best_of(self, detections: dict[str, Optional[Detection]], names: list[str]) -> Optional[Detection]:
        found = [detections.get(name) for name in names if detections.get(name) is not None]
        if not found:
            return None
        return max(found, key=lambda d: d.score)

    def _lowest_reply_marker(self, frame: np.ndarray, detections: dict[str, Optional[Detection]]) -> Optional[Detection]:
        candidates: list[Detection] = []
        for name in self.logic["reply_markers"]:
            if hasattr(self.detector, "detect_all"):
                candidates.extend(self.detector.detect_all(frame, name))
            elif detections.get(name) is not None:
                candidates.append(detections[name])
        if not candidates:
            return None
        return max(candidates, key=lambda det: (det.center[1], det.score))

    def _frame_to_screen_scale(self) -> tuple[float, float]:
        if not self._last_frame_shape:
            return (1.0, 1.0)
        frame_h, frame_w = self._last_frame_shape[:2]
        if frame_w <= 0 or frame_h <= 0:
            return (1.0, 1.0)
        sx = float(self.region["width"]) / float(frame_w)
        sy = float(self.region["height"]) / float(frame_h)
        return (sx, sy)

    def _to_screen_point(self, frame_x: float, frame_y: float) -> tuple[int, int]:
        sx, sy = self._frame_to_screen_scale()
        x = int(round(self.region["left"] + frame_x * sx))
        y = int(round(self.region["top"] + frame_y * sy))
        return (x, y)

    def _abs_point(self, det: Detection) -> tuple[int, int]:
        return self._to_screen_point(det.center[0], det.center[1])

    def _click_detection(self, det: Detection, dx: int = 0, dy: int = 0) -> None:
        x, y = self._abs_point(det)
        x += int(dx)
        y += int(dy)
        self._log_event("click", {"target": det.name, "x": x, "y": y})
        pyautogui.moveTo(x, y, duration=float(self.timing.get("mouse_move_duration_sec", 2.0)))
        pyautogui.click(x, y)
        time.sleep(float(self.timing.get("click_after_sec", 1.0)))
        self._move_mouse_out_of_way()

    def _read_clipboard_until_changed(self, sentinel: str, timeout_sec: float) -> str:
        deadline = time.time() + max(0.1, timeout_sec)
        while time.time() < deadline:
            current = (pyperclip.paste() or "").strip()
            if current and current != sentinel:
                return current
            time.sleep(0.2)
        return ""

    def _move_mouse_out_of_way(self) -> None:
        if not bool(self.timing.get("move_mouse_to_corner_after_click", True)):
            return
        # Avoid true screen corners: PyAutoGUI fail-safe triggers when cursor hits
        # a corner, which can abort the next click/drag sequence.
        x = int(self.timing.get("mouse_hide_x", 20))
        y = int(self.timing.get("mouse_hide_y", 20))
        if x <= 1:
            x = 20
        if y <= 1:
            y = 20
        try:
            pyautogui.moveTo(x, y, duration=float(self.timing.get("mouse_hide_move_duration_sec", 0.2)))
            self._log_event("mouse.hidden", {"x": x, "y": y})
        except Exception as error:
            self._log_event("mouse.hide_failed", {"error": str(error)})

    def _shortcut_modifier(self) -> str:
        return "command" if platform.system() == "Darwin" else "ctrl"

    def _press_primary_combo(self, key: str) -> None:
        self._release_modifiers()
        if platform.system() == "Darwin":
            script = f'''
tell application "System Events"
  keystroke "{key}" using command down
end tell
'''
            subprocess.run(["osascript", "-e", script], check=False)
            self._release_modifiers()
            return

        mod = self._shortcut_modifier()
        pyautogui.keyDown(mod)
        try:
            time.sleep(0.03)
            pyautogui.press(key)
            time.sleep(0.02)
        finally:
            pyautogui.keyUp(mod)
            self._release_modifiers()

    def _release_modifiers(self) -> None:
        keys = ["command", "ctrl", "alt", "option", "shift"]
        for key in keys:
            try:
                pyautogui.keyUp(key)
            except Exception:
                pass
        time.sleep(float(self.timing.get("modifier_release_settle_sec", 0.1)))

    def _press_enter_and_hide_mouse(self) -> None:
        pyautogui.press("enter")
        self._move_mouse_out_of_way()

    def _roi_rect(self, roi_name: str, frame_shape: tuple[int, int, int]) -> tuple[int, int, int, int]:
        cfg = (self.config.get("rois", {}) or {}).get(roi_name)
        h, w = frame_shape[:2]
        if not cfg:
            return (0, 0, w, h)
        x0 = int(max(0.0, min(1.0, cfg["x0"])) * w)
        y0 = int(max(0.0, min(1.0, cfg["y0"])) * h)
        x1 = int(max(0.0, min(1.0, cfg["x1"])) * w)
        y1 = int(max(0.0, min(1.0, cfg["y1"])) * h)
        x1 = max(x0 + 1, x1)
        y1 = max(y0 + 1, y1)
        return (x0, y0, x1, y1)

    def _roi_diff_score(self, before: np.ndarray, after: np.ndarray, roi_name: str) -> float:
        x0, y0, x1, y1 = self._roi_rect(roi_name, before.shape)
        b = cv2.cvtColor(before[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        a = cv2.cvtColor(after[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        if b.shape != a.shape:
            return 0.0
        diff = cv2.absdiff(b, a)
        return float(np.mean(diff))

    def _has_input_placeholder(self, state: UiState) -> bool:
        preferred = list(self.logic.get("input_markers", ["typebox", "input_box"]))
        for name in preferred:
            if state.evidence and state.evidence.get(name) is not None:
                return True
        return False

    def _has_typebox_marker(self, state: UiState) -> bool:
        return bool(state.evidence and state.evidence.get("typebox") is not None)

    def _confirm_paste_by_placeholder(self, had_typebox_before: bool) -> tuple[bool, list[dict]]:
        delays = self.timing.get("paste_confirm_delays_sec", [2.0, 5.0, 15.0])
        if not isinstance(delays, list) or not delays:
            delays = [2.0, 5.0, 15.0]
        checks = []
        if not had_typebox_before:
            checks.append(
                {
                    "check": 0,
                    "delay_sec": 0.0,
                    "typebox_before": False,
                    "typebox_after": None,
                    "confirmed": False,
                    "reason": "typebox missing before paste",
                }
            )
            return False, checks
        for index, delay in enumerate(delays, start=1):
            time.sleep(float(delay))
            state = self.get_state()
            typebox_after = self._has_typebox_marker(state)
            confirmed = had_typebox_before and (not typebox_after)
            checks.append(
                {
                    "check": index,
                    "delay_sec": float(delay),
                    "typebox_before": had_typebox_before,
                    "typebox_after": typebox_after,
                    "confirmed": confirmed,
                    "state": state.name,
                }
            )
            if confirmed:
                return True, checks
        return False, checks

    def _wait_for_stop_transition_after_send(
        self, stop_before_send: bool, timeout_sec: float
    ) -> UiState:
        start = time.time()
        last_state: Optional[UiState] = None
        while True:
            state = self.get_state()
            last_state = state
            self._maybe_log_state(state, "wait_for_stop_transition_after_send")
            stop_now = state.stop_button is not None
            if (not stop_before_send) and stop_now:
                return state
            if (not stop_before_send) and state.send_button is None and state.input_marker is not None:
                self._log_event(
                    "send.submit_confirmed",
                    {"method": "composer_reset", "state": state.name},
                )
                return state
            if time.time() - start > timeout_sec:
                raise TimeoutError(
                    "wait_for_stop_transition_after_send timeout, "
                    f"stop_before={stop_before_send}, stop_now={stop_now}, "
                    f"last_state={last_state.name if last_state else 'NONE'}"
                )
            time.sleep(self.timing["poll_interval_sec"])

    def _wait_for_send_button_or_timeout(self, timeout_sec: float) -> Optional[Detection]:
        start = time.time()
        last_state: Optional[UiState] = None
        while True:
            state = self.get_state()
            last_state = state
            self._maybe_log_state(state, "wait_for_send_button_or_timeout")
            if state.send_button is not None:
                return state.send_button
            if time.time() - start > timeout_sec:
                self._log_event(
                    "send_button.timeout",
                    {
                        "timeout_sec": timeout_sec,
                        "last_state": last_state.name if last_state else "NONE",
                    },
                )
                return None
            time.sleep(self.timing["poll_interval_sec"])

    def get_state(self) -> UiState:
        frame, detections = self._capture_and_detect()

        page_marker = self._best_of(detections, self.logic["page_markers"])
        input_marker = self._best_of(detections, self.logic["input_markers"])
        voice_button = self._best_of(detections, self.logic["voice_markers"])
        send_button = self._best_of(detections, self.logic["send_markers"])
        stop_button = self._best_of(detections, self.logic["waiting_markers"])
        copy_button = self._lowest_reply_marker(frame, detections)
        down_arrow = self._best_of(detections, self.logic["down_arrow_markers"])
        if copy_button is not None:
            detections = {**detections, copy_button.name: copy_button}

        if stop_button is not None:
            return UiState(
                name="WAITING_REPLY",
                reason=f"detected waiting marker {stop_button.name} score={stop_button.score:.3f}",
                send_button=send_button,
                input_marker=input_marker,
                stop_button=stop_button,
                copy_button=copy_button,
                down_arrow=down_arrow,
                page_marker=page_marker,
                voice_button=voice_button,
                evidence=detections,
            )

        if copy_button is not None:
            return UiState(
                name="REPLY_READY",
                reason=f"detected reply marker {copy_button.name} score={copy_button.score:.3f} and no stop marker",
                send_button=send_button,
                input_marker=input_marker,
                stop_button=stop_button,
                copy_button=copy_button,
                down_arrow=down_arrow,
                page_marker=page_marker,
                voice_button=voice_button,
                evidence=detections,
            )

        ready_anchor = input_marker or page_marker or voice_button
        composer_button = send_button or voice_button
        if composer_button is not None and ready_anchor is not None:
            return UiState(
                name="READY_TO_SEND",
                reason="ready markers are present, composer button is present, and stop marker is absent",
                send_button=send_button,
                input_marker=input_marker,
                stop_button=stop_button,
                copy_button=copy_button,
                down_arrow=down_arrow,
                page_marker=page_marker,
                voice_button=voice_button,
                evidence=detections,
            )

        if page_marker is not None:
            return UiState(
                name="ON_CHAT_PAGE",
                reason=f"page marker {page_marker.name} detected but send/copy state is not stable yet",
                send_button=send_button,
                input_marker=input_marker,
                stop_button=stop_button,
                copy_button=copy_button,
                down_arrow=down_arrow,
                page_marker=page_marker,
                voice_button=voice_button,
                evidence=detections,
            )

        return UiState(
            name="UNKNOWN",
            reason="no stable state marker matched",
            send_button=send_button,
            input_marker=input_marker,
            stop_button=stop_button,
            copy_button=copy_button,
            down_arrow=down_arrow,
            page_marker=page_marker,
            voice_button=voice_button,
            evidence=detections,
        )

    def get_state_snapshot(self) -> dict:
        return self.get_state().to_snapshot()

    def watch(self) -> None:
        print("Watching UI state. Press Ctrl+C to stop.")
        while True:
            print(json.dumps(self.get_state_snapshot(), ensure_ascii=False, indent=2))
            time.sleep(self.timing["poll_interval_sec"])

    def wait_until_ready(self, timeout_sec: Optional[float] = None) -> UiState:
        timeout = float(timeout_sec or self.timing["wait_reply_timeout_sec"])
        start = time.time()
        last_state: Optional[UiState] = None
        unknown_streak = 0
        unknown_fast_fail_count = int(self.timing.get("unknown_fast_fail_count", 3))

        while True:
            state = self.get_state()
            last_state = state
            self._maybe_log_state(state, "wait_until_ready")
            if state.name in ("READY_TO_SEND", "REPLY_READY"):
                return state
            if state.name == "UNKNOWN":
                unknown_streak += 1
                if unknown_streak >= max(1, unknown_fast_fail_count):
                    frame_shape = self._last_frame_shape
                    raise RuntimeError(
                        "wait_until_ready fast-fail: state is UNKNOWN repeatedly; "
                        f"streak={unknown_streak}, region={self.region}, frame_shape={frame_shape}"
                    )
            else:
                unknown_streak = 0
            if time.time() - start > timeout:
                raise TimeoutError(
                    f"wait_until_ready timeout, last state={last_state.name if last_state else 'NONE'} "
                    f"reason={last_state.reason if last_state else 'N/A'}"
                )
            time.sleep(self.timing["poll_interval_sec"])

    def wait_for_input_marker(self, timeout_sec: Optional[float] = None) -> Detection:
        timeout = float(timeout_sec or self.timing.get("wait_input_timeout_sec", 10.0))
        start = time.time()
        last_state: Optional[UiState] = None
        preferred = list(self.logic.get("input_markers", ["typebox", "input_box"]))

        while True:
            state = self.get_state()
            last_state = state
            self._maybe_log_state(state, "wait_for_input_marker")
            for name in preferred:
                det = state.evidence.get(name) if state.evidence else None
                if det is not None:
                    return det

            fallback = self._fallback_input_target(state)
            if fallback is not None:
                self._log_event(
                    "input.fallback",
                    {"x": fallback.x, "y": fallback.y, "w": fallback.w, "h": fallback.h, "anchor_from": fallback.name},
                )
                return fallback

            if time.time() - start > timeout:
                raise TimeoutError(
                    f"wait_for_input_marker timeout, last state={last_state.name if last_state else 'NONE'} "
                    f"reason={last_state.reason if last_state else 'N/A'}"
                )
            time.sleep(self.timing["poll_interval_sec"])

    def wait_for_typebox_marker(self, timeout_sec: Optional[float] = None) -> Detection:
        timeout = float(timeout_sec or self.timing.get("wait_input_timeout_sec", 10.0))
        start = time.time()
        last_state: Optional[UiState] = None
        while True:
            state = self.get_state()
            last_state = state
            self._maybe_log_state(state, "wait_for_typebox_marker")
            fallback = self._fallback_input_target(state)
            if fallback is not None and bool(self.timing.get("prefer_input_fallback_anchor", True)):
                self._log_event(
                    "typebox.prefer_fallback",
                    {"x": fallback.x, "y": fallback.y, "w": fallback.w, "h": fallback.h, "anchor_from": fallback.name},
                )
                return fallback
            det = state.evidence.get("typebox") if state.evidence else None
            if det is not None:
                return det
            det = state.evidence.get("input_box") if state.evidence else None
            if det is not None:
                return det
            if fallback is not None:
                self._log_event(
                    "typebox.fallback",
                    {"x": fallback.x, "y": fallback.y, "w": fallback.w, "h": fallback.h, "anchor_from": fallback.name},
                )
                return fallback
            if time.time() - start > timeout:
                raise TimeoutError(
                    f"wait_for_typebox_marker timeout, last state={last_state.name if last_state else 'NONE'} "
                    f"reason={last_state.reason if last_state else 'N/A'}"
                )
            time.sleep(self.timing["poll_interval_sec"])

    def _fallback_input_target(self, state: UiState) -> Optional[Detection]:
        if not bool(self.timing.get("input_fallback_enabled", True)):
            return None
        if state.name not in ("READY_TO_SEND", "REPLY_READY"):
            return None

        anchor = state.send_button or state.voice_button
        if anchor is None:
            return None

        # Fallback is a click target, not a real template hit. Use the composer
        # button center as the stable anchor and click inside the input area.
        w = int(self.timing.get("input_fallback_w_px", 40))
        h = int(self.timing.get("input_fallback_h_px", 40))
        left_offset = int(self.timing.get("input_fallback_left_offset_px", 150))
        click_x = max(0, anchor.center[0] - left_offset)
        click_y = max(0, anchor.center[1])
        x = max(0, click_x - (w // 2))
        y = max(0, click_y - (h // 2))
        return Detection(
            name="input_fallback",
            score=0.5,
            x=x,
            y=y,
            w=max(24, w),
            h=max(20, h),
            scale=1.0,
            roi_name="bottom_input",
            preprocess="fallback",
        )

    def wait_for_waiting_started(
        self, timeout_sec: Optional[float] = None, baseline_reply_signature: str = ""
    ) -> UiState:
        timeout = float(timeout_sec or self.timing["wait_waiting_start_timeout_sec"])
        start = time.time()
        last_state: Optional[UiState] = None

        while True:
            state = self.get_state()
            last_state = state
            self._maybe_log_state(state, "wait_for_waiting_started")

            if state.name == "WAITING_REPLY":
                return state

            if state.stop_button is None and state.voice_button is not None:
                self._log_event(
                    "waiting_started.already_done",
                    {"state": state.name, "reason": "voice visible and stop absent after send"},
                )
                return state

            # Very short replies may skip a visible stop state, but only treat
            # REPLY_READY as valid when the reply changed from the pre-send baseline.
            if state.name == "REPLY_READY":
                if not baseline_reply_signature or self._has_new_reply(baseline_reply_signature):
                    return state

            if time.time() - start > timeout:
                raise TimeoutError(
                    f"wait_for_waiting_started timeout, last state={last_state.name if last_state else 'NONE'} "
                    f"reason={last_state.reason if last_state else 'N/A'}"
                )
            time.sleep(self.timing["poll_interval_sec"])

    def _ensure_reply_is_scrolled_to_bottom(self) -> None:
        max_clicks = int(self.logic.get("down_arrow_max_clicks", 3))
        settle_sec = float(self.timing["down_arrow_after_click_sec"])

        for _ in range(max_clicks):
            state = self.get_state()
            if state.down_arrow is None:
                return
            try:
                self._click_detection(state.down_arrow)
            except pyautogui.FailSafeException:
                self._log_event("down_arrow.failsafe_skip")
                return
            time.sleep(settle_sec)

    def _keyboard_scroll_to_bottom(self) -> None:
        self._log_event("scroll_bottom.keyboard", {"key": "end"})
        pyautogui.press("end")
        time.sleep(float(self.timing.get("down_arrow_after_click_sec", 0.35)))

    def wait_for_reply_done(
        self, timeout_sec: Optional[float] = None, baseline_reply_signature: str = ""
    ) -> UiState:
        timeout = float(timeout_sec or self.timing["wait_reply_timeout_sec"])
        settle_sec = float(self.timing["post_stop_settle_sec"])
        start = time.time()
        saw_waiting = False
        last_state: Optional[UiState] = None

        while True:
            state = self.get_state()
            last_state = state
            self._maybe_log_state(state, "wait_for_reply_done")

            if state.name == "WAITING_REPLY":
                saw_waiting = True

            if state.name == "REPLY_READY":
                self._ensure_reply_is_scrolled_to_bottom()
                state = self.get_state()
                if state.copy_button is not None and state.stop_button is None:
                    if saw_waiting or not baseline_reply_signature or self._has_new_reply(baseline_reply_signature):
                        return state

            if state.stop_button is None and state.down_arrow is not None:
                self._ensure_reply_is_scrolled_to_bottom()
                self._keyboard_scroll_to_bottom()
                state = self.get_state()
                if state.copy_button is not None and state.stop_button is None:
                    return state

            if saw_waiting and state.stop_button is None:
                time.sleep(settle_sec)
                self._ensure_reply_is_scrolled_to_bottom()
                self._keyboard_scroll_to_bottom()
                state = self.get_state()
                if state.copy_button is not None and state.stop_button is None:
                    return state

            if time.time() - start > timeout:
                raise TimeoutError(
                    f"wait_for_reply_done timeout, last state={last_state.name if last_state else 'NONE'} "
                    f"reason={last_state.reason if last_state else 'N/A'}"
                )

            time.sleep(self.timing["poll_interval_sec"])

    def _click_input_area(self, state: UiState, target: Optional[Detection] = None) -> None:
        target = target or state.input_marker
        if target is None:
            raise RuntimeError("No clickable marker found for input area")
        second_click_delay = float(self.timing.get("input_second_click_delay_sec", 1.0))
        if target.name == "input_fallback":
            x, y = self._abs_point(target)
            self._log_event("click.input", {"target": target.name, "x": x, "y": y, "anchor": "center"})
            pyautogui.moveTo(x, y, duration=float(self.timing.get("mouse_move_duration_sec", 2.0)))
            pyautogui.click(x, y)
            time.sleep(float(self.timing.get("click_after_sec", 1.0)))
            time.sleep(second_click_delay)
            pyautogui.click(x, y)
            time.sleep(float(self.timing.get("click_after_sec", 1.0)))
            self._move_mouse_out_of_way()
            return
        # For typebox/input_box, click near the right side to avoid toolbar overlays.
        anchor = str(self.timing.get("input_click_anchor", "right")).strip().lower()
        margin = int(self.timing.get("input_click_margin_px", 10))
        if anchor == "right":
            rx = target.x + max(2, target.w - margin)
            ry = target.y + target.h // 2
            x, y = self._to_screen_point(rx, ry)
        else:
            x, y = self._abs_point(target)
        self._log_event("click.input", {"target": target.name, "x": x, "y": y, "anchor": anchor})
        pyautogui.moveTo(x, y, duration=float(self.timing.get("mouse_move_duration_sec", 2.0)))
        pyautogui.click(x, y)
        time.sleep(float(self.timing.get("click_after_sec", 1.0)))
        time.sleep(second_click_delay)
        pyautogui.click(x, y)
        time.sleep(float(self.timing.get("click_after_sec", 1.0)))
        self._move_mouse_out_of_way()

    def send_message(self, text: str) -> None:
        try:
            self._last_send_saw_waiting = False
            self._log_event("send.start", {"text_len": len(text)})
            self._bring_chatgpt_to_front(force=True)
            self._clear_clipboard("send.pre")
            max_attempts = int(self.timing.get("send_restart_max_attempts", 3))
            paste_check_delay = float(self.timing.get("post_paste_check_delay_sec", 2.0))
            pre_send_delay = float(self.timing.get("post_paste_pre_send_delay_sec", 1.0))
            send_text_prefix = str(self.timing.get("send_text_prefix", ". "))
            final_error: Optional[Exception] = None

            for attempt in range(1, max_attempts + 1):
                try:
                    state = self.wait_until_ready()
                    stop_before_send = state.stop_button is not None
                    input_target = self.wait_for_typebox_marker()
                    self._click_input_area(state, input_target)

                    self._release_modifiers()
                    pyautogui.press("esc")
                    pyperclip.copy(text)

                    focus_probe_max = max(1, int(self.timing.get("focus_probe_max_attempts", 3)))
                    focus_ready = False
                    probe_text = str(self.timing.get("focus_probe_text", "zzprobezz"))
                    for probe_idx in range(1, focus_probe_max + 1):
                        self._press_primary_combo("a")
                        pyautogui.press("backspace")
                        pyperclip.copy(probe_text)
                        self._press_primary_combo("v")
                        time.sleep(float(self.timing.get("focus_probe_settle_sec", 0.25)))
                        probe_state = self.get_state()
                        probe_typebox_visible = self._has_typebox_marker(probe_state)
                        probe_send_visible = probe_state.send_button is not None
                        focus_ready = (not probe_typebox_visible) or probe_send_visible
                        self._log_event(
                            "send.focus_probe",
                            {
                                "attempt": attempt,
                                "probe": probe_idx,
                                "typebox_after": probe_typebox_visible,
                                "send_button_after": probe_send_visible,
                                "ready": focus_ready,
                            },
                        )
                        if focus_ready:
                            break
                        self._click_input_area(probe_state, self.wait_for_typebox_marker())
                    if not focus_ready:
                        raise RuntimeError("Input focus probe failed: typebox still visible after probe paste")

                    self._press_primary_combo("a")
                    pyautogui.press("backspace")
                    self._release_modifiers()
                    if send_text_prefix:
                        time.sleep(float(self.timing.get("send_prefix_pre_delay_sec", 1.0)))
                        pyautogui.write(send_text_prefix)
                        time.sleep(float(self.timing.get("send_prefix_post_delay_sec", 1.0)))
                    pyperclip.copy(text)

                    self._press_primary_combo("v")
                    time.sleep(float(self.timing.get("send_after_paste_sec", 0.2)))
                    time.sleep(paste_check_delay)

                    state_after_paste = self.get_state()
                    typebox_still_visible = self._has_typebox_marker(state_after_paste)
                    send_button_visible = state_after_paste.send_button is not None
                    paste_confirmed = (not typebox_still_visible) or send_button_visible
                    self._log_event(
                        "send.paste_confirm",
                        {
                            "method": "typebox_disappear_or_send_button",
                            "attempt": attempt,
                            "typebox_before": True,
                            "typebox_after": typebox_still_visible,
                            "send_button_after": send_button_visible,
                            "confirmed": paste_confirmed,
                        },
                    )
                    if not paste_confirmed:
                        raise RuntimeError("Paste verification failed: typebox still visible and send button not found")

                    time.sleep(pre_send_delay)
                    send_timeout = float(self.timing.get("send_button_wait_timeout_sec", 10.0))
                    send_button = self._wait_for_send_button_or_timeout(timeout_sec=send_timeout)
                    self._press_enter_and_hide_mouse()
                    self._log_event(
                        "send.enter",
                        {
                            "attempt": attempt,
                            "send_button_found": send_button is not None,
                            "timeout_sec": send_timeout,
                        },
                    )
                    time.sleep(float(self.timing.get("post_enter_check_delay_sec", 0.8)))
                    state_after_enter = self.get_state()
                    if send_button is not None and state_after_enter.send_button is not None:
                        self._log_event(
                            "send.enter_fallback_click",
                            {
                                "attempt": attempt,
                                "reason": "send_button_still_visible_after_enter",
                            },
                        )
                        self._click_detection(state_after_enter.send_button)
                    self.history.append("user", text)
                    if bool(self.timing.get("require_waiting_after_send", True)):
                        probe_timeout = float(self.timing.get("post_send_waiting_timeout_sec", 5.0))
                        transition_state = self._wait_for_stop_transition_after_send(
                            stop_before_send=stop_before_send,
                            timeout_sec=probe_timeout,
                        )
                        self._last_send_saw_waiting = transition_state.name == "WAITING_REPLY"
                        self._log_event(
                            "send.working_detected",
                            {
                                "timeout_sec": probe_timeout,
                                "stop_before_send": stop_before_send,
                                "stop_after_send": self._last_send_saw_waiting,
                            },
                        )
                    post_state = self.get_state()
                    self._log_event(
                        "send.done",
                        {"attempt": attempt, "state": post_state.name, "summary": self._state_detection_summary(post_state)},
                    )
                    return
                except Exception as attempt_error:
                    final_error = attempt_error
                    self._log_event("send.restart", {"attempt": attempt, "error": str(attempt_error)})
                    if attempt >= max_attempts:
                        break
                    # Clean up input before restarting from scratch.
                    self._press_primary_combo("a")
                    pyautogui.press("backspace")
                    time.sleep(0.2)

            raise RuntimeError(f"Send failed after {max_attempts} restart attempts: {final_error}")
        except Exception as error:
            if self.save_debug_on_error:
                self._capture_error_artifacts("send_message", error)
            raise
        finally:
            self._clear_clipboard("send.post")

    def copy_last_reply(self, baseline_reply_signature: str = "") -> str:
        try:
            self._log_event("copy.start")
            self._bring_chatgpt_to_front(force=True)
            self._clear_clipboard("copy.pre")
            state = self.get_state()
            if state.name != "REPLY_READY":
                state = self.wait_for_reply_done()

            self._ensure_reply_is_scrolled_to_bottom()
            frame, detections = self._capture_and_detect()
            candidates: list[Detection] = []
            if hasattr(self.detector, "detect_all"):
                candidates = self.detector.detect_all(frame, "copy_button")
            elif detections.get("copy_button") is not None:
                candidates = [detections["copy_button"]]
            if not candidates:
                raise RuntimeError("Copy button not found")

            text = ""
            sorted_candidates = sorted(candidates, key=lambda det: (det.center[1], det.score), reverse=True)
            max_candidates = max(1, int(self.timing.get("copy_max_candidates", 2)))
            max_clicks_per_candidate = max(1, int(self.timing.get("copy_click_retries_per_candidate", 2)))
            inset = int(self.timing.get("copy_click_inset_px", 2))
            click_wait = float(self.timing.get("copy_after_click_sec", 0.35))
            read_wait = float(self.timing.get("copy_wait_timeout_sec", 1.2))
            used_click: Optional[Detection] = None
            for idx, det in enumerate(sorted_candidates[:max_candidates]):
                for attempt in range(1, max_clicks_per_candidate + 1):
                    sentinel = f"__CHAT_VISION_COPY_SENTINEL_{time.time_ns()}__"
                    pyperclip.copy(sentinel)
                    self._click_detection(det, dx=inset, dy=inset)
                    time.sleep(click_wait)
                    text = self._read_clipboard_until_changed(sentinel=sentinel, timeout_sec=read_wait)
                    self._log_event(
                        "copy.attempt",
                        {
                            "candidate_idx": idx,
                            "attempt": attempt,
                            "x": det.center[0],
                            "y": det.center[1],
                            "score": round(float(det.score), 4),
                            "copied": bool(text),
                        },
                    )
                    if text:
                        used_click = det
                        break
                if text:
                    break
            if not text:
                text = self._read_latest_reply_via_dom()
                if text:
                    self._log_event("copy.dom_fallback", {"reply_len": len(text)})
            if not text:
                raise RuntimeError("Clipboard is empty after clicking copy button")
            if baseline_reply_signature and self._reply_signature(text) == baseline_reply_signature:
                raise RuntimeError("Copied reply matches baseline (new reply not detected)")

            self.history.append("assistant", text)
            self._log_event(
                "copy.done",
                {
                    "reply_len": len(text),
                    "click_y": used_click.center[1] if used_click is not None else None,
                    "summary": self._state_detection_summary(self.get_state()),
                },
            )
            return text
        except Exception as error:
            if self.save_debug_on_error:
                self._capture_error_artifacts("copy_last_reply", error)
            raise
        finally:
            self._clear_clipboard("copy.post")

    def ask(self, text: str) -> str:
        try:
            self._log_event("ask.start", {"text_len": len(text)})
            self._bring_chatgpt_to_front(force=True)
            baseline_reply_signature = self._reply_signature(self._read_latest_reply_via_dom())
            self.send_message(text)
            if not self._last_send_saw_waiting:
                self.wait_for_waiting_started(baseline_reply_signature=baseline_reply_signature)
            self.wait_for_reply_done(baseline_reply_signature=baseline_reply_signature)
            reply = self.copy_last_reply(baseline_reply_signature=baseline_reply_signature)
            self._log_event("ask.done", {"reply_len": len(reply)})
            return reply
        except Exception as error:
            if self.save_debug_on_error:
                self._capture_error_artifacts("ask", error)
            raise

    def save_debug_shot(self, out_path: str) -> str:
        frame, detections = self._capture_and_detect()
        state = self.get_state()
        canvas = self.detector.draw_detections(frame, detections)
        label = f"{state.name} | {state.reason}"
        cv2.putText(
            canvas,
            label,
            (18, 28),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (40, 40, 220),
            2,
            cv2.LINE_AA,
        )
        out = self.project_root / out_path if not Path(out_path).is_absolute() else Path(out_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out), canvas)
        return str(out)
