from __future__ import annotations
import hashlib
import hmac
import ipaddress
import sqlite3
from collections import Counter
from io import BytesIO

import os
import sys
from datetime import date
from pathlib import Path
from urllib.parse import quote
from typing import Literal

import cv2
from dotenv import load_dotenv
from PIL import Image

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from .storage import COLLECTIONS, SQLiteStore, SupabaseStore


PROJECT_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(PROJECT_ROOT / ".env", override=False)
load_dotenv(PROJECT_ROOT / "backend" / ".env", override=False)

DEFAULT_BUNDLE = PROJECT_ROOT / "aitrain" / "PigAI_Webapp_Integration"
BUNDLE_DIR = Path(os.getenv("PIG_AI_BUNDLE_DIR", str(DEFAULT_BUNDLE)))

integration_error = None
ai_router = None
ai_service = None
identity_classes: tuple[str, ...] = ()
identity_weights_kg: dict[str, float] = {}
identity_dataset_dir: Path | None = None
identity_model_dir: Path | None = None

if BUNDLE_DIR.exists():
    sys.path.insert(0, str(BUNDLE_DIR))
    try:
        from integration.config import IDENTITY_CLASSES, IDENTITY_DATASET_DIR, IDENTITY_WEIGHTS_KG, MODEL_DIR
        from integration.routes import router as ai_camera_router, service as camera_service

        ai_router = ai_camera_router
        ai_service = camera_service
        identity_classes = IDENTITY_CLASSES
        identity_weights_kg = IDENTITY_WEIGHTS_KG
        identity_dataset_dir = IDENTITY_DATASET_DIR
        identity_model_dir = MODEL_DIR
    except Exception as error:  # Keep the health endpoint available for setup diagnostics.
        integration_error = str(error)
else:
    integration_error = f"AI bundle not found at {BUNDLE_DIR}"

app = FastAPI(
    title="Smart Swine API",
    description="Backend API for AI pig detection, identity recognition, and weight estimation.",
    version="0.1.0",
)
PIG_PROFILE_IMAGE_DIR = PROJECT_ROOT / "backend" / "data" / "pig_profile_images"
store = (
    SupabaseStore()
    if os.getenv("SUPABASE_URL")
    and (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("SUPABASE_SECRET_KEY")
        or os.getenv("SUPABASE_ANON_KEY")
    )
    else SQLiteStore()
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175",
    ],
    allow_origin_regex=(
        r"https?://(?:(?:localhost|127\.0\.0\.1|192\.168(?:\.\d{1,3}){2}|"
        r"10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})|"
        r".*\.devtunnels\.ms)(:\d+)?$"
    ),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

if ai_router is not None:
    app.include_router(ai_router)


class CameraConnection(BaseModel):
    ip: str
    username: str
    password: str


