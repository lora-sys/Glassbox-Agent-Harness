import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const failures = [];
const root = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const packageJson = readJson("package.json");
const lock = readJson("package-lock.json");
const lockRoot = lock.packages?.[""];

function fail(message) {
  failures.push(message);
}

function versionParts(value) {
  return value.split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

if (lock.lockfileVersion !== 3) fail("package-lock.json must use lockfileVersion 3.");
if (lockRoot?.name !== packageJson.name)
  fail("Root package name does not match package-lock.json.");
if (JSON.stringify(lockRoot?.workspaces) !== JSON.stringify(packageJson.workspaces)) {
  fail("Workspace declarations do not match package-lock.json.");
}
for (const field of ["dependencies", "devDependencies", "engines"]) {
  if (JSON.stringify(lockRoot?.[field] ?? {}) !== JSON.stringify(packageJson[field] ?? {})) {
    fail(`Root ${field} do not match package-lock.json.`);
  }
}

const packageManager = /^npm@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager ?? "");
if (!packageManager) {
  fail('package.json must pin packageManager in the form "npm@x.y.z".');
} else {
  const npmVersion = (
    process.env.npm_execpath
      ? execFileSync(process.execPath, [process.env.npm_execpath, "--version"], {
          encoding: "utf8",
        })
      : execFileSync("npm", ["--version"], { encoding: "utf8" })
  ).trim();
  if (npmVersion !== packageManager[1]) {
    fail(`npm ${packageManager[1]} is required by package.json, but npm ${npmVersion} is running.`);
  }
}

const minimumNode = /^>=(\d+\.\d+\.\d+)$/.exec(packageJson.engines?.node ?? "");
if (!minimumNode) {
  fail('package.json must declare a pinned minimum Node engine such as ">=24.12.0".');
} else if (compareVersions(process.versions.node, minimumNode[1]) < 0) {
  fail(`Node ${minimumNode[1]} or newer is required, but ${process.versions.node} is running.`);
}

const workspacePackageFiles = [];
for (const pattern of packageJson.workspaces ?? []) {
  const base = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
  for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packagePath = `${base}/${entry.name}/package.json`;
    try {
      const workspacePackage = readJson(packagePath);
      workspacePackageFiles.push(packagePath);
      if (!lock.packages?.[`${base}/${entry.name}`]) {
        fail(`${packagePath} is missing from package-lock.json.`);
      }
      if (!workspacePackage.name) fail(`${packagePath} must declare a package name.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
if (workspacePackageFiles.length === 0) fail("No workspace package manifests were found.");

const tanstackConfig = readJson("apps/web/tsr.config.json");
const lockedRouterVersion = lock.packages?.["node_modules/@tanstack/react-start"]?.version;
if (!lockedRouterVersion || tanstackConfig.targetVersion !== lockedRouterVersion) {
  fail("TanStack Router targetVersion must match the locked @tanstack/react-start version.");
}

const trackedPaths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .map((path) => path.replaceAll("\\", "/"));
const forbiddenTrackedPath =
  /(?:^|\/)(?:node_modules|dist|coverage|test-results|playwright-report|blob-report|\.glassbox|\.cache)(?:\/|$)|\.(?:db|sqlite|sqlite3)$/i;
const privateKeyPath = /\.(?:pem|p12|pfx|key|jks|keystore)$/i;
const envPath = /(?:^|\/)\.env(?:$|\.)/i;

for (const path of trackedPaths) {
  if (forbiddenTrackedPath.test(path))
    fail(`Generated, test, runtime, or database artifact is tracked: ${path}`);
  if (privateKeyPath.test(path)) fail(`Private-key material must not be tracked: ${path}`);
  if (envPath.test(path) && path !== ".env.example") {
    fail(`Environment files must not be tracked; only .env.example is allowed: ${path}`);
  }
}

const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
for (const requiredPattern of [
  "node_modules/",
  "dist/",
  "coverage/",
  ".glassbox/",
  "*.db",
  "*.sqlite",
  "*.sqlite3",
  ".env.*",
  "!.env.example",
]) {
  if (!gitignore.split(/\r?\n/).includes(requiredPattern)) {
    fail(`.gitignore must protect ${requiredPattern}.`);
  }
}

const schemaSource = readFileSync(join(root, "apps/server/src/persistence/schema.ts"), "utf8");
const databaseSource = readFileSync(join(root, "apps/server/src/persistence/database.ts"), "utf8");
const versionMatch = /export const CURRENT_SCHEMA_VERSION = (\d+);/.exec(schemaSource);
if (!versionMatch) {
  fail("schema.ts must declare CURRENT_SCHEMA_VERSION.");
} else {
  const currentVersion = Number(versionMatch[1]);
  // A migration is either a statement array or a function that needs to read the database first.
  // Both count as exported; naming only one of the two shapes is how a function-shaped migration
  // came to be invisible to this check.
  const exportedMigrations = new Set(
    [
      ...schemaSource.matchAll(/schemaV(\d+)Migration/g),
      ...schemaSource.matchAll(/applySchemaV(\d+)Migration/g),
    ].map((match) => Number(match[1])),
  );
  const appliedMigrations = new Set(
    [...databaseSource.matchAll(/version < (\d+)\)/g)].map((match) => Number(match[1])),
  );
  for (let version = 2; version <= currentVersion; version += 1) {
    if (!exportedMigrations.has(version)) fail(`Schema migration V${version} is not exported.`);
    if (!appliedMigrations.has(version)) fail(`Schema migration V${version} is not applied.`);
  }
  if (databaseSource.includes("version > CURRENT_SCHEMA_VERSION") === false) {
    fail("Database open must reject a schema newer than CURRENT_SCHEMA_VERSION.");
  }
  if (
    (databaseSource.match(/PRAGMA user_version = \$\{CURRENT_SCHEMA_VERSION\}/g) ?? []).length !== 2
  ) {
    fail("New and upgraded databases must both be set to CURRENT_SCHEMA_VERSION.");
  }
}

if (failures.length > 0) {
  console.error("Repository hygiene checks failed:");
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

console.log(
  `Repository hygiene checks passed for ${workspacePackageFiles.length} workspace packages.`,
);
