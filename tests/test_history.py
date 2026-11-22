import base64
import io
import os
import sqlite3
import stat
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock

import pytest
from PIL import Image
from pypdf import PdfWriter

import job_history
import server


def pdf_bytes(pages=1, title=None):
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(612, 792)
    if title:
        writer.add_metadata({'/Title': title})
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def png_bytes():
    output = io.BytesIO()
    Image.new('RGB', (2, 2)).save(output, format='PNG')
    return output.getvalue()


def set_created(job_id, when):
    with job_history.connect() as db:
        db.execute('UPDATE jobs SET created_at=? WHERE id=?', (when.astimezone(timezone.utc).isoformat(), job_id))


@pytest.fixture
def accepted(monkeypatch):
    submit = Mock(return_value={'job_id': 'epson-7'})
    monkeypatch.setattr(server, '_submit_raw', submit)
    return submit


def test_old_schema_rows_stay_readable(tmp_path):
    db = sqlite3.connect(tmp_path / 'history.sqlite3')
    db.execute('''CREATE TABLE jobs (
        id TEXT PRIMARY KEY, cups_id TEXT, printer TEXT NOT NULL, source TEXT NOT NULL,
        state TEXT NOT NULL, pages INTEGER NOT NULL, copies INTEGER NOT NULL,
        created_at TEXT NOT NULL, dry_run INTEGER NOT NULL)''')
    db.execute("INSERT INTO jobs VALUES ('old1','epson-1','document','mcp','completed',2,1,'2025-01-02T03:04:05+00:00',0)")
    db.commit()
    db.close()
    [old] = job_history.jobs()
    assert (old['id'], old['state'], old['pages']) == ('old1', 'completed', 2)
    assert all(old[key] is None for key in ('name', 'kind', 'options', 'finished_at', 'size_bytes', 'error', 'kept_until'))
    assert old['reprintable'] is False
    assert job_history.detail('old1')['events'] == [] and job_history.detail('old1')['document_pages'] is None
    # New rows go in alongside the migrated ones.
    job_history.begin('document', 1, 1, name='New')
    assert [job['name'] for job in job_history.jobs()] == ['New', None]


def test_clean_name():
    assert job_history.clean_name(' a\x00b\t\n  c\u200b ') == 'ab c'
    assert job_history.clean_name('x' * 300) == 'x' * 120
    assert job_history.clean_name(' \n ') is None and job_history.clean_name(None) is None


def test_pdf_title_and_text_names(accepted):
    server.print_document(base64.b64encode(pdf_bytes(3, 'Quarterly report')).decode(), 'pdf', page_range='1-2')
    job = job_history.jobs()[0]
    assert (job['name'], job['kind'], job['pages']) == ('Quarterly report', 'pdf', 2)
    assert job_history.detail(job['id'])['document_pages'] == 3
    assert job['options'] == {'sides': 'one-sided', 'page_range': '1-2', 'color': 'monochrome', 'paper_size': 'Letter'}
    server.print_document(base64.b64encode(pdf_bytes()).decode(), 'pdf')
    assert job_history.jobs()[0]['name'] == 'Document'
    server.print_document('\n\n  ## Shopping list\nmilk', 'markdown')
    job = job_history.jobs()[0]
    assert (job['name'], job['kind'], job['reprintable']) == ('Shopping list', 'text', True)
    path, kept_type = job_history.kept_file(job['id'])
    assert kept_type == 'application/pdf' and path.read_bytes().startswith(b'%PDF-')


def test_url_names_drop_query(monkeypatch):
    monkeypatch.setattr(server, 'fetch_pdf', Mock(return_value=pdf_bytes(title='Ignored title')))
    server.print_url('https://pdf.example/papers/My%20Paper.pdf?token=capability-secret', dry_run=True)
    server.print_url('https://pdf.example/', dry_run=True)
    assert [job['name'] for job in job_history.jobs()] == ['pdf.example', 'My Paper.pdf']
    database = Path(os.environ['PRINT_HISTORY_DB'])
    assert b'capability-secret' not in database.read_bytes()


def test_upload_fallback_names_keep_original_bytes(tmp_path):
    image = tmp_path / 'image'
    image.write_bytes(png_bytes())
    server._print_file(image, 'image/png', None, 1, 'monochrome', 'one-sided', 'Letter', True)
    document = tmp_path / 'document'
    document.write_bytes(pdf_bytes())
    server._print_file(document, 'application/pdf', None, 1, 'monochrome', 'one-sided', 'Letter', True)
    pdf_job, image_job = job_history.jobs()
    assert (pdf_job['name'], image_job['name'], image_job['kind']) == ('Uploaded PDF', 'Uploaded image', 'image')
    path, kept_type = job_history.kept_file(image_job['id'])
    assert kept_type == 'image/png' and path.read_bytes() == png_bytes()


