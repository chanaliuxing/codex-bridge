from __future__ import annotations

import json
import time
from collections import deque
from pathlib import Path


class LocalHistoryStore:
    def __init__(self, base_dir: Path, keep_last: int = 200):
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.file = self.base_dir / "chat_history.jsonl"
        self.keep_last = keep_last

    def append(self, role: str, text: str) -> None:
        record = {
            "ts": time.time(),
            "role": role,
            "text": text,
        }
        with self.file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._trim()

    def _trim(self) -> None:
        if not self.file.exists():
            return
        with self.file.open("r", encoding="utf-8") as f:
            lines = deque(f, maxlen=self.keep_last)
        with self.file.open("w", encoding="utf-8") as f:
            for line in lines:
                f.write(line)


class VisionEventStore:
    def __init__(self, base_dir: Path, file_name: str = "vision_events.jsonl", keep_last: int = 5000):
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.file = self.base_dir / file_name
        self.keep_last = keep_last

    def append(self, event: dict) -> None:
        record = {
            "ts": time.time(),
            **(event or {}),
        }
        with self.file.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._trim()

    def _trim(self) -> None:
        if not self.file.exists():
            return
        with self.file.open("r", encoding="utf-8") as f:
            lines = deque(f, maxlen=self.keep_last)
        with self.file.open("w", encoding="utf-8") as f:
            for line in lines:
                f.write(line)
