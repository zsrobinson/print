import plistlib
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest
from starlette.testclient import TestClient

import job_history
import server
from test_history import pdf_bytes

AUTH = {'Authorization': 'Bearer test-private-token'}


@pytest.fixture
def api(monkeypatch):
    monkeypatch.setenv('PRINT_CORE_TOKEN', 'test-private-token')
    monkeypatch.setenv('PRINT_RECEIPT_QUEUE', 'thermal')
    with TestClient(server.create_internal_app(), client=('127.0.0.1', 12345)) as client:
        yield client


def ipp(*attributes, successful=True):
    return plistlib.dumps({'Successful': successful, 'Tests': [
        {'Successful': successful, 'ResponseAttributes': list(attributes)}]}).decode()


class FakeCups:
    """Dispatches mocked CUPS commands; `lp` must never be called by reads or checks."""

    def __init__(self, lpstat_p='printer epson is idle.  enabled since today\n\tAlerts: none', accepting=True):
        self.calls = []
        self.lpstat_p = lpstat_p
        self.accepting = accepting
        self.jobs = ipp()

    def __call__(self, *args):
        self.calls.append(args)
        if args[0] in ('lp', 'cancel'):
            raise AssertionError('No submissions')
        if args[0] == 'ipptool':
            if args[-1].endswith('capabilities.test'):
                return ipp({'sides-supported': ['one-sided', 'two-sided-long-edge', 'bogus'],
                            'media-supported': ['na_letter_8.5x11in', 'iso_a4_210x297mm'],
                            'print-color-mode-supported': ['monochrome', 'color'],
                            'printer-make-and-model': 'Example Inkjet'})
            if args[-1].endswith('jobs.test'):
                return self.jobs
            return ipp({'printer-state': 3, 'printer-state-reasons': 'none'})
        if args[:3] == ('lpstat', '-h', server.CUPS):
            flag = args[3]
            if flag == '-r':
                return 'scheduler is running'
            if flag == '-p':
                if self.lpstat_p is None:
                    raise RuntimeError('CUPS command failed: lpstat: Invalid destination name')
                return self.lpstat_p
            if flag == '-a':
                return f'{args[4]} {"accepting" if self.accepting else "not accepting"} requests since today'
            if flag == '-W':
                return f'{args[-1]}-9 owner 1024 today' if args[4] == 'not-completed' else f'{args[-1]}-8 owner 2048 today'
        raise AssertionError(f'Unexpected command {args}')


@pytest.fixture
def cups_run(monkeypatch):
    fake = FakeCups()
    monkeypatch.setattr(server, 'run', fake)
    return fake


def test_printers_capabilities_and_transitions(api, cups_run):
    response = api.get('/internal/printers', headers=AUTH)
    assert response.status_code == 200
    document, receipt = response.json()['printers']
    assert (document['id'], document['state'], document['accepting']) == ('document', 'idle', True)
    assert document['capabilities'] == {'sides': ['one-sided', 'two-sided-long-edge'],
                                        'media': ['na_letter_8.5x11in', 'iso_a4_210x297mm'],
                                        'color': True, 'make_model': 'Example Inkjet'}
    assert receipt['id'] == 'receipt' and document['last_job'] is None
    calls = len([call for call in cups_run.calls if call[-1].endswith('capabilities.test')])
    api.get('/internal/printers', headers=AUTH)
    assert len([call for call in cups_run.calls if call[-1].endswith('capabilities.test')]) == calls  # cached
    cups_run.lpstat_p = 'printer epson disabled since today'
    api.get('/internal/printers', headers=AUTH)
    assert [row['state'] for row in job_history.printer_history('document')] == ['idle', 'stopped']


def test_receipt_omitted_when_unconfigured(api, cups_run, monkeypatch):
    monkeypatch.delenv('PRINT_RECEIPT_QUEUE')
    assert [printer['id'] for printer in api.get('/internal/printers', headers=AUTH).json()['printers']] == ['document']
    assert api.get('/internal/printers/receipt', headers=AUTH).status_code == 404


def test_printer_detail(api, cups_run):
    job_id = job_history.begin('document', 2, 1, name='Done')
    job_history.finish(job_id, 'completed')
    detail = api.get('/internal/printers/document', headers=AUTH).json()['printer']
    assert detail['last_job']['id'] == job_id and detail['recent_jobs'][0]['name'] == 'Done'
    assert detail['queue'] == 'epson-9 active\nepson-8 completed'
    assert [row['state'] for row in detail['history']] == ['idle']
    assert api.get('/internal/printers/unknown', headers=AUTH).status_code == 404


