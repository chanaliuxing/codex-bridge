from __future__ import annotations

from pathlib import Path
from typing import Optional

import cv2
import numpy as np

from .models import Detection


class TemplateDetector:
    def __init__(self, project_root: Path, config: dict):
        self.project_root = project_root
        self.config = config
        self.scale_factors = list(config["matching"]["scale_factors"])
        self.default_threshold = float(config["matching"]["default_threshold"])
        self.rois = config.get("rois", {})
        self.templates = self._load_templates(config["templates"])

    def _load_templates(self, templates_cfg: dict) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for name, item in templates_cfg.items():
            raw_paths = item["path"]
            paths = raw_paths if isinstance(raw_paths, list) else [raw_paths]
            variants = []
            for raw_path in paths:
                path = self.project_root / raw_path
                tpl_bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
                if tpl_bgr is None:
                    raise FileNotFoundError(f"Template not found: {path}")

                gray = cv2.cvtColor(tpl_bgr, cv2.COLOR_BGR2GRAY)
                variants.append(
                    {
                        "path": str(path),
                        "image_gray": gray,
                        "image_gray_blur": self._blur_image(gray),
                        "image_edge": self._edge_image(gray),
                    }
                )
            preprocesses = list(item.get("preprocess", ["gray"]))

            out[name] = {
                "variants": variants,
                "threshold": float(item.get("threshold", self.default_threshold)),
                "allow_soft_match": bool(item.get("allow_soft_match", False)),
                "soft_threshold": float(item.get("soft_threshold", item.get("threshold", self.default_threshold))),
                "roi": item.get("roi", "whole"),
                "preprocess": preprocesses,
                "scale_factors": list(item.get("scale_factors", self.scale_factors)),
                "post_filter": item.get("post_filter", {}),
            }
        return out

    def _blur_image(self, gray: np.ndarray) -> np.ndarray:
        return cv2.GaussianBlur(gray, (3, 3), 0)

    def _edge_image(self, gray: np.ndarray) -> np.ndarray:
        blur = self._blur_image(gray)
        return cv2.Canny(blur, 60, 180)

    def _resolve_roi(self, frame_bgr: np.ndarray, roi_name: str) -> tuple[np.ndarray, tuple[int, int]]:
        if roi_name == "whole" or roi_name not in self.rois:
            return frame_bgr, (0, 0)

        cfg = self.rois[roi_name]
        h, w = frame_bgr.shape[:2]
        x0 = int(max(0.0, min(1.0, cfg["x0"])) * w)
        y0 = int(max(0.0, min(1.0, cfg["y0"])) * h)
        x1 = int(max(0.0, min(1.0, cfg["x1"])) * w)
        y1 = int(max(0.0, min(1.0, cfg["y1"])) * h)

        x1 = max(x0 + 1, x1)
        y1 = max(y0 + 1, y1)

        return frame_bgr[y0:y1, x0:x1], (x0, y0)

    def _prepare_frame_variant(
        self,
        frame_bgr: np.ndarray,
        roi_name: str,
        preprocess: str,
        cache: dict,
    ) -> tuple[np.ndarray, tuple[int, int]]:
        key = (roi_name, preprocess)
        if key in cache:
            return cache[key]

        roi_bgr, offset = self._resolve_roi(frame_bgr, roi_name)
        gray = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2GRAY)

        if preprocess == "gray":
            result = gray
        elif preprocess == "gray_blur":
            result = self._blur_image(gray)
        elif preprocess == "edge":
            result = self._edge_image(gray)
        else:
            raise ValueError(f"Unsupported preprocess mode: {preprocess}")

        cache[key] = (result, offset)
        return result, offset

    def _match_one(self, frame_proc: np.ndarray, template_proc: np.ndarray, scale: float) -> tuple[float, tuple[int, int], tuple[int, int]]:
        if scale == 1.0:
            resized = template_proc
        else:
            new_w = max(8, int(template_proc.shape[1] * scale))
            new_h = max(8, int(template_proc.shape[0] * scale))
            resized = cv2.resize(template_proc, (new_w, new_h), interpolation=cv2.INTER_AREA)

        h, w = resized.shape[:2]
        if h >= frame_proc.shape[0] or w >= frame_proc.shape[1]:
            return -1.0, (0, 0), (w, h)

        result = cv2.matchTemplate(frame_proc, resized, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(result)
        return float(max_val), max_loc, (w, h)

    def _match_all(
        self,
        frame_proc: np.ndarray,
        template_proc: np.ndarray,
        scale: float,
        threshold: float,
    ) -> list[tuple[float, tuple[int, int], tuple[int, int]]]:
        if scale == 1.0:
            resized = template_proc
        else:
            new_w = max(8, int(template_proc.shape[1] * scale))
            new_h = max(8, int(template_proc.shape[0] * scale))
            resized = cv2.resize(template_proc, (new_w, new_h), interpolation=cv2.INTER_AREA)

        h, w = resized.shape[:2]
        if h >= frame_proc.shape[0] or w >= frame_proc.shape[1]:
            return []

        result = cv2.matchTemplate(frame_proc, resized, cv2.TM_CCOEFF_NORMED)
        ys, xs = np.where(result >= threshold)
        return [(float(result[y, x]), (int(x), int(y)), (w, h)) for y, x in zip(ys, xs)]

    def _nms_detections(self, detections: list[Detection], iou_threshold: float = 0.35) -> list[Detection]:
        kept: list[Detection] = []
        for det in sorted(detections, key=lambda item: item.score, reverse=True):
            should_keep = True
            for existing in kept:
                x0 = max(det.x, existing.x)
                y0 = max(det.y, existing.y)
                x1 = min(det.x + det.w, existing.x + existing.w)
                y1 = min(det.y + det.h, existing.y + existing.h)
                inter = max(0, x1 - x0) * max(0, y1 - y0)
                union = det.w * det.h + existing.w * existing.h - inter
                iou = inter / union if union > 0 else 0.0
                if iou > iou_threshold:
                    should_keep = False
                    break
            if should_keep:
                kept.append(det)
        return kept

    def _template_variant(self, variant: dict, preprocess: str) -> np.ndarray:
        if preprocess == "gray":
            return variant["image_gray"]
        if preprocess == "gray_blur":
            return variant["image_gray_blur"]
        if preprocess == "edge":
            return variant["image_edge"]
        raise ValueError(f"Unsupported preprocess mode: {preprocess}")

    def _passes_post_filter(
        self,
        frame_bgr: np.ndarray,
        det: Detection,
        post_filter: dict,
    ) -> bool:
        if not post_filter:
            return True

        min_w = post_filter.get("min_w")
        min_h = post_filter.get("min_h")
        if min_w is not None and det.w < int(min_w):
            return False
        if min_h is not None and det.h < int(min_h):
            return False

        center_region = post_filter.get("center_region")
        if center_region:
            frame_h, frame_w = frame_bgr.shape[:2]
            cx, cy = det.center
            x0 = float(center_region.get("x0", 0.0)) * frame_w
            y0 = float(center_region.get("y0", 0.0)) * frame_h
            x1 = float(center_region.get("x1", 1.0)) * frame_w
            y1 = float(center_region.get("y1", 1.0)) * frame_h
            if not (x0 <= cx <= x1 and y0 <= cy <= y1):
                return False

        return True

    def _effective_threshold(self, cfg: dict) -> float:
        threshold = cfg["threshold"]
        soft_threshold = cfg["soft_threshold"]
        if (
            cfg["allow_soft_match"]
            and 0.5 <= soft_threshold < threshold
            and cfg["post_filter"].get("center_region")
        ):
            return soft_threshold
        return threshold

    def detect(self, frame_bgr: np.ndarray, name: str) -> Optional[Detection]:
        detections = self.detect_many(frame_bgr, names=[name])
        return detections.get(name)

    def detect_all(self, frame_bgr: np.ndarray, name: str) -> list[Detection]:
        cfg = self.templates[name]
        frame_cache: dict = {}
        hits: list[Detection] = []
        threshold = self._effective_threshold(cfg)

        for preprocess in cfg["preprocess"]:
            frame_proc, (offset_x, offset_y) = self._prepare_frame_variant(
                frame_bgr=frame_bgr,
                roi_name=cfg["roi"],
                preprocess=preprocess,
                cache=frame_cache,
            )
            for variant in cfg["variants"]:
                tpl_proc = self._template_variant(variant, preprocess)
                for scale in cfg["scale_factors"]:
                    for score, (x, y), (w, h) in self._match_all(frame_proc, tpl_proc, scale, threshold):
                        det = Detection(
                            name=name,
                            score=score,
                            x=x + offset_x,
                            y=y + offset_y,
                            w=w,
                            h=h,
                            scale=float(scale),
                            roi_name=cfg["roi"],
                            preprocess=preprocess,
                        )
                        if self._passes_post_filter(frame_bgr, det, cfg["post_filter"]):
                            hits.append(det)

        return self._nms_detections(hits)

    def detect_many(self, frame_bgr: np.ndarray, names: Optional[list[str]] = None) -> dict[str, Optional[Detection]]:
        target_names = names or list(self.templates.keys())
        frame_cache: dict = {}
        out: dict[str, Optional[Detection]] = {}

        for name in target_names:
            cfg = self.templates[name]
            best: Optional[Detection] = None
            threshold = self._effective_threshold(cfg)

            for preprocess in cfg["preprocess"]:
                frame_proc, (offset_x, offset_y) = self._prepare_frame_variant(
                    frame_bgr=frame_bgr,
                    roi_name=cfg["roi"],
                    preprocess=preprocess,
                    cache=frame_cache,
                )

                for variant in cfg["variants"]:
                    tpl_proc = self._template_variant(variant, preprocess)

                    for scale in cfg["scale_factors"]:
                        score, (x, y), (w, h) = self._match_one(frame_proc, tpl_proc, scale)
                        if score < threshold:
                            continue

                        det = Detection(
                            name=name,
                            score=score,
                            x=x + offset_x,
                            y=y + offset_y,
                            w=w,
                            h=h,
                            scale=float(scale),
                            roi_name=cfg["roi"],
                            preprocess=preprocess,
                        )
                        if not self._passes_post_filter(frame_bgr, det, cfg["post_filter"]):
                            continue
                        if best is None or det.score > best.score:
                            best = det

            out[name] = best

        return out

    def best_scores(self, frame_bgr: np.ndarray, names: Optional[list[str]] = None) -> dict[str, dict]:
        target_names = names or list(self.templates.keys())
        frame_cache: dict = {}
        out: dict[str, dict] = {}

        for name in target_names:
            cfg = self.templates[name]
            best_info = {
                "score": -1.0,
                "threshold": cfg["threshold"],
                "delta": -1.0 - cfg["threshold"],
                "hit": False,
                "roi": cfg["roi"],
                "preprocess": None,
                "scale": 1.0,
                "best_loc": None,
                "best_pass_post_filter": False,
            }
            threshold = self._effective_threshold(cfg)

            for preprocess in cfg["preprocess"]:
                frame_proc, (offset_x, offset_y) = self._prepare_frame_variant(
                    frame_bgr=frame_bgr,
                    roi_name=cfg["roi"],
                    preprocess=preprocess,
                    cache=frame_cache,
                )
                for variant in cfg["variants"]:
                    tpl_proc = self._template_variant(variant, preprocess)
                    for scale in cfg["scale_factors"]:
                        score, (x, y), (w, h) = self._match_one(frame_proc, tpl_proc, scale)
                        det = Detection(
                            name=name,
                            score=score,
                            x=x + offset_x,
                            y=y + offset_y,
                            w=w,
                            h=h,
                            scale=float(scale),
                            roi_name=cfg["roi"],
                            preprocess=preprocess,
                        )
                        passes = self._passes_post_filter(frame_bgr, det, cfg["post_filter"])
                        if score > best_info["score"]:
                            best_info = {
                                "score": score,
                                "threshold": threshold,
                                "delta": score - threshold,
                                "hit": score >= threshold and passes,
                                "roi": cfg["roi"],
                                "preprocess": preprocess,
                                "scale": float(scale),
                                "best_loc": (int(x + offset_x), int(y + offset_y)),
                                "best_pass_post_filter": passes,
                            }

            out[name] = best_info

        return out

    def draw_detections(self, frame_bgr: np.ndarray, detections: dict[str, Optional[Detection]]) -> np.ndarray:
        canvas = frame_bgr.copy()
        for name, det in detections.items():
            if det is None:
                continue
            cv2.rectangle(canvas, (det.x, det.y), (det.x + det.w, det.y + det.h), (0, 200, 0), 2)
            label = f"{name}:{det.score:.2f}"
            cv2.putText(
                canvas,
                label,
                (det.x, max(18, det.y - 6)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.52,
                (0, 180, 0),
                2,
                cv2.LINE_AA,
            )
        return canvas
