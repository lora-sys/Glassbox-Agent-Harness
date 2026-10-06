import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
  symlink,
  lstat,
  link as createHardLink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentReviewRecord, writeAgentReviewRecord } from "../lib/agent-review-store.mjs";

const bindingSha256 = "a".repeat(64);
const receipt = { action: "record-agent-review", bindingSha256 };
const artifactBytes = Buffer.from('{"review":"full diff"}\n');

test("stores one immutable private record with its original artifact outside the repository", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-review-store-"));
  const directory = join(temporaryRoot, "private-review-store");
  const repositoryRoot = join(temporaryRoot, "checkout");
  try {
    await mkdir(repositoryRoot);
    if (process.platform !== "linux") {
      await assert.rejects(
        writeAgentReviewRecord({ directory, repositoryRoot, receipt, artifactBytes }),
        { code: "AGENT_REVIEW_PLATFORM" },
      );
      await assert.rejects(readdir(directory), { code: "ENOENT" });
      return;
    }
    const path = await writeAgentReviewRecord({
      directory,
      repositoryRoot,
      receipt,
      artifactBytes,
    });
    const record = await readAgentReviewRecord({ directory, repositoryRoot, bindingSha256 });
    assert.equal(record.path, path);
    assert.deepEqual(record.receipt, receipt);
    assert.deepEqual(record.artifactBytes, artifactBytes);
    const directoryInfo = await lstat(directory);
    assert.equal(directoryInfo.mode & 0o077, 0);
    await assert.rejects(
      writeAgentReviewRecord({ directory, repositoryRoot, receipt, artifactBytes }),
      { code: "AGENT_REVIEW_EXISTS" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("refuses repository-local receipt storage and unreadable records", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-review-store-"));
  const repositoryRoot = join(temporaryRoot, "checkout");
  const insideRepository = join(repositoryRoot, ".reviews");
  try {
    await mkdir(repositoryRoot);
    await assert.rejects(
      writeAgentReviewRecord({
        directory: insideRepository,
        repositoryRoot,
        receipt,
        artifactBytes,
      }),
      { code: process.platform === "linux" ? "AGENT_REVIEW_STORE" : "AGENT_REVIEW_PLATFORM" },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("record path key is not influenced by receipt or artifact content", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-review-store-"));
  const directory = join(temporaryRoot, "private-review-store");
  const repositoryRoot = join(temporaryRoot, "checkout");
  try {
    await mkdir(repositoryRoot);
    await assert.rejects(
      writeAgentReviewRecord({
        directory,
        repositoryRoot,
        receipt: { action: "record-agent-review", bindingSha256: "../bad" },
        artifactBytes,
      }),
      { code: process.platform === "linux" ? "AGENT_REVIEW_STORE" : "AGENT_REVIEW_PLATFORM" },
    );
    assert.deepEqual(await readdir(directory).catch(() => []), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a symlinked store ancestor that resolves inside the repository", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-review-store-link-"));
  const repositoryRoot = join(temporaryRoot, "checkout");
  const privateParent = join(temporaryRoot, "private-parent");
  const directory = join(privateParent, "agent-reviews");
  try {
    await mkdir(join(repositoryRoot, "private-target"), { recursive: true });
    if (process.platform !== "linux") {
      await assert.rejects(
        writeAgentReviewRecord({ directory, repositoryRoot, receipt, artifactBytes }),
        { code: "AGENT_REVIEW_PLATFORM" },
      );
      return;
    }
    await symlink(join(repositoryRoot, "private-target"), privateParent, "dir");
    await assert.rejects(
      writeAgentReviewRecord({ directory, repositoryRoot, receipt, artifactBytes }),
      { code: "AGENT_REVIEW_STORE" },
    );
    await assert.rejects(readAgentReviewRecord({ directory, repositoryRoot, bindingSha256 }), {
      code: "AGENT_REVIEW_STORE",
    });
    assert.deepEqual(await readdir(join(repositoryRoot, "private-target")), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects directory replacement after opening and keeps writes on the original directory handle", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-review-store-race-"));
  const repositoryRoot = join(temporaryRoot, "checkout");
  const repositoryTarget = join(repositoryRoot, "target");
  const parent = join(temporaryRoot, "outside");
  const directory = join(parent, "store");
  const movedDirectory = join(parent, "opened-store");
  try {
    await mkdir(repositoryTarget, { recursive: true });
    await mkdir(directory, { recursive: true });
    if (process.platform !== "linux") {
      await assert.rejects(
        writeAgentReviewRecord({ directory, repositoryRoot, receipt, artifactBytes }),
        { code: "AGENT_REVIEW_PLATFORM" },
      );
      return;
    }
    let replaced = false;
    await assert.rejects(
      writeAgentReviewRecord({
        directory,
        repositoryRoot,
        receipt,
        artifactBytes,
        io: {
          async afterDirectoryOpen() {
            await rename(directory, movedDirectory);
            await symlink(repositoryTarget, directory, "dir");
            replaced = true;
          },
        },
      }),
      { code: "AGENT_REVIEW_STORE" },
    );
    assert.equal(replaced, true);
    assert.deepEqual(await readdir(repositoryTarget), []);
    assert.deepEqual(await readdir(movedDirectory), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("removes a published receipt through the opened directory if its path is replaced", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-review-store-publish-race-"));
  const repositoryRoot = join(temporaryRoot, "checkout");
  const repositoryTarget = join(repositoryRoot, "target");
  const parent = join(temporaryRoot, "outside");
  const directory = join(parent, "store");
  const movedDirectory = join(parent, "published-store");
  try {
    await mkdir(repositoryTarget, { recursive: true });
    await mkdir(directory, { recursive: true });
    if (process.platform !== "linux") {
      await assert.rejects(
        writeAgentReviewRecord({ directory, repositoryRoot, receipt, artifactBytes }),
        { code: "AGENT_REVIEW_PLATFORM" },
      );
      return;
    }
    let replaced = false;
    await assert.rejects(
      writeAgentReviewRecord({
        directory,
        repositoryRoot,
        receipt,
        artifactBytes,
        io: {
          async link(source, target) {
            await createHardLink(source, target);
            await rename(directory, movedDirectory);
            await symlink(repositoryTarget, directory, "dir");
            replaced = true;
          },
        },
      }),
      { code: "AGENT_REVIEW_STORE" },
    );
    assert.equal(replaced, true);
    assert.deepEqual(await readdir(repositoryTarget), []);
    assert.deepEqual(await readdir(movedDirectory), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
