import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sdk.python.bridge_tool_sdk import run_stdio_tool


def handler(message):
    return {"text": f"python says: {str(message.get('text', '')).lower()}"}


if __name__ == "__main__":
    run_stdio_tool("python_stdio", handler)