class APIRecord(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class PigRecord(APIRecord):
    id: str = Field(min_length=1, max_length=80)
    tag_id: str | None = Field(default=None, alias="tagId", pattern=r"^(0[1-9]|1[0-9]|20)$")
    model_identity: str | None = Field(default=None, alias="modelIdentity", max_length=80)
    stage: str = Field(min_length=1, max_length=40)
    days_in_pen: int | None = Field(default=None, alias="daysInPen", ge=0)
    weight: float | None = Field(default=None, ge=0)
    temp: float | None = Field(default=None, ge=0)
    behavior: str | None = Field(default=None, max_length=120)
    health_indicator: str | None = Field(default=None, alias="healthIndicator", max_length=240)
    status: Literal["Unreviewed", "Healthy", "Monitor", "Alert"] = "Unreviewed"


class ObservationRecord(APIRecord):
    detected_id: str | None = Field(default=None, alias="detectedId", max_length=80)
    pig_id: str | None = Field(default=None, alias="pigId", max_length=80)
    identity_status: str | None = Field(default=None, alias="identityStatus", max_length=40)
    source: Literal["camera", "upload", "manual"] = "manual"
    estimated_weight_kg: float | None = Field(default=None, alias="estimatedWeightKg", ge=0)
    weight_source: str | None = Field(default=None, alias="weightSource", max_length=80)
    recognition_confidence: float | None = Field(default=None, alias="recognitionConfidence", ge=0, le=100)
    detection_confidence: float | None = Field(default=None, alias="detectionConfidence", ge=0, le=100)
    behavior_indicator: str | None = Field(default=None, alias="behaviorIndicator", max_length=120)
    behavior_confidence: float | None = Field(default=None, alias="behaviorConfidence", ge=0, le=100)
    behavior_source: str | None = Field(default=None, alias="behaviorSource", max_length=80)
    box: dict[str, float] | None = None


class AlertRecord(APIRecord):
    pig_id: str | None = Field(default=None, alias="pigId", max_length=80)
    title: str = Field(min_length=1, max_length=160)
    type: str | None = Field(default=None, max_length=80)
    indicator: str | None = Field(default=None, max_length=240)
    evidence: str | None = Field(default=None, max_length=1000)
    next_action: str | None = Field(default=None, alias="nextAction", max_length=500)
    severity: Literal["Critical", "Warning", "Info"] = "Info"
    status: str = Field(default="Pending", max_length=40)
    referral_status: str = Field(default="Not referred", alias="referralStatus", max_length=40)


class AlertUpdate(APIRecord):
    status: str | None = Field(default=None, max_length=40)
    referral_status: str | None = Field(default=None, alias="referralStatus", max_length=40)


class EnvironmentRecord(APIRecord):
    ambient_temperature: float | None = Field(default=None, alias="ambientTemperature", ge=-30, le=80)
    humidity: float | None = Field(default=None, ge=0, le=100)
    body_temperature: float | None = Field(default=None, alias="bodyTemperature", ge=20, le=50)
    source: str = Field(default="manual", max_length=40)


class PigTemperatureReading(APIRecord):
    pig_id: str | None = Field(default=None, alias="pigId", min_length=1, max_length=80)
    tag_id: str | None = Field(default=None, alias="tagId", pattern=r"^(0[1-9]|1[0-9]|20)$")
    temperature_c: float = Field(alias="temperatureC", ge=20, le=50)
    sensor_id: str | None = Field(default=None, alias="sensorId", max_length=80)
    source: str = Field(default="sensor", min_length=1, max_length=40)


class FeedRecord(APIRecord):
    date: date
    pigs: int = Field(ge=1)
    feed_per_pig: float = Field(alias="feedPerPig", gt=0)
    cost_per_kg: float = Field(alias="costPerKg", gt=0)


def record_payload(model: BaseModel) -> dict:
    return model.model_dump(mode="json", by_alias=True, exclude={"id"})


def ensure_pig_identity(
    pig_id: str | None,
    *,
    behavior: str | None = None,
    weight: float | None = None,
    health_indicator: str | None = None,
) -> dict | None:
    if not pig_id:
        return None

    existing = store.get("pigs", pig_id) or next(
        (pig for pig in store.list("pigs", 500) if pig.get("tagId") == pig_id),
        None,
    )
    if existing is not None:
        to_update: dict[str, object] = {}
        if behavior and not existing.get("behavior"):
            to_update["behavior"] = behavior
        if weight is not None and (existing.get("weight") in (None, "") or float(existing.get("weight") or 0) == 0):
            to_update["weight"] = weight
        if health_indicator and not existing.get("healthIndicator"):
            to_update["healthIndicator"] = health_indicator
        if not to_update:
            return existing

        base = {key: value for key, value in existing.items() if key not in {"id", "createdAt", "updatedAt"}}
        updated = {**base, **to_update}
        return store.update("pigs", existing["id"], updated)

    created = {
        "id": pig_id,
        "tagId": pig_id if len(pig_id) == 2 and pig_id.isdigit() and 1 <= int(pig_id) <= 20 else None,
        "modelIdentity": None,
        "stage": "Unassigned",
        "daysInPen": None,
        "weight": weight,
        "temp": None,
        "behavior": behavior or "AI-detected",
        "healthIndicator": health_indicator or "Identity linked from camera detection",
        "status": "Unreviewed",
    }
    return create_record("pigs", created)


def map_detected_identities(detected_pigs: list[dict]) -> list[dict]:
    profiles_by_model_identity = {
        pig["modelIdentity"]: pig
        for pig in store.list("pigs", 500)
        if pig.get("modelIdentity")
    }
    predicted_ids = [
        pig.get("pig_id")
        for pig in detected_pigs
        if pig.get("pig_id") and not str(pig.get("pig_id")).startswith("UNKNOWN-")
    ]
    prediction_counts = Counter(predicted_ids)

    for detected_pig in detected_pigs:
        predicted_id = detected_pig.get("pig_id")
        is_unknown = not predicted_id or str(predicted_id).startswith("UNKNOWN-")
        is_duplicate = not is_unknown and prediction_counts[predicted_id] > 1
        profile = profiles_by_model_identity.get(predicted_id) if not is_unknown and not is_duplicate else None
        detected_pig["model_identity"] = None if is_unknown else predicted_id
        detected_pig["tag_id"] = profile.get("tagId") if profile else None
        detected_pig["farm_pig_id"] = profile.get("id") if profile else None
        if profile and profile.get("weight") is not None:
            detected_pig["estimated_weight_kg"] = float(profile["weight"])
            detected_pig["weight_source"] = "registered_measurement"
        elif detected_pig.get("estimated_weight_kg") is not None:
            detected_pig["weight_source"] = "model_estimate"
        else:
            detected_pig["weight_source"] = None
        detected_pig["identity_status"] = (
            "duplicate-prediction" if is_duplicate
            else "unassigned" if profile is None
            else "assigned"
        )
    return detected_pigs


def validate_pig_assignments(record: PigRecord, current_id: str | None = None) -> None:
    for pig in store.list("pigs", 500):
        if pig["id"] == current_id:
            continue
        if record.tag_id and pig.get("tagId") == record.tag_id:
            raise HTTPException(status_code=409, detail=f"Pen tag {record.tag_id} is already assigned.")
        if record.model_identity and pig.get("modelIdentity") == record.model_identity:
            raise HTTPException(status_code=409, detail=f"AI class {record.model_identity} is already mapped to another pen tag.")


def create_record(collection: str, payload: dict) -> dict:
    try:
        return store.create(collection, payload)
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="A record with this ID already exists.") from error


