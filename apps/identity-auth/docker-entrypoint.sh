#!/bin/sh
# migrate-then-start: apply pending migrations, then boot the service.
set -e
node scripts/migrate.js up
exec node dist/server.js
