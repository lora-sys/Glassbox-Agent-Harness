# Linux runtime migration

Issue: #30. This runbook records the migration from the existing Windows service to a Linux runtime. Keep the Windows service and its data available for rollback until the Linux QQ, Worker, browser, sandbox, and restart paths pass real acceptance.

## Availability limit

WSL runs on the Windows host. A Windows sleep, shutdown, or reboot interrupts the WSL services. Linux `systemd` can restart services when the distribution starts, but a `systemd` service does not keep the WSL distribution alive. On this host, the Windows scheduled task `Glassbox-WSL-Keepalive` starts `wsl.exe -d Ubuntu -u yanbingzhao -- /usr/bin/sleep infinity` at user logon and retries each minute when that process has exited. Its repeated trigger ignores new instances while the task is already running. After a controlled WSL termination, the task restarted Ubuntu and Docker and Herdr recovered. Check the task after a Windows login. Continuous service during host downtime requires an independent Linux host.

## Frozen baseline

Record actual versions and results again immediately before cutover. Do not infer a working QQ login from an open OneBot port.

| Component | Current migration baseline |
| --- | --- |
| Glassbox | Same commit on Windows and Linux, before cutover |
| Node.js | 24.21.0 Linux x64 |
| npm | 12.0.2 |
| Pi | 0.85.1, loaded through the pinned Kit |
| Lora PI Kit | Commit `5375a595e0521923ea87f4bbad08ce8732d4bd64` |
| NapCat | v4.18.28, identified by the SHA256 of the installed `napcat.mjs` and the official release asset |
| Herdr | 0.9.0 Linux x86_64 |
| agent-browser | 0.38.1 |
| Linux browser | Chrome for Testing 154.0.8037.57 |

The pinned Kit commit is reachable from `origin/codex/issue-30-linux-kit`. The Kit lock also contains `registry.npmmirror.com` URLs, so npm 12 requires that registry for `npm ci`. The configured sandbox image ID must be built for the target Docker host and checked against the Kit checkout's `locks/sandbox-image.json` before a sandbox smoke.

## WSL checkpoint on 2026-09-27

- Ubuntu 26.04.1 WSL2 has an independent Linux filesystem checkout at the same Glassbox commit as the Windows baseline.
- Linux Node and npm were installed from pinned versions. `npm ci` succeeded independently for Glassbox and Kit. Kit doctor passed.
- Glassbox `vp run verify:full` passed with 1482 unit tests passed and one existing live Herdr test skipped. Core checks and Web build passed.
- Glassbox started with disposable Linux data on a separate port. An unauthenticated management request returned 401. That instance was then stopped.
- A consistent Windows SQLite backup with schema version 11 passed `PRAGMA quick_check`. Its protected Linux copy has the same SHA256. It is a staging snapshot, not a cutover copy.
- Linux Herdr 0.9.0, `agent-browser` 0.38.1, Chrome for Testing, `rg`, and `fd` are installed. Chrome opened and read a public page. Ubuntu browser libraries are installed through apt. The pinned Linux NapCat image is in the Linux Docker daemon, and its Compose configuration parses. Linux NapCat remains stopped until QQ cutover.
- Two copied default workspaces passed an isolated path migration rehearsal. IDs, grants, and selection were retained. The Windows runtime and its original data remained active.
- Ubuntu now has a Linux Docker daemon. The v4.18.28 NapCat image was pulled into it by its platform digest. Kit sandbox image `sha256:23c20ebaeaf891f17c77a519af7f657ce869596b0144f537c62ca4c5ed858af2` was built in WSL and passed the real sandbox smoke. Kit commit `5375a595e0521923ea87f4bbad08ce8732d4bd64` records that image and the Linux smoke correction and is pushed to its remote branch.
- Linux Herdr has a durable session, socket, and Worker workspace. It and Docker recovered after an intentional WSL termination. WSL startup removed the user D-Bus socket, so this installation uses the system-level service templates in `deploy/linux/system` for service control.
- A fresh `ubuntu:26.04` container cloned the two pushed Issue #30 branches, installed Node 24.21.0 and npm 12.0.2 using `scripts/setup-linux-toolchain.sh`, and completed independent `npm ci` runs. Kit doctor passed. Glassbox `verify:full` passed with 1482 tests and one existing skipped live Herdr test. A disposable Glassbox data directory returned an authenticated `/manage/status` response with `status=ready` and `platform=linux`. The log is outside the repository at `~/.glassbox-migration/issue-30/clean-ubuntu-verify-full.log`. This clean user-space check used the WSL host's Docker socket and did not run a separate QQ bot, Herdr Worker, or full-stack rebuild acceptance.
- Native Linux Codex CLI 0.157.1 is installed, authenticated, and passed `codex doctor` with no failed checks. Native Claude Code 2.1.283 is installed but still needs its own WSL login.
- The Windows Glassbox, NapCat, and Herdr processes remain active. Real Linux QQ and Worker acceptance have not run.