def ensure_enrolled_pig_profiles() -> None:
    for identity in identity_classes:
        existing = store.get("pigs", identity)
        if existing is None:
            store.create("pigs", {
                "id": identity,
                "tagId": None,
                "modelIdentity": identity,
                "stage": "Unassigned",
                "daysInPen": None,
                "weight": identity_weights_kg.get(identity),
                "temp": None,
                "behavior": None,
                "healthIndicator": None,
                "status": "Unreviewed",
            })
        else:
            updates = {}
            if not existing.get("modelIdentity"):
                updates["modelIdentity"] = identity
            if existing.get("weight") is None and identity in identity_weights_kg:
                updates["weight"] = identity_weights_kg[identity]
            if updates:
                store.update("pigs", identity, {**existing, **updates})


def require_collection(collection: str) -> str:
    if collection not in COLLECTIONS:
        raise HTTPException(status_code=404, detail="Data collection not found.")
    return collection


@app.get("/api/pigs")
def list_pigs(limit: int = 100):
    ensure_enrolled_pig_profiles()
    pigs = store.list("pigs", max(1, min(limit, 500)))
    known_model_classes = set(ai_service.classes) if ai_service is not None else set()
    for pig in pigs:
        if not pig.get("modelIdentity") and pig["id"] in known_model_classes:
            pig["modelIdentity"] = pig["id"]
    return pigs


@app.get("/api/pig-temperatures")
def list_pig_temperature_readings(limit: int = 100, pig_id: str | None = None):
    readings = store.list("pig-temperatures", max(1, min(limit, 500)))
    if pig_id:
        readings = [reading for reading in readings if reading.get("pigId") == pig_id]
    return readings


@app.post("/api/pig-temperatures", status_code=201)
def create_pig_temperature_reading(
    record: PigTemperatureReading,
    x_sensor_token: str | None = Header(default=None),
):
    configured_token = os.getenv("PIG_TEMPERATURE_SENSOR_TOKEN", "")
    if not configured_token:
        raise HTTPException(status_code=503, detail="Pig temperature sensor ingestion is not configured.")
    if not x_sensor_token or not hmac.compare_digest(x_sensor_token, configured_token):
        raise HTTPException(status_code=401, detail="Invalid temperature sensor token.")
    if bool(record.pig_id) == bool(record.tag_id):
        raise HTTPException(status_code=422, detail="Provide exactly one of pigId or tagId.")

    pigs = store.list("pigs", 500)
    pig = (
        store.get("pigs", record.pig_id)
        if record.pig_id
        else next((item for item in pigs if item.get("tagId") == record.tag_id), None)
    )
    if pig is None:
        raise HTTPException(status_code=404, detail="Pig profile not found.")

    reading = create_record("pig-temperatures", {
        "pigId": pig["id"],
        "tagId": pig.get("tagId"),
        "temperatureC": record.temperature_c,
        "sensorId": record.sensor_id,
        "source": record.source,
    })
    updated_pig = store.update("pigs", pig["id"], {**pig, "temp": record.temperature_c})
    return {"reading": reading, "pig": updated_pig}


@app.post("/api/pigs", status_code=201)
def create_pig(record: PigRecord):
    validate_pig_assignments(record)
    return create_record("pigs", {"id": record.id, **record_payload(record)})


