# ADR 0001 — Observability stack: Prometheus + Grafana + Loki + Tempo + Alertmanager

**Status**: Accepted
**Date**: 2025-01-15
**Decision owner**: StraforAI platform team

## Context

StraforAI runs 14 containers (9 application services + 5 platform services) on
Docker Compose, with a Kubernetes base in `infra/k8s/base/`. Until now the only
observability was:

- Per-service `/health` and `/ready` HTTP probes.
- An admin "Service Health" dashboard (`/admin/health`) that polls those probes
  every 10 seconds and reports `healthy | degraded | down` + latency.
- Console logs (the monolith uses a custom redacting logger; the extracted
  services use `@strafor/node-common` pino JSON logger).

There is **no** time-series store, **no** metrics endpoint, **no** log
aggregation, **no** distributed tracing, and **no** alerting pipeline. When a
container restarts, runs out of memory, or slows down, the operator has to
`docker logs` each container by hand and has no history beyond the current
process lifetime.

The platform needs production-grade observability that:

1. Shows per-container CPU / memory / network / disk / restarts / OOM history.
2. Shows per-service RED metrics (rate, errors, duration) and domain metrics
   (auth, LLM cost, Celery, queues).
3. Correlates metrics → logs → traces (click a latency spike, see the logs and
   the trace that produced it).
4. Alerts the operator when a container is down, a service is erroring, a
   datastore is saturated, or the LLM budget is exceeded.
5. Is reachable from the admin panel without a second login, while remaining
   invisible to HR users.
6. Works on Docker Compose today and on Kubernetes tomorrow, with the same
   dashboards.

## Decision

Adopt the **Prometheus + Grafana + Loki + Tempo + Alertmanager** stack as the
single observability platform for StraforAI, deployed as 13 additional
containers (27 total) and provisioned declaratively.

### Why this stack

| Option                                                          | Verdict                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prometheus + Grafana + Loki + Tempo + Alertmanager** (chosen) | CNCF-native, single Grafana UI for metrics/logs/traces/alerts, low resource footprint on a single host, portable to K8s with the same dashboards, no per-node agent cost, strong correlation (exemplars, derived fields, trace-to-log). |
| ELK + APM (Elasticsearch + Kibana + APM Server)                 | Heavier (Elasticsearch JVM), logs-first (metrics/traces are second-class), licensing complexity, no native exemplar correlation.                                                                                                        |
| Datadog / New Relic (SaaS APM)                                  | Excellent UX but per-host + per-ingest pricing, external dependency, data leaves the cluster, no on-prem option.                                                                                                                        |
| OpenTelemetry Collector → Grafana Cloud                         | Same stack as chosen but hosted; rejected for the same SaaS reasons + network dependency in air-gapped dev.                                                                                                                             |
| InfluxDB + Telegraf + Grafana                                   | Metrics-only (logs/traces need separate stores), TICKscript is niche vs. PromQL.                                                                                                                                                        |

### Sub-decisions

1. **Metrics collection**: Prometheus with `docker_sd_configs` (compose) and
   `kubernetes_sd_configs` (K8s). cAdvisor for container metrics,
   node-exporter for host metrics, postgres-exporter / redis-exporter /
   RabbitMQ prometheus plugin / MinIO built-in metrics / celery-exporter for
   platform services. Application metrics via a `/metrics` endpoint on each
   service using `prom-client` (Node) and `prometheus-fastapi-instrumentator`
   (Python), protected by `METRICS_TOKEN`.

2. **Logs**: Loki (single-binary, filesystem storage) + Promtail
   (`docker_sd_configs`, JSON pipeline, `level` as the only high-cardinality
   label). The monolith migrates from its custom logger to the shared
   `@strafor/node-common` pino logger so all services emit the same JSON shape.

3. **Traces**: Tempo (OTLP receiver, local backend, metrics-generator
   emitting span-metrics + service-graph to Prometheus). OpenTelemetry
   auto-instrumentation in `@strafor/node-common/tracing.js` (Node) and
   `opentelemetry-instrumentation-*` (Python). Sampling 20% by default
   (`OTEL_TRACES_SAMPLER_ARG=0.2`); 100% sampling of errors is a future
   enhancement via an otel-collector tail-sampling processor.

