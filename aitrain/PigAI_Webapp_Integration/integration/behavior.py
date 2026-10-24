from __future__ import annotations

import json
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any

from .config import BEHAVIOR_DATASET_DIR

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
VIDEO_SUFFIXES = {".mp4", ".avi", ".mov", ".mkv"}
LABEL_ALIASES = {
    "fight": "Fighting",
    "no fight": "No fight",
    "nose to nose": "Nose-to-nose interaction",
    "nose-to-nose": "Nose-to-nose interaction",
    "moutend": "Mounting",
    "not lying": "Not lying",
    "sitting nf": "Sitting (no fight)",
    "standing nf": "Standing (no fight)",
    "sternal lying nf": "Sternal lying (no fight)",
    "lateral lying": "Lateral lying",
    "sternal lying drinking": "Sternal lying while drinking",
    "sternal lying feeding": "Sternal lying while eating",
    "standing drinking": "Standing while drinking",
    "standing feeding": "Standing while eating",
    "sitting drinking": "Sitting while drinking",
    "sitting feeding": "Sitting while eating",
}


def normalize_behavior_label(label: str) -> str:
    normalized = re.sub(r"\s+", " ", label.replace("_", " ").replace("-", " ").strip().casefold())
    return LABEL_ALIASES.get(normalized, normalized.capitalize())


def _source_directories(dataset_root: Path) -> dict[str, Path]:
    directories: dict[str, Path] = {}
    if not dataset_root.is_dir():
        return directories
    for parent in dataset_root.iterdir():
        if not parent.is_dir():
            continue
        directories.setdefault(parent.name, parent)
        for child in parent.iterdir():
            if child.is_dir():
                directories.setdefault(child.name, child)
    return directories


def _resolve_sample_path(reference: str, source_directories: dict[str, Path]) -> Path | None:
    path_text = reference.replace("\\", "/").strip()
    if ": " in path_text:
        path_text = path_text.split(": ", 1)[1]
    parts = [part for part in path_text.split("/") if part]
    for index, part in enumerate(parts):
        source_directory = source_directories.get(part)
        if source_directory is not None:
            return source_directory.joinpath(*parts[index + 1 :])
    return None


def _sample_directory_exists(media_path: Path, directory_status: dict[Path, bool]) -> bool:
    parent = media_path.parent
    if parent not in directory_status:
        directory_status[parent] = parent.is_dir()
    return directory_status[parent]


@lru_cache(maxsize=4)
def _load_samples(
    dataset_root_text: str,
    train_modified: int,
    test_modified: int,
) -> tuple[dict[str, tuple[tuple[str, str], ...]], dict[str, int]]:
    dataset_root = Path(dataset_root_text)
    source_directories = _source_directories(dataset_root)
    directory_status: dict[Path, bool] = {}
    samples: dict[str, list[tuple[str, str]]] = {"train": [], "test": []}
    counts = Counter()

    for split, filename in (("train", "train.json"), ("test", "test.json")):
        metadata_path = dataset_root / filename
        if not metadata_path.is_file():
            continue
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            counts[f"{split}_metadata_errors"] += 1
            continue

        for row in payload.get("training_data", []):
            label = normalize_behavior_label(str(row.get("original_label") or row.get("label") or ""))
            media_path = _resolve_sample_path(str(row.get("input") or ""), source_directories)
            if not label or media_path is None:
                counts[f"{split}_unresolved"] += 1
                continue
            suffix = media_path.suffix.lower()
            if suffix in VIDEO_SUFFIXES:
                counts[f"{split}_videos"] += _sample_directory_exists(media_path, directory_status)
                continue
            if suffix not in IMAGE_SUFFIXES:
                counts[f"{split}_unsupported"] += 1
                continue
            if not _sample_directory_exists(media_path, directory_status):
                counts[f"{split}_missing_images"] += 1
                continue
            samples[split].append((str(media_path), label))

    return {split: tuple(entries) for split, entries in samples.items()}, dict(counts)


def _load_manifest(dataset_root: Path):
    train_path = dataset_root / "train.json"
    test_path = dataset_root / "test.json"
    return _load_samples(
        str(dataset_root.resolve()),
        train_path.stat().st_mtime_ns if train_path.exists() else 0,
        test_path.stat().st_mtime_ns if test_path.exists() else 0,
    )


def behavior_samples(split: str, dataset_root: Path = BEHAVIOR_DATASET_DIR) -> tuple[tuple[str, str], ...]:
    if split not in {"train", "test"}:
        raise ValueError("Behavior dataset split must be 'train' or 'test'.")
    samples, _ = _load_manifest(dataset_root)
    return samples[split]


def behavior_dataset_summary(dataset_root: Path = BEHAVIOR_DATASET_DIR) -> dict[str, Any]:
    train_path = dataset_root / "train.json"
    test_path = dataset_root / "test.json"
    samples, counts = _load_manifest(dataset_root)
    train_counts = Counter(label for _, label in samples["train"])
    test_counts = Counter(label for _, label in samples["test"])
    labels = sorted(set(train_counts) | set(test_counts), key=str.casefold)
    return {
        "dataset_path": str(dataset_root),
        "classes": [
            {"name": label, "train_images": train_counts[label], "test_images": test_counts[label]}
            for label in labels
        ],
        "train_image_count": len(samples["train"]),
        "test_image_count": len(samples["test"]),
        "train_video_count": counts.get("train_videos", 0),
        "test_video_count": counts.get("test_videos", 0),
        "train_missing_images": counts.get("train_missing_images", 0),
        "test_missing_images": counts.get("test_missing_images", 0),
        "train_unresolved": counts.get("train_unresolved", 0),
        "test_unresolved": counts.get("test_unresolved", 0),
        "metadata_available": train_path.is_file() and test_path.is_file(),
    }