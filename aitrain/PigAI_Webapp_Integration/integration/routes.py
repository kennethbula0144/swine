from __future__ import annotations

import json
import hashlib
import random
import re
import tempfile
import threading
from collections import Counter, defaultdict
from io import BytesIO
from pathlib import Path
from zipfile import BadZipFile, ZipFile

import joblib
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from PIL import Image
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from starlette.concurrency import run_in_threadpool
import torch
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision.datasets import ImageFolder

from .config import BEHAVIOR_DATASET_DIR, BEHAVIOR_MODEL_FILE, CAMERA_LOG_FILE, DETECTOR_CONFIDENCE, DETECTOR_DEBUG_DIR, DETECTOR_DEVICE, DETECTOR_HALF, DETECTOR_IMAGE_SIZE, DETECTOR_IOU, IDENTITY_CLASSES, IDENTITY_DATASET_DIR, IDENTITY_WEIGHTS_KG, MODEL_DIR, WEIGHT_CALIBRATION_FILE, WEIGHT_CAPTURE_CAMERA_HEIGHT_M, WEIGHT_CAPTURE_DIR, WEIGHT_MODEL_FILE
from .behavior import behavior_dataset_summary, behavior_samples
from .service import PigCameraService, SimplePigClassifier, transforms

router = APIRouter(prefix="/api/ai-camera", tags=["AI camera"])
service = PigCameraService(CAMERA_LOG_FILE)
identity_training_state = {
    "status": "idle",
    "epoch": 0,
    "epochs": 0,
    "accuracy": 0.0,
    "loss": 0.0,
    "message": "Identity model training has not started.",
}
identity_training_lock = threading.Lock()
behavior_training_state = {
    "status": "idle",
    "epoch": 0,
    "epochs": 0,
    "accuracy": None,
    "loss": None,
    "message": "OPB behavior training has not started.",
}
behavior_training_lock = threading.Lock()
MAX_BEHAVIOR_IMAGES_PER_CLASS = 1500
MAX_DATASET_BYTES = 100 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024
WEIGHT_FOLDER_PATTERN = re.compile(r"^(\d+(?:\.\d+)?)(?:\s*kg)?(?:[_\-\s].*)?$", re.IGNORECASE)


class BehaviorImageDataset(Dataset):
    def __init__(self, samples, class_indices, training=False):
        self.samples = samples
        self.class_indices = class_indices
        operations = [transforms.Resize((64, 64))]
        if training:
            operations.append(transforms.RandomHorizontalFlip())
        operations.append(transforms.ToTensor())
        self.transform = transforms.Compose(operations)

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, index):
        image_path, label = self.samples[index]
        with Image.open(image_path) as image:
            image_tensor = self.transform(image.convert("RGB"))
        return image_tensor, self.class_indices[label]


