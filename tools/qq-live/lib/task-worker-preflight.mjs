import { constants } from "node:fs";
import { open, lstat, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fail } from "./core.mjs";

function invalid() {
  fail("TASK_WORKER_PREFLIGHT", "专用 Worker 目录或服务目标与受保护配置不一致。", "BLOCKED");
}
async function readStable(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 65536) invalid();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      bytes.length !== before.size ||
      [after, current].some(
        (s) =>
          !s.isFile() ||
          s.nlink !== 1 ||
          s.dev !== before.dev ||
          s.ino !== before.ino ||
          s.size !== before.size ||
          s.mtimeMs !== before.mtimeMs ||
          s.ctimeMs !== before.ctimeMs,
      )
    )
      invalid();
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Read-only preflight must complete before any Task or Worker is created. */
export async function verifyTaskWorkerPreflight({ dataDirectory, fixture }) {
  if (process.platform !== "linux" || !constants.O_NOFOLLOW) invalid();
  try {
    const root = await lstat(fixture.canonicalRoot);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (await realpath(fixture.canonicalRoot)) !== fixture.canonicalRoot
    )
      invalid();
    const names = await readdir(fixture.canonicalRoot);
    if (names.length !== 1 || names[0] !== ".qq-live-fixture.json") invalid();
    const marker = await readStable(join(fixture.canonicalRoot, ".qq-live-fixture.json"));
    if (createHash("sha256").update(marker).digest("hex") !== fixture.markerSha256) invalid();
    const provenance = JSON.parse(marker.toString("utf8"));
    if (
      provenance.schemaVersion !== 1 ||
      provenance.purpose !== "isolated-real-qq-worker-acceptance" ||
      provenance.retained !== true
    )
      invalid();
    const target = JSON.parse(
      (await readStable(join(dataDirectory, "agent-operations.json"))).toString("utf8"),
    );
    if (
      target.workspaceId !== fixture.workspaceId ||
      target.sessionId !== fixture.herdrSession ||
      target.agentKind !== fixture.agentKind ||
      target.worktreePath !== fixture.canonicalRoot
    )
      invalid();
    const afterRoot = await lstat(fixture.canonicalRoot);
    if (
      root.dev !== afterRoot.dev ||
      root.ino !== afterRoot.ino ||
      !afterRoot.isDirectory() ||
      afterRoot.isSymbolicLink()
    )
      invalid();
    return { targetVerified: true, markerSha256: fixture.markerSha256 };
  } catch {
    invalid();
  }
}