def test_receipt_names_and_kept_text(monkeypatch, cups):
    monkeypatch.setenv('PRINT_RECEIPT_QUEUE', 'thermal')
    server.print_receipt('- [ ] **Milk**\n- eggs', dry_run=True)
    server.print_receipt('body', title='Groceries', dry_run=True)
    server.print_receipt('\n# Weekly plan\n', dry_run=True)
    titled, plain = job_history.jobs()[1], job_history.jobs()[2]
    assert [job['name'] for job in job_history.jobs()] == ['Weekly plan', 'Groceries', 'Milk']
    assert job_history.detail(titled['id'])['receipt_text'] == '# Groceries\nbody'
    assert job_history.detail(plain['id'])['receipt_text'] == '- [ ] **Milk**\n- eggs'
    assert titled['kind'] == 'receipt' and titled['options'] is None
    cups.assert_not_called()


def test_events_and_finished_at():
    job_id = job_history.begin('document', 1, 1)
    job_history.finish(job_id, 'pending', 'epson-3')
    job_history.finish(job_id, 'processing')
    job_history.finish(job_id, 'processing')
    assert job_history.get(job_id)['finished_at'] is None
    job_history.finish(job_id, 'completed')
    detail = job_history.detail(job_id)
    assert [event['state'] for event in detail['events']] == ['pending', 'processing', 'completed']
    assert detail['cups_id'] == 'epson-3' and detail['finished_at'] == detail['events'][-1]['at']


@pytest.mark.parametrize('exc,message', [
    (TimeoutError('x'), server.TIMEOUT_ERROR),
    (RuntimeError('CUPS command failed: lp: The printer or class does not exist.'), 'The printer queue does not exist in CUPS.'),
    (RuntimeError('CUPS command failed: lp: Destination "epson" is not accepting jobs.'), 'The printer is not accepting jobs.'),
    (RuntimeError('CUPS command failed: secret stderr detail'), 'CUPS refused the job.'),
    (RuntimeError('Submission outcome unknown; inspect list_jobs before retrying.'), server.UNCONFIRMED_ERROR),
])
def test_submission_errors_are_plain(monkeypatch, tmp_path, exc, message):
    monkeypatch.setattr(server, '_submit_raw', Mock(side_effect=exc))
    path = tmp_path / 'doc'
    path.write_bytes(b'%PDF-')
    with pytest.raises(type(exc)):
        server._submit_recorded(path, 1, 'one-sided', 'monochrome', None, 'Letter', pages=1)
    job = job_history.jobs()[0]
    assert (job['state'], job['error']) == ('unknown', message)
    assert job['finished_at'] is not None


def test_names_never_logged(monkeypatch, caplog, capsys, tmp_path):
    import logging
    caplog.set_level(logging.DEBUG)
    name = 'SECRET-NAME-SENTINEL'
    monkeypatch.setenv('PRINT_KEEP_DIR', str(tmp_path / 'not-a-dir'))
    (tmp_path / 'not-a-dir').write_text('blocks the kept directory')  # Forces the keep warning path.
    monkeypatch.setattr(server, '_submit_raw', Mock(side_effect=RuntimeError(f'CUPS command failed: {name}')))
    with pytest.raises(RuntimeError):
        server.print_document(f'# {name}\nbody', 'markdown')
    monkeypatch.setattr(server, '_submit_raw', Mock(return_value={'job_id': 'epson-1'}))
    server.print_document(f'# {name}\nbody', 'markdown')
    assert 'Kept copy unavailable' in caplog.text
    logs = caplog.text + capsys.readouterr().err
    assert name not in logs
    assert job_history.jobs()[0]['name'] == name and job_history.jobs()[0]['reprintable'] is False
    assert name not in (job_history.jobs()[1]['error'] or '')


def test_kept_copy_permissions_and_expiry(tmp_path):
    job_id = job_history.begin('document', 1, 1, keep=b'%PDF-original', keep_type='application/pdf')
    directory = job_history.keep_dir()
    assert directory == tmp_path / 'kept'
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert stat.S_IMODE((directory / job_id).stat().st_mode) == 0o600
    assert job_history.get(job_id)['reprintable'] is True
    with job_history.connect() as db:
        db.execute('UPDATE jobs SET kept_until=? WHERE id=?', ('2000-01-01T00:00:00+00:00', job_id))
    assert job_history.get(job_id)['reprintable'] is False and job_history.kept_file(job_id) is None
    job_history.prune()
    assert not (directory / job_id).exists()


