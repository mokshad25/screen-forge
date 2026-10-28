"""
SQLite persistence. Standard library only.

Three things outlive a restart:
  contexts -- every version of every machine context, plus which is current.
              A machine imported from OPC UA, or changed at runtime, is still
              there after the API restarts.
  screens  -- the screen library: screens an operator chose to keep.
  events   -- one append-only log for alarm transitions and audit entries
              (generated, edited, saved, acknowledged, imported).

The database path comes from SCREENFORGE_DB (default api/data/screenforge.db).
Tests call init(":memory:").
"""

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent / "data" / "screenforge.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS contexts (
    asset_id   TEXT NOT NULL,
    version    TEXT NOT NULL,
    body       TEXT NOT NULL,
    origin     TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (asset_id, version)
);
CREATE TABLE IF NOT EXISTS current_context (
    asset_id TEXT PRIMARY KEY,
    version  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS screens (
    screen_id       TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    asset_id        TEXT NOT NULL,
    context_version TEXT NOT NULL,
    spec            TEXT NOT NULL,
    origin_kind     TEXT NOT NULL,
    saved_at        REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       REAL NOT NULL,
    kind     TEXT NOT NULL,
    asset_id TEXT,
    detail   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
"""

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def init(path: str | os.PathLike | None = None) -> None:
    """Open (or reopen) the database and create tables. Safe to call twice."""
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
        target = str(path or os.environ.get("SCREENFORGE_DB") or DEFAULT_DB)
        if target != ":memory:":
            Path(target).parent.mkdir(parents=True, exist_ok=True)
        _conn = sqlite3.connect(target, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.executescript(_SCHEMA)
        _conn.commit()


def _db() -> sqlite3.Connection:
    if _conn is None:
        init()
    return _conn  # type: ignore[return-value]


# ---------------------------------------------------------------- contexts

def save_context(context: dict, origin: str, make_current: bool = True) -> None:
    with _lock:
        db = _db()
        db.execute(
            "INSERT OR REPLACE INTO contexts (asset_id, version, body, origin, created_at) VALUES (?,?,?,?,?)",
            (context["asset_id"], context["context_version"], json.dumps(context), origin, time.time()),
        )
        if make_current:
            db.execute(
                "INSERT OR REPLACE INTO current_context (asset_id, version) VALUES (?,?)",
                (context["asset_id"], context["context_version"]),
            )
        db.commit()


def current_contexts() -> dict[str, dict]:
    with _lock:
        rows = _db().execute(
            "SELECT c.asset_id, c.body FROM current_context cc "
            "JOIN contexts c ON c.asset_id = cc.asset_id AND c.version = cc.version"
        ).fetchall()
    return {row["asset_id"]: json.loads(row["body"]) for row in rows}


def context_versions(asset_id: str) -> dict[str, dict]:
    with _lock:
        rows = _db().execute(
            "SELECT version, body FROM contexts WHERE asset_id = ?", (asset_id,)
        ).fetchall()
    return {row["version"]: json.loads(row["body"]) for row in rows}


def context_origin(asset_id: str, version: str) -> str | None:
    with _lock:
        row = _db().execute(
            "SELECT origin FROM contexts WHERE asset_id = ? AND version = ?", (asset_id, version)
        ).fetchone()
    return row["origin"] if row else None


# ----------------------------------------------------------------- screens

def save_screen(spec: dict) -> dict:
    origin = (spec.get("origin") or {}).get("kind", "prompt")
    with _lock:
        db = _db()
        db.execute(
            "INSERT OR REPLACE INTO screens (screen_id, title, asset_id, context_version, spec, origin_kind, saved_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (spec["screen_id"], spec["title"], spec["asset_id"], spec["context_version"],
             json.dumps(spec), origin, time.time()),
        )
        db.commit()
    return get_screen(spec["screen_id"])  # type: ignore[return-value]


def list_screens(asset_id: str | None = None) -> list[dict]:
    query = "SELECT screen_id, title, asset_id, context_version, origin_kind, saved_at FROM screens"
    args: tuple = ()
    if asset_id:
        query += " WHERE asset_id = ?"
        args = (asset_id,)
    query += " ORDER BY saved_at DESC"
    with _lock:
        rows = _db().execute(query, args).fetchall()
    return [dict(row) for row in rows]


def get_screen(screen_id: str) -> dict | None:
    with _lock:
        row = _db().execute("SELECT * FROM screens WHERE screen_id = ?", (screen_id,)).fetchone()
    if row is None:
        return None
    out = dict(row)
    out["spec"] = json.loads(out["spec"])
    return out


def delete_screen(screen_id: str) -> bool:
    with _lock:
        db = _db()
        cur = db.execute("DELETE FROM screens WHERE screen_id = ?", (screen_id,))
        db.commit()
    return cur.rowcount > 0


# ------------------------------------------------------------------ events

def log_event(kind: str, asset_id: str | None, **detail) -> dict:
    ts = time.time()
    with _lock:
        db = _db()
        cur = db.execute(
            "INSERT INTO events (ts, kind, asset_id, detail) VALUES (?,?,?,?)",
            (ts, kind, asset_id, json.dumps(detail, default=str)),
        )
        db.commit()
    return {"id": cur.lastrowid, "ts": ts, "kind": kind, "asset_id": asset_id, **detail}


def recent_events(limit: int = 100, asset_id: str | None = None, kinds: list[str] | None = None) -> list[dict]:
    query = "SELECT id, ts, kind, asset_id, detail FROM events"
    clauses, args = [], []
    if asset_id:
        clauses.append("asset_id = ?")
        args.append(asset_id)
    if kinds:
        clauses.append(f"kind IN ({','.join('?' * len(kinds))})")
        args.extend(kinds)
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    with _lock:
        rows = _db().execute(query, args).fetchall()
    return [
        {"id": r["id"], "ts": r["ts"], "kind": r["kind"], "asset_id": r["asset_id"], **json.loads(r["detail"])}
        for r in rows
    ]
