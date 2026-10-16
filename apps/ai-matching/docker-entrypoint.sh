#!/bin/sh
# Apply DB migrations (best effort ??? the API still boots and reports /ready
# honestly if the database is unreachable), seed the skills taxonomy, then
# exec the real command (uvicorn for the api, celery for the worker).
set -e

if [ "${SKIP_MIGRATIONS:-0}" != "1" ]; then
    python -m alembic upgrade head || echo "WARNING: alembic upgrade failed; continuing"
    python -m app.seed_skills || echo "WARNING: skills seed failed; continuing"
fi

exec "$@"
