import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pathlib import Path
from sdk.python.bridge_tool_sdk import run_folder_tool


def handler(message):
    text = str(message.get("text", ""))
    return {"text": f"python folder length={len(text)} text={text}"}


if __name__ == "__main__":
    base = Path.cwd() / "mailboxes" / "python_folder"
    run_folder_tool(
        "python_folder",
        str(base / "inbox"),
        str(base / "outbox"),
        handler,
        poll_interval_ms=600,
    )
