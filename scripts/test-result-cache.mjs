import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CACHE_VERSION = 1;
const MAX_CACHED_RUNS = 20;
// Known test inputs. The full environment is also hashed so future test env vars miss safely.
const TEST_ENV_ALLOWLIST = [
  "CI",
  "CLAUDE_BINARY_PATH",
  "CODEX_BINARY_PATH",
  "CODEX_HOME",
  "GLASSBOX_DATA_DIR",
  "GLASSBOX_REPO_ROOT",
  "GLASSBOX_RUNTIME_DIR",
  "GLASSBOX_TEST_HERDR_SOCKET",
  "GLASSBOX_TEST_KIT_PATH",
  "GLASSBOX_WORKER_CONTEXT",
  "GLASSBOX_WORKER_SYSTEM_PROMPT",
  "GLASSBOX_WORKSPACE_CLAUDE",
  "GLASSBOX_WORKSPACE_CODEX",
  "GLASSBOX_WORKSPACE_DEMO",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LORA_PI_KIT_PATH",
  "NAPCAT_CHECKOUT",
  "NODE_ENV",
  "NODE_OPTIONS",
  "PORT",
  "SystemRoot",
  "TZ",
  "USERPROFILE",
  "VITEST_MAX_FORKS",
  "VITEST_MAX_THREADS",
];
const ENV_INPUT_FILES = [".env", ".env.local", ".env.test", ".env.test.local"];

function tryCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableHash(value) {
  return hash(JSON.stringify(value));
}

function snapshotFile(path) {
  const absolutePath = resolve(path);
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path, kind: "missing" };
    return null;
  }

  try {
    if (stat.isSymbolicLink()) {
      return {
        path,
        kind: "symlink",
        mode: stat.mode & 0o7777,
        target: readlinkSync(absolutePath),
      };
    }
    if (!stat.isFile()) return null;
    return {
      path,
      kind: "file",
      mode: stat.mode & 0o7777,
      content: hash(readFileSync(absolutePath)),
    };
  } catch {
    return null;
  }
}

function computeTestSnapshot() {
  const head = tryCapture("git", ["rev-parse", "HEAD"])?.trim();
  const indexTree = tryCapture("git", ["write-tree"])?.trim();
  const trackedAndUntracked = tryCapture("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const vitePlusVersion = tryCapture("vp", ["--version"]);
  const gitVersion = tryCapture("git", ["--version"]);
  const gitConfig = tryCapture("git", ["config", "--null", "--show-origin", "--list"]);
  const npmInstallLock = snapshotFile("node_modules/.package-lock.json");
  if (
    !head ||
    !indexTree ||
    trackedAndUntracked === null ||
    !vitePlusVersion ||
    !gitVersion ||
    gitConfig === null ||
    !npmInstallLock
  ) {
    return null;
  }

  const paths = new Set(trackedAndUntracked.split("\0").filter(Boolean));
  for (const path of ENV_INPUT_FILES) paths.add(path);
  paths.add("node_modules/.package-lock.json");
  const files = [...paths].sort((left, right) => left.localeCompare(right, "en")).map(snapshotFile);
  if (files.some((file) => file === null)) return null;

  const environment = Object.entries(process.env)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => [key, value ?? ""]);
  const knownEnvironment = TEST_ENV_ALLOWLIST.map((key) => [key, process.env[key] ?? null]);
  return {
    cwd: process.cwd(),
    head,
    indexTree,
    files,
    node: process.version,
    nodePath: process.execPath,
    platform: process.platform,
    arch: process.arch,
    vitePlusVersion: vitePlusVersion.trim(),
    gitVersion: gitVersion.trim(),
    gitConfigFingerprint: hash(gitConfig),
    knownEnvironment,
    environment,
  };
}

function createTestCacheKey(snapshot, scope) {
  return stableHash({ version: CACHE_VERSION, scope, snapshot });
}

function cachePath() {
  const gitPath = tryCapture("git", ["rev-parse", "--git-path", "codex-verify-test-cache.json"]);
  return gitPath?.trim() ? resolve(gitPath.trim()) : null;
}

function prepareTestCache(scope) {
  const path = cachePath();
  const snapshot = computeTestSnapshot();
  if (!path || !snapshot) return null;
  return { cachePath: path, key: createTestCacheKey(snapshot, scope), scope };
}

function isValidCache(cache) {
  return (
    cache?.version === CACHE_VERSION &&
    Array.isArray(cache.runs) &&
    cache.runs.every(
      (run) =>
        run !== null &&
        typeof run === "object" &&
        typeof run.key === "string" &&
        typeof run.scope === "string" &&
        run.status === "passed" &&
        typeof run.completedAt === "string",
    )
  );
}

function lookupTestCache(context) {
  let cache;
  try {
    cache = JSON.parse(readFileSync(context.cachePath, "utf8"));
  } catch (error) {
    return {
      hit: false,
      reason:
        error?.code === "ENOENT" ? "no successful run is cached" : "cache is unreadable or invalid",
    };
  }
  if (!isValidCache(cache)) {
    return { hit: false, reason: "cache schema is outdated or invalid" };
  }
  const match = cache.runs.find(
    (run) => run.key === context.key && run.scope === context.scope && run.status === "passed",
  );
  return match
    ? {
        hit: true,
        reason:
          "matching successful run is cached for this exact repository and environment fingerprint",
      }
    : {
        hit: false,
        reason: "no successful run matches this repository and environment fingerprint",
      };
}

function recordSuccessfulTestRun(context, result, snapshotAfterRun) {
  if (result.exitCode !== 0 || result.interrupted) return false;
  const currentSnapshot = snapshotAfterRun ?? computeTestSnapshot();
  if (!currentSnapshot || createTestCacheKey(currentSnapshot, context.scope) !== context.key)
    return false;

  let existing = { version: CACHE_VERSION, runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(context.cachePath, "utf8"));
    if (isValidCache(parsed)) existing = parsed;
  } catch {
    // A missing or invalid cache starts a fresh record after a successful run.
  }

  const record = {
    key: context.key,
    scope: context.scope,
    status: "passed",
    completedAt: new Date().toISOString(),
  };
  const runs = [
    record,
    ...existing.runs.filter((run) => run.key !== context.key || run.scope !== context.scope),
  ].slice(0, MAX_CACHED_RUNS);
  try {
    mkdirSync(dirname(context.cachePath), { recursive: true });
    const temporaryPath = `${context.cachePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify({ version: CACHE_VERSION, runs }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporaryPath, context.cachePath);
    return true;
  } catch {
    return false;
  }
}

export { createTestCacheKey, lookupTestCache, prepareTestCache, recordSuccessfulTestRun };
