import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
from PIL import Image

from integration.service import PigCameraService


class FakeTensor:
    def __init__(self, values):
        self.values = values

    def tolist(self):
        return self.values


class FakeDetector:
    def __init__(self, results):
        self.results = results
        self.options = None

    def predict(self, **options):
        self.options = options
        return self.results


def make_result(boxes, confidences, classes, shape=(100, 200), names=None):
    if boxes is None:
        result_boxes = None
    else:
        result_boxes = SimpleNamespace(
            xyxy=FakeTensor(boxes),
            conf=FakeTensor(confidences),
            cls=FakeTensor(classes),
        )
    return SimpleNamespace(
        boxes=result_boxes,
        orig_shape=shape,
        names=names or {0: "pig"},
    )


class DetectionServiceTests(unittest.TestCase):
    def make_service(self, results):
        service = object.__new__(PigCameraService)
        service.detector = FakeDetector(results)
        service.detector_error = None
        return service

    def test_returns_clipped_original_image_boxes_and_class_confidence(self):
        service = self.make_service([
            make_result(
                [[-5, 4.2, 210, 80.7], [20, 10, 20, 40], [5, 5, 10, 10]],
                [0.91, 0.8, float("nan")],
                [0, 0, 0],
            )
        ])
        image = np.zeros((100, 200, 3), dtype=np.uint8)

        detections, inference_time_ms = service.detect_objects(image)

        self.assertEqual(len(detections), 1)
        self.assertEqual(detections[0], {
            "class_name": "pig",
            "class_id": 0,
            "confidence": 0.91,
            "bbox_model_xyxy": {"x1": -5.0, "y1": 4.2, "x2": 210.0, "y2": 80.7},
            "bbox": {"x1": 0.0, "y1": 4.2, "x2": 200.0, "y2": 80.7},
        })
        self.assertGreaterEqual(inference_time_ms, 0)

    def test_uses_ultralytics_nms_settings_and_rgb_to_bgr_source(self):
        detector = FakeDetector([make_result([], [], [])])
        service = self.make_service([])
        service.detector = detector
        rgb_image = np.array([[[255, 0, 0]]], dtype=np.uint8)

        service.detect_objects(
            rgb_image,
            confidence_threshold=0.4,
            iou_threshold=0.6,
            image_size=960,
            device="cpu",
            half=True,
        )

        self.assertEqual(detector.options["conf"], 0.4)
        self.assertEqual(detector.options["iou"], 0.6)
        self.assertEqual(detector.options["imgsz"], 960)
        self.assertEqual(detector.options["device"], "cpu")
        self.assertNotIn("half", detector.options)
        self.assertEqual(detector.options["source"][0, 0].tolist(), [0, 0, 255])

    def test_returns_empty_list_when_no_objects_detected(self):
        service = self.make_service([make_result(None, [], [])])

        detections, _ = service.detect_objects(np.zeros((100, 200, 3), dtype=np.uint8))

        self.assertEqual(detections, [])

    def test_rejects_invalid_thresholds_and_images(self):
        service = self.make_service([])
        with self.assertRaisesRegex(ValueError, "confidence_threshold"):
            service.detect_objects(np.zeros((10, 10, 3), dtype=np.uint8), confidence_threshold=1.1)
        with self.assertRaisesRegex(ValueError, "RGB HWC"):
            service.detect_objects(np.zeros((10, 10), dtype=np.uint8))

    def test_missing_detector_reports_its_load_error(self):
        service = self.make_service([])
        service.detector = None
        service.detector_error = "YOLO weights are invalid."

        with self.assertRaisesRegex(RuntimeError, "YOLO weights are invalid"):
            service.detect_objects(np.zeros((10, 10, 3), dtype=np.uint8))

    def test_process_image_keeps_legacy_pig_data_without_exposing_debug_coordinates(self):
        service = object.__new__(PigCameraService)
        service.previous_boxes = []
        service.weight_model = None
        detection = {
            "class_name": "pig",
            "class_id": 0,
            "confidence": 0.9,
            "bbox_model_xyxy": {"x1": -1, "y1": 0, "x2": 10, "y2": 10},
            "bbox": {"x1": 0, "y1": 0, "x2": 10, "y2": 10},
        }
        service.detect_objects = lambda image: ([detection], 15.0)
        service._recognize = lambda crop: {"pig_id": "UNKNOWN", "confidence": 0.0, "known": False}
        service._classify_behavior = lambda crop: None
        service._append_log = lambda pig: None
        image_buffer = Image.new("RGB", (20, 20), "white")
        encoded_image = BytesIO()
        image_buffer.save(encoded_image, format="PNG")

        result = service.process_image(encoded_image.getvalue())

        self.assertEqual(result["detected_count"], 1)
        self.assertEqual(result["detections"][0]["bbox"], detection["bbox"])
        self.assertNotIn("bbox_model_xyxy", result["detections"][0])
        self.assertIsNone(result["pigs"][0]["estimated_weight_kg"])
        self.assertEqual(result["inference_time_ms"], 15.0)

    def test_debug_output_is_annotated_jpeg_under_configured_directory(self):
        image = Image.new("RGB", (40, 30), color="white")
        detection = {
            "class_name": "pig",
            "class_id": 0,
            "confidence": 0.95,
            "bbox_model_xyxy": {"x1": 2, "y1": 3, "x2": 30, "y2": 20},
            "bbox": {"x1": 2, "y1": 3, "x2": 30, "y2": 20},
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            with patch("integration.service.DETECTOR_DEBUG_DIR", Path(temporary_directory)):
                filename = PigCameraService._save_debug_image(image, [detection], 12.5)
                with Image.open(Path(temporary_directory) / filename) as saved_image:
                    self.assertEqual(saved_image.size, (image.width * 2, image.height))
                    self.assertEqual(saved_image.format, "JPEG")


if __name__ == "__main__":
    unittest.main()
