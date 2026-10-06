import { readFile, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildAgentReviewReceipt,
  reviewBindingSha256,
  verifyAgentReviewReceipt,
} from "./agent-review-receipt.mjs";
import {
  defaultAgentReviewStoreDirectory,
  readAgentReviewRecord,
  writeAgentReviewRecord,
} from "./agent-review-store.mjs";
import { fail } from "./core.mjs";

const runFile = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_REVIEW_ARTIFACT = 2 * 1024 * 1024;

function text(value, max = 2048) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function outside(path, root) {
  const difference = relative(resolve(root), resolve(path));
  return difference !== "" && difference !== ".." && !difference.startsWith(`..${sep}`);
}

async function git(cwd, args, options = {}) {
  try {
    return await runFile("git", args, { cwd, ...options });
  } catch {
    fail("AGENT_REVIEW_GIT", "The reviewed commit or diff cannot be rederived locally.");
  }
}

async function gitText(cwd, args) {
  return (await git(cwd, args)).stdout.trim();
}

function decodeBuffer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
  const decoded = buffer.toString("utf8");
  if (decoded.includes("\uFFFD"))
    fail("AGENT_REVIEW_GIT", "The reviewed file list is not valid UTF-8.");
  return { buffer, decoded };
}

/** Recompute the complete candidate binding from the current PR and committed Git objects. */
export async function deriveAgentReviewBinding({
  github,
  remote,
  cwd = repositoryRoot,
  candidateCommit = remote?.headCommit,
  baseCommit = remote?.baseCommit,
  allowMerged = false,
  expectedLocalCommit = candidateCommit,
}) {
  if (
    !github ||
    !remote ||
    (allowMerged ? remote.state !== "MERGED" : remote.state !== "OPEN") ||
    remote.repoIdentity == null ||
    !remote.pr?.number ||
    !text(remote.pullRequestUrl) ||
    !text(remote.authorLogin, 256) ||
    !COMMIT.test(candidateCommit ?? "") ||
    !COMMIT.test(baseCommit ?? "") ||
    remote.headCommit !== candidateCommit
  )
    fail(
      "AGENT_REVIEW_BINDING",
      "The PR state, base, or candidate commit does not match the review binding.",
    );

  const localHead = await gitText(cwd, ["rev-parse", "HEAD"]);
  const localTreeStatus = await gitText(cwd, ["status", "--porcelain"]);
  if (localHead !== expectedLocalCommit || localTreeStatus)
    fail("AGENT_REVIEW_BINDING", "The local checkout must be clean at the exact expected commit.");

  const candidateTree = await gitText(cwd, ["rev-parse", `${candidateCommit}^{tree}`]);
  if (!COMMIT.test(candidateTree)) fail("AGENT_REVIEW_BINDING", "Candidate tree SHA is invalid.");
  const [diffResult, pathsResult] = await Promise.all([
    git(cwd, ["diff", "--binary", "--full-index", "--no-ext-diff", baseCommit, candidateCommit], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    }),
    git(cwd, ["diff", "--name-only", "-z", "--no-renames", baseCommit, candidateCommit], {
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    }),
  ]);
  const { buffer: diff } = decodeBuffer(diffResult.stdout);
  const { decoded: rawPaths } = decodeBuffer(pathsResult.stdout);
  const changedPaths = [...new Set(rawPaths.split("\0").filter(Boolean))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (!changedPaths.length)
    fail("AGENT_REVIEW_BINDING", "The candidate diff has no changed paths.");
  const origin = await gitText(cwd, ["remote", "get-url", "origin"]);
  const repository = `https://github.com/${remote.repoIdentity}`;
  const originMatch =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      origin.trim(),
    );
  if (originMatch?.[1].toLowerCase() !== String(remote.repoIdentity).toLowerCase())
    fail("AGENT_REVIEW_BINDING", "The local origin and pull request repository differ.");

  const diffSha256 = (await import("node:crypto")).createHash("sha256").update(diff).digest("hex");
  return {
    repository,
    pullRequestNumber: remote.pr.number,
    pullRequestUrl: remote.pullRequestUrl,
    baseCommit,
    candidateCommit,
    candidateTree,
    diffSha256,
    changedPaths,
    pullRequestAuthorLogin: remote.authorLogin,
  };
}

