# PigAI Webapp Integration Bundle

This is the single folder to export and copy into the existing FastAPI website.

## Bundle contents

```text
PigAI_Webapp_Integration/
├── integration/
│   ├── __init__.py
│   ├── config.py
│   ├── routes.py
│   └── service.py
├── models/
│   ├── pig_model.pt
│   └── pig_detector.pt
├── camera_weight_model.joblib
├── requirements.txt
└── README.md
```

## Install

Copy this entire folder into the root of the existing website. The final website layout should be:

```text
your-website/
├── app.py
├── recognize.py
├── train.py
├── integration/
├── models/
├── camera_weight_model.joblib
└── ...
```

Install the bundle requirements from the website root:

```powershell
pip install -r integration/requirements.txt
```

## Connect the existing FastAPI app

Add this import in `app.py`:

```python
from integration.routes import router as ai_camera_router
```

After creating the FastAPI app, add:

```python
app.include_router(ai_camera_router)
```

Start the website:

```powershell
python -m uvicorn app:app --reload
```

## Endpoints

- `GET /api/ai-camera/status`
- `POST /api/ai-camera/process-image` (multipart `image`; optional `debug=true`)
- `GET /api/ai-camera/debug-image/{filename}` (only for debug images created by the process endpoint)

Send an image using multipart field `image`. The response retains the `pigs` results and also returns `detections` with class, confidence, and `xyxy` pixel coordinates in the original image, plus measured inference time. Ultralytics performs its standard resize/letterbox, NMS, and coordinate restoration; the integration clips invalid/out-of-frame boxes without applying a second NMS pass. Optional `debug=true` saves a side-by-side JPEG comparing Ultralytics' original-image boxes with the clipped response boxes, including labels, confidences, coordinates, inference time, and detection count.

Configure inference with `PIG_DETECTOR_CONFIDENCE` (default `0.35`), `PIG_DETECTOR_IOU` (default `0.7`), `PIG_DETECTOR_IMAGE_SIZE` (default `640`), `PIG_DETECTOR_DEVICE` (default automatic), and `PIG_DETECTOR_HALF` (default `false`; FP16 is enabled only on CUDA). These are runtime controls, not accuracy claims; tune them against an annotated validation set. YOLO inference supports images through this endpoint. Video/webcam/IP-stream capture is not currently provided by this integration.

Place the trained Ultralytics checkpoint at `aitrain/PigAI_Webapp_Integration/models/pig_detector.pt` (or set `PIG_MODEL_DIR` to its containing directory). From the workspace root, install dependencies with `python -m pip install -r backend/requirements.txt`. Start the backend with `python -m uvicorn backend.app:app --reload --port 8000`; start the frontend in `smartswine-dashboard` with `npm install` and `npm run dev`. Open System Settings → Try the current YOLO detector, select an image, and enable the annotated comparison checkbox to inspect the boxes. The API accepts image uploads; video/webcam/IP-stream capture is not implemented by this integration. Measure precision, recall, mAP@0.5, mAP@0.5:0.95, IoU, false positives/negatives, and inference time on a held-out labeled dataset. No such detector validation dataset is bundled here, so detection accuracy is not claimed.

For an annotated Ultralytics validation set, run from the workspace root (replace `path\to\data.yaml` with your dataset YAML):

```powershell
yolo detect val model=aitrain\PigAI_Webapp_Integration\models\pig_detector.pt data=path\to\data.yaml split=val imgsz=640 conf=0.35 iou=0.7 device=cpu plots=True
```

Record precision, recall, mAP50, mAP50-95, and the reported preprocessing/inference/postprocessing times; inspect the generated confusion matrix and PR curves for false positives and false negatives. For a before/after comparison, use the same checkpoint, validation split, thresholds, image size, and device, and calculate per-image box IoU against annotations. The dashboard debug image compares raw Ultralytics original-image coordinates with the returned clipped coordinates; it does not alter model predictions or claim an accuracy improvement.

The log is created automatically as `camera_log.csv` in the website root.

## Important

Add your own pig enrollment images to the website's existing dataset folders, retrain the recognition model, and replace `models/pig_model.pt` with the newly trained model. The bundled model is only the starting model from the current project.

Protect the upload endpoint with authentication and upload-size limits before deploying publicly.