@app.put("/api/pigs/{pig_id}")
def update_pig(pig_id: str, record: PigRecord):
    if record.id != pig_id:
        raise HTTPException(status_code=400, detail="Pig ID in the URL must match the request body.")
    validate_pig_assignments(record, current_id=pig_id)
    updated = store.update("pigs", pig_id, record_payload(record))
    if updated is None:
        raise HTTPException(status_code=404, detail="Pig record not found.")
    return updated


@app.delete("/api/pigs/{pig_id}")
def delete_pig(pig_id: str):
    if not store.delete("pigs", pig_id):
        raise HTTPException(status_code=404, detail="Pig record not found.")
    return {"deleted": True}


def pig_profile_image_path(pig_id: str) -> Path:
    filename = hashlib.sha256(pig_id.encode("utf-8")).hexdigest()
    return PIG_PROFILE_IMAGE_DIR / f"{filename}.jpg"


def fallback_pig_image_path(profile: dict) -> Path | None:
    model_identity = profile.get("modelIdentity")
    if model_identity not in identity_classes:
        return None

    if identity_model_dir is not None:
        custom_image = identity_model_dir / "identity_profiles" / f"{model_identity}.jpg"
        if custom_image.is_file():
            return custom_image

    if identity_dataset_dir is None:
        return None
    dataset_root = identity_dataset_dir.resolve()
    identity_directory = (dataset_root / model_identity).resolve()
    if dataset_root not in identity_directory.parents or not identity_directory.is_dir():
        return None
    return next(
        (
            path for path in sorted(identity_directory.iterdir())
            if path.is_file() and path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        ),
        None,
    )


