#!/bin/sh
set -eu

if [ -n "${DATABASE_TLS_CA_FILE:-}" ]; then
  # Capture the secret in the environment, never in argv or application logs.
  DATABASE_URL="$(node /app/scripts/database-tls-url.cjs)"
  export DATABASE_URL
fi

# Preserve PID 1 signal handling for both services and one-off migration commands.
exec "$@"