def test_check_never_submits(api, cups_run, monkeypatch):
    result = api.post('/internal/printers/document/check', headers=AUTH).json()
    assert result['ok'] is True and result['printer'] == 'document'
    assert {check['id']: check['ok'] for check in result['checks']} == {
        'cups': True, 'queue': True, 'accepting': True, 'state': True, 'device': None}
    assert result['checks'][-1]['detail'] == 'Not configured'
    receipt = api.post('/internal/printers/receipt/check', headers=AUTH).json()
    assert receipt['checks'][-1]['detail'] == 'Raw queue; no device query'
    cups_run.lpstat_p = None
    missing = api.post('/internal/printers/document/check', headers=AUTH).json()
    assert missing['ok'] is False
    assert {check['id']: check['ok'] for check in missing['checks']}['queue'] is False
    cups_run.lpstat_p = 'printer epson is idle.'
    cups_run.accepting = False
    monkeypatch.setenv('PRINT_STATUS_URI', 'ipp://printer.invalid/ipp/print')
    refused = api.post('/internal/printers/document/check', headers=AUTH).json()
    assert {check['id']: check['ok'] for check in refused['checks']} == {
        'cups': True, 'queue': True, 'accepting': False, 'state': True, 'device': True}
    assert not any(call[0] in ('lp', 'cancel') for call in cups_run.calls)


def test_sampler_records_transitions(monkeypatch, cups_run):
    monkeypatch.setenv('PRINT_CORE_TOKEN', 'test-private-token')
    monkeypatch.setenv('PRINT_SAMPLE_SECONDS', '0.01')
    monkeypatch.delenv('PRINT_RECEIPT_QUEUE', raising=False)
    with TestClient(server.create_internal_app(), client=('127.0.0.1', 12345)):
        deadline = time.monotonic() + 5
        while not job_history.printer_history('document') and time.monotonic() < deadline:
            time.sleep(0.02)
    assert [row['state'] for row in job_history.printer_history('document')] == ['idle']
    assert {call[4] for call in cups_run.calls} == {'epson'}  # receipt skipped when unconfigured


def test_jobs_endpoint_filters(api, cups_run):
    for name in ('50% off', 'a_b', 'other'):
        job_history.begin('document', 1, 1, name=name)
    response = api.get('/internal/jobs', params={'q': '%', 'status': 'active', 'limit': '10'}, headers=AUTH)
    assert response.status_code == 200
    assert [job['name'] for job in response.json()['jobs']] == ['50% off'] and response.json()['total'] == 1
    page = api.get('/internal/jobs', params={'limit': '1', 'offset': '1'}, headers=AUTH).json()
    assert page['total'] == 3 and len(page['jobs']) == 1
    assert api.get('/internal/jobs', params={'status': 'finished'}, headers=AUTH).json()['total'] == 0
    for bad in ({'limit': '0'}, {'limit': '101'}, {'status': 'done'}, {'from': '2025-13-01'},
                {'q': 'x' * 101}, {'dry_run': 'yes'}, {'printer': 'other'}, {'offset': '-1'},
                {'from': '2025-02-02', 'to': '2025-02-01'}):
        result = api.get('/internal/jobs', params=bad, headers=AUTH)
        assert result.status_code == 400 and result.json() == {'error': 'Invalid job filters'}


def test_refresh_maps_aborted_reasons_and_vanished(api, cups_run):
    aborted = job_history.begin('document', 1, 1)
    job_history.finish(aborted, 'pending', 'epson-5')
    vanished = job_history.begin('document', 1, 1)
    job_history.finish(vanished, 'pending', 'epson-6')
    with job_history.connect() as db:
        db.execute('UPDATE jobs SET created_at=? WHERE id=?',
                   ((datetime.now(timezone.utc) - timedelta(hours=2)).isoformat(), vanished))
    cups_run.jobs = ipp({'job-id': 5, 'job-state': 8, 'job-state-reasons': ['job-canceled-at-device']})
    detail = api.get(f'/internal/jobs/{aborted}', headers=AUTH).json()['job']
    assert (detail['state'], detail['error']) == ('aborted', 'Cancelled at the printer.')
    assert [event['state'] for event in detail['events']] == ['pending', 'aborted']
    assert job_history.get(vanished)['state'] == 'unknown'
    assert job_history.get(vanished)['error'].startswith('CUPS lost track of this job')
    assert api.get('/internal/jobs/missing', headers=AUTH).status_code == 404


def test_kept_file_endpoint(api, cups_run):
    job_id = job_history.begin('document', 1, 1, keep=b'%PDF-kept', keep_type='application/pdf')
    response = api.get(f'/internal/jobs/{job_id}/file', headers=AUTH)
    assert response.status_code == 200 and response.content == b'%PDF-kept'
    assert response.headers['content-type'] == 'application/pdf'
    assert response.headers['cache-control'] == 'no-store'
    with job_history.connect() as db:
        db.execute("UPDATE jobs SET kept_until='2000-01-01T00:00:00+00:00' WHERE id=?", (job_id,))
    expired = api.get(f'/internal/jobs/{job_id}/file', headers=AUTH)
    assert expired.status_code == 404 and expired.json() == {'error': 'The kept copy has expired'}
    assert api.get('/internal/jobs/unknown/file', headers=AUTH).status_code == 404