function parseOptions(options) {
  const allowed = new Set(["pr", "artifact", "expectedReviewBindingSha256"]);
  if (
    !options ||
    typeof options !== "object" ||
    Object.keys(options).some((key) => !allowed.has(key)) ||
    !text(options.pr, 2048) ||
    (options.artifact !== undefined && !text(options.artifact, 4096)) ||
    (options.expectedReviewBindingSha256 !== undefined &&
      !SHA256.test(options.expectedReviewBindingSha256))
  )
    fail(
      "AGENT_REVIEW_ARGUMENT",
      "Record Agent Review accepts only a PR, artifact and binding hash.",
    );
}

/** Explicit host-operator action. Without the exact binding hash it only returns a preview. */
export async function recordAgentReviewCli(
  config,
  options,
  {
    cwd = repositoryRoot,
    homeDirectory = homedir(),
    githubFactory,
    now = () => new Date().toISOString(),
  } = {},
) {
  parseOptions(options);
  const github = githubFactory
    ? githubFactory(options.pr, cwd)
    : (await import("./github-delivery.mjs")).createGitHubDelivery({
        pullRequestUrl: options.pr,
        cwd,
      });
  const remote = await github.readRemote();
  if (config?.runtime?.expectedCommit && remote.headCommit !== config.runtime.expectedCommit)
    fail("AGENT_REVIEW_BINDING", "The PR head differs from the configured acceptance commit.");
  const binding = await deriveAgentReviewBinding({ github, remote, cwd });
  const expectedReviewBindingSha256 = reviewBindingSha256(binding);
  if (!options.artifact || !options.expectedReviewBindingSha256)
    return { status: "REVIEW_BINDING_READY", binding, expectedReviewBindingSha256 };
  if (options.expectedReviewBindingSha256 !== expectedReviewBindingSha256)
    fail(
      "AGENT_REVIEW_BINDING",
      "The expected review binding does not match the current PR and diff.",
    );

  const artifactPath = resolve(options.artifact);
  if (!outside(artifactPath, cwd))
    fail("AGENT_REVIEW_ARTIFACT", "Review artifact must be outside the checkout.");
  const originalInfo = await lstat(artifactPath);
  if (
    !originalInfo.isFile() ||
    originalInfo.isSymbolicLink() ||
    originalInfo.size > MAX_REVIEW_ARTIFACT
  )
    fail("AGENT_REVIEW_ARTIFACT", "Review artifact must be a bounded regular file.");
  const realArtifactPath = await realpath(artifactPath);
  if (!outside(realArtifactPath, cwd))
    fail("AGENT_REVIEW_ARTIFACT", "Review artifact must be outside the checkout.");
  const info = await lstat(realArtifactPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REVIEW_ARTIFACT)
    fail("AGENT_REVIEW_ARTIFACT", "Review artifact must be a bounded regular file.");
  const artifactBytes = await readFile(realArtifactPath);
  const receipt = buildAgentReviewReceipt({
    action: "record-agent-review",
    binding,
    artifactBytes,
    expectedReviewBindingSha256,
    hostOperatorIdentityAttested: true,
    recordedAt: now(),
  });
  const storeDirectory = defaultAgentReviewStoreDirectory(homeDirectory);
  const receiptPath = await writeAgentReviewRecord({
    directory: storeDirectory,
    repositoryRoot: cwd,
    receipt,
    artifactBytes,
  });
  return {
    status: "RECORDED",
    receiptSha256: receipt.receiptSha256,
    bindingSha256: receipt.bindingSha256,
    reviewerId: receipt.review.reviewerId,
    artifactSha256: receipt.artifact.sha256,
    receiptPath,
  };
}

/** Find and reverify a receipt for a currently derived binding. */
export async function readVerifiedAgentReview({
  binding,
  repositoryRoot: checkout = repositoryRoot,
  homeDirectory = homedir(),
}) {
  const bindingSha256 = reviewBindingSha256(binding);
  const stored = await readAgentReviewRecord({
    directory: defaultAgentReviewStoreDirectory(homeDirectory),
    repositoryRoot: checkout,
    bindingSha256,
  });
  if (!stored) return null;
  return verifyAgentReviewReceipt({
    receipt: stored.receipt,
    artifactBytes: stored.artifactBytes,
    expected: binding,
  });
}
