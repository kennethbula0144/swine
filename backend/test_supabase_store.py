import os
import pathlib
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from backend.storage import COLLECTIONS, SupabaseStore


class SupabaseStoreContractTests(unittest.TestCase):
    def test_schema_file_exists_and_has_expected_postgres_tables(self):
        schema_path = pathlib.Path(__file__).resolve().parents[1] / "supabase" / "schema.sql"
        self.assertTrue(schema_path.exists(), "Supabase schema file is missing")
        schema_sql = schema_path.read_text(encoding="utf-8")
        self.assertIn("CREATE TABLE IF NOT EXISTS public.records", schema_sql)
        self.assertIn("CREATE INDEX IF NOT EXISTS idx_records_collection_updated_desc", schema_sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS public.pigs", schema_sql)
        self.assertIn("FROM public.records\nWHERE collection = 'pigs'", schema_sql)

    def test_collections_are_supported(self):
        self.assertSetEqual(COLLECTIONS, {"pigs", "observations", "alerts", "environment", "feed-records", "pig-temperatures"})

    def test_sensor_temperature_updates_pig_and_records_history(self):
        import backend.app as app_module

        pig = {"id": "pig:01", "tagId": "01", "temp": None}
        reading = {
            "id": "reading-1",
            "pigId": "pig:01",
            "tagId": "01",
            "temperatureC": 38.2,
            "sensorId": "sensor-01",
            "source": "sensor",
            "createdAt": "2026-10-11T00:00:00+00:00",
        }
        store = unittest.mock.Mock()
        store.list.side_effect = lambda collection, limit=100: [pig] if collection == "pigs" else [reading]
        store.create.return_value = reading
        store.update.return_value = {**pig, "temp": 38.2}
        original_store = app_module.store

        try:
            app_module.store = store
            with patch.dict(os.environ, {"PIG_TEMPERATURE_SENSOR_TOKEN": "test-sensor-token"}):
                with TestClient(app_module.app) as client:
                    response = client.post(
                        "/api/pig-temperatures",
                        headers={"X-Sensor-Token": "test-sensor-token"},
                        json={"tagId": "01", "temperatureC": 38.2, "sensorId": "sensor-01"},
                    )
                    history = client.get("/api/pig-temperatures?pig_id=pig%3A01")
                    unauthorized = client.post(
                        "/api/pig-temperatures",
                        json={"tagId": "01", "temperatureC": 38.2},
                    )
                    out_of_range = client.post(
                        "/api/pig-temperatures",
                        headers={"X-Sensor-Token": "test-sensor-token"},
                        json={"tagId": "01", "temperatureC": 70},
                    )
        finally:
            app_module.store = original_store

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json()["pig"]["temp"], 38.2)
        self.assertEqual(history.status_code, 200)
        self.assertEqual(history.json()[0]["temperatureC"], 38.2)
        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(out_of_range.status_code, 422)

    def test_supabase_secret_key_alias_is_supported(self):
        original_url = os.environ.get("SUPABASE_URL")
        original_service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        original_secret_key = os.environ.get("SUPABASE_SECRET_KEY")
        try:
            os.environ["SUPABASE_URL"] = "https://example.supabase.co"
            os.environ["SUPABASE_SECRET_KEY"] = "secret-key-123"
            os.environ.pop("SUPABASE_SERVICE_ROLE_KEY", None)
            store = SupabaseStore()
            self.assertEqual(store.key, "secret-key-123")
        finally:
            if original_url is None:
                os.environ.pop("SUPABASE_URL", None)
            else:
                os.environ["SUPABASE_URL"] = original_url
            if original_service_key is None:
                os.environ.pop("SUPABASE_SERVICE_ROLE_KEY", None)
            else:
                os.environ["SUPABASE_SERVICE_ROLE_KEY"] = original_service_key
            if original_secret_key is None:
                os.environ.pop("SUPABASE_SECRET_KEY", None)
            else:
                os.environ["SUPABASE_SECRET_KEY"] = original_secret_key

    def test_app_uses_supabase_when_secret_key_is_present(self):
        original_url = os.environ.get("SUPABASE_URL")
        original_service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        original_secret_key = os.environ.get("SUPABASE_SECRET_KEY")
        original_anon_key = os.environ.get("SUPABASE_ANON_KEY")
        try:
            os.environ["SUPABASE_URL"] = "https://example.supabase.co"
            os.environ["SUPABASE_SECRET_KEY"] = "secret-key-123"
            os.environ["SUPABASE_SERVICE_ROLE_KEY"] = ""
            os.environ["SUPABASE_ANON_KEY"] = ""

            import importlib
            import backend.app as app

            importlib.reload(app)
            self.assertIsInstance(app.store, app.SupabaseStore)
            self.assertEqual(app.store.key, "secret-key-123")
        finally:
            if original_url is None:
                os.environ.pop("SUPABASE_URL", None)
            else:
                os.environ["SUPABASE_URL"] = original_url
            if original_service_key is None:
                os.environ.pop("SUPABASE_SERVICE_ROLE_KEY", None)
            else:
                os.environ["SUPABASE_SERVICE_ROLE_KEY"] = original_service_key
            if original_secret_key is None:
                os.environ.pop("SUPABASE_SECRET_KEY", None)
            else:
                os.environ["SUPABASE_SECRET_KEY"] = original_secret_key
            if original_anon_key is None:
                os.environ.pop("SUPABASE_ANON_KEY", None)
            else:
                os.environ["SUPABASE_ANON_KEY"] = original_anon_key

    def test_pig_profiles_are_written_to_dedicated_pigs_table(self):
        with patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_SECRET_KEY": "secret-key-123",
        }):
            store = SupabaseStore()
            supabase_row = {
                "id": "Pig_1",
                "tag_id": None,
                "model_identity": "Pig_1",
                "stage": "Unassigned",
                "days_in_pen": None,
                "weight": 15.67,
                "temp": None,
                "behavior": None,
                "health_indicator": None,
                "status": "Unreviewed",
                "created_at": "2026-10-03T00:00:00+00:00",
                "updated_at": "2026-10-03T00:00:00+00:00",
            }
            with patch.object(store, "_request", return_value=[supabase_row]) as request:
                pig = store.create("pigs", {
                    "id": "Pig_1",
                    "tagId": None,
                    "modelIdentity": "Pig_1",
                    "stage": "Unassigned",
                    "weight": 15.67,
                    "status": "Unreviewed",
                })

        self.assertEqual(request.call_args.kwargs["table"], "pigs")
        self.assertEqual(request.call_args.kwargs["payload"][0]["model_identity"], "Pig_1")
        self.assertEqual(pig["modelIdentity"], "Pig_1")

    def test_legacy_pig_records_are_migrated_once_without_overwriting(self):
        with patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_SECRET_KEY": "secret-key-123",
        }):
            store = SupabaseStore()
            legacy_row = {
                "id": "Pig_1",
                "payload": {
                    "tagId": "01",
                    "modelIdentity": "Pig_1",
                    "stage": "Grower",
                    "weight": 15.67,
                    "status": "Healthy",
                },
                "created_at": "2026-10-03T00:00:00+00:00",
                "updated_at": "2026-10-03T00:00:00+00:00",
            }
            with patch.object(store, "_request", side_effect=[[legacy_row], []]) as request:
                store._migrate_legacy_pigs()
                store._migrate_legacy_pigs()

        self.assertEqual(request.call_count, 2)
        migration_call = request.call_args_list[1].kwargs
        self.assertEqual(migration_call["table"], "pigs")
        self.assertEqual(migration_call["params"]["on_conflict"], "id")
        self.assertEqual(migration_call["payload"][0]["tag_id"], "01")
        self.assertEqual(migration_call["prefer"], "resolution=ignore-duplicates,return=minimal")

    def test_record_create_requests_and_decodes_the_inserted_row(self):
        with patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_SECRET_KEY": "secret-key-123",
        }):
            store = SupabaseStore()
            row = {
                "collection": "observations",
                "id": "observation-1",
                "created_at": "2026-10-03T00:00:00+00:00",
                "updated_at": "2026-10-03T00:00:00+00:00",
                "payload": {
                    "id": "observation-1",
                    "source": "camera",
                    "box": {"x1": 10, "y1": 20, "x2": 40, "y2": 60},
                },
            }
            with patch.object(store, "_request", return_value=[row]) as request:
                observation = store.create("observations", {
                    "source": "camera",
                    "box": {"x1": 10, "y1": 20, "x2": 40, "y2": 60},
                })

        self.assertEqual(request.call_args.kwargs["prefer"], "return=representation")
        self.assertEqual(observation["id"], "observation-1")
        self.assertEqual(observation["box"], row["payload"]["box"])

    def test_record_create_reports_missing_insert_representation(self):
        with patch.dict(os.environ, {
            "SUPABASE_URL": "https://example.supabase.co",
            "SUPABASE_SECRET_KEY": "secret-key-123",
        }):
            store = SupabaseStore()
            with patch.object(store, "_request", return_value=[]):
                with self.assertRaisesRegex(RuntimeError, "did not return the created record"):
                    store.create("observations", {"source": "camera"})

    def test_non_ai_pig_profile_can_upload_and_read_photo(self):
        import backend.app as app_module

        original_store = app_module.store
        try:
            with tempfile.TemporaryDirectory() as temporary_directory:
                app_module.store = unittest.mock.Mock()
                app_module.store.get.return_value = {
                    "id": "pig:Pig_5",
                    "modelIdentity": "Pig_5",
                }
                image_buffer = BytesIO()
                Image.new("RGB", (8, 8), color=(30, 160, 90)).save(image_buffer, format="PNG")

                with patch.object(app_module, "PIG_PROFILE_IMAGE_DIR", Path(temporary_directory)):
                    client = TestClient(app_module.app)
                    upload_response = client.post(
                        "/api/pigs/pig%3APig_5/image",
                        files={"image": ("pig.png", image_buffer.getvalue(), "image/png")},
                    )
                    image_response = client.get("/api/pigs/pig%3APig_5/image")

            self.assertEqual(upload_response.status_code, 200)
            self.assertEqual(image_response.status_code, 200)
            self.assertEqual(image_response.headers["content-type"], "image/jpeg")
        finally:
            app_module.store = original_store

    def test_ai_image_analysis_returns_and_persists_detection_boxes(self):
        import backend.app as app_module

        original_store = app_module.store
        original_ai_service = app_module.ai_service
        app_module.store = unittest.mock.Mock()
        app_module.store.list.return_value = []
        box = {"x1": 10.0, "y1": 20.0, "x2": 40.0, "y2": 60.0, "confidence": 90.0}
        app_module.store.create.return_value = {"id": "observation-1", "box": box}
        app_module.ai_service = unittest.mock.Mock()
        app_module.ai_service.process_image.return_value = {
            "status": "ok",
            "detected_count": 1,
            "pigs": [{
                "pig_id": "Pig_1",
                "recognition_confidence": 95.0,
                "estimated_weight_kg": 15.5,
                "behavior_indicator": "Standing",
                "behavior_confidence": 80.0,
                "behavior_source": "OPB behavior model",
                "box": box,
            }],
        }

        try:
            image_buffer = BytesIO()
            Image.new("RGB", (64, 64), color=(30, 160, 90)).save(image_buffer, format="JPEG")
            client = TestClient(app_module.app)
            response = client.post(
                "/api/observations/analyze-image",
                files={"image": ("pig.jpg", image_buffer.getvalue(), "image/jpeg")},
                data={"source": "upload"},
            )
        finally:
            app_module.store = original_store
            app_module.ai_service = original_ai_service

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["pigs"][0]["box"], box)
        self.assertEqual(response.json()["observations"][0]["box"], box)


if __name__ == "__main__":
    unittest.main()
