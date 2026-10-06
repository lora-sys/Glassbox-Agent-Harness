import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveAgentReviewBinding } from "../lib/agent-review-cli.mjs";

async function repositoryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agent-review-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture author",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture author",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    }).trim();
  git("init", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/project.git");
  await writeFile(join(root, "README.md"), "base\n");
  git("add", "README.md");
  git("commit", "-m", "base");
  const baseCommit = git("rev-parse", "HEAD");
  git("checkout", "-b", "review-candidate");
  await writeFile(join(root, "README.md"), "candidate\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "change.ts"), "export const value = 1;\n");
  git("add", "README.md", "src/change.ts");
  git("commit", "-m", "candidate");
  const candidateCommit = git("rev-parse", "HEAD");
  return { root, git, baseCommit, candidateCommit };
}

function remote(state, baseCommit, headCommit, mergeCommit = null) {
  return {
    repoIdentity: "example/project",
    authorLogin: "implementation-agent",
    pullRequestUrl: "https://github.com/example/project/pull/12",
    pr: { number: 12 },
    state,
    baseCommit,
    headCommit,
    mergeCommit,
  };
}

test("review binding hashes the exact committed diff and rejects a dirty checkout", async (t) => {
  const fixture = await repositoryFixture(t);
  const binding = await deriveAgentReviewBinding({
    github: {},
    remote: remote("OPEN", fixture.baseCommit, fixture.candidateCommit),
    cwd: fixture.root,
  });
  assert.equal(binding.baseCommit, fixture.baseCommit);
  assert.equal(binding.candidateCommit, fixture.candidateCommit);
  assert.equal(binding.pullRequestAuthorLogin, "implementation-agent");
  assert.deepEqual(binding.changedPaths, ["README.md", "src/change.ts"]);
  assert.match(binding.diffSha256, /^[a-f0-9]{64}$/);
  assert.match(binding.candidateTree, /^[a-f0-9]{40}$/);

  await writeFile(join(fixture.root, "README.md"), "dirty\n");
  await assert.rejects(
    deriveAgentReviewBinding({
      github: {},
      remote: remote("OPEN", fixture.baseCommit, fixture.candidateCommit),
      cwd: fixture.root,
    }),
    { code: "AGENT_REVIEW_BINDING" },
  );
});

test("post-merge review rederives the original candidate binding without replacing it with merge SHA", async (t) => {
  const fixture = await repositoryFixture(t);
  const beforeMerge = await deriveAgentReviewBinding({
    github: {},
    remote: remote("OPEN", fixture.baseCommit, fixture.candidateCommit),
    cwd: fixture.root,
  });
  fixture.git("checkout", "main");
  fixture.git("merge", "--squash", "review-candidate");
  fixture.git("commit", "-m", "squash merge");
  const mergeCommit = fixture.git("rev-parse", "HEAD");
  assert.notEqual(mergeCommit, fixture.candidateCommit);
  const current = remote("MERGED", fixture.baseCommit, fixture.candidateCommit, mergeCommit);
  const afterMerge = await deriveAgentReviewBinding({
    github: {},
    remote: current,
    cwd: fixture.root,
    candidateCommit: fixture.candidateCommit,
    baseCommit: fixture.baseCommit,
    allowMerged: true,
    expectedLocalCommit: mergeCommit,
  });
  assert.deepEqual(afterMerge, beforeMerge);
  assert.notEqual(afterMerge.candidateCommit, mergeCommit);
  assert.equal(fixture.git("rev-parse", `${mergeCommit}^1`), fixture.baseCommit);
});