def test_web_submit_records_name_and_keeps_original(api, monkeypatch):
    data = pdf_bytes(2, 'Embedded title')
    monkeypatch.setattr(server, '_submit_raw', Mock(return_value={'job_id': 'epson-4'}))
    response = api.post('/internal/jobs', headers=AUTH, files={'file': ('upload.pdf', data)},
                        data={'printer': 'document', 'dry_run': 'false', 'name': ' Report\x00.pdf ',
                              'page_range': '2', 'duplex': 'two-sided-long-edge'})
    job = response.json()['job']
    assert (job['name'], job['kind'], job['pages'], job['cups_id']) == ('Report.pdf', 'pdf', 1, 'epson-4')
    assert job['options']['sides'] == 'two-sided-long-edge' and job['options']['page_range'] == '2'
    assert api.get(f'/internal/jobs/{job["id"]}/file', headers=AUTH).content == data
    assert api.get(f'/internal/jobs/{job["id"]}', headers=AUTH).json()['job']['document_pages'] == 2
    untitled = api.post('/internal/jobs', headers=AUTH, files={'file': ('upload.pdf', data)},
                        data={'printer': 'document', 'dry_run': 'true'}).json()['job']
    assert untitled['name'] == 'Embedded title' and untitled['dry_run'] is True


def test_web_receipt_title(api, monkeypatch):
    response = api.post('/internal/jobs', headers=AUTH,
                        data={'printer': 'receipt', 'text': '- milk', 'title': 'Shop', 'dry_run': 'true'})
    job_id = response.json()['job']['id']
    detail = api.get(f'/internal/jobs/{job_id}', headers=AUTH).json()['job']
    assert (detail['name'], detail['receipt_text']) == ('Shop', '# Shop\n- milk')
    assert api.get(f'/internal/jobs/{job_id}/file', headers=AUTH).headers['content-type'].startswith('text/plain')


def test_fetch_endpoint(api, monkeypatch):
    fetch = Mock(return_value=b'%PDF-linked')
    monkeypatch.setattr(server, 'fetch_pdf', fetch)
    response = api.post('/internal/fetch', headers=AUTH, data={'url': 'https://pdf.example/a.pdf'})
    assert response.status_code == 200 and response.content == b'%PDF-linked'
    assert response.headers['content-type'] == 'application/pdf' and response.headers['cache-control'] == 'no-store'
    assert fetch.call_args.args == ('https://pdf.example/a.pdf', server.MAX_PDF)
    fetch.return_value = b'%PDF-' + b'x' * server.MAX_PDF
    too_big = api.post('/internal/fetch', headers=AUTH, data={'url': 'https://pdf.example/a.pdf'})
    assert too_big.status_code == 413 and too_big.json() == {'error': 'Linked PDFs can be up to 10 MiB here'}
    fetch.side_effect = server.DownloadTooLarge('PDF exceeds download size limit')
    assert api.post('/internal/fetch', headers=AUTH, data={'url': 'https://pdf.example/a.pdf'}).status_code == 413
    fetch.side_effect = ValueError('PDF URL must use HTTPS')
    refused = api.post('/internal/fetch', headers=AUTH, files={'url': (None, 'http://pdf.example/a.pdf')})
    assert refused.status_code == 400 and refused.json() == {'error': 'PDF URL must use HTTPS'}
    assert api.post('/internal/fetch', headers=AUTH, data={}).status_code == 400
    assert api.post('/internal/fetch', headers=AUTH, data={'url': 'https://x/' + 'a' * 2048}).status_code == 400
    assert job_history.jobs() == []


def test_stats_endpoint(api, cups_run):
    job_history.begin('document', 2, 1)
    week = api.get('/internal/stats', params={'range': '7d'}, headers=AUTH).json()
    assert week['range'] == '7d' and week['totals']['jobs'] == 1 and week['previous'] is not None
    assert api.get('/internal/stats', headers=AUTH).json()['range'] == '30d'
    assert api.get('/internal/stats', params={'range': 'all'}, headers=AUTH).json()['previous'] is None
    assert api.get('/internal/stats', params={'range': '1y'}, headers=AUTH).status_code == 400


def test_cancel_unknown_is_404(api):
    assert api.post('/internal/jobs/missing/cancel', headers=AUTH).status_code == 404


def test_every_route_requires_token(api):
    for method, path in (('get', '/internal/printers'), ('get', '/internal/printers/document'),
                         ('post', '/internal/printers/document/check'), ('get', '/internal/jobs'),
                         ('get', '/internal/jobs/x'), ('get', '/internal/jobs/x/file'),
                         ('post', '/internal/fetch'), ('get', '/internal/stats')):
        assert getattr(api, method)(path).status_code == 401
