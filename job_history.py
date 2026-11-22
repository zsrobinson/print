"""Private submission ledger and kept copies shared by MCP and the web API.

Job names and kept bytes live only here, in the private SQLite file and the
private kept directory. Nothing in this module logs them.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
import unicodedata
import uuid

last_submission: ContextVar[str] = ContextVar('last_submission', default='')
source: ContextVar[str] = ContextVar('print_source', default='mcp')

ACTIVE = ('pending', 'held', 'processing', 'stopped')
TERMINAL = ('completed', 'canceled', 'aborted', 'unknown')
FAILED = ('aborted', 'unknown')
STATUS_GROUPS = {'active': ACTIVE, 'finished': TERMINAL, 'completed': ('completed',),
                 'failed': FAILED, 'canceled': ('canceled',)}
KEEP_DAYS = 7
NAME_LIMIT = 120
SIZE_BUCKETS = ('1', '2–5', '6–10', '11–25', '26+')
RANGES = {'7d': 7, '30d': 30, '90d': 90, 'all': None}

# Additive migration: every column added after the first release is nullable.
COLUMNS = {'name': 'TEXT', 'kind': 'TEXT', 'options': 'TEXT', 'finished_at': 'TEXT',
           'size_bytes': 'INTEGER', 'error': 'TEXT', 'kept_until': 'TEXT',
           'kept_type': 'TEXT', 'document_pages': 'INTEGER'}

_log = logging.getLogger(__name__)
_schema_lock = threading.Lock()
_migrated: set[str] = set()
_write_lock = threading.Lock()
_prune_lock = threading.Lock()
_pruned_at = 0.0


def db_path() -> Path:
    return Path(os.environ.get('PRINT_HISTORY_DB', str(Path.home() / '.local/share/print/history.sqlite3')))


def keep_dir() -> Path:
    """Kept copies sit beside the ledger unless PRINT_KEEP_DIR says otherwise."""
    configured = os.environ.get('PRINT_KEEP_DIR', '').strip()
    return Path(configured) if configured else db_path().parent / 'kept'


def keep_max_bytes() -> int:
    return int(os.environ.get('PRINT_KEEP_MAX_BYTES', str(512 * 1024 * 1024)))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def _migrate(db: sqlite3.Connection) -> None:
    db.execute('''CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, cups_id TEXT, printer TEXT NOT NULL, source TEXT NOT NULL,
        state TEXT NOT NULL, pages INTEGER NOT NULL, copies INTEGER NOT NULL,
        created_at TEXT NOT NULL, dry_run INTEGER NOT NULL)''')
    existing = {row[1] for row in db.execute('PRAGMA table_info(jobs)')}
    for column, kind in COLUMNS.items():
        if column not in existing:
            db.execute(f'ALTER TABLE jobs ADD COLUMN {column} {kind}')
    db.execute('CREATE TABLE IF NOT EXISTS job_events (job_id TEXT NOT NULL, state TEXT NOT NULL, at TEXT NOT NULL)')
    db.execute('''CREATE TABLE IF NOT EXISTS printer_states (
        printer TEXT NOT NULL, state TEXT NOT NULL, reasons TEXT NOT NULL, at TEXT NOT NULL)''')
    db.execute('CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at)')
    db.execute('CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id)')
    db.execute('CREATE INDEX IF NOT EXISTS printer_states_printer ON printer_states(printer, at)')
    db.commit()


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(path, timeout=10)
    path.chmod(0o600)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    with _schema_lock:
        if str(path) not in _migrated:
            _migrate(db)
            _migrated.add(str(path))
    try:
        with db:
            yield db
    finally:
        db.close()


def clean_name(value: Any) -> str | None:
    """Strip controls, collapse whitespace, trim to 120 characters; None when empty."""
    if not isinstance(value, str):
        return None
    # Whitespace (including newlines and tabs) becomes a space; other controls go.
    text = re.sub(r'\s+', ' ', value)
    text = ''.join(char for char in text if not unicodedata.category(char).startswith('C'))
    text = re.sub(r' +', ' ', text).strip()[:NAME_LIMIT].strip()
    return text or None


def begin(printer: str, pages: int, copies: int, dry_run: bool = False, *,
          name: str | None = None, kind: str | None = None, options: dict[str, Any] | None = None,
          size_bytes: int | None = None, document_pages: int | None = None,
          keep: bytes | Path | None = None, keep_type: str | None = None) -> str:
    job_id = uuid.uuid4().hex
    now = _now()
    with connect() as db:
        db.execute('''INSERT INTO jobs (id, cups_id, printer, source, state, pages, copies, created_at,
            dry_run, name, kind, options, size_bytes, document_pages)
            VALUES (?,NULL,?,?,?,?,?,?,?,?,?,?,?,?)''', (
            job_id, printer, source.get(), 'pending', pages, copies, now, int(dry_run),
            clean_name(name), kind, json.dumps(options) if options is not None else None,
            size_bytes, document_pages))
        db.execute('INSERT INTO job_events VALUES (?,?,?)', (job_id, 'pending', now))
    last_submission.set(job_id)
    if keep is not None and keep_type:
        attach(job_id, keep, keep_type)
    return job_id


def attach(job_id: str, data: bytes | Path, content_type: str) -> bool:
    """Keep a copy for "Print again". Never raises: keeping must not fail a print."""
    directory = keep_dir()
    target = directory / job_id
    temporary = directory / f'.{job_id}.tmp'
    try:
        if not re.fullmatch(r'[0-9a-f]{32}', job_id):
            raise ValueError()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        until = (datetime.now(timezone.utc) + timedelta(days=KEEP_DAYS)).isoformat(timespec='microseconds')
        # Record first so a concurrent prune never mistakes the new file for an orphan.
        with connect() as db:
            db.execute('UPDATE jobs SET kept_until=?, kept_type=? WHERE id=?', (until, content_type, job_id))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            if isinstance(data, Path):
                with data.open('rb') as original:
                    shutil.copyfileobj(original, stream, 1024 * 1024)
            else:
                stream.write(data)
        os.replace(temporary, target)
    except Exception:
        _log.warning('Kept copy unavailable')
        try:
            temporary.unlink(missing_ok=True)
            with connect() as db:
                db.execute('UPDATE jobs SET kept_until=NULL, kept_type=NULL WHERE id=?', (job_id,))
        except Exception:
            pass
        return False
    try:
        prune()
    except Exception:
        _log.warning('Kept copy pruning unavailable')
    return True


def prune() -> None:
    """Delete expired or unrecorded copies, then the oldest until under the cap."""
    global _pruned_at
    directory = keep_dir()
    with _prune_lock:
        _pruned_at = time.monotonic()
        if not directory.is_dir():
            return
        with connect() as db:
            live = {row['id']: row['kept_until'] for row in db.execute(
                'SELECT id, kept_until FROM jobs WHERE kept_until > ?', (_now(),))}
        files = []
        for entry in os.scandir(directory):
            if not entry.is_file(follow_symlinks=False):
                continue
            if entry.name.startswith('.'):
                # Abandoned partial writes; a live write finishes within seconds.
                if entry.stat().st_mtime < time.time() - 3600:
                    os.unlink(entry.path)
                continue
            if entry.name not in live:
                os.unlink(entry.path)
                continue
            files.append((live[entry.name], entry.stat().st_size, entry.path))
        files.sort()
        total = sum(size for _, size, _ in files)
        cap = keep_max_bytes()
        for _, size, path in files:
            if total <= cap:
                break
            os.unlink(path)
            total -= size


def maybe_prune() -> None:
    """Reads prune at most once a minute."""
    if time.monotonic() - _pruned_at < 60:
        return
    try:
        prune()
    except Exception:
        _log.warning('Kept copy pruning unavailable')


def finish(job_id: str, state: str, cups_id: str | None = None, error: str | None = None) -> None:
    # CUPS may already have accepted the job. A ledger error must never invite
    # the caller to retry a successful submission or hide the original error.
    try:
        with _write_lock, connect() as db:
            row = db.execute('SELECT state, cups_id FROM jobs WHERE id=?', (job_id,)).fetchone()
            if row is None:
                return
            if row['state'] != state:
                now = _now()
                db.execute('''UPDATE jobs SET state=?, error=COALESCE(?, error),
                    finished_at=CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END
                    WHERE id=?''', (state, error, state in TERMINAL, now, job_id))
                db.execute('INSERT INTO job_events VALUES (?,?,?)', (job_id, state, now))
            if cups_id is not None and row['cups_id'] != cups_id:
                db.execute('UPDATE jobs SET cups_id=? WHERE id=?', (cups_id, job_id))
    except (OSError, sqlite3.Error):
        _log.warning('Job history update unavailable')


def _reprintable(row: sqlite3.Row, now: str) -> bool:
    return bool(row['kept_until'] and row['kept_until'] > now and (keep_dir() / row['id']).is_file())


def _job(row: sqlite3.Row, now: str) -> dict[str, Any]:
    try:
        options = json.loads(row['options']) if row['options'] else None
    except ValueError:
        options = None
    return {'id': row['id'], 'cups_id': row['cups_id'], 'printer': row['printer'],
            'source': row['source'], 'state': row['state'], 'pages': row['pages'],
            'copies': row['copies'], 'created_at': row['created_at'], 'dry_run': bool(row['dry_run']),
            'name': row['name'], 'kind': row['kind'], 'options': options,
            'finished_at': row['finished_at'], 'size_bytes': row['size_bytes'], 'error': row['error'],
            'kept_until': row['kept_until'], 'reprintable': _reprintable(row, now)}


def jobs() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = query(limit=500)['jobs']
    return result


def query(*, q: str | None = None, printer: str | None = None, status: str | None = None,
          source: str | None = None, dry_run: bool | None = None, start: date | None = None,
          end: date | None = None, limit: int = 25, offset: int = 0) -> dict[str, Any]:
    """Newest first. Callers validate values; this only builds parameterised SQL."""
    where: list[str] = []
    params: list[Any] = []
    if q:
        escaped = q.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        where.append("name LIKE ? ESCAPE '\\'")
        params.append(f'%{escaped}%')
    if printer:
        where.append('printer = ?')
        params.append(printer)
    if status:
        states = STATUS_GROUPS[status]
        where.append(f'state IN ({",".join("?" * len(states))})')
        params.extend(states)
    if source:
        where.append('source = ?')
        params.append(source)
    if dry_run is not None:
        where.append('dry_run = ?')
        params.append(int(dry_run))
    if start:
        where.append("date(created_at,'localtime') >= ?")
        params.append(start.isoformat())
    if end:
        where.append("date(created_at,'localtime') <= ?")
        params.append(end.isoformat())
    clause = ' WHERE ' + ' AND '.join(where) if where else ''
    now = _now()
    with connect() as db:
        total = db.execute(f'SELECT count(*) FROM jobs{clause}', params).fetchone()[0]
        rows = db.execute(f'SELECT * FROM jobs{clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?',
                          [*params, limit, offset]).fetchall()
    return {'jobs': [_job(row, now) for row in rows], 'total': total}


def get(job_id: str) -> dict[str, Any] | None:
    with connect() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    return None if row is None else _job(row, _now())


def detail(job_id: str) -> dict[str, Any] | None:
    """A Job plus its timeline, whole-document pages and any kept receipt text."""
    with connect() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if row is None:
            return None
        events = [{'state': event['state'], 'at': event['at']} for event in db.execute(
            'SELECT state, at FROM job_events WHERE job_id=? ORDER BY at, rowid', (job_id,))]
    job = _job(row, _now()) | {'events': events, 'document_pages': row['document_pages']}
    if row['kind'] == 'receipt':
        kept = kept_file(job_id)
        try:
            job['receipt_text'] = kept[0].read_text('utf-8') if kept else None
        except OSError:
            job['receipt_text'] = None
    return job


def kept_file(job_id: str) -> tuple[Path, str] | None:
    """The kept copy and its content type while it is retained."""
    with connect() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    if row is None or not row['kept_type'] or not _reprintable(row, _now()):
        return None
    return keep_dir() / row['id'], row['kept_type']


def active(printer: str) -> list[dict[str, Any]]:
    with connect() as db:
        return [{key: row[key] for key in row.keys()} for row in db.execute(
            f'SELECT id, cups_id, created_at FROM jobs WHERE printer=? AND state IN ({",".join("?" * len(ACTIVE))})',
            (printer, *ACTIVE))]


def last_job(printer: str) -> dict[str, Any] | None:
    terminal = ','.join('?' * len(TERMINAL))
    with connect() as db:
        row = db.execute(f'''SELECT * FROM jobs WHERE printer=? AND dry_run=0 AND state IN ({terminal})
            ORDER BY created_at DESC, rowid DESC LIMIT 1''', (printer, *TERMINAL)).fetchone()
    return None if row is None else _job(row, _now())


def record_printer_state(printer: str, state: str, reasons: list[str]) -> bool:
    """Append a row only when the state differs from the last recorded one."""
    with _write_lock, connect() as db:
        row = db.execute('SELECT state FROM printer_states WHERE printer=? ORDER BY at DESC, rowid DESC LIMIT 1',
                         (printer,)).fetchone()
        if row is not None and row['state'] == state:
            return False
        db.execute('INSERT INTO printer_states VALUES (?,?,?,?)',
                   (printer, state, json.dumps([str(reason) for reason in reasons]), _now()))
        return True


def printer_history(printer: str, days: int = 7) -> list[dict[str, Any]]:
    """Transitions in the window, oldest first, preceded by the one before it."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec='microseconds')
    with connect() as db:
        before = db.execute('''SELECT * FROM printer_states WHERE printer=? AND at < ?
            ORDER BY at DESC, rowid DESC LIMIT 1''', (printer, cutoff)).fetchall()
        within = db.execute('SELECT * FROM printer_states WHERE printer=? AND at >= ? ORDER BY at, rowid',
                            (printer, cutoff)).fetchall()
    result = []
    for row in [*before, *within]:
        try:
            reasons = [str(reason) for reason in json.loads(row['reasons'])]
        except (ValueError, TypeError):
            reasons = []
        result.append({'state': row['state'], 'at': row['at'], 'reasons': reasons})
    return result


