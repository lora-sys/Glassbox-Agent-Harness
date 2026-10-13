import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceSourceIdentity, serviceSourceTreeSha256 } from "./service-source-identity.mjs";
import { sanitizedGitEnvironment } from "./git-environment.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: sanitizedGitEnvironment(),
  }).trim();
}

function fixture(t) {
  const checkout = mkdtempSync(join(tmpdir(), "service-source-identity-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Fixture");
  git(checkout, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(checkout, ".gitignore"), "ignored-secret.txt\n");
  writeFileSync(join(checkout, "tracked.mjs"), "export const value = 1;\n");
  git(checkout, "add", "--all");
  git(checkout, "commit", "-q", "-m", "fixture");
  return checkout;
}

// test-contract-change: ISSUE-194 verify symlink and executable-bit hashing when the host supports those filesystem features.
test("source tree digest includes tracked and unignored untracked sources, modes and symlink targets", (t) => {
  const checkout = fixture(t);
  writeFileSync(join(checkout, "ignored-secret.txt"), "excluded");
  const base = serviceSourceTreeSha256(checkout);
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(serviceSourceTreeSha256(checkout), base);

  writeFileSync(join(checkout, "new-source.mjs"), "export const extra = true;\n");
  const withUntracked = serviceSourceTreeSha256(checkout);
  assert.notEqual(withUntracked, base);

  mkdirSync(join(checkout, "assets"));
  writeFileSync(join(checkout, "assets", "payload"), "same");
  const withPayload = serviceSourceTreeSha256(checkout);
  let symlinkCreated = false;
  try {
    symlinkSync("payload", join(checkout, "assets", "link"));
    symlinkCreated = true;
  } catch (error) {
    assert.ok(["EACCES", "EPERM", "ENOTSUP", "UNKNOWN"].includes(error?.code));
  }
  const withLink = serviceSourceTreeSha256(checkout);
  assert.equal(withLink !== withPayload, symlinkCreated);
  if (symlinkCreated) {
    symlinkSync("missing", join(checkout, "assets", "other-link"));
    assert.notEqual(serviceSourceTreeSha256(checkout), withLink);
  }

  const modePath = join(checkout, "tracked.mjs");
  const beforeMode = statSync(modePath).mode & 0o111;
  const beforeModeHash = serviceSourceTreeSha256(checkout);
  chmodSync(modePath, 0o755);
  const afterMode = statSync(modePath).mode & 0o111;
  const afterModeHash = serviceSourceTreeSha256(checkout);
  assert.equal(afterModeHash !== beforeModeHash, afterMode !== beforeMode);
});

test("launch identity keeps clean commit evidence compatible and hashes dirty snapshots", (t) => {
  const checkout = fixture(t);
  const commit = git(checkout, "rev-parse", "HEAD");
  assert.deepEqual(serviceSourceIdentity(checkout), { launchCommit: commit, launchClean: true });

  writeFileSync(join(checkout, "tracked.mjs"), "export const value = 2;\n");
  const dirty = serviceSourceIdentity(checkout);
  assert.deepEqual(dirty, {
    launchCommit: commit,
    launchClean: false,
    launchSourceTreeSha256: serviceSourceTreeSha256(checkout),
  });

  assert.equal(serviceSourceIdentity(join(checkout, "missing-checkout")), undefined);
});

test("digest excludes ignored state and changes for tracked modifications", (t) => {
  const checkout = fixture(t);
  const first = serviceSourceTreeSha256(checkout);
  writeFileSync(join(checkout, "ignored-secret.txt"), "different ignored state");
  assert.equal(serviceSourceTreeSha256(checkout), first);
  writeFileSync(join(checkout, "tracked.mjs"), "export const value = 99;\n");
  assert.notEqual(serviceSourceTreeSha256(checkout), first);
});
