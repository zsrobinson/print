import io
from pathlib import Path
from unittest.mock import Mock

from PIL import Image
from starlette.testclient import TestClient
import job_history
import server


def client(monkeypatch):
    monkeypatch.setenv('PRINT_CORE_TOKEN', 'test-private-token')
    monkeypatch.setenv('PRINT_RECEIPT_QUEUE', 'thermal')
    return TestClient(server.create_internal_app(), client=('127.0.0.1', 12345))


def test_core_requires_separate_bearer(monkeypatch):
    with client(monkeypatch) as c:
        assert c.get('/internal/stats').status_code == 401
        assert c.get('/internal/stats', headers={'Authorization': 'Bearer test-private-token'}).status_code == 200


def test_image_original_bytes_and_history(monkeypatch):
    output = io.BytesIO()
    Image.new('RGB', (2, 2)).save(output, format='PNG')
    data = output.getvalue()
    def submit(*args):
        assert Path(args[-1]).read_bytes() == data
        return 'request id is epson-42 (1 file(s))'
    mock = Mock(side_effect=submit)
    monkeypatch.setattr(server, 'run', mock)
    with client(monkeypatch) as c:
        result = c.post('/internal/jobs', headers={'Authorization': 'Bearer test-private-token'},
                        files={'file': ('private-name.png', data)},
                        data={'printer': 'document', 'dry_run': 'false', 'copies': '2', 'name': 'private-name.png'})
    assert result.status_code == 200
    job = result.json()['job']
    assert (job['source'], job['pages'], job['copies']) == ('web', 1, 2)
    # Names are kept in the private ledger and returned only to the authenticated app.
    assert (job['name'], job['kind'], job['size_bytes'], job['reprintable']) == ('private-name.png', 'image', len(data), True)
    mock.assert_called_once()


def test_receipt_dry_run_no_cups(monkeypatch):
    monkeypatch.setattr(server, 'run', Mock(side_effect=AssertionError('No CUPS')))
    with client(monkeypatch) as c:
        response = c.post('/internal/jobs', headers={'Authorization': 'Bearer test-private-token'},
                          data={'printer': 'receipt', 'text': 'Private receipt text', 'dry_run': 'true'})
        assert response.status_code == 200
        stats = job_history.stats()
    # Dry runs are counted apart from real jobs.
    assert stats['totals'] == {'jobs': 0, 'pages': 0, 'failures': 0, 'dry_runs': 1}
    assert job_history.jobs()[0]['name'] == 'Private receipt text'


def test_failed_submission_recorded_at_submit(monkeypatch, tmp_path):
    path = tmp_path / 'doc'
    path.write_bytes(b'unchanged')
    monkeypatch.setattr(server, '_submit_raw', Mock(side_effect=RuntimeError('sensitive error')))
    try:
        server._submit_recorded(path, 1, 'one-sided', 'monochrome', None, 'Letter', pages=3)
    except RuntimeError:
        pass
    assert job_history.jobs()[0]['state'] == 'unknown'
    assert job_history.stats()['totals']['failures'] == 1


def test_private_routes_absent_from_mcp_listener(monkeypatch):
    monkeypatch.setenv('PRINT_CORE_TOKEN', 'test-private-token')
    with TestClient(server.create_app()) as c:
        assert c.get('/internal/stats', headers={'Authorization': 'Bearer test-private-token'}).status_code == 404


def test_nonloopback_core_peer_rejected(monkeypatch):
    monkeypatch.setenv('PRINT_CORE_TOKEN', 'test-private-token')
    with TestClient(server.create_internal_app(), client=('192.0.2.1', 12345)) as c:
        assert c.get('/internal/stats', headers={'Authorization': 'Bearer test-private-token'}).status_code == 401


def test_history_failure_after_submit_preserves_success(monkeypatch, tmp_path):
    from contextlib import contextmanager
    import sqlite3
    path = tmp_path / 'doc'
    path.write_bytes(b'original')
    @contextmanager
    def unavailable():
        raise sqlite3.OperationalError('private database detail')
        yield
    def submit(*args):
        monkeypatch.setattr(job_history, 'connect', unavailable)
        return {'job_id': 'epson-42'}
    monkeypatch.setattr(server, '_submit_raw', submit)
    result = server._submit_recorded(path, 1, 'one-sided', 'monochrome', None, 'Letter', pages=1)
    assert result['job_id'] == 'epson-42'
