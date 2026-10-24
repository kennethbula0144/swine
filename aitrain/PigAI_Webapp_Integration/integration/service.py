from __future__ import annotations

import json
import math
import pickle
import time
from datetime import datetime
from io import BytesIO
from pathlib import Path
from typing import Any
from uuid import uuid4

import cv2
import joblib
import numpy as np
from PIL import Image
from torch import nn
from ultralytics import YOLO

from .config import (
    DETECTOR_CONFIDENCE,
    DETECTOR_DEVICE,
    DETECTOR_HALF,
    DETECTOR_IMAGE_SIZE,
    DETECTOR_IOU,
    DETECTOR_DEBUG_DIR,
    BEHAVIOR_MODEL_FILE,
    IDENTITY_CLASSES,
    MODEL_DIR,
    RECOGNITION_MARGIN,
    RECOGNITION_THRESHOLD,
    WEIGHT_CALIBRATION_FILE,
    WEIGHT_MODEL_FILE,
)

try:
    import torch
    from torchvision import transforms
except ImportError:
    torch = None
    transforms = None


class SimplePigClassifier(nn.Module):
    def __init__(self, num_classes: int):
        super().__init__()
        self.model = nn.Sequential(
            nn.Conv2d(3, 16, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(16, 32, 3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(2),
            nn.Conv2d(32, 64, 3, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((1, 1)),
        )
        self.classifier = nn.Linear(64, num_classes)

    def forward(self, images):
        features = self.model(images)
        return self.classifier(torch.flatten(features, 1))


class PigCameraService:
    def __init__(self, log_file: Path):
        self.log_file = log_file
        self.previous_boxes: list[dict[str, Any]] = []
        self.recognition_model, self.classes = self._load_recognition_model()
        self.behavior_model, self.behavior_classes = self._load_behavior_model()
        self.weight_model = joblib.load(WEIGHT_MODEL_FILE) if WEIGHT_MODEL_FILE.exists() else None
        self.weight_calibration = {"slope": 1.0, "intercept": 0.0}
        if WEIGHT_CALIBRATION_FILE.exists():
            try:
                self.weight_calibration.update(json.loads(WEIGHT_CALIBRATION_FILE.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError, TypeError):
                pass
        detector_file = MODEL_DIR / "pig_detector.pt"
        self.detector_error: str | None = None
        self.detector = None
        if detector_file.is_file():
            try:
                self.detector = YOLO(str(detector_file))
            except (OSError, RuntimeError, ValueError, KeyError, EOFError, pickle.UnpicklingError) as error:
                self.detector_error = f"Could not load YOLO weights at {detector_file}: {error}"
        else:
            self.detector_error = f"YOLO weights not found at {detector_file}"

    def _load_recognition_model(self):
        model_file = MODEL_DIR / "pig_model.pt"
        if torch is None or not model_file.exists():
            return None, []
        checkpoint = torch.load(model_file, map_location="cpu")
        classes = checkpoint["classes"]
        if tuple(classes) != IDENTITY_CLASSES:
            return None, []
        model = SimplePigClassifier(num_classes=len(classes))
        model.load_state_dict(checkpoint["model_state"])
        model.eval()
        return model, classes

    def _load_behavior_model(self):
        if torch is None or not BEHAVIOR_MODEL_FILE.exists():
            return None, []
        checkpoint = torch.load(BEHAVIOR_MODEL_FILE, map_location="cpu")
        classes = checkpoint.get("classes", [])
        if len(classes) < 2:
            return None, []
        model = SimplePigClassifier(num_classes=len(classes))
        model.load_state_dict(checkpoint["model_state"])
        model.eval()
        return model, classes

    @staticmethod
    def _weight_features(image: Image.Image) -> np.ndarray:
        pixels = np.asarray(image.convert("RGB"))
        return np.asarray([pixels.shape[0] * pixels.shape[1], pixels.mean(axis=(0, 1)).mean()], dtype=float)

    def _recognize(self, crop: Image.Image) -> dict[str, Any]:
        if self.recognition_model is None or transforms is None:
            return {"pig_id": "UNKNOWN", "confidence": 0.0, "known": False}
        tensor = transforms.Compose([transforms.Resize((64, 64)), transforms.ToTensor()])(
            crop.convert("RGB")
        ).unsqueeze(0)
        with torch.no_grad():
            probabilities = torch.softmax(self.recognition_model(tensor), dim=1)[0]
            values, indices = torch.sort(probabilities, descending=True)
        confidence = float(values[0].item())
        second = float(values[1].item()) if len(values) > 1 else 0.0
        known = confidence >= RECOGNITION_THRESHOLD and confidence - second >= RECOGNITION_MARGIN
        class_name = self.classes[int(indices[0].item())] if known else "UNKNOWN"
        return {"pig_id": class_name, "confidence": confidence * 100, "known": known}

    def _classify_behavior(self, crop: Image.Image) -> dict[str, Any] | None:
        if self.behavior_model is None or transforms is None:
            return None
        tensor = transforms.Compose([transforms.Resize((64, 64)), transforms.ToTensor()])(
            crop.convert("RGB")
        ).unsqueeze(0)
        with torch.no_grad():
            probabilities = torch.softmax(self.behavior_model(tensor), dim=1)[0]
            confidence, index = torch.max(probabilities, dim=0)
        return {
            "label": self.behavior_classes[int(index.item())],
            "confidence": float(confidence.item()) * 100,
        }

    def detect_objects(
        self,
        image: Image.Image | np.ndarray,
        confidence_threshold: float = DETECTOR_CONFIDENCE,
        iou_threshold: float = DETECTOR_IOU,
        image_size: int = DETECTOR_IMAGE_SIZE,
        device: str | None = DETECTOR_DEVICE,
        half: bool = DETECTOR_HALF,
    ) -> tuple[list[dict[str, Any]], float]:
        """Run Ultralytics inference and return clipped original-image xyxy boxes."""
        if self.detector is None:
            raise RuntimeError(self.detector_error or "YOLO detector is not loaded.")
        for name, value in (("confidence_threshold", confidence_threshold), ("iou_threshold", iou_threshold)):
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError(f"{name} must be a finite value between 0 and 1.")
        if image_size <= 0:
            raise ValueError("image_size must be a positive integer.")

        if isinstance(image, Image.Image):
            rgb_image = np.asarray(image.convert("RGB"))
        elif isinstance(image, np.ndarray) and image.ndim == 3 and image.shape[2] == 3:
            rgb_image = image
        else:
            raise ValueError("image must be a PIL image or an RGB HWC image array.")
        height, width = rgb_image.shape[:2]
        if height == 0 or width == 0:
            raise ValueError("image must not be empty.")

        # Ultralytics interprets NumPy sources as OpenCV BGR images. Convert once;
        # Ultralytics handles resize, letterboxing, NMS, and mapping boxes to orig_shape.
        bgr_image = cv2.cvtColor(np.ascontiguousarray(rgb_image), cv2.COLOR_RGB2BGR)
        requested_device = (device or "").strip().lower()
        use_half = bool(
            half
            and torch is not None
            and torch.cuda.is_available()
            and requested_device not in {"cpu", "mps"}
        )
        prediction_options: dict[str, Any] = {
            "source": bgr_image,
            "conf": confidence_threshold,
            "iou": iou_threshold,
            "imgsz": image_size,
            "verbose": False,
        }
        if use_half:
            prediction_options["half"] = True
        if device is not None:
            prediction_options["device"] = device

        started_at = time.perf_counter()
        results = self.detector.predict(**prediction_options)
        inference_time_ms = (time.perf_counter() - started_at) * 1000
        detections: list[dict[str, Any]] = []
        for result in results:
            if result.boxes is None:
                continue
            original_height, original_width = result.orig_shape
            if original_height <= 0 or original_width <= 0:
                raise ValueError("YOLO returned an invalid original image shape.")
            names = result.names or {}
            raw_boxes = result.boxes.xyxy.tolist()
            raw_confidences = result.boxes.conf.tolist()
            raw_class_ids = result.boxes.cls.tolist()
            if not (len(raw_boxes) == len(raw_confidences) == len(raw_class_ids)):
                raise ValueError("YOLO returned mismatched box, confidence, and class counts.")
            for raw_box, raw_confidence, raw_class_id in zip(raw_boxes, raw_confidences, raw_class_ids):
                if len(raw_box) != 4 or not all(math.isfinite(float(value)) for value in raw_box):
                    continue
                if not math.isfinite(float(raw_confidence)) or not math.isfinite(float(raw_class_id)):
                    continue
                x1, y1, x2, y2 = (float(value) for value in raw_box)
                x1 = min(max(x1, 0.0), float(original_width))
                x2 = min(max(x2, 0.0), float(original_width))
                y1 = min(max(y1, 0.0), float(original_height))
                y2 = min(max(y2, 0.0), float(original_height))
                if x2 <= x1 or y2 <= y1:
                    continue

                class_id = int(raw_class_id)
                if isinstance(names, dict):
                    class_name = str(names.get(class_id, class_id))
                elif isinstance(names, (list, tuple)) and 0 <= class_id < len(names):
                    class_name = str(names[class_id])
                else:
                    class_name = str(class_id)
                confidence = float(raw_confidence)
                if not 0 <= confidence <= 1:
                    continue
                detections.append({
                    "class_name": class_name,
                    "class_id": class_id,
                    "confidence": confidence,
                    "bbox_model_xyxy": {
                        "x1": round(float(raw_box[0]), 2),
                        "y1": round(float(raw_box[1]), 2),
                        "x2": round(float(raw_box[2]), 2),
                        "y2": round(float(raw_box[3]), 2),
                    },
                    "bbox": {
                        "x1": round(x1, 2),
                        "y1": round(y1, 2),
                        "x2": round(x2, 2),
                        "y2": round(y2, 2),
                    },
                })
        return detections, inference_time_ms

    @staticmethod
    def _detect_boxes(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [
            {
                **detection["bbox"],
                "confidence": round(detection["confidence"] * 100, 2),
                "class_name": detection["class_name"],
                "class_id": detection["class_id"],
            }
            for detection in detections
        ]

    @staticmethod
    def _save_debug_image(
        image: Image.Image,
        detections: list[dict[str, Any]],
        inference_time_ms: float,
    ) -> str:
        original = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2BGR)
        corrected = original.copy()

        for detection in detections:
            for canvas, coordinate_key, color in (
                (original, "bbox_model_xyxy", (0, 180, 255)),
                (corrected, "bbox", (0, 220, 80)),
            ):
                box = detection[coordinate_key]
                x1, y1, x2, y2 = (int(round(box[key])) for key in ("x1", "y1", "x2", "y2"))
                cv2.rectangle(canvas, (x1, y1), (x2, y2), color, 2)
                label = f'{detection["class_name"]} {detection["confidence"]:.2f} [{x1},{y1},{x2},{y2}]'
                cv2.putText(canvas, label, (max(0, x1), max(18, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1)

        cv2.putText(original, "Ultralytics original-image xyxy", (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
        cv2.putText(corrected, "Returned (clipped) xyxy", (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2)
        cv2.putText(
            original,
            f"Inference: {inference_time_ms:.2f} ms | Detections: {len(detections)}",
            (8, 42),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            2,
        )
        annotated = np.concatenate((original, corrected), axis=1)
        DETECTOR_DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        filename = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid4().hex[:8]}.jpg"
        if not cv2.imwrite(str(DETECTOR_DEBUG_DIR / filename), annotated):
            raise OSError("Could not save the annotated YOLO debug image.")
        return filename

    @staticmethod
    def _movement_indicator(box: dict[str, Any], previous_boxes: list[dict[str, Any]], image: Image.Image) -> str:
        if not previous_boxes:
            return "New observation"

        current_center = ((box["x1"] + box["x2"]) / 2, (box["y1"] + box["y2"]) / 2)
        current_width = max(box["x2"] - box["x1"], 1)
        nearest_distance = min(
            (
                ((current_center[0] - ((old["x1"] + old["x2"]) / 2)) ** 2
                 + (current_center[1] - ((old["y1"] + old["y2"]) / 2)) ** 2) ** 0.5
                for old in previous_boxes
            ),
            default=0,
        )
        normalized_motion = nearest_distance / current_width
        if normalized_motion < 0.15:
            return "Stationary"
        if normalized_motion < 0.6:
            return "Moving"
        return "Highly active"

    def process_image(self, image_bytes: bytes, debug: bool = False) -> dict[str, Any]:
        try:
            image = Image.open(BytesIO(image_bytes)).convert("RGB")
        except (OSError, ValueError) as error:
            raise ValueError("The uploaded file is not a valid image.") from error
        detections, inference_time_ms = self.detect_objects(image)
        boxes = self._detect_boxes(detections)
        previous_boxes = self.previous_boxes
        self.previous_boxes = boxes
        pigs = []
        for index, (box, detection) in enumerate(zip(boxes, detections), start=1):
            coordinates = (int(box["x1"]), int(box["y1"]), int(box["x2"]), int(box["y2"]))
            crop = image.crop(coordinates)
            identity = self._recognize(crop)
            behavior = self._classify_behavior(crop)
            if self.weight_model is None:
                estimated_weight = None
            else:
                estimated_weight = float(self.weight_model.predict(self._weight_features(crop).reshape(1, -1))[0])
                estimated_weight = (
                    estimated_weight * self.weight_calibration["slope"]
                    + self.weight_calibration["intercept"]
                )
            pig = {
                "pig_id": identity["pig_id"] if identity["known"] else f"UNKNOWN-{index}",
                "recognition_confidence": round(identity["confidence"], 2),
                "estimated_weight_kg": round(estimated_weight, 2) if estimated_weight is not None else None,
                "behavior_indicator": behavior["label"] if behavior else self._movement_indicator(box, previous_boxes, image),
                "behavior_confidence": round(behavior["confidence"], 2) if behavior else None,
                "behavior_source": "OPB behavior model" if behavior else "Movement heuristic",
                "box": box,
                "detection": {key: value for key, value in detection.items() if key != "bbox_model_xyxy"},
            }
            pigs.append(pig)
            self._append_log(pig)
        result = {
            "status": "ok",
            "pigs": pigs,
            "detections": [
                {key: value for key, value in detection.items() if key != "bbox_model_xyxy"}
                for detection in detections
            ],
            "detected_count": len(pigs),
            "inference_time_ms": round(inference_time_ms, 2),
        }
        if debug:
            result["debug_image"] = self._save_debug_image(image, detections, inference_time_ms)
        return result

    def _append_log(self, pig: dict[str, Any]) -> None:
        import pandas as pd

        row = pd.DataFrame([{"timestamp": datetime.now().isoformat(timespec="seconds"), **pig}])
        self.log_file.parent.mkdir(parents=True, exist_ok=True)
        row.to_csv(self.log_file, mode="a", header=not self.log_file.exists(), index=False)