def run_behavior_training(epochs: int, batch_size: int) -> None:
    try:
        if transforms is None:
            raise RuntimeError("torchvision transforms are unavailable in this environment.")

        available_samples = behavior_samples("train", BEHAVIOR_DATASET_DIR)
        grouped_samples = defaultdict(list)
        for sample in available_samples:
            grouped_samples[sample[1]].append(sample)
        randomizer = random.Random(42)
        selected_groups = {}
        for label, class_samples in grouped_samples.items():
            randomizer.shuffle(class_samples)
            readable_samples = []
            for sample in class_samples:
                if Path(sample[0]).is_file():
                    readable_samples.append(sample)
                if len(readable_samples) >= MAX_BEHAVIOR_IMAGES_PER_CLASS:
                    break
            if readable_samples:
                selected_groups[label] = readable_samples
        classes = sorted(selected_groups, key=str.casefold)
        if len(classes) < 2:
            raise ValueError("At least two OPB behavior classes need readable training images.")

        selected_samples = []
        for label in classes:
            selected_samples.extend(selected_groups[label])
        class_indices = {label: index for index, label in enumerate(classes)}
        selected_counts = Counter(label for _, label in selected_samples)
        test_samples = [
            sample for sample in behavior_samples("test", BEHAVIOR_DATASET_DIR)
            if sample[1] in class_indices and Path(sample[0]).is_file()
        ]
        train_dataset = BehaviorImageDataset(selected_samples, class_indices, training=True)
        sample_weights = [1.0 / selected_counts[label] for _, label in selected_samples]
        sampler = WeightedRandomSampler(sample_weights, num_samples=len(selected_samples), replacement=True)
        dataloader = DataLoader(train_dataset, batch_size=batch_size, sampler=sampler)
        model = SimplePigClassifier(num_classes=len(classes))
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model.to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
        criterion = torch.nn.CrossEntropyLoss()

        for epoch in range(1, epochs + 1):
            model.train()
            loss_total = 0.0
            total = 0
            for images, labels in dataloader:
                images = images.to(device)
                labels = labels.to(device)
                optimizer.zero_grad()
                outputs = model(images)
                loss = criterion(outputs, labels)
                loss.backward()
                optimizer.step()
                loss_total += loss.item() * images.size(0)
                total += labels.size(0)

            with behavior_training_lock:
                behavior_training_state.update({
                    "epoch": epoch,
                    "loss": loss_total / max(total, 1),
                    "message": f"Completed epoch {epoch} of {epochs} using {len(selected_samples):,} balanced still images.",
                })

        validation_accuracy = None
        if test_samples:
            model.eval()
            validation_loader = DataLoader(
                BehaviorImageDataset(test_samples, class_indices),
                batch_size=batch_size,
                shuffle=False,
            )
            correct = 0
            total = 0
            with torch.no_grad():
                for images, labels in validation_loader:
                    outputs = model(images.to(device))
                    correct += (outputs.argmax(dim=1).cpu() == labels).sum().item()
                    total += labels.size(0)
            validation_accuracy = 100.0 * correct / total if total else None

        model.to("cpu")
        model.eval()
        BEHAVIOR_MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary_file = BEHAVIOR_MODEL_FILE.with_name(f".{BEHAVIOR_MODEL_FILE.name}.tmp")
        torch.save({
            "model_state": model.state_dict(),
            "classes": classes,
            "epochs": epochs,
            "batch_size": batch_size,
            "train_image_count": len(selected_samples),
            "test_image_count": len(test_samples),
            "validation_accuracy": validation_accuracy,
        }, temporary_file)
        temporary_file.replace(BEHAVIOR_MODEL_FILE)
        service.behavior_model = model
        service.behavior_classes = classes
        with behavior_training_lock:
            behavior_training_state.update({
                "status": "complete",
                "accuracy": validation_accuracy,
                "message": "OPB behavior model trained and activated on still images.",
            })
    except Exception as error:
        with behavior_training_lock:
            behavior_training_state.update({"status": "error", "message": str(error)})


async def read_dataset_upload(dataset: UploadFile) -> bytes:
    if not dataset.filename or not dataset.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Upload a ZIP dataset bundle.")
    data = await dataset.read(MAX_DATASET_BYTES + 1)
    if len(data) > MAX_DATASET_BYTES:
        raise HTTPException(status_code=413, detail="Dataset ZIP files must be 100 MB or smaller.")
    return data


def read_weight_rows(data: bytes) -> tuple[np.ndarray, np.ndarray]:
    try:
        archive = ZipFile(BytesIO(data))
    except BadZipFile as error:
        raise HTTPException(status_code=400, detail="The uploaded file is not a valid ZIP archive.") from error

    infos = [info for info in archive.infolist() if not info.is_dir()]
    if sum(info.file_size for info in infos) > MAX_UNCOMPRESSED_BYTES:
        raise HTTPException(status_code=413, detail="The uncompressed dataset must be 500 MB or smaller.")

    features = []
    weights = []
    for info in infos:
        image_path = Path(info.filename.replace("\\", "/"))
        match = WEIGHT_FOLDER_PATTERN.match(image_path.parent.name)
        if image_path.suffix.lower() != ".png" or match is None:
            continue
        try:
            with Image.open(BytesIO(archive.read(info))) as image:
                feature = service._weight_features(image)
        except Exception as error:
            raise HTTPException(status_code=400, detail=f"Could not read weight-labeled image {image_path.name}.") from error
        features.append(feature)
        weights.append(float(match.group(1)))

    if len(features) < 5 or len(set(weights)) < 2:
        raise HTTPException(
            status_code=422,
            detail="Provide at least 5 valid PNG images across 2 or more measured-weight folders, such as 101.74_127.",
        )
    return np.vstack(features), np.asarray(weights, dtype=float)


