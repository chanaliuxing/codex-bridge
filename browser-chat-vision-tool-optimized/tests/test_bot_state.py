import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from chat_vision.bot import ChatVisionBot
from chat_vision.models import Detection, UiState


def det(name, x=100, y=100, w=40, h=30):
    return Detection(
        name=name,
        score=0.99,
        x=x,
        y=y,
        w=w,
        h=h,
        scale=1.0,
        roi_name="test",
        preprocess="gray",
    )


def state(name="READY_TO_SEND", **kwargs):
    evidence = kwargs.pop("evidence", {})
    return UiState(name=name, reason="test", evidence=evidence, **kwargs)


class BotStateMachineTest(unittest.TestCase):
    def make_bot(self):
        bot = ChatVisionBot.__new__(ChatVisionBot)
        bot.timing = {
            "poll_interval_sec": 0.01,
            "input_fallback_enabled": True,
            "input_fallback_w_px": 40,
            "input_fallback_h_px": 40,
            "input_fallback_left_offset_px": 250,
            "wait_input_timeout_sec": 0.05,
            "down_arrow_after_click_sec": 0.01,
            "post_stop_settle_sec": 0.01,
            "wait_reply_timeout_sec": 0.1,
            "copy_after_click_sec": 0.01,
            "copy_wait_timeout_sec": 0.2,
        }
        bot.logic = {"down_arrow_max_clicks": 1}
        bot.region = {"left": 0, "top": 0, "width": 1000, "height": 800}
        bot._last_frame_shape = (800, 1000, 3)
        bot.history = SimpleNamespace(append=lambda *args, **kwargs: None)
        bot.save_debug_on_error = False
        bot._log_event = lambda *args, **kwargs: None
        bot._maybe_log_state = lambda *args, **kwargs: None
        bot._bring_chatgpt_to_front = lambda *args, **kwargs: None
        bot._clear_clipboard = lambda *args, **kwargs: None
        bot._click_detection = lambda *args, **kwargs: None
        bot._read_latest_reply_via_dom = lambda: ""
        bot._reply_signature = lambda text: "sig:" + (text or "")
        bot._capture_and_detect = lambda: (object(), {"copy_button": det("copy_button")})
        bot.detector = SimpleNamespace(detect_all=lambda _frame, _name: [det("copy_button")])
        return bot

    def test_typebox_marker_falls_back_to_voice_anchor(self):
        bot = self.make_bot()
        voice = det("voice_button", x=800, y=720, w=34, h=34)
        bot.get_state = lambda: state("READY_TO_SEND", voice_button=voice, evidence={"voice_button": voice})

        target = bot.wait_for_typebox_marker(timeout_sec=0.05)

        self.assertEqual(target.name, "input_fallback")
        self.assertEqual(target.roi_name, "bottom_input")
        self.assertEqual(target.center, (voice.center[0] - 250, voice.center[1]))

    def test_reply_done_scrolls_down_arrow_even_without_local_waiting_observation(self):
        bot = self.make_bot()
        down = det("down_arrow", x=490, y=650)
        copy = det("copy_button", x=430, y=710)
        states = iter([
            state("ON_CHAT_PAGE", down_arrow=down, evidence={"down_arrow": down}),
            state("REPLY_READY", copy_button=copy, evidence={"copy_button": copy}),
        ])
        bot.get_state = lambda: next(states)
        calls = []
        bot._ensure_reply_is_scrolled_to_bottom = lambda: calls.append("scroll_click")
        bot._keyboard_scroll_to_bottom = lambda: calls.append("end_key")

        result = bot.wait_for_reply_done(timeout_sec=0.1)

        self.assertIs(result.copy_button, copy)
        self.assertEqual(calls, ["scroll_click", "end_key"])

    def test_copy_uses_sentinel_not_previous_clipboard_value(self):
        bot = self.make_bot()
        copy = det("copy_button")
        bot.get_state = lambda: state("REPLY_READY", copy_button=copy, evidence={"copy_button": copy})
        bot._ensure_reply_is_scrolled_to_bottom = lambda: None
        bot._click_detection = lambda *args, **kwargs: None

        clipboard = {"value": "old reply"}

        def fake_copy(value):
            clipboard["value"] = value

        def fake_paste():
            return "same visible reply"

        with patch("chat_vision.bot.pyperclip.copy", side_effect=fake_copy), patch(
            "chat_vision.bot.pyperclip.paste", side_effect=fake_paste
        ), patch("chat_vision.bot.time.time_ns", return_value=123), patch(
            "chat_vision.bot.time.sleep", lambda *_args, **_kwargs: None
        ):
            text = bot.copy_last_reply()

        self.assertEqual(text, "same visible reply")

    def test_enter_send_hides_mouse_after_keypress(self):
        bot = self.make_bot()
        calls = []
        bot._move_mouse_out_of_way = lambda: calls.append("hide")

        with patch("chat_vision.bot.pyautogui.press", side_effect=lambda key: calls.append(("press", key))):
            bot._press_enter_and_hide_mouse()

        self.assertEqual(calls, [("press", "enter"), "hide"])

    def test_send_restores_real_text_after_probe_paste(self):
        bot = self.make_bot()
        bot.timing.update(
            {
                "send_restart_max_attempts": 1,
                "post_paste_check_delay_sec": 0.01,
                "post_paste_pre_send_delay_sec": 0.01,
                "focus_probe_max_attempts": 1,
                "focus_probe_settle_sec": 0.01,
                "send_after_paste_sec": 0.01,
                "send_button_wait_timeout_sec": 0.01,
                "post_enter_check_delay_sec": 0.01,
                "require_waiting_after_send": True,
                "post_send_waiting_timeout_sec": 0.01,
            }
        )
        send_button = det("send_button")
        ready = state("READY_TO_SEND", send_button=send_button, evidence={"send_button": send_button})
        waiting = state("WAITING_REPLY")
        bot.wait_until_ready = lambda: ready
        bot.wait_for_typebox_marker = lambda: det("input_fallback")
        bot._click_input_area = lambda *args, **kwargs: None
        bot._release_modifiers = lambda: None
        bot.get_state = lambda: ready
        bot._wait_for_send_button_or_timeout = lambda timeout_sec=None: send_button
        bot._press_enter_and_hide_mouse = lambda: None
        bot._wait_for_stop_transition_after_send = lambda **kwargs: waiting

        clipboard = {"value": ""}
        pasted = []

        def fake_copy(value):
            clipboard["value"] = value

        def fake_combo(key):
            if key == "v":
                pasted.append(clipboard["value"])

        with patch("chat_vision.bot.pyperclip.copy", side_effect=fake_copy), patch(
            "chat_vision.bot.pyautogui.press", lambda *_args, **_kwargs: None
        ), patch("chat_vision.bot.time.sleep", lambda *_args, **_kwargs: None):
            bot._press_primary_combo = fake_combo
            bot.send_message("REAL_BODY")

        self.assertEqual(pasted, ["zzprobezz", "REAL_BODY"])

    def test_reply_marker_prefers_lower_copy_button(self):
        bot = self.make_bot()
        upper = det("copy_button", x=100, y=300, w=30, h=30)
        upper.score = 0.99
        lower = det("copy_button", x=100, y=500, w=30, h=30)
        lower.score = 0.9
        bot.logic = {"reply_markers": ["copy_button"]}
        bot.detector = SimpleNamespace(detect_all=lambda _frame, _name: [upper, lower])

        result = bot._lowest_reply_marker(object(), {"copy_button": upper})

        self.assertIs(result, lower)


if __name__ == "__main__":
    unittest.main()
