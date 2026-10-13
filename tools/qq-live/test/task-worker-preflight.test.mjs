import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyTaskWorkerPreflight } from "../lib/task-worker-preflight.mjs";
test("preflight binds the dedicated marker and configured service target before execution", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "qq-worker-preflight-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const canonicalRoot = join(dataDirectory, "fixture");
  await mkdir(canonicalRoot);
  const marker = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      purpose: "isolated-real-qq-worker-acceptance",
      retained: true,
    }),
  );
  await writeFile(join(canonicalRoot, ".qq-live-fixture.json"), marker);
  const fixture = {
    canonicalRoot,
    markerSha256: createHash("sha256").update(marker).digest("hex"),
    workspaceId: "w2",
    herdrSession: "fixture",
    agentKind: "pi",
  };
  const target = {
    workspaceId: "w2",
    sessionId: "fixture",
    agentKind: "pi",
    worktreePath: canonicalRoot,
  };
  const path = join(dataDirectory, "agent-operations.json");
  await writeFile(path, JSON.stringify(target));
  assert.equal((await verifyTaskWorkerPreflight({ dataDirectory, fixture })).targetVerified, true);
  await writeFile(path, JSON.stringify({ ...target, worktreePath: "/other" }));
  await assert.rejects(verifyTaskWorkerPreflight({ dataDirectory, fixture }), {
    code: "TASK_WORKER_PREFLIGHT",
  });
  await rm(path);
  const linked = join(dataDirectory, "linked.json");
  await writeFile(linked, JSON.stringify(target));
  await symlink(linked, path);
  await assert.rejects(verifyTaskWorkerPreflight({ dataDirectory, fixture }), {
    code: "TASK_WORKER_PREFLIGHT",
  });
});
