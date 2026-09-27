# Owner Pi sandbox

Original Owner sandbox Issue: [#23](https://github.com/lora-sys/Glassbox-Agent-Harness/issues/23). Herdr Worker closeout: [#24](https://github.com/lora-sys/Glassbox-Agent-Harness/issues/24).

## Current execution path

Glassbox resolves the QQ Principal and private scope before tool discovery. The
server creates a separate default workspace for each Owner. A trusted management
caller may register an existing project directory and grant another Owner read or
write access. QQ text and Pi tool arguments cannot register a host directory or
change a workspace grant. The selected workspace ID is stored by Principal.

For each Run, Glassbox checks both the workspace registry and the product
authorization decision before offering a Pi tool. It repeats both checks before
each call. A write capable Run takes the workspace write occupancy before it
opens a sandbox session. The occupancy is stored under the service data directory
and shared across server processes. It is released only after Kit confirms that
Docker removed the session container. An unconfirmed stop quarantines the
workspace. On restart, Glassbox keeps old leases quarantined until Kit confirms
the corresponding container has stopped.

Glassbox supplies Kit with the authorized canonical workspace path. Kit mounts
that directory into a Docker container and runs Pi's `read`, `grep`, `find`,
`ls`, `write`, `edit`, `bash`, and `powershell` implementations there. Pi sees the
isolated definitions with their native schemas and result blocks. The host Pi
session uses an explicit tool allowlist. Kit does not start another model session.
If the locked image, Docker daemon, or required tool is unavailable, Glassbox
withholds that tool. There is no host execution fallback.

The default container has no network, runs as a nonroot user, and receives only
the selected workspace bind mount. Kit also applies a read only root filesystem,
capability drop, process, memory, CPU, and lifetime limits. A Run that offers the
protected `browser` Tool requests Kit's `public_web` policy on that same session.
Kit places the container on an internal Docker network. A separate proxy
container resolves each target, rejects nonpublic addresses and nonweb ports,
and pins the approved address for the connection. The browser container has no
direct route to the Internet. The default network policy stays `none` for Runs
without the browser.

The proxy uses system DNS by default. Networks that return fake IP addresses
can explicitly set `GLASSBOX_SANDBOX_DNS_MODE=cloudflare_doh`. In that mode Kit
resolves through its fixed encrypted DNS endpoint, still rejects private and
special addresses, and pins the approved public address. An invalid mode or
failed resolution closes the request; it does not fall back to another resolver.

Browser-only Runs without an authorized project workspace receive a disposable,
read-only scratch mount. They do not receive Pi file or Shell Tools. The browser
CLI and authorized Owner file and Shell Tools reuse the same Kit session when a
Run has both. A screenshot is copied through the bounded Kit CLI result into a
private Glassbox Artifact store. Glassbox records its Run, Principal,
Conversation, workspace, and policy binding. Reading the Artifact checks the
current browser permission, a separate delivery grant, and the original Run
scope. The Owner management endpoint `GET /manage/browser-artifacts/:id`
returns the PNG as base64 JSON after those checks. The endpoint accepts only the
opaque Artifact ID. Glassbox resolves the Run and Principal from private Artifact
metadata and Raw Trace, then limits the delivered image to 2 MiB. A
network-enabled browser Run also records a durable sandbox stop lease.
After a service restart, Glassbox verifies the old Docker session stopped before
releasing that lease.

## Deployment

Build and smoke test the Kit image using the commands in the Kit README. Set
`LORA_PI_KIT_PATH` to the reviewed Kit checkout and
`GLASSBOX_SANDBOX_IMAGE` to the exact `sha256:...` image ID in that Kit's
`locks/sandbox-image.json`. Glassbox verifies the lock's image, Pi version, and
the built execution artifact hashes before loading the executor. The management
API reports availability at `GET /manage/sandbox`.

Authenticated management routes provide workspace registration, grant,
revocation, selection, and listing under `/manage/workspaces`. The registration
route accepts an absolute existing host directory from a trusted management
caller. The registry rejects known service, repository, Kit, credential, and
configuration roots. Default workspaces cannot be shared.

## Herdr Worker path in Issue 24

The Pi Worker retains the bounded `worker_read_file`, `worker_write_file`, and
`worker_list_files` tools. Its configured Herdr directory must exactly match a
registered product workspace that the caller can access. Glassbox checks both
the Worker file grant and product workspace grant, then writes an attempt
context outside the Worker directory. The Worker cannot choose a directory
through Tool arguments.
Before enabling delegation, register the configured `agent-operations.json`
`worktreePath` as a product workspace and grant the acting Owner write access.
An unregistered or protected host directory fails closed; the server does not
silently create a workspace grant for an existing Herdr path.

A write-capable attempt takes the same durable product-workspace occupancy as
the main Agent before Herdr starts it. A second Owner or main Run cannot take a
write lease on that workspace while the Worker retains write ability. Each
Worker Tool checks the active TaskAttempt, current file grant, and current
workspace grant. Writes also check the original lease. Separate workspaces
can run in parallel. Accept, Rework, and Cancel close the named Herdr pane and
verify its absence before releasing occupancy. Unconfirmed closure leaves the
lease quarantined. Restart quarantines prior leases, so old Worker processes
cannot reuse stale write permission. Recovery requires a trusted Herdr stop
check. Raw Task Trace records lease acquire, quarantine, and release.

This path does not load Kit `core/sandbox-tools` and offers no Shell Tool. A
future Shell or other write entry must join the same workspace contract before
it is exposed. Herdr and Glassbox must run on the same host for the current
Worker file extension and database-backed authorization check.

The controlled browser network and shared Run path were integrated under
Issue #20. Local Docker browser, Artifact, cancellation, and cleanup smoke
passed with the locked Kit image. Real QQ Owner delegation to a dedicated
Herdr workspace, including Review, Rework or Accept, revocation, and cleanup,
remains the Issue #24 acceptance gate. Linux full-stack migration belongs to
Issue #30.