def weight_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict:
    return {
        "sampleCount": int(len(actual)),
        "maeKg": float(mean_absolute_error(actual, predicted)),
        "rmseKg": float(np.sqrt(mean_squared_error(actual, predicted))),
        "biasKg": float(np.mean(predicted - actual)),
        "r2": float(r2_score(actual, predicted)) if len(actual) > 1 and len(np.unique(actual)) > 1 else None,
    }


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary_path.replace(path)


@router.post("/process-image")
async def process_image(image: UploadFile = File(...), debug: bool = Form(False)):
    if image.content_type is None or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Upload an image file.")
    image_bytes = await image.read(20 * 1024 * 1024 + 1)
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image uploads must be 20 MB or smaller.")
    try:
        with Image.open(BytesIO(image_bytes)) as uploaded_image:
            uploaded_image.verify()
        return await run_in_threadpool(service.process_image, image_bytes, debug)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/debug-image/{filename}")
def debug_image(filename: str):
    if Path(filename).name != filename or not filename.lower().endswith(".jpg"):
        raise HTTPException(status_code=404, detail="Debug image not found.")
    image_path = (DETECTOR_DEBUG_DIR / filename).resolve()
    if DETECTOR_DEBUG_DIR.resolve() not in image_path.parents or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Debug image not found.")
    return FileResponse(image_path, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/status")
def status():
    return {
        "recognition_model_loaded": service.recognition_model is not None,
        "weight_model_loaded": service.weight_model is not None,
        "detector_loaded": service.detector is not None,
        "detector_error": service.detector_error,
        "detector_settings": {
            "confidence_threshold": DETECTOR_CONFIDENCE,
            "iou_threshold": DETECTOR_IOU,
            "image_size": DETECTOR_IMAGE_SIZE,
            "device": DETECTOR_DEVICE or "auto",
            "half_precision_requested": DETECTOR_HALF,
        },
        "debug_image_dir": str(DETECTOR_DEBUG_DIR),
        "behavior_model_loaded": service.behavior_model is not None,
        "behavior_classes": service.behavior_classes,
        "classes": service.classes,
        "log_file": str(service.log_file),
    }


@router.get("/behavior-dataset")
def behavior_dataset():
    return behavior_dataset_summary()


@router.get("/identity-image/{model_identity}")
def identity_image(model_identity: str):
    if model_identity not in IDENTITY_CLASSES:
        raise HTTPException(status_code=404, detail="No dataset identity matches this model class.")
    custom_image = MODEL_DIR / "identity_profiles" / f"{model_identity}.jpg"
    if custom_image.is_file():
        return FileResponse(custom_image, headers={"Cache-Control": "public, max-age=3600"})

    identity_directory = (IDENTITY_DATASET_DIR / model_identity).resolve()
    dataset_root = IDENTITY_DATASET_DIR.resolve()
    if dataset_root not in identity_directory.parents or not identity_directory.is_dir():
        raise HTTPException(status_code=404, detail="No dataset images are available for this identity.")
    image_path = next(
        (
            path for path in sorted(identity_directory.iterdir())
            if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        ),
        None,
    )
    if image_path is None:
        raise HTTPException(status_code=404, detail="No dataset images are available for this identity.")
    return FileResponse(image_path, headers={"Cache-Control": "public, max-age=3600"})


@router.post("/identity-image/{model_identity}")
async def update_identity_image(model_identity: str, image: UploadFile = File(...)):
    if model_identity not in IDENTITY_CLASSES:
        raise HTTPException(status_code=404, detail="No dataset identity matches this model class.")

    image_bytes = await image.read(10 * 1024 * 1024 + 1)
    if len(image_bytes) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Profile images must be 10 MB or smaller.")
    try:
        with Image.open(BytesIO(image_bytes)) as uploaded_image:
            uploaded_image.verify()
        with Image.open(BytesIO(image_bytes)) as uploaded_image:
            profile_image = uploaded_image.convert("RGB")
    except Exception as error:
        raise HTTPException(status_code=400, detail="Upload a valid image file.") from error

    image_digest = hashlib.sha256(image_bytes).digest()
    profiles_directory = MODEL_DIR / "identity_profiles"
    for other_identity in IDENTITY_CLASSES:
        if other_identity == model_identity:
            continue
        other_profile = profiles_directory / f"{other_identity}.jpg"
        if other_profile.is_file() and hashlib.sha256(other_profile.read_bytes()).digest() == image_digest:
            raise HTTPException(status_code=409, detail=f"Choose a different profile image from {other_identity}.")

    profiles_directory.mkdir(parents=True, exist_ok=True)
    destination = profiles_directory / f"{model_identity}.jpg"
    temporary_image = profiles_directory / f".{model_identity}.tmp.jpg"
    profile_image.save(temporary_image, format="JPEG", quality=90)
    temporary_image.replace(destination)
    return {"status": "ok", "pig_id": model_identity, "message": f"Profile image updated for {model_identity}."}


@router.get("/identity-dataset")
def identity_dataset():
    counts = {}
    excluded_directories = []
    for directory in sorted(IDENTITY_DATASET_DIR.iterdir()) if IDENTITY_DATASET_DIR.exists() else []:
        if not directory.is_dir():
            continue
        image_count = sum(
            1 for path in directory.iterdir()
            if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp"}
        )
        if directory.name in IDENTITY_CLASSES:
            counts[directory.name] = image_count
        elif image_count:
            excluded_directories.append(directory.name)

    missing_classes = [class_name for class_name in IDENTITY_CLASSES if counts.get(class_name, 0) == 0]
    return {
        "dataset_path": str(IDENTITY_DATASET_DIR),
        "classes": [
            {"pig_id": class_name, "images": counts.get(class_name, 0), "weight_kg": IDENTITY_WEIGHTS_KG[class_name]}
            for class_name in IDENTITY_CLASSES
        ],
        "identity_count": sum(counts.get(class_name, 0) > 0 for class_name in IDENTITY_CLASSES),
        "image_count": sum(counts.values()),
        "excluded_directories": excluded_directories,
        "missing_classes": missing_classes,
        "model_classes": service.classes,
        "model_loaded": service.recognition_model is not None,
        "weight_capture": {
            "path": str(WEIGHT_CAPTURE_DIR),
            "frame_count": sum(
                1 for path in WEIGHT_CAPTURE_DIR.iterdir()
                if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
            ) if WEIGHT_CAPTURE_DIR.exists() else 0,
            "labeled": False,
            "camera_height_m": WEIGHT_CAPTURE_CAMERA_HEIGHT_M,
        },
    }


def run_identity_training(epochs: int, batch_size: int) -> None:
    try:
        if transforms is None:
            raise RuntimeError("torchvision transforms are unavailable in this environment.")

        base_dataset = ImageFolder(
            root=str(IDENTITY_DATASET_DIR),
            transform=transforms.Compose([
                transforms.Resize((64, 64)),
                transforms.ToTensor(),
            ]),
        )
        missing_classes = [name for name in IDENTITY_CLASSES if name not in base_dataset.class_to_idx]
        if missing_classes:
            raise ValueError(f"Missing enrolled pig folders: {', '.join(missing_classes)}.")

        class_indices = {name: index for index, name in enumerate(IDENTITY_CLASSES)}
        filtered_samples = [
            (path, class_indices[base_dataset.classes[label]])
            for path, label in base_dataset.samples
            if base_dataset.classes[label] in class_indices
        ]
        if any(not any(label == index for _, label in filtered_samples) for index in range(len(IDENTITY_CLASSES))):
            raise ValueError("Each of Pig_1, Pig_2, Pig_3, and Pig_4 must contain at least one supported image.")

        base_dataset.classes = list(IDENTITY_CLASSES)
        base_dataset.class_to_idx = class_indices
        base_dataset.samples = filtered_samples
        base_dataset.imgs = filtered_samples
        base_dataset.targets = [label for _, label in filtered_samples]
        dataloader = DataLoader(base_dataset, batch_size=batch_size, shuffle=True)
        model = SimplePigClassifier(num_classes=len(IDENTITY_CLASSES))
        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
        criterion = torch.nn.CrossEntropyLoss()

        for epoch in range(1, epochs + 1):
            model.train()
            loss_total = 0.0
            correct = 0
            total = 0
            for images, labels in dataloader:
                optimizer.zero_grad()
                outputs = model(images)
                loss = criterion(outputs, labels)
                loss.backward()
                optimizer.step()
                loss_total += loss.item() * images.size(0)
                correct += (outputs.argmax(dim=1) == labels).sum().item()
                total += labels.size(0)

            with identity_training_lock:
                identity_training_state.update({
                    "epoch": epoch,
                    "loss": loss_total / total,
                    "accuracy": 100.0 * correct / total,
                    "message": f"Completed epoch {epoch} of {epochs} using only Pig_1 through Pig_4.",
                })

        model.eval()
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        model_file = MODEL_DIR / "pig_model.pt"
        temporary_file = model_file.with_name(".pig_model.pt.tmp")
        torch.save({
            "model_state": model.state_dict(),
            "classes": list(IDENTITY_CLASSES),
            "epochs": epochs,
            "batch_size": batch_size,
        }, temporary_file)
        temporary_file.replace(model_file)
        service.recognition_model = model
        service.classes = list(IDENTITY_CLASSES)
        with identity_training_lock:
            identity_training_state.update({"status": "complete", "message": "Four-pig identity model trained and activated."})
    except Exception as error:
        with identity_training_lock:
            identity_training_state.update({"status": "error", "message": str(error)})


@router.post("/training/identity")
def train_identity_model(epochs: int = Form(10), batch_size: int = Form(32)):
    if not 1 <= epochs <= 100:
        raise HTTPException(status_code=422, detail="Epochs must be between 1 and 100.")
    if not 1 <= batch_size <= 128:
        raise HTTPException(status_code=422, detail="Batch size must be between 1 and 128.")

    with identity_training_lock:
        if identity_training_state["status"] == "running":
            return JSONResponse(status_code=409, content={"detail": "Identity model training is already running."})
        identity_training_state.update({
            "status": "running",
            "epoch": 0,
            "epochs": epochs,
            "accuracy": 0.0,
            "loss": 0.0,
            "message": "Preparing only the Pig_1, Pig_2, Pig_3, and Pig_4 image folders.",
        })

    threading.Thread(target=run_identity_training, args=(epochs, batch_size), daemon=True).start()
    return JSONResponse(status_code=202, content={"status": "running", "message": "Four-pig identity training started."})


@router.get("/training/identity/status")
def identity_training_status():
    with identity_training_lock:
        return dict(identity_training_state)


@router.post("/training/behavior")
def train_behavior_model(epochs: int = Form(5), batch_size: int = Form(32)):
    if not 1 <= epochs <= 100:
        raise HTTPException(status_code=422, detail="Epochs must be between 1 and 100.")
    if not 1 <= batch_size <= 128:
        raise HTTPException(status_code=422, detail="Batch size must be between 1 and 128.")
    with behavior_training_lock:
        if behavior_training_state["status"] == "running":
            return JSONResponse(status_code=409, content={"detail": "OPB behavior training is already running."})
        behavior_training_state.update({
            "status": "running",
            "epoch": 0,
            "epochs": epochs,
            "accuracy": None,
            "loss": None,
            "message": "Preparing labeled OPB still images for training.",
        })
    threading.Thread(target=run_behavior_training, args=(epochs, batch_size), daemon=True).start()
    return JSONResponse(status_code=202, content={"status": "running", "message": "OPB behavior training started."})


@router.get("/training/behavior/status")
def behavior_training_status():
    with behavior_training_lock:
        return dict(behavior_training_state)


@router.post("/calibration/validate")
async def validate_calibration_dataset(
    dataset: UploadFile = File(...),
    calibration_mode: str = Form("detector"),
):
    """Inspect a ZIP dataset before training or calibration."""
    try:
        archive = ZipFile(BytesIO(await read_dataset_upload(dataset)))
    except BadZipFile as error:
        raise HTTPException(status_code=400, detail="The uploaded file is not a valid ZIP archive.") from error

    image_extensions = {".jpg", ".jpeg", ".png", ".webp"}
    label_extensions = {".txt", ".xml", ".json"}
    files = [name for name in archive.namelist() if not name.endswith("/")]
    image_count = sum(Path(name).suffix.lower() in image_extensions for name in files)
    label_count = sum(Path(name).suffix.lower() in label_extensions for name in files)
    has_train_split = any("train" in name.lower() for name in files)
    has_validation_split = any(token in name.lower() for name in files for token in ("val", "valid"))

    if calibration_mode == "weight":
        weight_values = [
            float(match.group(1))
            for name in files
            if Path(name).suffix.lower() == ".png"
            if (match := WEIGHT_FOLDER_PATTERN.match(Path(name).parent.name))
        ]
        weight_groups = set(weight_values)
        labeled_image_count = len(weight_values)
        ready = labeled_image_count >= 5 and len(weight_groups) >= 2
        return {
            "status": "ready" if ready else "needs_review",
            "calibration_mode": calibration_mode,
            "filename": dataset.filename,
            "image_count": image_count,
            "label_count": label_count,
            "labeled_image_count": labeled_image_count,
            "weight_group_count": len(weight_groups),
            "has_train_split": has_train_split,
            "has_validation_split": has_validation_split,
            "message": (
                "Weight-labeled PNG folders found and ready for training or calibration."
                if ready
                else "Expected PNG images inside folders whose names include measured weight in kg, with at least 5 images across 2 or more weight groups."
            ),
        }

    return {
        "status": "ready" if image_count > 0 and label_count > 0 else "needs_review",
        "calibration_mode": calibration_mode,
        "filename": dataset.filename,
        "image_count": image_count,
        "label_count": label_count,
        "has_train_split": has_train_split,
        "has_validation_split": has_validation_split,
        "message": "Dataset contains images and labels." if image_count > 0 and label_count > 0 else "Add matching image and label files before calibration.",
    }


@router.post("/training/weight")
async def train_weight_estimator(dataset: UploadFile = File(...)):
    data = await read_dataset_upload(dataset)
    features, weights = read_weight_rows(data)
    model = RandomForestRegressor(n_estimators=300, random_state=42, min_samples_leaf=2)
    model.fit(features, weights)

    WEIGHT_MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = None
    try:
        with tempfile.NamedTemporaryFile(dir=WEIGHT_MODEL_FILE.parent, suffix=".joblib", delete=False) as temp:
            temporary_file = Path(temp.name)
        joblib.dump(model, temporary_file)
        temporary_file.replace(WEIGHT_MODEL_FILE)
    finally:
        if temporary_file is not None and temporary_file.exists():
            temporary_file.unlink()

    service.weight_model = model
    service.weight_calibration = {"slope": 1.0, "intercept": 0.0}
    atomic_write_json(WEIGHT_CALIBRATION_FILE, service.weight_calibration)
    return {
        "status": "trained",
        "imageCount": int(len(weights)),
        "weightGroupCount": int(len(np.unique(weights))),
        "modelPath": str(WEIGHT_MODEL_FILE),
        "message": "The new model is active now and will load after backend restarts.",
    }


@router.post("/calibration/weight")
async def calibrate_weight_estimator(dataset: UploadFile = File(...)):
    if service.weight_model is None:
        raise HTTPException(status_code=409, detail="Train or load a weight model before calibration.")
    data = await read_dataset_upload(dataset)
    features, weights = read_weight_rows(data)
    raw_predictions = service.weight_model.predict(features)

    if len(np.unique(np.round(raw_predictions, 6))) < 2:
        slope = 1.0
        intercept = float(np.mean(weights - raw_predictions))
        method = "offset"
    else:
        calibrator = LinearRegression().fit(raw_predictions.reshape(-1, 1), weights)
        slope = float(calibrator.coef_[0])
        intercept = float(calibrator.intercept_)
        method = "linear"
        if slope <= 0:
            raise HTTPException(status_code=422, detail="Calibration data did not produce a usable positive weight relationship.")

    calibrated_predictions = raw_predictions * slope + intercept
    calibration = {"slope": slope, "intercept": intercept}
    atomic_write_json(WEIGHT_CALIBRATION_FILE, calibration)
    service.weight_calibration = calibration
    return {
        "status": "calibrated",
        "method": method,
        "rawMetrics": weight_metrics(weights, raw_predictions),
        "calibratedMetrics": weight_metrics(weights, calibrated_predictions),
        "message": "Calibration is active. Use a separate held-out dataset for an independent accuracy check.",
    }
