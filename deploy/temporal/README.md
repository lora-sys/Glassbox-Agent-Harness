# Temporal Server on Linux

This Compose deployment runs the pinned Temporal Server and matching admin-tools images with PostgreSQL persistence. It is a single-node baseline for the Glassbox Linux deployment. It follows Temporal's official PostgreSQL Compose and self-hosted deployment guidance.

The frontend port defaults to host loopback at `127.0.0.1:7233`. If that host port is already occupied, set `TEMPORAL_HOST_PORT` in the local `.env` to another available loopback port. The server listens on `0.0.0.0` inside its container so Docker can reach it. PostgreSQL has no published host port. The named `temporal-postgres` volume keeps database state across container recreation. The Server mounts a production dynamic-configuration file with the documented maximum ID length override.

## Prepare credentials

Run these commands from `deploy/temporal` on the Linux host:

```sh
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `POSTGRES_PASSWORD` in `.env`. Compose rejects the blank value in the example. Keep `.env` on the host, outside source control, and restrict it with `chmod 600 .env`. Rotate credentials through an operational secret-management process, not by editing the tracked example.

## Initialize and start

Start PostgreSQL and wait for its health check:

```sh
docker compose up -d postgresql
docker compose ps
```

Initialize both Temporal databases and their versioned schemas once on a fresh volume:

```sh
docker compose run --rm --entrypoint /bin/sh temporal-admin-tools /scripts/init-postgres.sh
```

The script follows the official `samples-server` sequence for `temporal` and `temporal_visibility`. It creates databases, sets up schema version `0.0`, and applies the versioned PostgreSQL schemas. It is not a reset command. If a database already exists, use the matching release's schema update procedure instead of rerunning database creation.

Start the Server:

```sh
docker compose up -d temporal
docker compose ps
```

Create the Glassbox namespace explicitly after the Server is healthy:

```sh
docker compose run --rm --entrypoint temporal temporal-admin-tools \
  operator namespace create --address temporal:7233 --namespace glassbox --retention 365d
```

The namespace create command is a one-time operation. If it already exists, inspect it with `docker compose run --rm --entrypoint temporal temporal-admin-tools operator namespace describe --address temporal:7233 --namespace glassbox`.

Check server health and logs with `docker compose ps` and `docker compose logs temporal`. A Temporal SDK client on the same Linux host can connect to `127.0.0.1:7233`, or the `TEMPORAL_HOST_PORT` selected in `.env`, and use namespace `glassbox`.

Configure both the Glassbox Server and the independent long-work Worker with `GLASSBOX_TEMPORAL_ADDRESS=127.0.0.1:7233` and `GLASSBOX_TEMPORAL_NAMESPACE=glassbox`. Use the selected host port in the address if `TEMPORAL_HOST_PORT` differs from 7233. Run the Worker with `npm run long-work:worker -w @glassbox/server`. Both processes must use the same protected Glassbox data directory. Keep that directory and credentials outside this deployment folder, and do not run a second Glassbox service against the same data directory.

`long-work-worker.service` is a template for the independent Worker, not a ready-to-enable unit. Replace its `WorkingDirectory` and `ExecStart` paths with the checkout and absolute npm path confirmed on the target host. Set `EnvironmentFile` to the same runtime environment file used by the Server. That file must define the same `GLASSBOX_DATA_DIR`, `GLASSBOX_TEMPORAL_ADDRESS`, and `GLASSBOX_TEMPORAL_NAMESPACE` values for both processes. The Worker and Server checkout must use a compatible database schema. Grant the service account access to the shared data directory, Herdr socket, and assigned Worker workspaces. Install the unit only after the Server, PostgreSQL schema, and namespace are ready. The existing Issue #30 Server unit remains the Server manager.

## Back up and restore

Stop the Server to take a consistent dump of both databases. Store backups outside the repository and restrict the directory and files to the service operator:

```sh
umask 077
backup_dir="${GLASSBOX_BACKUP_DIR:-$HOME/glassbox-temporal-backups}"
install -d -m 700 "$backup_dir"
docker compose stop temporal
docker compose exec -T postgresql sh -ec 'pg_dump -U "$POSTGRES_USER" -Fc temporal' > "$backup_dir/temporal.dump"
docker compose exec -T postgresql sh -ec 'pg_dump -U "$POSTGRES_USER" -Fc temporal_visibility' > "$backup_dir/temporal-visibility.dump"
docker compose start temporal
```

Keep both dumps in protected backup storage. Restore them in a separate Compose project or onto a new, empty PostgreSQL data volume. Keep the original volume as rollback evidence. Start only PostgreSQL and wait for its health check before running these commands. Do not start Temporal until both restores succeed:

```sh
backup_dir="${GLASSBOX_BACKUP_DIR:-$HOME/glassbox-temporal-backups}"
docker compose exec -T postgresql sh -ec 'createdb -U "$POSTGRES_USER" temporal'
docker compose exec -T postgresql sh -ec 'createdb -U "$POSTGRES_USER" temporal_visibility'
docker compose exec -T postgresql sh -ec 'pg_restore -U "$POSTGRES_USER" -d temporal --no-owner' < "$backup_dir/temporal.dump"
docker compose exec -T postgresql sh -ec 'pg_restore -U "$POSTGRES_USER" -d temporal_visibility --no-owner' < "$backup_dir/temporal-visibility.dump"
docker compose up -d temporal
```

For production recovery, verify the dump in an isolated environment and follow the database provider's backup guidance. A named Docker volume alone is not a backup.

## Operational limits

- This Compose file provides one Temporal Server process and one PostgreSQL instance. It does not provide high availability, automated failover, or managed backup retention.
- The gRPC port is loopback-only and has no TLS or client authentication configured. For clients on other hosts, put authenticated TLS and firewall controls in place before exposing the endpoint.
- The Compose file pins multi-platform image digests as well as tags. The tested Server digest is `sha256:c3e752127759616bb1615e0f9ba0e21635aeb5fdeb922de4f371c350955f46ae`, admin-tools is `sha256:a9f84fb9a374b2374fe2e67c8efc0468ff3f1c66c8a0b14597ec86e349e62bca`, and PostgreSQL is `sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54`. The OCI indexes include `linux/amd64` and `linux/arm64`; startup and restore were exercised on `linux/amd64`. For upgrades, review the matching Temporal release's PostgreSQL schema changes, back up both databases, update Server and admin-tools to the same release and verified digests, and repeat isolated startup and restore checks before rollout.
- Do not replace `temporalio/server` with `temporalio/temporal` or a `start-dev` command. Temporal's self-hosted guide identifies the Server image for deployment; `start-dev` is for local development.

## Official references

- [Temporal self-hosted deployment guide](https://docs.temporal.io/self-hosted-guide/deployment)
- [Temporal samples-server PostgreSQL Compose](https://github.com/temporalio/samples-server/blob/main/compose/docker-compose-postgres.yml)
- [Temporal samples-server PostgreSQL schema setup](https://github.com/temporalio/samples-server/blob/main/compose/scripts/setup-postgres.sh)
- [Temporal Server Docker image configuration](https://github.com/temporalio/docker-builds/blob/main/docker-readme/server.md)
