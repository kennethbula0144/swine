# Smart Swine FastAPI backend

This backend loads the AI integration bundle from:

`../aitrain/PigAI_Webapp_Integration`

## Install

From the workspace root:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r backend\requirements.txt
```

## Run

```powershell
python -m uvicorn backend.app:app --reload --port 8000
```

## Check the setup

- `GET http://127.0.0.1:8000/api/health`
- `GET http://127.0.0.1:8000/api/ai-camera/status`
- `POST http://127.0.0.1:8000/api/ai-camera/process-image`

The image endpoint expects a multipart upload using the field name `image`.

Set `PIG_AI_BUNDLE_DIR` if the AI integration folder is stored somewhere else. The default points to the existing `aitrain/PigAI_Webapp_Integration` folder beside this project.

## Per-pig temperature sensors

An external sensor gateway can post pig-specific samples to `POST /api/pig-temperatures`. Configure a shared token as `PIG_TEMPERATURE_SENSOR_TOKEN` and send it in the `X-Sensor-Token` request header. The backend validates readings from 20°C to 50°C, stores a history record, and updates the pig profile's current `temp` value. Identify each pig with exactly one of its profile `pigId` or pen `tagId`.

Set the token in the workspace-root `.env` or `backend/.env`, then restart the backend:

```dotenv
PIG_TEMPERATURE_SENSOR_TOKEN=<long-random-secret>
```

Example JSON body:

```json
{
	"tagId": "01",
	"temperatureC": 38.2,
	"sensorId": "pen-01-ir"
}
```

Reading history is available from `GET /api/pig-temperatures?limit=100`; filter by profile ID with `pig_id`. Pig Profiles displays the latest sensor sample and recent history and refreshes while the page is open.

This repository does not include a physical sensor driver or gateway firmware. Use an individually aimed/contact sensor for each pig, or a scanning gateway that sends the matching pig ID/tag with each sample; a pen ambient sensor cannot measure each pig. For a gateway on the farm LAN, bind Uvicorn to the computer's LAN interface (for example, `--host 0.0.0.0`), keep the token private, and do not expose the API or port 8000 to the public internet.
