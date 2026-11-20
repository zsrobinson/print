"""Authenticated loopback API; never returns or records document content."""
from __future__ import annotations

import hmac
import os
from pathlib import Path
import plistlib
import tempfile
import threading
import time
from datetime import datetime, timezone
from typing import Any

import anyio
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
import job_history as history


class CoreAPI:
    def __init__(self, core: Any) -> None:
        self.core = core
        self.limiter = anyio.CapacityLimiter(2)
        self.refresh_lock = threading.Lock()
        self.refreshed_at = 0.0

    async def handle(self, request: Request) -> JSONResponse:
        secret = os.environ.get('PRINT_CORE_TOKEN', '')
        peer = request.client.host if request.client else ''
        if peer not in ('127.0.0.1', '::1') or not secret or not hmac.compare_digest(
                request.headers.get('authorization', ''), 'Bearer ' + secret):
            return JSONResponse({'error': 'Unauthorized'}, status_code=401)
        try:
            if request.method == 'GET':
                data = await anyio.to_thread.run_sync(self.read, request.url.path, limiter=self.limiter)
            elif request.url.path.endswith('/cancel'):
                data = await anyio.to_thread.run_sync(self.cancel, request.path_params['job_id'], limiter=self.limiter)
            else:
                # Bound the complete multipart body, including chunked requests.
                body = bytearray()
                async for chunk in request.stream():
                    body.extend(chunk)
                    if len(body) > self.core.MAX_PDF + 65536:
                        return JSONResponse({'error': 'Upload exceeds 10 MiB'}, status_code=413)
                request._body = bytes(body)
                async with request.form(max_files=1, max_fields=8, max_part_size=self.core.MAX_PDF) as form:
                    values = dict(form)
                    upload = values.pop('file', None)
                    data_bytes = await upload.read() if upload is not None and hasattr(upload, 'read') else None
                    data = await anyio.to_thread.run_sync(self.submit, values, data_bytes, limiter=self.limiter)
            return JSONResponse(data)
        except (ValueError, TypeError, KeyError):
            return JSONResponse({'error': 'Job cannot be cancelled in its current state' if request.url.path.endswith('/cancel')
                                 else 'Invalid print options or document'}, status_code=400)
        except Exception:
            return JSONResponse({'error': 'Printer operation failed; check queue before retrying'}, status_code=502)

    def read(self, path: str) -> dict[str, Any]:
        self.refresh()
        if path == '/internal/stats':
            return history.stats()
        jobs = history.jobs()
        if path == '/internal/jobs':
            # Return only job ids from CUPS, never owners, names, or documents.
            cups: dict[str, str] = {}
            for printer in ('document', 'receipt'):
                try:
                    raw = self.core.list_jobs(printer=printer)['jobs']
                    cups[printer] = '\n'.join(line.split()[0] for line in raw.splitlines() if line.split())
                except (OSError, RuntimeError, TimeoutError, ValueError):
                    cups[printer] = 'Queue unavailable'
            return {'jobs': jobs, 'cups': cups}
        printers = []
        for printer in ('document', 'receipt'):
            raw = self.core.printer_status(printer)
            state_text = str(raw.get('state', '')).lower()
            state = ('offline' if 'unavailable' in state_text else 'stopped' if 'disabled' in state_text
                     else 'busy' if 'printing' in state_text else 'idle')
            printers.append({'id': printer, 'state': state,
                             'status': {'queried_at': int(time.time()), **{key: raw[key] for key in ('queried_at', 'printer_state_message', 'reasons') if key in raw}},
                             'last_job': next((job for job in jobs if job['printer'] == printer and not job['dry_run']
                                              and job['state'] in ('completed','canceled','aborted','failed','unknown')), None)})
        return {'printers': printers}

    def refresh(self) -> None:
        if time.monotonic() - self.refreshed_at < 10 or not self.refresh_lock.acquire(blocking=False):
            return
        try:
            self._refresh()
            self.refreshed_at = time.monotonic()
        finally:
            self.refresh_lock.release()

    def _refresh(self) -> None:
        """Read only numeric job state and page counts; never ask CUPS for titles."""
        for printer in ('document', 'receipt'):
            active = {job['cups_id']: job for job in history.jobs() if job['printer'] == printer
                      and job['state'] in ('pending', 'held', 'processing', 'stopped')}
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
                states = {3: 'pending', 4: 'held', 5: 'processing', 6: 'stopped',
                          7: 'canceled', 8: 'aborted', 9: 'completed'}
                seen = set()
                for test in report['Tests']:
                    if not test.get('Successful'):
                        continue
                    for attributes in test.get('ResponseAttributes', []):
                        number = attributes.get('job-id')
                        state = states.get(attributes.get('job-state'))
                        cups_id = f'{queue}-{number}'
                        seen.add(cups_id)
                        job = active.get(cups_id)
                        if job and state:
                            history.finish(job['id'], state)
                for cups_id, job in active.items():
                    age = (datetime.now(timezone.utc) - datetime.fromisoformat(job['created_at'])).total_seconds()
                    if cups_id not in seen and age > 3600:
                        history.finish(job['id'], 'unknown')
            except (OSError, RuntimeError, TimeoutError, ValueError, KeyError, TypeError):
                continue

    def submit(self, values: dict[str, Any], data: bytes | None) -> dict[str, Any]:
        printer = values.get('printer')
        if printer not in ('document', 'receipt') or values.get('dry_run') not in ('true', 'false'):
            raise ValueError('Invalid printer or dry_run')
        dry_run = values['dry_run'] == 'true'
        token = history.source.set('web')
        try:
            if printer == 'receipt':
                if data is not None:
                    raise ValueError('Receipt requires text')
                if dry_run:
                    self.core.print_receipt(values['text'], dry_run=True)
                    job_id = history.last_submission.get()
                else:
                    self.core.print_receipt(values['text'])
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
                with tempfile.TemporaryDirectory(prefix='print-web-') as directory:
                    path = Path(directory) / 'document'
                    path.write_bytes(data)  # Original bytes, including images; no re-rendering.
                    job_id = self.core._submit_recorded(path, copies, duplex, 'monochrome', page_range,
                                                        'Letter', pages=len(selected), dry_run=dry_run)['history_id']
            return {'job': next(job for job in history.jobs() if job['id'] == job_id)}
        finally:
            history.source.reset(token)

    def cancel(self, job_id: str) -> dict[str, Any]:
        job = next((job for job in history.jobs() if job['id'] == job_id), None)
        if job is None:
            raise ValueError('Unknown job')
        if job['state'] not in ('pending', 'processing', 'held', 'stopped'):
            raise ValueError('Job is not active')
        if not job['cups_id']:
            raise ValueError('Submission outcome unknown; check printer before cancelling')
        if job['cups_id']:
            self.core.cancel_job(job['cups_id'], job['printer'])
        history.finish(job_id, 'canceled')
        return {'cancelled': job_id}

    def routes(self) -> list[Route]:
        return [Route(path, self.handle, methods=methods) for path, methods in (
            ('/internal/printers', ['GET']), ('/internal/jobs', ['GET', 'POST']),
            ('/internal/stats', ['GET']), ('/internal/jobs/{job_id}/cancel', ['POST']))]
