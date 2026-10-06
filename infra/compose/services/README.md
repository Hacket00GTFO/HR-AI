# Service compose fragments

Each service owns ONE file here: `<service-name>.yml`, containing its full
compose service definition(s). The parent agent merges fragments into the
root `docker-compose.yml` during integration — **do not edit the root
compose file yourself** (it is shared and would collide across agents).

## Fragment format

```yaml
services:
    <service-name>:
        build:
            context: ../../.. # repo root
            dockerfile: apps/<service-name>/Dockerfile
        environment:
            PORT: <assigned port>
            DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/<db>
            # ...
        depends_on:
            db:
                condition: service_healthy
        healthcheck:
            test: ['CMD-SHELL', 'wget -qO- http://localhost:<port>/health || exit 1']
            interval: 10s
            timeout: 5s
            retries: 6
        ports:
            - '<assigned port>:<assigned port>'
        restart: unless-stopped
```

Rules: every service exposes `/health` (and `/ready` if it depends on db/broker);
non-root container user; no hardcoded secrets — env refs only; validate with
`docker compose -f infra/compose/services/<name>.yml config`.

## Port map (host = container)

| Service                 | Port | Database              |
| ----------------------- | ---- | --------------------- |
| api (legacy monolith)   | 3000 | innovation            |
| gateway                 | 8080 | —                     |
| identity-auth           | 3001 | strafor_identity      |
| vacancies               | 3002 | strafor_vacancies     |
| candidates-applications | 3003 | strafor_candidates    |
| documents-resumes       | 3004 | strafor_documents     |
| ai-matching             | 3005 | strafor_ai            |
| notifications           | 3007 | strafor_notifications |
| analytics               | 3008 | strafor_analytics     |
| recruitment-core        | 3009 | strafor_recruitment   |
| web (Next.js)           | 3010 | —                     |
| hr-core                 | 3010 | strafor_hr            |

> **Port conflict:** hr-core was assigned 3010 per the extraction spec, which
> collides with `web`. If both are deployed on the same host, renumber one —
> e.g. `PORT: 3011` + `'3011:3010'` in `hr-core.yml` and
> `HR_CORE_URL=http://hr-core:3010` (container port stays 3010).

## Platform (already defined in root docker-compose.yml)

| Service            | Host:Port           | Notes                                                     |
| ------------------ | ------------------- | --------------------------------------------------------- |
| db (pgvector/pg16) | 5432                | all DBs created by `infra/compose/initdb/`                |
| redis              | 6379                | cache, rate limit, token blacklist, Celery broker backend |
| rabbitmq           | 5672 (mgmt 15672)   | domain events — quorum queues                             |
| minio              | 9000 (console 9001) | S3-compatible document store                              |
| mailpit            | 1025 smtp / 8025 ui | dev SMTP sink                                             |

## Full topology (docker compose ps)

15 compose services total — 5 platform + 10 application:

| #   | Compose service    | Source                  | Depends on                       |
| --- | ------------------ | ----------------------- | -------------------------------- |
| 1   | db                 | root docker-compose.yml | —                                |
| 2   | redis              | root docker-compose.yml | —                                |
| 3   | rabbitmq           | root docker-compose.yml | —                                |
| 4   | minio              | root docker-compose.yml | —                                |
| 5   | mailpit            | root docker-compose.yml | —                                |
| 6   | api                | root docker-compose.yml | db                               |
| 7   | identity-auth      | identity-auth.yml       | db, redis, rabbitmq              |
| 8   | gateway            | gateway.yml             | api, identity-auth, redis        |
| 9   | documents-resumes  | documents-resumes.yml   | db, minio, rabbitmq              |
| 10  | notifications      | notifications.yml       | db, mailpit, rabbitmq            |
| 11  | ai-matching        | ai-matching.yml         | db, redis, rabbitmq              |
| 12  | ai-matching-worker | ai-matching.yml         | ai-matching, db, redis, rabbitmq |
| 13  | analytics          | analytics.yml           | db, rabbitmq                     |
| 14  | web                | web.yml                 | api                              |
| 15  | hr-core            | hr-core.yml             | db, rabbitmq                     |
| 16  | recruitment-core   | recruitment-core.yml    | db, rabbitmq                     |

`vacancies` (3002) and `candidates-applications` (3003) are reserved for the
final recruitment split — the intermediate `recruitment-core` (3009) is planned
in `docs/extraction/recruitment-core.md`. Kubernetes equivalents of this
topology live in `infra/k8s/base/`.

> **Operator note (existing deployments):** `infra/compose/initdb/` runs only
> on a _fresh_ `pgdata` volume. On an existing volume, create the new service
> database manually before starting the service:
> `docker compose exec db psql -U $POSTGRES_USER -c 'CREATE DATABASE strafor_recruitment;'`
> The service runs its own migrations on boot — no further schema setup needed.
>
> **Cutover:** recruitment traffic reaches `recruitment-core` only when the
> gateway env `RECRUITMENT_CORE_URL` is set (e.g. `http://recruitment-core:3009`).
> While unset, `/api/v1/{vacancies,candidates,applications,public,recruitment}`
> and `/api/v1/ai/process-feedback` fall back to the monolith (path rewritten
> `/api/v1/x → /api/x`), keeping the public URLs stable in both modes.
