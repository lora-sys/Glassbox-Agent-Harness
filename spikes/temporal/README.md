# P6.0 Temporal Linux spike

This spike ran on 2026-09-27 in disposable Linux containers. It exercises Temporal execution primitives only. The workflow input is a stable test ID. The code does not model Glassbox authorization, Task state, Herdr, or delivery.

## Pinned runtime

| Component | Pin | Observed |
| --- | --- | --- |
| Base image | `node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` | Node `v24.21.0`, Linux AMD64 |
| Temporal TypeScript packages | `@temporalio/{activity,client,worker,workflow}` `1.24.0` | Installed by `npm ci` from `package-lock.json` |
| Temporal CLI | `1.9.1`, release archive SHA-256 `09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5` | CLI reported `1.9.1` |
| Embedded Temporal Server | From CLI `1.9.1` | Server reported `1.32.0` |
| Persistence | `temporal server start-dev --db-filename /data/temporal.db` | SQLite file mounted at `./.state/temporal.db` |

The CLI archive checksum comes from the [Temporal CLI v1.9.1 release checksums](https://github.com/temporalio/cli/releases/tag/v1.9.1). The Dockerfile verifies it before extraction. `./.state` is local experiment data and is ignored by Git.

## Reproduce

Run these commands from this directory. Use a fresh workflow ID if retaining a previous `.state` directory.

```sh
docker compose build
docker compose up -d server worker
docker compose run --rm client start glassbox-p6-spike-node24
docker compose stop worker
docker compose exec -T server temporal workflow show -w glassbox-p6-spike-node24
```

The history should contain `TimerStarted` and, after eight seconds, `TimerFired` while the worker is stopped. Continue:

```sh
docker compose start worker
docker compose exec -T server temporal workflow show -w glassbox-p6-spike-node24
docker compose restart server
docker compose run --rm client describe glassbox-p6-spike-node24
docker compose run --rm client signal glassbox-p6-spike-node24
docker compose run --rm client wait glassbox-p6-spike-node24
docker compose run --rm client describe glassbox-p6-spike-node24
docker compose logs worker
```

The Activity deliberately fails on attempt 1 and succeeds on attempt 2. The parent then executes a child workflow and continues as new with the same workflow ID and a new run ID. Cancel a separate waiting workflow:

```sh
docker compose run --rm client cancel-start glassbox-p6-cancel-node24
docker compose run --rm client cancel glassbox-p6-cancel-node24
docker compose run --rm client describe glassbox-p6-cancel-node24
docker compose down
```

`docker compose down` removes only this spike's containers and network. It leaves the local SQLite evidence file intact.

## Observed result

| Check | Evidence | Result |
| --- | --- | --- |
| Start | Workflow `glassbox-p6-spike-node24` started with run `01a0e127-3f29-7e83-a137-913d0ce7433a` | Pass |
| Durable timer and worker restart | History events 5 and 6 are `TimerStarted` at 04:37:21 UTC and `TimerFired` at 04:37:29 UTC. Worker was stopped. The scheduled workflow task timed out, then the restarted worker completed it at event 11. | Pass |
| Server restart | `docker compose restart server` during signal wait. Subsequent describe returned the same workflow ID and run ID, `RUNNING`, history length 11. | Pass |
| Signal | `WorkflowExecutionSignaled` at history event 12 after server restart. | Pass |
| Activity retry | Worker log recorded attempt 1 failure and attempt 2 success. Final result contained `attempt: 2`. | Pass |
| Child workflow | Parent history recorded `StartChildWorkflowExecutionInitiated`, started, and completed at events 22, 23, and 27. Final child result was `child:glassbox-p6-spike-node24`. | Pass |
| Continue-as-new | First run ended with `WorkflowExecutionContinuedAsNew` at event 31. Final run `ccfaf288-a87e-45cc-91cb-31f5615d02e3` completed under the same workflow ID, with generation 1 and a new history length of 5. | Pass |
| Cancellation | `glassbox-p6-cancel-node24` had a one-hour timer. A cancel request changed it to `CANCELLED`, history length 11. | Pass |

The first Node 22 experiment used an incorrect Activity API call and failed after its signal. The code was corrected to `activityInfo()`, then all checks above passed on Node 24. The first failed run remains in the ignored local SQLite file as evidence.

## Adoption decision and limits

Adopt Temporal as the P6 orchestration engine for timers, waiting, signal delivery, Activity retries, child orchestration, cancellation, and continuation. The observed Node 24 and Server 1.32.0 combination has no blocker for these primitives. Bind Temporal workflow identity to the Glassbox Task or orchestration identity, but keep authorization, Task events, Step decisions, review, and acceptance in Glassbox. A Temporal Activity can retry, so protected actions need a current authorization check and side-effect idempotency or an explicit unknown-outcome path before enabling retries.

The exact verified deployment path is this pinned Linux image, CLI `start-dev`, SQLite file, and TypeScript SDK lockfile. `start-dev` is a local development server. This spike does not qualify it as a production deployment. Production deployment still needs a separately pinned Temporal Server setup with supported persistent storage, restart and backup tests, health checks, and the Issue #30 Linux gate. The [Temporal Helm chart](https://github.com/temporalio/helm-charts) is an official server deployment route and requires an external database. No Helm, PostgreSQL, Herdr, QQ, or Glassbox integration was tested here.
