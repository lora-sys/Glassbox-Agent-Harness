#!/bin/sh

set -eu

: "${POSTGRES_SEEDS:?POSTGRES_SEEDS is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${SQL_PASSWORD:?SQL_PASSWORD is required}"

# Fresh databases only. This follows the official samples-server PostgreSQL
# setup order. For an existing database, apply versioned schema updates instead.
for database in temporal temporal_visibility; do
  temporal-sql-tool \
    --plugin postgres12 \
    --ep "$POSTGRES_SEEDS" \
    -u "$POSTGRES_USER" \
    -p "${DB_PORT:-5432}" \
    --db "$database" create
done

temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db temporal setup-schema -v 0.0
temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db temporal update-schema -d /etc/temporal/schema/postgresql/v12/temporal/versioned
temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db temporal_visibility setup-schema -v 0.0
temporal-sql-tool --plugin postgres12 --ep "$POSTGRES_SEEDS" -u "$POSTGRES_USER" -p "${DB_PORT:-5432}" --db temporal_visibility update-schema -d /etc/temporal/schema/postgresql/v12/visibility/versioned
