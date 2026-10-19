# StraforAI on Kubernetes

Base manifests for the full platform, deployable with **kustomize**
(`kubectl apply -k`). This is a dev/local-grade base — production overlays
should add TLS, real storage classes, HPA/PDB, External Secrets and the
observability stack (Prometheus/Grafana/Loki/Tempo) per the plan's Phase 8.

## Topology

| Component               | Kind         | Service (ClusterIP unless noted) | Notes                                |
| ----------------------- | ------------ | -------------------------------- | ------------------------------------ |
| `strafor`               | Namespace    | —                                | everything lives here                |
| `strafor-db`            | StatefulSet  | headless :5432                   | pgvector/pg16, 10 Gi PVC             |
| `strafor-redis`         | Deployment   | :6379                            | cache, rate limit, jti blacklist     |
| `strafor-rabbitmq`      | Deployment   | :5672, mgmt :15672               | `domain.events` topic exchange       |
| `strafor-minio`         | Deployment   | :9000, console :9001             | S3 document store, 10 Gi PVC         |
| `strafor-mailpit`       | Deployment   | :1025, ui :8025                  | dev SMTP sink — drop in prod         |
| `api`                   | Deployment   | :3000                            | legacy monolith (dashboard/admin)    |
| `identity-auth`         | Deployment   | :3001                            | RS256 JWT + JWKS                     |
| `gateway`               | Deployment   | :8080 **LoadBalancer**           | JWT enforcement, routing, rate limit |
| `documents-resumes`     | Deployment   | :3004                            | resumes/documents → MinIO            |
| `ai-matching` (+worker) | 2×Deployment | :3005                            | FastAPI + Celery                     |
| `analytics`             | Deployment   | :3008                            | event-fed read models (skeleton)     |
| `notifications`         | Deployment   | :3007                            | templated email                      |
| `web`                   | Deployment   | :3010                            | Next.js frontend + BFF               |
| `strafor`               | Ingress      | `strafor.local`                  | `/` → web, `/api` → gateway          |

## Prerequisites

- A cluster with `kubectl` configured (Docker Desktop / kind / minikube all work)
- An nginx ingress controller for `ingress.yaml`
  (`kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml`
  — use the `kind` variant on kind)
- `envsubst` (GNU gettext) for the secrets template — on Windows use Git Bash
  or `wsl`, or apply secrets via `kubectl create secret` instead

## Build the images

Manifests reference `strafor/<app>:latest` with `imagePullPolicy:
IfNotPresent`. Build from the repo root so the workspace context resolves:

```sh
for app in api gateway identity-auth documents-resumes notifications analytics web; do
    docker build -f "apps/$app/Dockerfile" -t "strafor/$app:latest" .
done
docker build -f apps/ai-matching/Dockerfile -t strafor/ai-matching:latest apps/ai-matching
```

On kind: `kind load docker-image strafor/<app>:latest` per image.
On minikube: `eval $(minikube docker-env)` before building.

## Create the per-service databases

The single Postgres instance hosts one logical DB per service (same layout as
`infra/compose/initdb/01-create-service-dbs.sql`). After `strafor-db` is ready:

```sh
kubectl exec -n strafor strafor-db-0 -- psql -U strafor -d innovation -c "
CREATE DATABASE strafor_identity;
CREATE DATABASE strafor_documents;
CREATE DATABASE strafor_notifications;
CREATE DATABASE strafor_ai;
CREATE DATABASE strafor_analytics;
CREATE DATABASE strafor_recruitment;
"
```

## Deploy

```sh
# 1. Fill in the secrets template (values come from your root .env)
set -a && source .env && set +a
envsubst < infra/k8s/base/secrets.yaml | kubectl apply -f -

# 2. Everything else via kustomize
kubectl apply -k infra/k8s/base

# 3. Watch rollout
kubectl -n strafor rollout status deployment/gateway
kubectl -n strafor get pods
```

Service-to-service calls use in-cluster DNS (`http://identity-auth:3001`,
`amqp://strafor-rabbitmq:5672`, …) — all wired through `strafor-config` +
`strafor-secrets`, injected via `envFrom`. `DATABASE_URL`/`RABBITMQ_URL` are
composed per service with `$(VAR)` expansion so credentials never appear in
plain env literals.

## Verify

```sh
kubectl -n strafor port-forward svc/gateway 8080:8080
curl http://localhost:8080/health

kubectl -n strafor port-forward svc/web 3010:3010   # frontend
```

Add `strafor.local` to `/etc/hosts` (→ the ingress IP) to test the ingress.

## Notes & follow-ups (Phase 8 hardening)

- `secrets.yaml` is a template for local use. Real clusters should use
  External Secrets Operator or sealed-secrets — never commit filled values.
- Redis/RabbitMQ use `emptyDir` (dev-grade). Move to PVCs or operators
  (Bitnami/CloudNativePG/Cluster-operator) for durability.
- Add `HorizontalPodAutoscaler` + `PodDisruptionBudget` per stateless service,
  and `liveness ≠ readiness` is already honored (`/health` vs `/ready`).
- `recruitment-core` (port 3009) joins this layout when extracted — see
  `docs/extraction/recruitment-core.md`.
- Gateway is `LoadBalancer` for dev convenience; prod should front it with
  the ingress only (change to `ClusterIP` in the prod overlay).

## Observability Stack

The observability stack (Prometheus, Grafana, Loki, Tempo, Alertmanager,
Promtail, node-exporter) is deployed as a separate kustomize overlay:

```bash
kubectl apply -k infra/k8s/observability/
```

This creates a `strafor-observability` namespace with all observability
components. The application services in the `strafor` namespace are discovered
automatically via Kubernetes pod annotations.

### Prerequisites

1. The application services must have the following annotations to be scraped:

    ```yaml
    metadata:
        annotations:
            prometheus.io/scrape: 'true'
            prometheus.io/port: '3000'
            prometheus.io/path: '/metrics'
    ```

2. Grafana is accessed through the web BFF at `/api/grafana/*` with auth-proxy.
   Do NOT expose Grafana directly.

3. Alertmanager sends webhooks to `http://api.strafor.svc.cluster.local:3000/api/admin/alerts/webhook`.
   The webhook token must be configured as a Kubernetes secret.
