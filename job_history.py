"""Private, content-free submission ledger shared by MCP and the web API."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
import os
import sqlite3
import uuid

last_submission: ContextVar[str] = ContextVar('last_submission', default='')
source: ContextVar[str] = ContextVar('print_source', default='mcp')


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    path = Path(os.environ.get('PRINT_HISTORY_DB', str(Path.home() / '.local/share/print/history.sqlite3')))
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path, timeout=10)
    path.chmod(0o600)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('''CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, cups_id TEXT, printer TEXT NOT NULL, source TEXT NOT NULL,
        state TEXT NOT NULL, pages INTEGER NOT NULL, copies INTEGER NOT NULL,
        created_at TEXT NOT NULL, dry_run INTEGER NOT NULL)''')
    try:
        with db:
            yield db
    finally:
        db.close()


def begin(printer: str, pages: int, copies: int, dry_run: bool = False) -> str:
    job_id = uuid.uuid4().hex
    with connect() as db:
        db.execute('INSERT INTO jobs VALUES (?,NULL,?,?,?,?,?,?,?)', (
            job_id, printer, source.get(), 'pending', pages, copies,
            datetime.now(timezone.utc).isoformat(), int(dry_run)))
    last_submission.set(job_id)
    return job_id


def finish(job_id: str, state: str, cups_id: str | None = None) -> None:
    with connect() as db:
        db.execute('''UPDATE jobs SET state=?, cups_id=COALESCE(?,cups_id)
            WHERE id=? AND (state != ? OR (? IS NOT NULL AND cups_id IS NOT ?))''',
            (state, cups_id, job_id, state, cups_id, cups_id))


def jobs() -> list[dict[str, Any]]:
    with connect() as db:
        return [dict(row) | {'dry_run': bool(row['dry_run'])} for row in db.execute(
            'SELECT * FROM jobs ORDER BY created_at DESC LIMIT 500')]


def stats() -> dict[str, Any]:
    with connect() as db:
        daily = [dict(row) for row in db.execute('''SELECT date(created_at,'localtime') AS date,
            printer,source,count(*) AS jobs,sum(pages*copies) AS pages,
            sum(state IN ('failed','aborted','unknown')) AS failures
            FROM jobs WHERE date(created_at,'localtime') >= date('now','localtime','-29 days')
            GROUP BY date,printer,source ORDER BY date''')]
    return {'daily': daily, 'totals': {key: sum(row[key] for row in daily) for key in ('jobs','pages','failures')}}
