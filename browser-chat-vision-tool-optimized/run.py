from __future__ import annotations

import argparse
import json
from pathlib import Path

from src.chat_vision.bot import ChatVisionBot


def load_config(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Browser Chat Vision Tool - Optimized")
    p.add_argument("--config", default="config.json", help="Path to config JSON")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("watch", help="Watch UI state continuously")

    state = sub.add_parser("state", help="Print current state once")
    state.add_argument("--json", action="store_true", help="Print raw JSON")

    send = sub.add_parser("send", help="Send a message only")
    send.add_argument("--text", required=True)

    ask = sub.add_parser("ask", help="Send then wait and copy reply")
    ask.add_argument("--text", required=True)

    sub.add_parser("copy-last", help="Copy latest assistant reply via copy button")

    debug = sub.add_parser("debug-shot", help="Save annotated debug image")
    debug.add_argument("--out", default="debug/last_debug.png", help="Output image path")
    return p


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    config = load_config(args.config)
    project_root = Path(args.config).resolve().parent
    bot = ChatVisionBot(project_root=project_root, config=config)

    if args.cmd == "watch":
        bot.watch()
    elif args.cmd == "send":
        bot.send_message(args.text)
    elif args.cmd == "ask":
        reply = bot.ask(args.text)
        print("\n===== ASSISTANT REPLY =====\n")
        print(reply)
    elif args.cmd == "copy-last":
        print(bot.copy_last_reply())
    elif args.cmd == "state":
        snapshot = bot.get_state_snapshot()
        if args.json:
            print(json.dumps(snapshot, ensure_ascii=False, indent=2))
        else:
            print(snapshot["state"])
            print(snapshot["reason"])
            print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    elif args.cmd == "debug-shot":
        out = bot.save_debug_shot(args.out)
        print(out)


if __name__ == "__main__":
    main()
