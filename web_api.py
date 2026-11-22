"""Authenticated loopback API for the private web app.

Job names and kept copies appear only in these authenticated responses; they
are never logged and never echoed in error messages.
"""
from __future__ import annotations

import hmac
import os
from pathlib import Path
import plistlib
import re
import tempfile
import threading
import time
from datetime import date, datetime, timezone
from typing import Any, Awaitable, Callable, TypeVar

import anyio
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
import job_history as history

PRINTERS = ('document', 'receipt')
JOB_STATES = {3: 'pending', 4: 'held', 5: 'processing', 6: 'stopped',
              7: 'canceled', 8: 'aborted', 9: 'completed'}
ABORT_REASONS = {
    'document-format-error': 'The printer could not read the document.',
    'job-canceled-at-device': 'Cancelled at the printer.',
    'aborted-by-system': 'CUPS stopped the job.',
}
ABORTED_ERROR = 'The printer stopped the job before it finished.'
VANISHED_ERROR = 'CUPS lost track of this job, so it may or may not have printed.'
CUPS_ERRORS = (OSError, RuntimeError, TimeoutError, ValueError)
NO_STORE = {'Cache-Control': 'no-store'}
T = TypeVar('T')


class BadRequest(ValueError):
    """A 400 whose message is safe to return as-is."""


class NotFound(Exception):
    """A 404 whose message is safe to return as-is."""


def printer_state(lpstat: str) -> str:
    text = lpstat.lower()
    return ('offline' if 'unavailable' in text else 'stopped' if 'disabled' in text
            else 'busy' if 'printing' in text else 'idle')


def lpstat_reasons(lpstat: str) -> list[str]:
    for line in lpstat.splitlines():
        if line.strip().startswith('Alerts:'):
            return [word for word in line.split(':', 1)[1].split() if word != 'none']
    return []


def _date(value: str) -> date:
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError()
    return date.fromisoformat(value)


def _integer(value: str, low: int, high: int) -> int:
    if not re.fullmatch(r'\d{1,7}', value) or not low <= int(value) <= high:
        raise ValueError()
    return int(value)