@app.get("/api/pigs/{pig_id}/image")
def get_pig_profile_image(pig_id: str):
    profile = store.get("pigs", pig_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Pig profile not found.")

    image_path = pig_profile_image_path(pig_id)
    if not image_path.is_file():
        image_path = fallback_pig_image_path(profile)
    if image_path is None or not image_path.is_file():
        raise HTTPException(status_code=404, detail="No profile photo is available for this pig.")
    return FileResponse(image_path, headers={"Cache-Control": "no-store"})


@app.post("/api/pigs/{pig_id}/image")
async def update_pig_profile_image(pig_id: str, image: UploadFile = File(...)):
    if store.get("pigs", pig_id) is None:
        raise HTTPException(status_code=404, detail="Pig profile not found.")
    if image.content_type is None or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Upload an image file.")

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

    destination = pig_profile_image_path(pig_id)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_image = destination.with_name(f".{destination.stem}.tmp.jpg")
    profile_image.save(temporary_image, format="JPEG", quality=90)
    temporary_image.replace(destination)
    return {"status": "ok", "pigId": pig_id, "message": "Profile photo updated."}


@app.get("/api/observations")
def list_observations(limit: int = 100):
    return store.list("observations", max(1, min(limit, 500)))


@app.post("/api/observations", status_code=201)
def create_observation(record: ObservationRecord):
    return create_record("observations", record_payload(record))


@app.post("/api/observations/analyze-image")
async def analyze_image(
    image: UploadFile = File(...),
    source: Literal["camera", "upload"] = Form("upload"),
):
    if ai_service is None:
        raise HTTPException(status_code=503, detail="AI integration is unavailable.")
    if image.content_type is None or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="Upload an image file.")
    image_bytes = await image.read(20 * 1024 * 1024 + 1)
    if len(image_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image uploads must be 20 MB or smaller.")
    result = await run_in_threadpool(ai_service.process_image, image_bytes)
    result["pigs"] = map_detected_identities(result["pigs"])
    saved_observations = []
    for detected_pig in result["pigs"]:
        predicted_id = detected_pig.get("pig_id")
        pig_id = detected_pig.get("farm_pig_id") or detected_pig.get("tag_id")
        behavior = detected_pig.get("behavior_indicator")
        weight = detected_pig.get("estimated_weight_kg")
        if pig_id:
            ensure_pig_identity(
                pig_id,
                behavior=behavior,
                weight=weight,
                health_indicator=behavior,
            )
        observation = ObservationRecord(
            detectedId=predicted_id,
            pigId=pig_id,
            identityStatus=detected_pig.get("identity_status"),
            source=source,
            estimatedWeightKg=weight,
            weightSource=detected_pig.get("weight_source"),
            recognitionConfidence=detected_pig["recognition_confidence"],
            detectionConfidence=detected_pig["box"].get("confidence"),
            behaviorIndicator=behavior,
            behaviorConfidence=detected_pig.get("behavior_confidence"),
            behaviorSource=detected_pig.get("behavior_source"),
            box={
                coordinate: detected_pig["box"][coordinate]
                for coordinate in ("x1", "y1", "x2", "y2")
            },
        )
        saved_observations.append(
            create_record("observations", record_payload(observation))
        )
    return {**result, "observations": saved_observations}


@app.get("/api/alerts")
def list_alerts(limit: int = 100):
    return store.list("alerts", max(1, min(limit, 500)))


@app.post("/api/alerts", status_code=201)
def create_alert(record: AlertRecord):
    return create_record("alerts", record_payload(record))


@app.patch("/api/alerts/{alert_id}")
def update_alert(alert_id: str, changes: AlertUpdate):
    record = store.get("alerts", alert_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Alert record not found.")
    payload = {key: value for key, value in changes.model_dump(mode="json", by_alias=True, exclude_unset=True).items() if value is not None}
    updated = store.update("alerts", alert_id, {**record, **payload, "id": alert_id, "createdAt": None, "updatedAt": None})
    return updated


@app.get("/api/environment")
def list_environment_readings(limit: int = 100):
    return store.list("environment", max(1, min(limit, 500)))


@app.post("/api/environment", status_code=201)
def create_environment_reading(record: EnvironmentRecord):
    return create_record("environment", record_payload(record))


@app.get("/api/feed-records")
def list_feed_records(limit: int = 100):
    return store.list("feed-records", max(1, min(limit, 500)))


@app.post("/api/feed-records", status_code=201)
def create_feed_record(record: FeedRecord):
    payload = record_payload(record)
    payload["totalKg"] = round(record.pigs * record.feed_per_pig, 2)
    payload["totalCost"] = round(payload["totalKg"] * record.cost_per_kg, 2)
    return create_record("feed-records", payload)


def open_rtsp_capture(url: str):
    timeout_options = [
        cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,
        5000,
        cv2.CAP_PROP_READ_TIMEOUT_MSEC,
        5000,
    ]
    capture = cv2.VideoCapture(url, cv2.CAP_FFMPEG, timeout_options)
    if not capture.isOpened():
        capture.release()
        return None
    return capture


@app.post("/api/camera/connect")
def connect_camera(connection: CameraConnection, request: Request):
    if request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(status_code=403, detail="Camera setup is only available locally.")
    if not connection.username or not connection.password:
        raise HTTPException(status_code=400, detail="Enter the camera account username and password.")
    try:
        camera_ip = ipaddress.IPv4Address(connection.ip)
    except ipaddress.AddressValueError as error:
        raise HTTPException(status_code=400, detail="Enter a valid camera IPv4 address.") from error

    username = quote(connection.username, safe="")
    password = quote(connection.password, safe="")
    rtsp_url = f"rtsp://{username}:{password}@{camera_ip}:554/stream1"
    capture = open_rtsp_capture(rtsp_url)
    if capture is None:
        raise HTTPException(status_code=502, detail="Could not open the camera RTSP stream. Check the camera account and stream settings.")
    try:
        frame_read, _ = capture.read()
    finally:
        capture.release()
    if not frame_read:
        raise HTTPException(status_code=502, detail="Connected to the camera, but no video frame was received.")

    app.state.camera_rtsp_url = rtsp_url
    return {"status": "connected", "camera": "TP-Link Tapo C230"}


@app.get("/api/camera/status")
def camera_status():
    return {"configured": bool(getattr(app.state, "camera_rtsp_url", None))}


@app.post("/api/camera/disconnect")
def disconnect_camera(request: Request):
    if request.client and request.client.host not in {"127.0.0.1", "::1", "testclient"}:
        raise HTTPException(status_code=403, detail="Camera setup is only available locally.")
    app.state.camera_rtsp_url = None
    return {"status": "disconnected"}


def mjpeg_frames(capture):
    try:
        while True:
            frame_read, frame = capture.read()
            if not frame_read:
                break
            encoded, jpeg = cv2.imencode(".jpg", frame)
            if not encoded:
                continue
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg.tobytes() + b"\r\n"
    finally:
        capture.release()


@app.get("/api/camera/stream.mjpg")
def camera_stream():
    rtsp_url = getattr(app.state, "camera_rtsp_url", None)
    if not rtsp_url:
        raise HTTPException(status_code=409, detail="Connect the camera before opening its stream.")
    capture = open_rtsp_capture(rtsp_url)
    if capture is None:
        app.state.camera_rtsp_url = None
        raise HTTPException(status_code=502, detail="The camera RTSP stream is no longer reachable.")
    return StreamingResponse(
        mjpeg_frames(capture),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/health")
def health():
    return {
        "status": "ok" if integration_error is None else "degraded",
        "ai_bundle": str(BUNDLE_DIR),
        "integration_loaded": ai_router is not None,
        "integration_error": integration_error,
    }
