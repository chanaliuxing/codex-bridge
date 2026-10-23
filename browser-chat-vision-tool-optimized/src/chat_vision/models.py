from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Detection:
    name: str
    score: float
    x: int
    y: int
    w: int
    h: int
    scale: float
    roi_name: str
    preprocess: str

    @property
    def center(self) -> tuple[int, int]:
        return (self.x + self.w // 2, self.y + self.h // 2)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "score": round(self.score, 4),
            "x": self.x,
            "y": self.y,
            "w": self.w,
            "h": self.h,
            "scale": self.scale,
            "roi_name": self.roi_name,
            "preprocess": self.preprocess,
        }


@dataclass
class UiState:
    name: str
    reason: str
    send_button: Optional[Detection] = None
    input_marker: Optional[Detection] = None
    stop_button: Optional[Detection] = None
    copy_button: Optional[Detection] = None
    down_arrow: Optional[Detection] = None
    page_marker: Optional[Detection] = None
    voice_button: Optional[Detection] = None
    evidence: dict[str, Optional[Detection]] = field(default_factory=dict)

    def to_snapshot(self) -> dict:
        return {
            "state": self.name,
            "reason": self.reason,
            "send_button": self.send_button.to_dict() if self.send_button else None,
            "input_marker": self.input_marker.to_dict() if self.input_marker else None,
            "stop_button": self.stop_button.to_dict() if self.stop_button else None,
            "copy_button": self.copy_button.to_dict() if self.copy_button else None,
            "down_arrow": self.down_arrow.to_dict() if self.down_arrow else None,
            "page_marker": self.page_marker.to_dict() if self.page_marker else None,
            "voice_button": self.voice_button.to_dict() if self.voice_button else None,
            "all_matches": {
                name: det.to_dict() if det else None
                for name, det in self.evidence.items()
            },
        }
