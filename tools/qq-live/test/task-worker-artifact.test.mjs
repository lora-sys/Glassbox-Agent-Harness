import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, link, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectTaskWorkerArtifact } from "../lib/task-worker-artifact.mjs";

const NONCE = "ab".repeat(16);
const MARKER_NAME = ".qq-live-fixture.json";
const FILENAME = `qq-live-worker-${NONCE}.txt`;
const ERROR = {
  code: "TASK_WORKER_ARTIFACT_EVIDENCE",
  message: "Task worker artifact evidence is invalid.",
};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "qq-live-task-worker-artifact-"));
  const root = join(parent, "workspace");
  await mkdir(root);
  const markerBytes = Buffer.from(JSON.stringify({ fixtureNonce: NONCE, prepared: true }));
  const artifactBytes = Buffer.from(NONCE + "\n");
  await writeFile(join(root, MARKER_NAME), markerBytes);
  await writeFile(join(root, FILENAME), artifactBytes);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const canonicalRoot = await realpath(root);
  return {
    parent,
    root,
    canonicalRoot,
    markerBytes,
    artifactBytes,
    artifactPath: join(root, FILENAME),
    markerPath: join(root, MARKER_NAME),
    input: (overrides = {}) => ({
      fixtureNonce: NONCE,
      canonicalRoot,
      markerSha256: sha256(markerBytes),
      workerBindingPath: canonicalRoot,
      productWorkspacePath: canonicalRoot,
      ...overrides,
    }),
  };
}

async function rejects(input) {
  await assert.rejects(inspectTaskWorkerArtifact(input), ERROR);
}

test("accepts only the exact nonce artifact and returns a safe digest projection", async (t) => {
  const f = await fixture(t);
  const result = await inspectTaskWorkerArtifact(f.input());
  assert.deepEqual(result, {
    filename: FILENAME,
    sizeBytes: Buffer.byteLength(NONCE + "\n"),
    sha256: sha256(Buffer.from(NONCE + "\n")),
    fullContentVerified: true,
  });
  assert.equal(JSON.stringify(result).includes(f.canonicalRoot), false);
  assert.equal(JSON.stringify(result).includes(NONCE + "\n"), false);
  assert.deepEqual(Object.keys(result).sort(), [
    "filename",
    "fullContentVerified",
    "sha256",
    "sizeBytes",
  ]);
});

test("rejects marker mismatch, altered nonce content, and any extra root entry", async (t) => {
  {
    const f = await fixture(t);
    await rejects(f.input({ markerSha256: "0".repeat(64) }));
  }
  {
    const f = await fixture(t);
    await writeFile(f.markerPath, JSON.stringify({ fixtureNonce: NONCE, prepared: false }));
    await rejects(f.input());
  }
  {
    const f = await fixture(t);
    await writeFile(f.artifactPath, NONCE);
    await rejects(f.input());
  }
  {
    const f = await fixture(t);
    await writeFile(join(f.root, "extra.txt"), "extra");
    await rejects(f.input());
  }
});

test("requires both persisted workspace paths to be the canonical root", async (t) => {
  const f = await fixture(t);
  const alias = join(f.parent, "workspace-alias");
  await symlink(f.root, alias, "dir");
  await rejects(f.input({ workerBindingPath: alias }));
  await rejects(f.input({ productWorkspacePath: join(f.root, "child") }));
  await rejects(
    f.input({ canonicalRoot: alias, workerBindingPath: alias, productWorkspacePath: alias }),
  );
});

test("rejects symlink and multiply-linked marker or artifact files", async (t) => {
  {
    const f = await fixture(t);
    const outside = join(f.parent, "outside-artifact.txt");
    await writeFile(outside, f.artifactBytes);
    await rm(f.artifactPath);
    await symlink(outside, f.artifactPath);
    await rejects(f.input());
  }
  {
    const f = await fixture(t);
    await link(f.artifactPath, join(f.parent, "artifact-hardlink.txt"));
    await rejects(f.input());
  }
  {
    const f = await fixture(t);
    const outside = join(f.parent, "outside-marker.json");
    await writeFile(outside, f.markerBytes);
    await rm(f.markerPath);
    await symlink(outside, f.markerPath);
    await rejects(f.input());
  }
  {
    const f = await fixture(t);
    await link(f.markerPath, join(f.parent, "marker-hardlink.json"));
    await rejects(f.input());
  }
});