class CoreAPI:
    def __init__(self, core: Any) -> None:
        self.core = core
        self.limiter = anyio.CapacityLimiter(2)
        self.refresh_lock = threading.Lock()
        self.refreshed_at = 0.0

    # Routing and authentication

    def routes(self) -> list[Route]:
        jobs_invalid = 'Invalid print options or document'
        return [
            Route('/internal/printers', self.endpoint(self.get_printers), methods=['GET']),
            Route('/internal/printers/{printer}', self.endpoint(self.get_printer), methods=['GET']),
            Route('/internal/printers/{printer}/check', self.endpoint(self.post_check), methods=['POST']),
            Route('/internal/jobs', self.endpoint(self.get_jobs), methods=['GET']),
            Route('/internal/jobs', self.endpoint(self.post_job, jobs_invalid), methods=['POST']),
            Route('/internal/jobs/{job_id}', self.endpoint(self.get_job), methods=['GET']),
            Route('/internal/jobs/{job_id}/file', self.endpoint(self.get_file), methods=['GET']),
            Route('/internal/jobs/{job_id}/cancel', self.endpoint(
                self.post_cancel, 'Job cannot be cancelled in its current state'), methods=['POST']),
            Route('/internal/fetch', self.endpoint(self.post_fetch), methods=['POST']),
            Route('/internal/stats', self.endpoint(self.get_stats), methods=['GET']),
        ]

    def authorized(self, request: Request) -> bool:
        secret = os.environ.get('PRINT_CORE_TOKEN', '')
        peer = request.client.host if request.client else ''
        return peer in ('127.0.0.1', '::1') and bool(secret) and hmac.compare_digest(
            request.headers.get('authorization', ''), 'Bearer ' + secret)

    def endpoint(self, handler: Callable[[Request], Awaitable[Any]],
                 invalid: str = 'Invalid request') -> Callable[[Request], Awaitable[Response]]:
        """Shared auth and error mapping. Messages are generic unless deliberately safe."""
        async def respond(request: Request) -> Response:
            if not self.authorized(request):
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
            try:
                result = await handler(request)
            except NotFound as exc:
                return JSONResponse({'error': str(exc)}, status_code=404)
            except BadRequest as exc:
                return JSONResponse({'error': str(exc)}, status_code=400)
            except (ValueError, TypeError, KeyError, HTTPException):
                # HTTPException: Starlette's own malformed-form rejection.
                return JSONResponse({'error': invalid}, status_code=400)
            except Exception:
                return JSONResponse({'error': 'Printer operation failed; check queue before retrying'}, status_code=502)
            return result if isinstance(result, Response) else JSONResponse(result)
        return respond

    async def thread(self, function: Callable[..., T], *args: Any) -> T:
        return await anyio.to_thread.run_sync(function, *args, limiter=self.limiter)

    def configured(self) -> list[str]:
        receipt = os.environ.get('PRINT_RECEIPT_QUEUE', '').strip()
        return [printer for printer in PRINTERS if printer == 'document' or receipt]

    def printer_id(self, request: Request) -> str:
        printer = request.path_params['printer']
        if printer not in self.configured():
            raise NotFound('Unknown printer')
        return str(printer)

    # Printers

    async def get_printers(self, request: Request) -> dict[str, Any]:
        return await self.thread(self.printers)

    async def get_printer(self, request: Request) -> dict[str, Any]:
        return await self.thread(self.printer_detail, self.printer_id(request))

    async def post_check(self, request: Request) -> dict[str, Any]:
        return await self.thread(self.check, self.printer_id(request))

    def printers(self) -> dict[str, Any]:
        self.refresh()
        return {'printers': [self.printer(printer) for printer in self.configured()]}

    def printer(self, printer: str) -> dict[str, Any]:
        raw = self.core.printer_status(printer)
        state = printer_state(str(raw.get('state', '')))
        reasons = [str(item.get('reason', item) if isinstance(item, dict) else item) for item in raw.get('reasons', [])]
        history.record_printer_state(printer, state, reasons)
        return {'id': printer, 'state': state, 'accepting': self.core.queue_accepting(printer),
                'status': {'queried_at': int(time.time()), **{key: raw[key] for key in
                           ('queried_at', 'printer_state_message', 'reasons') if key in raw}},
                'capabilities': self.core.printer_capabilities(printer),
                'last_job': history.last_job(printer)}

    def printer_detail(self, printer: str) -> dict[str, Any]:
        self.refresh()
        detail = self.printer(printer)
        return {'printer': detail | {
            'history': history.printer_history(printer),
            'recent_jobs': history.query(printer=printer, limit=10)['jobs'],
            'queue': self.queue_view(printer)}}

    def queue_view(self, printer: str) -> str:
        """CUPS job ids with active/completed only: never owners, titles or files."""
        try:
            queue = self.core._printer_queue(printer)
            lines: list[str] = []
            for which, label in (('not-completed', 'active'), ('completed', 'completed')):
                raw = self.core.run('lpstat', '-h', self.core.CUPS, '-W', which, '-o', queue)
                lines.extend(f'{line.split()[0]} {label}' for line in raw.splitlines() if line.split())
            return '\n'.join(lines)
        except CUPS_ERRORS:
            return 'Queue unavailable'

    def check(self, printer: str) -> dict[str, Any]:
        """Read-only diagnostics. Never submits anything to CUPS."""
        core = self.core
        queue = core._printer_queue(printer)
        checks: list[dict[str, Any]] = []

        def add(check_id: str, label: str, ok: bool | None, detail: str) -> None:
            checks.append({'id': check_id, 'label': label, 'ok': ok, 'detail': detail})

        try:
            core.run('lpstat', '-h', core.CUPS, '-r')
            cups_ok = True
            add('cups', 'CUPS', True, 'CUPS is answering.')
        except CUPS_ERRORS:
            cups_ok = False
            add('cups', 'CUPS', False, 'CUPS is not answering.')
        lpstat = None
        if cups_ok:
            try:
                lpstat = core.run('lpstat', '-h', core.CUPS, '-p', queue, '-l')
                add('queue', 'Queue', True, 'The queue exists in CUPS.')
            except CUPS_ERRORS:
                add('queue', 'Queue', False, 'The printer queue does not exist in CUPS.')
        else:
            add('queue', 'Queue', None, 'Skipped because CUPS is not answering.')
        if lpstat is None:
            add('accepting', 'Accepting jobs', None, 'Skipped because the queue is unavailable.')
            add('state', 'State', None, 'Skipped because the queue is unavailable.')
        else:
            accepting = core.queue_accepting(printer)
            add('accepting', 'Accepting jobs', accepting,
                {True: 'The queue accepts new jobs.', False: 'The printer is not accepting jobs.',
                 None: 'CUPS did not say whether the queue accepts jobs.'}[accepting])
            state = printer_state(lpstat)
            history.record_printer_state(printer, state, lpstat_reasons(lpstat))
            add('state', 'State', state not in ('stopped', 'offline'),
                {'idle': 'Ready.', 'busy': 'Printing.', 'stopped': 'The queue is stopped in CUPS.',
                 'offline': 'CUPS cannot reach the printer.'}[state])
        uri = os.environ.get('PRINT_STATUS_URI', '').strip()
        if printer == 'receipt':
            add('device', 'Device', None, 'Raw queue; no device query')
        elif not uri:
            add('device', 'Device', None, 'Not configured')
        else:
            try:
                core._query_status(uri, 'printer')
                add('device', 'Device', True, 'The printer answered.')
            except CUPS_ERRORS:
                add('device', 'Device', False, 'The printer did not answer.')
        return {'printer': printer, 'checked_at': datetime.now(timezone.utc).isoformat(),
                'ok': all(check['ok'] is not False for check in checks), 'checks': checks}

    def sample(self) -> None:
        """Background sampler: cheap lpstat per printer, recording transitions only."""
        for printer in self.configured():
            try:
                queue = self.core._printer_queue(printer)
                lpstat = self.core.run('lpstat', '-h', self.core.CUPS, '-p', queue, '-l')
                history.record_printer_state(printer, printer_state(lpstat), lpstat_reasons(lpstat))
            except Exception:
                continue

    # Jobs

    async def get_jobs(self, request: Request) -> dict[str, Any]:
        filters = self.job_filters(dict(request.query_params))
        return await self.thread(self.list_jobs, filters)

    def job_filters(self, params: dict[str, str]) -> dict[str, Any]:
        try:
            filters: dict[str, Any] = {}
            q = params.get('q', '')
            if len(q) > 100:
                raise ValueError()
            if q.strip():
                filters['q'] = q.strip()
            for key, allowed in (('printer', PRINTERS), ('status', tuple(history.STATUS_GROUPS)),
                                 ('source', ('web', 'mcp'))):
                if key in params:
                    if params[key] not in allowed:
                        raise ValueError()
                    filters[key] = params[key]
            if 'dry_run' in params:
                if params['dry_run'] not in ('true', 'false'):
                    raise ValueError()
                filters['dry_run'] = params['dry_run'] == 'true'
            if 'from' in params:
                filters['start'] = _date(params['from'])
            if 'to' in params:
                filters['end'] = _date(params['to'])
            if 'start' in filters and 'end' in filters and filters['start'] > filters['end']:
                raise ValueError()
            filters['limit'] = _integer(params['limit'], 1, 100) if 'limit' in params else 25
            filters['offset'] = _integer(params['offset'], 0, 1_000_000) if 'offset' in params else 0
            return filters
        except ValueError:
            raise BadRequest('Invalid job filters') from None

    def list_jobs(self, filters: dict[str, Any]) -> dict[str, Any]:
        self.refresh()
        history.maybe_prune()
        return history.query(**filters)

    async def get_job(self, request: Request) -> dict[str, Any]:
        return await self.thread(self.job_detail, request.path_params['job_id'])

    def job_detail(self, job_id: str) -> dict[str, Any]:
        self.refresh()
        history.maybe_prune()
        job = history.detail(job_id)
        if job is None:
            raise NotFound('Unknown job')
        return {'job': job}

    async def get_file(self, request: Request) -> Response:
        job_id = request.path_params['job_id']
        found = await self.thread(self.kept, job_id)
        path, content_type = found
        data = await self.thread(path.read_bytes)
        return Response(data, media_type=content_type, headers=NO_STORE)

    def kept(self, job_id: str) -> tuple[Path, str]:
        history.maybe_prune()
        if history.get(job_id) is None:
            raise NotFound('Unknown job')
        found = history.kept_file(job_id)
        if found is None:
            raise NotFound('The kept copy has expired')
        return found

    async def post_job(self, request: Request) -> Response | dict[str, Any]:
        # Bound the complete multipart body, including chunked requests.
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > self.core.MAX_PDF + 65536:
                return JSONResponse({'error': 'Upload exceeds 10 MiB'}, status_code=413)
        request._body = bytes(body)
        del body
        async with request.form(max_files=1, max_fields=10, max_part_size=self.core.MAX_PDF) as form:
            values = dict(form)
            upload = values.pop('file', None)
            data = await upload.read() if upload is not None and hasattr(upload, 'read') else None
        request._body = b''
        return await self.thread(self.submit, values, data)

    def submit(self, values: dict[str, Any], data: bytes | None) -> dict[str, Any]:
        printer = values.get('printer')
        if printer not in PRINTERS or values.get('dry_run') not in ('true', 'false'):
            raise ValueError('Invalid printer or dry_run')
        dry_run = values['dry_run'] == 'true'
        token = history.source.set('web')
        try:
            if printer == 'receipt':
                if data is not None:
                    raise ValueError('Receipt requires text')
                title = values.get('title') or None
                self.core.print_receipt(values['text'], title, dry_run=dry_run)
                job_id = history.last_submission.get()
            else:
                if not data or len(data) > self.core.MAX_PDF:
                    raise ValueError('Expected document')
                content_type = ('application/pdf' if data.startswith(b'%PDF-') else
                                'image/png' if data.startswith(b'\x89PNG\r\n\x1a\n') else 'image/jpeg')
                info = self.core._document_info(data, content_type)
                copies = int(values.get('copies', '1'))
                duplex = values.get('duplex', 'one-sided')
                page_range = values.get('page_range') or None
                self.core._validate_options(copies, duplex, 'monochrome', page_range, 'Letter')
                selected = set(range(1, info['pages'] + 1))
                if page_range:
                    if content_type != 'application/pdf':
                        raise ValueError('Page range requires PDF')
                    selected = set()
                    for part in page_range.split(','):
                        bounds = list(map(int, part.split('-')))
                        if bounds[-1] > info['pages']:
                            raise ValueError('Range outside document')
                        selected.update(range(bounds[0], bounds[-1] + 1))
                is_pdf = content_type == 'application/pdf'
                with tempfile.TemporaryDirectory(prefix='print-web-') as directory:
                    path = Path(directory) / 'document'
                    path.write_bytes(data)  # Original bytes, including images; no re-rendering.
                    name = history.clean_name(values.get('name')) or (self.core._pdf_title(path) if is_pdf else None)
                    record = {'name': name or ('Document' if is_pdf else 'Image'),
                              'kind': 'pdf' if is_pdf else 'image', 'size_bytes': len(data),
                              'document_pages': info['pages'],
                              'options': self.core._options(duplex, 'monochrome', page_range, 'Letter'),
                              'keep': path, 'keep_type': content_type}
                    job_id = self.core._submit_recorded(path, copies, duplex, 'monochrome', page_range, 'Letter',
                                                        pages=len(selected), dry_run=dry_run, record=record)['history_id']
            job = history.get(job_id)
            if job is None:
                raise RuntimeError('Job history unavailable')
            return {'job': job}
        finally:
            history.source.reset(token)

    async def post_cancel(self, request: Request) -> dict[str, Any]:
        return await self.thread(self.cancel, request.path_params['job_id'])

    def cancel(self, job_id: str) -> dict[str, Any]:
        job = history.get(job_id)
        if job is None:
            raise NotFound('Unknown job')
        if job['state'] not in history.ACTIVE:
            raise ValueError('Job is not active')
        if not job['cups_id']:
            raise ValueError('Submission outcome unknown; check printer before cancelling')
        self.core.cancel_job(job['cups_id'], job['printer'])
        history.finish(job_id, 'canceled')
        return {'cancelled': job_id}

    # Linked PDFs

    async def post_fetch(self, request: Request) -> Response:
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 16384:
                raise BadRequest('Invalid PDF URL')
        request._body = bytes(body)
        async with request.form(max_files=0, max_fields=4) as form:
            url = form.get('url')
        if not isinstance(url, str) or not url or len(url) > 2048:
            raise BadRequest('Invalid PDF URL')
        limit = self.core.MAX_PDF
        try:
            data = await self.thread(self.core.fetch_pdf, url, limit)
        except self.core.DownloadTooLarge:
            data = None
        except ValueError as exc:
            # fetch_pdf messages are fixed text and never echo the URL.
            raise BadRequest(str(exc)) from None
        if data is None or len(data) > limit:
            return JSONResponse({'error': 'Linked PDFs can be up to 10 MiB here'}, status_code=413)
        return Response(data, media_type='application/pdf', headers=NO_STORE)

    # Stats

    async def get_stats(self, request: Request) -> dict[str, Any]:
        selected = request.query_params.get('range', '30d')
        if selected not in history.RANGES:
            raise BadRequest('Unknown range')
        return await self.thread(self.stats, selected)

    def stats(self, selected: str) -> dict[str, Any]:
        self.refresh()
        result: dict[str, Any] = history.stats(selected)
        return result

    # CUPS job state refresh

    def refresh(self) -> None:
        if time.monotonic() - self.refreshed_at < 10 or not self.refresh_lock.acquire(blocking=False):
            return
        try:
            self._refresh()
            self.refreshed_at = time.monotonic()
        finally:
            self.refresh_lock.release()

    def _refresh(self) -> None:
        """Read only numeric job state and reasons; never ask CUPS for titles."""
        for printer in PRINTERS:
            active = {job['cups_id']: job for job in history.active(printer)}
            if not active:
                continue
            try:
                queue = self.core._printer_queue(printer)
                output = self.core.run('ipptool', '-T', '3', '-X',
                    f'ipp://{self.core.CUPS}/printers/{queue}',
                    str(Path(__file__).with_name('jobs.test')))
                report = plistlib.loads(output.encode())
                if not report.get('Successful'):
                    continue
                seen = set()
                for test in report['Tests']:
                    if not test.get('Successful'):
                        continue
                    for attributes in test.get('ResponseAttributes', []):
                        number = attributes.get('job-id')
                        state = JOB_STATES.get(attributes.get('job-state'))
                        cups_id = f'{queue}-{number}'
                        seen.add(cups_id)
                        job = active.get(cups_id)
                        if job and state:
                            error = None
                            if state == 'aborted':
                                reasons = attributes.get('job-state-reasons')
                                reasons = reasons if isinstance(reasons, list) else [reasons]
                                error = next((ABORT_REASONS[str(reason)] for reason in reasons
                                              if str(reason) in ABORT_REASONS), ABORTED_ERROR)
                            history.finish(job['id'], state, error=error)
                for cups_id, job in active.items():
                    age = (datetime.now(timezone.utc) - datetime.fromisoformat(job['created_at'])).total_seconds()
                    if cups_id not in seen and age > 3600:
                        history.finish(job['id'], 'unknown', error=VANISHED_ERROR)
            except (OSError, RuntimeError, TimeoutError, ValueError, KeyError, TypeError):
                continue
