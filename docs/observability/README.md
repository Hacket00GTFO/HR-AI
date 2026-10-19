# StraforAI Observability Stack

This document describes the observability architecture, components, and
operational procedures for the StraforAI platform.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Application Services                     │
│  api · identity-auth · gateway · documents · ai-matching    │
│  notifications · analytics · web                             │
│  (each exposes /metrics, structured JSON logs, OTel traces) │
└──────────┬──────────┬──────────┬──────────┬─────────────────┘
           │          │          │          │
    ┌──────▼──┐ ┌─────▼───┐ ┌────▼────┐ ┌──▼──────────┐
    │Promtail │ │ OTel   │ │Prometheus│ │ Alertmanager │
    │ (logs)  │ │ (traces)│ │(metrics) │ │   (alerts)   │
    └────┬────┘ └────┬────┘ └────┬────┘ └──────┬──────┘
         │           │           │              │
    ┌────▼───┐ ┌─────▼───┐ ┌────▼────┐ ┌───────▼───────┐
    │  Loki  │ │  Tempo  │ │ Grafana │ │  API webhook  │
    │ (logs) │ │ (traces)│ │(visual) │ │ → alerts table │
    └────────┘ └─────────┘ └─────────┘ └───────────────┘
```

## Components

### Metrics — Prometheus

- **Port**: 9090 (dev), internal only (prod)
- **Retention**: 90 days
- **Scrape interval**: 15s
- **Recording rules**: `infra/observability/prometheus/rules/recording.yml`
- **Alert rules**: `infra/observability/prometheus/rules/alerts.yml`

Prometheus scrapes:

- All application services via Docker service discovery (compose) or
  Kubernetes pod discovery (K8s).
- cAdvisor for container metrics (CPU, memory, network, filesystem).
- node-exporter for host metrics (CPU, disk, network).
- PostgreSQL exporter, Redis exporter, RabbitMQ management API.
- Blackbox exporter for HTTP health probes.
- Celery exporter for AI matching task metrics.
- Grafana, Loki, Tempo, Alertmanager self-monitoring.

### Visualization — Grafana

- **Port**: 3300 (dev), not exposed in prod (accessed via BFF)
- **Auth**: Auth-proxy mode (X-WEBAUTH-USER header from Next.js BFF)
- **Dashboards**: 8 dashboards with fixed UIDs

| Dashboard           | UID                         | Purpose                            |
| ------------------- | --------------------------- | ---------------------------------- |
| Containers Overview | strafor-containers-overview | All containers at a glance         |
| Container Detail    | strafor-container-detail    | Single container deep dive         |
| Services RED        | strafor-services-red        | Rate, Errors, Duration per service |
| Platform Datastores | strafor-platform-datastores | PostgreSQL, Redis, RabbitMQ, MinIO |
| AI Matching         | strafor-ai-matching         | LLM usage, Celery tasks, scoring   |
| Logs Explorer       | strafor-logs-explorer       | Centralized log search             |
| Traces Explorer     | strafor-traces              | Distributed trace search           |
| Alerts Overview     | strafor-alerts-overview     | Active alerts summary              |

Grafana is **never exposed directly** in production. All access goes through
the Next.js BFF at `/api/grafana/*` which:

1. Validates the session cookie.
2. Verifies the user has the `admin` role via the API.
3. Injects `X-WEBAUTH-USER` and `X-WEBAUTH-NAME` headers.
4. Forwards to Grafana's internal URL.

### Logs — Loki + Promtail

- **Loki port**: 3100 (internal)
- **Promtail port**: 9080 (internal)
- **Retention**: 30 days
- **Storage**: filesystem (compose) / PVC (K8s)

Promtail collects JSON logs from all containers and ships them to Loki.
The log format is:

```json
{
    "level": "info",
    "time": "2025-01-15T12:00:00.000Z",
    "service": "api",
    "env": "production",
    "msg": "Request completed",
    "correlationId": "abc-123",
    "trace_id": "def-456",
    "span_id": "ghi-789",
    "method": "GET",
    "route": "/api/vacancies",
    "status": 200,
    "duration_ms": 45
}
```

Sensitive values are redacted by pino's redact paths before logging:

- `password`, `token`, `secret`, `authorization`, `auth`
- `apikey`, `api_key`, `jwt`, `session`
- Bearer tokens and email addresses are masked.

### Traces — Tempo + OpenTelemetry

- **Tempo port**: 3200 (HTTP), 4317 (OTLP gRPC), 4318 (OTLP HTTP)
- **Retention**: 14 days
- **Storage**: filesystem (compose) / PVC (K8s)

All Node.js services use `@opentelemetry/auto-instrumentations-node` which
auto-instruments:

- HTTP server and client
- PostgreSQL (pg)
- Redis (ioredis)
- Express, Fastify, Koa
- gRPC

The Python AI matching service uses `opentelemetry-instrumentation-fastapi`
and `opentelemetry-instrumentation-celery`.

Trace IDs are injected into logs by the shared logger in
`packages/node-common/logger.js`, enabling click-through from Loki logs to
Tempo traces in Grafana.

### Alerts — Alertmanager

- **Port**: 9093 (internal)
- **Storage**: 1Gi PVC

Alertmanager receives alerts from Prometheus and:

1. Sends emails via SMTP (`ALERT_SMTP_*` env vars).
2. Sends webhooks to `POST /api/admin/alerts/webhook` with
   `Authorization: Bearer ${ALERT_WEBHOOK_TOKEN}`.

The webhook stores alerts in the `alerts` table (migration 0023) and they
appear in:

- The admin Notifications Viewer.
- The admin Monitoring page (Alerts tab).
- The navigation badge (firing count).

## Configuration

### Environment Variables

See `.env.example` for all observability-related variables. Key ones:

| Variable                      | Default             | Purpose                               |
| ----------------------------- | ------------------- | ------------------------------------- |
| `METRICS_TOKEN`               | (none)              | Bearer token for `/metrics` endpoints |
| `ALERT_WEBHOOK_TOKEN`         | (none)              | Token for Alertmanager → API webhook  |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://tempo:4318` | OTLP receiver URL                     |
| `OTEL_SERVICE_NAME`           | (per service)       | Service name for traces               |
| `PROMETHEUS_RETENTION`        | `90d`               | TSDB retention                        |
| `GRAFANA_ADMIN_USER`          | `admin`             | Grafana admin username                |
| `GRAFANA_ADMIN_PASSWORD`      | (none)              | Grafana admin password                |
| `ALERT_SMTP_HOST`             | (none)              | SMTP server for alerts                |
| `ALERT_EMAIL_TO`              | (none)              | Alert email recipient                 |

### Docker Compose

The observability stack is defined in 13 compose fragments under
`infra/compose/observability/`:

| Fragment                | Service             |
| ----------------------- | ------------------- |
| `prometheus.yml`        | Prometheus          |
| `grafana.yml`           | Grafana             |
| `loki.yml`              | Loki                |
| `tempo.yml`             | Tempo               |
| `alertmanager.yml`      | Alertmanager        |
| `promtail.yml`          | Promtail            |
| `cadvisor.yml`          | cAdvisor            |
| `node-exporter.yml`     | node-exporter       |
| `postgres-exporter.yml` | PostgreSQL exporter |
| `redis-exporter.yml`    | Redis exporter      |
| `blackbox-exporter.yml` | Blackbox exporter   |
| `celery-exporter.yml`   | Celery exporter     |
| `rabbitmq-exporter.yml` | RabbitMQ exporter   |

All fragments are included in the main `docker-compose.yml` via `include:`.

For development with published ports:

```bash
docker compose -f docker-compose.yml \
  -f infra/compose/docker-compose.observability-dev.yml up -d
```

### Kubernetes

The K8s observability stack is in `infra/k8s/observability/` and can be
applied independently:

```bash
kubectl apply -k infra/k8s/observability/
```

## Security

### Metrics endpoint protection

All `/metrics` endpoints check for a bearer token when `METRICS_TOKEN` is
set. In production, set `METRICS_TOKEN` to a strong random value and
configure Prometheus to send it as `Authorization: Bearer <token>`.

### Grafana access control

Grafana is configured with:

- `disable_login_form = true` — no direct login.
- `auth.proxy.enabled = true` — trusts X-WEBAUTH-USER from the BFF.
- `allow_embedding = true` — allows iframe embedding in the admin panel.
- No published port in production — only accessible via the BFF.

### Log redaction

The pino logger redacts sensitive fields before serialization:

- Passwords, tokens, secrets, API keys, JWTs, sessions.
- Bearer tokens in Authorization headers.
- Email addresses are masked (e.g., `j***@example.com`).

### Alert webhook security

The Alertmanager webhook to the API includes:

- `Authorization: Bearer ${ALERT_WEBHOOK_TOKEN}` header.
- The API validates this token before accepting the webhook payload.
- The token is mounted from a file (not an env var) in the Alertmanager container.

## Cardinality Management

To prevent metric cardinality explosions:

1. HTTP metrics use bounded labels: `service`, `route` (normalized), `method`,
   `status_class` (not individual status codes).
2. Route normalization strips IDs: `/api/vacancies/123` → `/api/vacancies/:id`.
3. No user IDs or request IDs as metric labels.
4. Recording rules pre-aggregate high-cardinality metrics.
5. Prometheus `metric_relabel_configs` drops internal Go/process metrics.

## Testing

### Smoke test

```bash
./scripts/observability-smoke.sh
```

This verifies:

- All services are healthy.
- Prometheus targets are up.
- Alert rules are loaded.
- Grafana datasources and dashboards are provisioned.
- Application and container metrics are being collected.

### Prometheus rule validation

```bash
docker compose exec prometheus promtool check rules /etc/prometheus/rules/*.yml
```

### Prometheus config validation

```bash
docker compose exec prometheus promtool check config /etc/prometheus/prometheus.yml
```

## Runbooks

See `docs/observability/runbooks/` for alert-specific diagnosis and mitigation
procedures.
