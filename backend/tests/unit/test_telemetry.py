"""Метрики Prometheus: запросы к API считаются по маршрутам, /metrics отдаёт текстовый формат."""

from fastapi.testclient import TestClient

from app.main import app


def test_metrics_endpoint_counts_requests_by_route():
    client = TestClient(app)
    assert client.get("/api/health").status_code == 200

    response = client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    body = response.text
    assert 'http_requests_total{method="GET",route="/api/health",status="200"}' in body
    assert 'http_request_duration_seconds_bucket{le="0.25",method="GET",route="/api/health"}' in body
    # метрики конвейера объявлены, даже пока обработчик ничего не выполнял
    for name in ("pipeline_jobs_total", "pipeline_steps_total", "external_calls_total", "decisions_total"):
        assert f"# HELP {name}" in body


def test_metrics_endpoint_is_not_counted_itself_and_unmatched_paths_are_grouped():
    client = TestClient(app)
    client.get("/api/no-such-path")
    body = client.get("/metrics").text
    assert 'route="unmatched",status="404"' in body
    assert 'route="/metrics"' not in body