def test_prune_by_cap_oldest_first(monkeypatch):
    monkeypatch.setenv('PRINT_KEEP_MAX_BYTES', '25')
    ids = [job_history.begin('document', 1, 1, keep=b'x' * 10, keep_type='application/pdf') for _ in range(3)]
    present = [(job_history.keep_dir() / job_id).exists() for job_id in ids]
    assert present == [False, True, True]
    # Orphans that the ledger does not know about are removed too.
    (job_history.keep_dir() / ('f' * 32)).write_bytes(b'orphan')
    job_history.prune()
    assert not (job_history.keep_dir() / ('f' * 32)).exists()


def test_query_filters_and_pagination():
    names = ['100% done', 'a_b', 'axb', 'plain']
    ids = [job_history.begin('document', 1, 1, name=name) for name in names]
    job_history.finish(ids[0], 'completed')
    job_history.finish(ids[1], 'aborted')
    job_history.finish(ids[2], 'canceled')
    receipt = job_history.begin('receipt', 1, 1, True, name='dry receipt')
    job_history.finish(receipt, 'completed')
    old = job_history.begin('document', 1, 1, name='old')
    job_history.finish(old, 'unknown')
    set_created(old, datetime.now().astimezone() - timedelta(days=40))

    def names_for(**filters):
        return sorted(job['name'] for job in job_history.query(**filters)['jobs'])
    assert names_for(q='%') == ['100% done']
    assert names_for(q='_') == ['a_b']
    assert names_for(q='A_B') == ['a_b']
    assert names_for(status='active') == ['plain']
    assert names_for(status='failed') == ['a_b', 'old']
    assert names_for(status='canceled') == ['axb']
    assert names_for(status='completed') == ['100% done', 'dry receipt']
    assert names_for(status='finished') == ['100% done', 'a_b', 'axb', 'dry receipt', 'old']
    assert names_for(printer='receipt') == names_for(dry_run=True) == ['dry receipt']
    today = datetime.now().astimezone().date()
    assert 'old' not in names_for(start=today - timedelta(days=1), end=today)
    assert names_for(end=today - timedelta(days=30)) == ['old']
    page = job_history.query(limit=2, offset=2)
    assert page['total'] == 6 and len(page['jobs']) == 2
    assert [job['name'] for job in job_history.query(limit=1)['jobs']] == ['dry receipt']


def test_stats_ranges(monkeypatch):
    now = datetime.now().astimezone().replace(minute=0, second=0, microsecond=0)
    def job(days_ago, pages=1, copies=1, state='completed', dry=False, printer='document'):
        job_id = job_history.begin(printer, pages, copies, dry)
        job_history.finish(job_id, state)
        set_created(job_id, now - timedelta(days=days_ago))
        return job_id
    job(0, pages=3, copies=2)            # 6 sheets
    job(1, state='aborted')
    job(2, state='unknown', pages=30)
    job(0, dry=True)
    job(10)                               # previous 7d period
    job(100, pages=12)                    # only in 'all'
    week = job_history.stats('7d')
    assert week['totals'] == {'jobs': 3, 'pages': 37, 'failures': 2, 'dry_runs': 1}
    assert week['previous'] == {'jobs': 1, 'pages': 1, 'failures': 0}
    assert week['end'] == now.date().isoformat()
    assert week['start'] == (now.date() - timedelta(days=6)).isoformat()
    assert {row['bucket']: row['jobs'] for row in week['sizes']} == {'1': 1, '2–5': 0, '6–10': 1, '11–25': 0, '26+': 1}
    assert sum(row['jobs'] for row in week['hours']) == 3
    today = [row for row in week['hours'] if row['weekday'] == now.weekday() and row['hour'] == now.hour]
    assert today and today[0]['jobs'] >= 1
    assert all(row['printer'] == 'document' for row in week['daily'])
    everything = job_history.stats('all')
    assert everything['previous'] is None and everything['totals']['jobs'] == 5
    assert everything['start'] == (now - timedelta(days=100)).date().isoformat()
    assert everything['first_job'] is not None
    with pytest.raises(ValueError):
        job_history.stats('1y')


def test_stats_empty():
    result = job_history.stats('all')
    assert result['first_job'] is None and result['start'] == result['end'] and result['daily'] == []


def test_printer_state_transitions():
    assert job_history.record_printer_state('document', 'idle', [])
    assert not job_history.record_printer_state('document', 'idle', ['other'])
    assert job_history.record_printer_state('document', 'stopped', ['paused'])
    with job_history.connect() as db:
        db.execute("INSERT INTO printer_states VALUES ('document','offline','[]','2000-01-01T00:00:00+00:00')")
        db.execute("INSERT INTO printer_states VALUES ('document','busy','[]','2000-01-02T00:00:00+00:00')")
    history = job_history.printer_history('document')
    assert [(row['state'], row['reasons']) for row in history] == [('busy', []), ('idle', []), ('stopped', ['paused'])]
    assert job_history.printer_history('receipt') == []