## Prepare an independent Linux checkout

1. Clone Glassbox and Kit into the Linux filesystem, such as `~/src`. Do not run the Linux service from `/mnt/c` or copy Windows `node_modules` or native binaries.
2. Run `scripts/setup-linux-toolchain.sh` to install the locked Linux Node and npm versions. Put the reported `bin` directory first in the PATH used by builds and services. The script verifies the Node archive against the official `SHASUMS256.txt` before extracting it.
3. Install `git`, `rg`, `fd`, browser libraries, a Linux Docker backend, and Linux browser binaries. On Ubuntu, the `fd-find` package installs `fdfind`; provide an `fd` command for tool compatibility.
4. Run `npm ci` independently in Glassbox and the pinned Kit checkout. Run Kit doctor, `scripts/doctor-linux-runtime.sh`, and Glassbox `vp run verify:full` in Linux. Keep their results separate from Windows verification.
5. Prepare Linux Herdr, NapCat, QQ, browser, sandbox image, and protected service configuration. Pin exact releases or image digests. Use Linux paths and executables in the Linux service configuration.

For NapCat on Linux x86_64, `docs/napcat-linux.compose.yml` pins the v4.18.28 Docker image by its platform digest. Set `NAPCAT_UID`, `NAPCAT_GID`, and `NAPCAT_DATA_DIR` before using Compose. The data directory needs private `config` and `ntqq` directories. The copied OneBot WebSocket server configuration must listen on `0.0.0.0` inside the container; Compose exposes ports 6700 and 6099 only on the Linux host loopback address. Validate the Compose file with `docker-compose -f docs/napcat-linux.compose.yml config --quiet` before cutover. Do not start the Linux bot while the Windows bot is active.

Do not place provider keys, QQ credentials, management tokens, or the live database in the repository. The Linux `service-launch.json` belongs in an access restricted data directory. Keep the Windows and Linux process registries separate.

Regenerate `service-launch.json` and `agent-operations.json` for Linux instead of copying their Windows paths. The existing operations file contains Windows paths with forward slashes, so searching only for backslashes misses them. Use the Linux Herdr session socket and a Linux Worker workspace. Preserve historical Task and Trace records as evidence of their original Windows execution.

This WSL installation uses the system-level template units in `deploy/linux/system`. They assume the service account has a `/home/<user>` home directory and the checkout locations shown in the unit files. Install them under `/etc/systemd/system`, then use instances such as `glassbox-herdr@yanbingzhao.service`. Enable the Herdr, NapCat, and Glassbox instances only at their corresponding cutover steps. Do not also enable the older user-level units in `deploy/linux`. The service account's `~/.config/glassbox/runtime.env` and `napcat.env` must be mode 600. The Herdr Worker agent directory needs its own copied Pi model credentials and `herdr integration install pi` with `PI_CODING_AGENT_DIR` pointing at that directory. Confirm the Herdr workspace ID and Unix socket before writing `agent-operations.json`. The Glassbox unit starts the server directly; do not also run `agent:up` against the Linux data directory.

