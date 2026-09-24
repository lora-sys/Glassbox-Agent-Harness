# Owner Pi sandbox

Issue: [#23](https://github.com/lora-sys/Glassbox-Agent-Harness/issues/23)

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

## Remaining acceptance for issue 23

The durable occupancy is used by the main Agent's isolated tool sessions.
Herdr Worker launch still uses its existing task workspace and authorization
path. It has not been bound to the same product workspace ID and occupancy.
The existing Worker file tools remain active; Glassbox does not load Kit's new
sandbox extension on that path until the trusted workspace lease is joined.

Kit's local and Herdr profiles register isolated Pi tools. The controlled
browser network and shared Run path are integrated on the local Issue #20
branches. Local real Docker browser, Artifact, cancellation, and cleanup smoke
passed with the locked Kit image. Real QQ and Herdr acceptance remain required
before Issue #23 can be closed.
