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
    return TestClient(server.create_app())


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
                        data={'printer': 'document', 'dry_run': 'false', 'copies': '2'})
    assert result.status_code == 200
    job = result.json()['job']
    assert (job['source'], job['pages'], job['copies']) == ('web', 1, 2)
    assert 'private-name' not in str(job_history.jobs())
    mock.assert_called_once()


def test_receipt_dry_run_no_cups(monkeypatch):
    monkeypatch.setattr(server, 'run', Mock(side_effect=AssertionError('No CUPS')))
    with client(monkeypatch) as c:
        response = c.post('/internal/jobs', headers={'Authorization': 'Bearer test-private-token'},
                          data={'printer': 'receipt', 'text': 'Private receipt text', 'dry_run': 'true'})
        assert response.status_code == 200
        stats = job_history.stats()
    assert stats['totals'] == {'jobs': 1, 'pages': 1, 'failures': 0}
    assert 'Private receipt' not in str(job_history.jobs())


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