4. **Dashboards**: Grafana with declarative provisioning (datasources +
   dashboards as code in `infra/observability/grafana/`). Eight dashboards,
   each with a stable `uid` so they can be embedded in the admin panel via
   `d-solo` iframes. The same JSON files are consumed by K8s via
   `configMapGenerator` — **one source of truth**.

5. **Grafana access**: Grafana is **never** published on a host port in the
   base compose file. It is reachable only from inside the Docker network.
   The Next.js BFF exposes `/api/grafana/*`, which:
    - Validates the `strafor_session` cookie server-side.
    - Calls `admin/monitoring/whoami` on the monolith to confirm `role=admin`.
    - Forwards the request to Grafana with `X-WEBAUTH-USER: <email>` and
      `X-WEBAUTH-NAME: <name>`.
    - Grafana runs with `auth_proxy` enabled, `disable_login_form=true`,
      `anonymous_enabled=false`.

    This reuses the existing RBAC (HR never reaches Grafana), avoids a second
    login, and keeps Grafana unreachable from the public network. A
    `docker-compose.observability-dev.yml` override publishes Grafana on
    `:3300` for break-glass access during development.

6. **Alerting**: Prometheus alerting rules → Alertmanager. Two receivers:
    - **email** via SMTP (Mailpit in dev, real SMTP in prod).
    - **webhook** to `POST /api/admin/alerts/webhook` on the monolith, which
      upserts the alert into an `alerts` table (keyed by Alertmanager
      `fingerprint`), surfaces it in the existing Notifications Viewer, and
      shows a badge in the admin navigation. The webhook is authenticated with
      `Authorization: Bearer ${ALERT_WEBHOOK_TOKEN}` (constant-time compare).

7. **Retention**: 90 days metrics / 30 days logs / 14 days traces, enforced
   via `--storage.tsdb.retention.time/size`, Loki `retention_period`, and
   Tempo `block_retention`. A `PrometheusTSDBLowDisk` alert guards the host
   disk. Retention is configurable via env for lower-end hardware.

8. **Service Health enrichment**: the existing `/admin/health` HTTP-poll
   dashboard is preserved (it works without Prometheus) and enriched with
   CPU/RAM sparklines fetched from Prometheus when available. If Prometheus
   is down, the sparklines simply do not render — no error shown.

## Consequences

### Positive

- One Grafana instance covers metrics, logs, traces, and alerts.
- Dashboards are portable between compose and K8s (recording rules normalize
  `container` / `service` labels across the two runtimes).
- No per-host SaaS cost; all data stays on the host / cluster.
- Admins see everything inside StraforAI; HR sees nothing of it.
- Alerting reaches the operator both by email and inside the product.

### Negative

- 13 more containers (~2-4 GB RAM total with 90d retention); mitigated by
  memory limits per service and a documented `observability-lite` profile.
- cAdvisor on Docker Desktop / WSL2 needs specific mounts and flags; if it
  fails, app-level `/metrics` + blackbox `probe_success` still cover status
  and RED (degraded but functional).
- Grafana auth-proxy requires Grafana to stay on the internal network; if it
  is ever published with `auth_proxy` enabled, an attacker could spoof
  `X-WEBAUTH-USER`. Documented as an invariant in the runbook.
- OpenTelemetry auto-instrumentation adds ~5-10% overhead; mitigated by 20%
  sampling and exclusion of `/health`, `/metrics`, `/ready`.

### Neutral

- PromQL becomes a required skill for the platform team.
- The monolith adopts `@strafor/node-common` (it was the only service not
  using it), which slightly changes its log format from custom to pino JSON.

## Alternatives considered

See the comparison table above. The key differentiator was the single-Grafana
UI for all three signals with native correlation (exemplars, trace-to-log,
service graph), combined with on-prem deployment and zero per-node licensing.

## References

- Plan: `C:\Users\Norbe\.devin\plans\plan-4c42e18ecc8a28db.md`
- Compose fragments: `infra/compose/observability/`
- K8s manifests: `infra/k8s/observability/`
- Runbooks: `docs/observability/runbooks/`
