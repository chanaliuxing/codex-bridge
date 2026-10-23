import json
import os
import sys
import time
from pathlib import Path


def create_reply(message, tool_name, text, to=None, meta=None):
    return {
        "threadId": message.get("threadId", "default"),
        "from": tool_name,
        "to": to or message.get("meta", {}).get("replyTo") or "console",
        "role": "assistant",
        "type": "text",
        "text": str(text),
        "meta": {
            "sourceMessageId": message.get("id"),
            **(meta or {})
        }
    }


def run_stdio_tool(tool_name, handler):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except Exception:
            continue
        result = handler(message)
        if result is None:
            continue
        if isinstance(result, dict):
            payload = create_reply(
                message,
                tool_name,
                result.get("text", ""),
                to=result.get("to"),
                meta=result.get("meta"),
            )
        else:
            payload = create_reply(message, tool_name, result)
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()


def run_folder_tool(tool_name, inbox_dir, outbox_dir, handler, poll_interval_ms=1000):
    inbox = Path(inbox_dir)
    outbox = Path(outbox_dir)
    processed = inbox / ".processed"
    inbox.mkdir(parents=True, exist_ok=True)
    outbox.mkdir(parents=True, exist_ok=True)
    processed.mkdir(parents=True, exist_ok=True)

    print(f"{tool_name} folder tool is running", flush=True)

    while True:
        files = sorted([p for p in inbox.iterdir() if p.is_file() and p.suffix == ".json"])
        for file_path in files:
            try:
                message = json.loads(file_path.read_text("utf-8"))
            except Exception:
                file_path.rename(processed / (file_path.name + ".bad"))
                continue

            result = handler(message)
            if result is not None:
                if isinstance(result, dict):
                    payload = create_reply(
                        message,
                        tool_name,
                        result.get("text", ""),
                        to=result.get("to"),
                        meta=result.get("meta"),
                    )
                else:
                    payload = create_reply(message, tool_name, result)
                out_file = outbox / f"{int(time.time() * 1000)}_{os.getpid()}.json"
                out_file.write_text(json.dumps(payload, indent=2), "utf-8")

            file_path.rename(processed / f"{int(time.time() * 1000)}_{file_path.name}")

        time.sleep(poll_interval_ms / 1000.0)
