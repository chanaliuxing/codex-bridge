from __future__ import annotations

import cv2
import mss
import numpy as np


class ScreenCapturer:
    def __init__(self, region: dict[str, int]):
        self.region = region
        self._sct = mss.mss()

    def set_region(self, region: dict[str, int]) -> None:
        self.region = region

    def grab_bgr(self) -> np.ndarray:
        shot = self._sct.grab(self.region)
        img = np.array(shot)
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