## Bridge and cutover

1. Record Windows process identities, service versions, current database schema, live QQ result, and a consistent database backup. Identify the only active Glassbox consumer.
2. Stop the Windows Glassbox process before starting the Linux Glassbox consumer against transferred durable state. Never let Windows and Linux write the same SQLite file through `/mnt/c`.
   Copy the final stopped database and durable files into the Linux data directory. Exclude Windows `runtime`, `service-processes.json`, lock directories, and logs. Convert the copied default workspace paths with `node scripts/migrate-windows-workspaces.mjs <linux-data-root> <windows-data-root>`. This helper only accepts default workspaces whose original paths match their IDs under the Windows data root. It stops if a registered workspace needs a separately reviewed path mapping. Keep the original registry backup that it creates.
3. Keep Windows NapCat as the temporary QQ protocol endpoint. Connect Linux Glassbox through the configured OneBot contract and verify one Owner private message and one group activation with Run and delivery evidence.
4. Stop the Windows NapCat bot process. Start the pinned Linux NapCat and Linux QQ runtime using its own Linux profile. Verify account login, OneBot connection, private and group replies, and Trace provenance. Never leave both bot runtimes active.
5. Move the Herdr service and Worker workspace to Linux. Verify a disposable delegated Task through review and acceptance. Then verify Memory and retrieval, protected QQ tools, Web, Pi basic tools, browser, sandbox, and restart recovery.
6. Stop remaining Windows project runtime processes. Confirm the Linux runtime works without a Windows executable or project process. The Windows host still needs to be awake while WSL runs.

If the Linux path fails before it writes new durable state, stop the Linux consumer and restore the verified Windows service. After Linux has written state, check schema and current authority before any rollback. Never overwrite newer durable state with an old backup.

## Completion evidence

Keep distinct records for WSL parity, clean Linux rebuild, and real Linux full stack smoke. Deterministic tests and a reachable port do not prove QQ login, delivery, Worker acceptance, sandbox isolation, or recovery after host restart. Record each acceptance as passed, failed, or untested with the runtime, checkout, and timestamp that produced the evidence.

## Read-only startup checks and explicit environment

The Linux unit templates run `scripts/linux-runtime-preflight.mts` before starting the server.
Start from `deploy/linux/runtime.env.example` and set explicit `GLASSBOX_DATA_DIR`, `PORT`,
`LORA_PI_KIT_PATH`, and `PI_CODING_AGENT_DIR` in the private runtime.env. Use real absolute
Linux paths; systemd does not expand shell variables. Keep the same GLASSBOX_DATA_DIR and PORT
in the shell used for the management CLI. The direct server historically defaults to checkout/.glassbox,
while the service launcher and CLI default to HOME/.glassbox; those defaults remain unchanged.
Do not put GLASSBOX_DATA_DIR in service-launch.json: the launcher resolves its data directory from
its own environment before loading that file. Export it before invoking any npm service command.
The direct systemd entry does not read service-launch.json. Do not run both service managers.

With the intended environment loaded, run `node --import tsx scripts/linux-runtime-preflight.mts`
from the checkout for an offline check. It requires the configured Kit and main Pi directories,
allows a missing data directory for a new install, and validates existing workspace metadata and
paths without creating directories, lock files, or changing data. It does not test credentials,
provider access, Temporal readiness, QQ, or Herdr. Temporal remains optional; when configured,
its address and namespace can also be passed through the npm launcher's environment allowlist.
Herdr Worker credentials still need separate acceptance. Optional Jev setup is not a migration gate.

Application startup validates workspace state before opening stores or migrating the database.
Malformed registries and unavailable or unconverted paths stop startup; map registered paths explicitly
and use the existing default-workspace migration helper only after reviewing a stopped copy.
The checkout switch rechecks the previous checkout's supported schema after candidate failure and
before rollback spawn. If the candidate upgraded beyond that version, rollback fails without replacing
new durable state with a backup. This guard is not a database downgrade or proof of full cutover.
