from __future__ import annotations

import json
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


DEFAULT_DATABASE = Path(__file__).resolve().parent / "data" / "smart_swine.sqlite3"
COLLECTIONS = {"pigs", "observations", "alerts", "environment", "feed-records", "pig-temperatures"}
PIG_COLUMNS = {
    "tagId": "tag_id",
    "modelIdentity": "model_identity",
    "stage": "stage",
    "daysInPen": "days_in_pen",
    "weight": "weight",
    "temp": "temp",
    "behavior": "behavior",
    "healthIndicator": "health_indicator",
    "status": "status",
}


class SupabaseStore:
    def __init__(self):
        self.url = os.getenv("SUPABASE_URL", "").rstrip("/")
        self.key = (
            os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_SECRET_KEY")
            or os.getenv("SUPABASE_ANON_KEY")
        )
        if not self.url or not self.key:
            raise RuntimeError(
                "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)."
            )
        self._legacy_pigs_migrated = False

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    @staticmethod
    def _decode(row: dict[str, Any]) -> dict[str, Any]:
        payload = dict(row.get("payload") or {})
        payload["id"] = row.get("id")
        payload["createdAt"] = row.get("created_at")
        payload["updatedAt"] = row.get("updated_at")
        return payload

    @staticmethod
    def _decode_pig(row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row.get("id"),
            "tagId": row.get("tag_id"),
            "modelIdentity": row.get("model_identity"),
            "stage": row.get("stage"),
            "daysInPen": row.get("days_in_pen"),
            "weight": row.get("weight"),
            "temp": row.get("temp"),
            "behavior": row.get("behavior"),
            "healthIndicator": row.get("health_indicator"),
            "status": row.get("status"),
            "createdAt": row.get("created_at"),
            "updatedAt": row.get("updated_at"),
        }

    @staticmethod
    def _pig_columns(payload: dict[str, Any]) -> dict[str, Any]:
        return {
            column: payload[key]
            for key, column in PIG_COLUMNS.items()
            if key in payload
        }

    def _migrate_legacy_pigs(self) -> None:
        if self._legacy_pigs_migrated:
            return

        legacy_rows = self._request(
            "GET",
            params={
                "collection": "eq.pigs",
                "select": "id,payload,created_at,updated_at",
                "limit": "500",
            },
        )
        pig_rows = []
        for row in legacy_rows:
            payload = self._decode(row)
            columns = self._pig_columns(payload)
            columns.setdefault("stage", "Unassigned")
            columns.setdefault("status", "Unreviewed")
            pig_rows.append({"id": row["id"], **columns})

        if pig_rows:
            self._request(
                "POST",
                table="pigs",
                params={"on_conflict": "id"},
                payload=pig_rows,
                prefer="resolution=ignore-duplicates,return=minimal",
            )
        self._legacy_pigs_migrated = True

    def _request(
        self,
        method: str,
        *,
        table: str = "records",
        params: dict[str, str] | None = None,
        payload: Any = None,
        prefer: str | None = None,
    ):
        if not self.url or not self.key:
            raise RuntimeError(
                "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)."
            )

        query = urllib.parse.urlencode(params or {}, doseq=True)
        url = f"{self.url}/rest/v1/{table}"
        if query:
            url = f"{url}?{query}"

        data = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        request = urllib.request.Request(
            url,
            method=method,
            data=data,
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else []
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            details = body.strip() or str(error)
            raise RuntimeError(f"Supabase request failed ({error.code}): {details}") from error

    def list(self, collection: str, limit: int = 100) -> list[dict[str, Any]]:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        if collection == "pigs":
            self._migrate_legacy_pigs()
            rows = self._request(
                "GET",
                table="pigs",
                params={
                    "select": "*",
                    "order": "updated_at.desc",
                    "limit": str(limit),
                },
            )
            return [self._decode_pig(row) for row in rows]
        rows = self._request(
            "GET",
            params={
                "collection": f"eq.{collection}",
                "select": "*",
                "order": "updated_at.desc",
                "limit": str(limit),
            },
        )
        return [self._decode(row) for row in rows]

    def get(self, collection: str, record_id: str) -> dict[str, Any] | None:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        if collection == "pigs":
            self._migrate_legacy_pigs()
            rows = self._request(
                "GET",
                table="pigs",
                params={"id": f"eq.{record_id}", "select": "*"},
            )
            return self._decode_pig(rows[0]) if rows else None
        rows = self._request(
            "GET",
            params={
                "collection": f"eq.{collection}",
                "id": f"eq.{record_id}",
                "select": "*",
            },
        )
        if not rows:
            return None
        return self._decode(rows[0])

    def create(self, collection: str, payload: dict[str, Any]) -> dict[str, Any]:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        record_id = str(payload.get("id") or uuid4())
        if collection == "pigs":
            self._migrate_legacy_pigs()
            row = {"id": record_id, **self._pig_columns(payload)}
            result = self._request(
                "POST",
                table="pigs",
                payload=[row],
                prefer="return=representation",
            )
            response_row = result[0] if isinstance(result, list) and result else result
            return self._decode_pig(response_row)
        record = {**payload, "id": record_id}
        timestamp = self._now()
        row = {
            "collection": collection,
            "id": record_id,
            "created_at": timestamp,
            "updated_at": timestamp,
            "payload": record,
        }
        result = self._request(
            "POST",
            payload=[row],
            prefer="return=representation",
        )
        response_row = result[0] if isinstance(result, list) and result else result
        if not isinstance(response_row, dict):
            raise RuntimeError(
                "Supabase did not return the created record. Verify the records table permissions."
            )
        return self._decode(response_row)

    def update(
        self, collection: str, record_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        if collection == "pigs":
            self._migrate_legacy_pigs()
            rows = self._request(
                "PATCH",
                table="pigs",
                params={"id": f"eq.{record_id}"},
                payload=self._pig_columns(payload),
                prefer="return=representation",
            )
            return self._decode_pig(rows[0]) if rows else None
        timestamp = self._now()
        record = {**payload, "id": record_id}
        result = self._request(
            "PATCH",
            params={
                "collection": f"eq.{collection}",
                "id": f"eq.{record_id}",
            },
            payload={"updated_at": timestamp, "payload": record},
        )
        rows = result if isinstance(result, list) else [result]
        return self._decode(rows[0]) if rows and rows[0] else None

    def delete(self, collection: str, record_id: str) -> bool:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        if collection == "pigs":
            self._migrate_legacy_pigs()
            result = self._request(
                "DELETE",
                table="pigs",
                params={"id": f"eq.{record_id}"},
                prefer="return=representation",
            )
            return bool(result)
        result = self._request(
            "DELETE",
            params={
                "collection": f"eq.{collection}",
                "id": f"eq.{record_id}",
            },
        )
        return bool(result)


class SQLiteStore:
    def __init__(self, database: Path | None = None):
        configured_database = database or os.getenv("PIG_DATA_DB_FILE", DEFAULT_DATABASE)
        self.database = Path(configured_database)
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS records (
                    collection TEXT NOT NULL,
                    id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    payload TEXT NOT NULL CHECK (json_valid(payload)),
                    PRIMARY KEY (collection, id)
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS records_collection_updated "
                "ON records (collection, updated_at DESC)"
            )
            connection.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS records_pig_tag_id_unique "
                "ON records (json_extract(payload, '$.tagId')) "
                "WHERE collection = 'pigs' AND json_extract(payload, '$.tagId') IS NOT NULL"
            )
            connection.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS records_pig_model_identity_unique "
                "ON records (json_extract(payload, '$.modelIdentity')) "
                "WHERE collection = 'pigs' AND json_extract(payload, '$.modelIdentity') IS NOT NULL"
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def _connection(self):
        connection = self._connect()
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        record = json.loads(row["payload"])
        record["id"] = row["id"]
        record["createdAt"] = row["created_at"]
        record["updatedAt"] = row["updated_at"]
        return record

    def list(self, collection: str, limit: int = 100) -> list[dict[str, Any]]:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM records WHERE collection = ? "
                "ORDER BY updated_at DESC, id DESC LIMIT ?",
                (collection, limit),
            ).fetchall()
        return [self._decode(row) for row in rows]

    def get(self, collection: str, record_id: str) -> dict[str, Any] | None:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        with self._connection() as connection:
            row = connection.execute(
                "SELECT * FROM records WHERE collection = ? AND id = ?",
                (collection, record_id),
            ).fetchone()
        return self._decode(row) if row is not None else None

    def create(self, collection: str, payload: dict[str, Any]) -> dict[str, Any]:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        record_id = str(payload.get("id") or uuid4())
        record = {**payload, "id": record_id}
        timestamp = self._now()
        encoded = json.dumps(record, ensure_ascii=False, allow_nan=False)
        with self._connection() as connection:
            connection.execute(
                "INSERT INTO records (collection, id, created_at, updated_at, payload) "
                "VALUES (?, ?, ?, ?, ?)",
                (collection, record_id, timestamp, timestamp, encoded),
            )
        return {**record, "createdAt": timestamp, "updatedAt": timestamp}

    def update(
        self, collection: str, record_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        timestamp = self._now()
        record = {**payload, "id": record_id}
        encoded = json.dumps(record, ensure_ascii=False, allow_nan=False)
        with self._connection() as connection:
            cursor = connection.execute(
                "UPDATE records SET updated_at = ?, payload = ? "
                "WHERE collection = ? AND id = ?",
                (timestamp, encoded, collection, record_id),
            )
            if cursor.rowcount == 0:
                return None
            row = connection.execute(
                "SELECT * FROM records WHERE collection = ? AND id = ?",
                (collection, record_id),
            ).fetchone()
        return self._decode(row)

    def delete(self, collection: str, record_id: str) -> bool:
        if collection not in COLLECTIONS:
            raise ValueError(f"Unsupported collection: {collection}")
        with self._connection() as connection:
            cursor = connection.execute(
                "DELETE FROM records WHERE collection = ? AND id = ?",
                (collection, record_id),
            )
        return cursor.rowcount > 0