def _totals(db: sqlite3.Connection, start: str, end: str) -> dict[str, int]:
    failed = ','.join('?' * len(FAILED))
    row = db.execute(f'''SELECT count(*) AS jobs, coalesce(sum(pages*copies),0) AS pages,
        coalesce(sum(state IN ({failed})),0) AS failures FROM jobs
        WHERE dry_run=0 AND date(created_at,'localtime') BETWEEN ? AND ?''', (*FAILED, start, end)).fetchone()
    return {'jobs': row['jobs'], 'pages': row['pages'], 'failures': row['failures']}


def stats(range: str = '30d') -> dict[str, Any]:
    """Real jobs in daily/previous/hours/sizes; dry runs only in totals.dry_runs."""
    if range not in RANGES:
        raise ValueError('Unknown range')
    days = RANGES[range]
    failed = ','.join('?' * len(FAILED))
    window = "dry_run=0 AND date(created_at,'localtime') BETWEEN ? AND ?"
    with connect() as db:
        today = date.fromisoformat(db.execute("SELECT date('now','localtime')").fetchone()[0])
        first = db.execute('SELECT min(created_at) FROM jobs').fetchone()[0]
        if days is None:
            start = today
            if first:
                start = min(today, date.fromisoformat(
                    db.execute("SELECT date(?,'localtime')", (first,)).fetchone()[0]))
        else:
            start = today - timedelta(days=days - 1)
        bounds = (start.isoformat(), today.isoformat())
        daily = [dict(row) for row in db.execute(f'''SELECT date(created_at,'localtime') AS date,
            printer, source, count(*) AS jobs, coalesce(sum(pages*copies),0) AS pages,
            coalesce(sum(state IN ({failed})),0) AS failures
            FROM jobs WHERE {window} GROUP BY date, printer, source ORDER BY date, printer, source''',
            (*FAILED, *bounds))]
        dry_runs = db.execute("""SELECT count(*) FROM jobs WHERE dry_run=1
            AND date(created_at,'localtime') BETWEEN ? AND ?""", bounds).fetchone()[0]
        previous = None
        if days is not None:
            previous = _totals(db, (start - timedelta(days=days)).isoformat(),
                               (start - timedelta(days=1)).isoformat())
        # SQLite %w counts from Sunday; the API counts from Monday.
        hours = [dict(row) for row in db.execute(f'''SELECT
            (CAST(strftime('%w', created_at, 'localtime') AS INTEGER) + 6) % 7 AS weekday,
            CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, count(*) AS jobs
            FROM jobs WHERE {window} GROUP BY weekday, hour ORDER BY weekday, hour''', bounds)]
        counted = {row['bucket']: row['jobs'] for row in db.execute(f'''SELECT CASE
            WHEN pages*copies <= 1 THEN 0 WHEN pages*copies <= 5 THEN 1 WHEN pages*copies <= 10 THEN 2
            WHEN pages*copies <= 25 THEN 3 ELSE 4 END AS bucket, count(*) AS jobs
            FROM jobs WHERE {window} GROUP BY bucket''', bounds)}
    sizes = [{'bucket': bucket, 'jobs': counted.get(index, 0)} for index, bucket in enumerate(SIZE_BUCKETS)]
    totals = {key: sum(row[key] for row in daily) for key in ('jobs', 'pages', 'failures')}
    return {'range': range, 'start': bounds[0], 'end': bounds[1], 'daily': daily,
            'totals': totals | {'dry_runs': dry_runs}, 'previous': previous, 'hours': hours,
            'sizes': sizes, 'first_job': first}
