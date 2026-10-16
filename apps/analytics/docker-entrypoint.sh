#!/bin/sh
# analytics entrypoint — hook point for future schema setup (read models are
# owned by this service's migrations once they exist). The API still boots and
# reports /ready honestly if the database is unreachable.
set -e

exec "$@"
