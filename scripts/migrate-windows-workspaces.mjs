#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const [dataRootInput, windowsDataRoot] = process.argv.slice(2);
if (process.platform !== "linux" || !dataRootInput || !windowsDataRoot) {
  console.error(
    "Usage on Linux: node scripts/migrate-windows-workspaces.mjs <linux-data-root> <windows-data-root>",
  );
  process.exit(2);
}

const dataRoot = await realpath(dataRootInput);
const registryFile = path.join(dataRoot, "workspace-registry.json");
const backupFile = path.join(dataRoot, "workspace-registry.windows.json");
const originalRegistry = await readFile(registryFile, "utf8");
const registry = JSON.parse(originalRegistry);
if (registry.version !== 1 || !registry.workspaces || !registry.selected) {
  throw new Error("Unsupported workspace registry");
}

const expectedWindowsRoot = path.win32.resolve(windowsDataRoot);
if (!path.win32.isAbsolute(expectedWindowsRoot) || !/^[A-Za-z]:\\/u.test(expectedWindowsRoot)) {
  throw new Error("An absolute Windows data root is required");
}

let migrated = 0;
for (const [id, record] of Object.entries(registry.workspaces)) {
  if (!/^default-[a-f0-9]{32}$/u.test(id) || record.id !== id || record.kind !== "default") {
    throw new Error("Registered or invalid workspaces need an explicit path mapping");
  }
  const target = path.join(dataRoot, "workspaces", id);
  if (!(await stat(target)).isDirectory() || (await realpath(target)) !== target) {
    throw new Error("Linux default workspace directory is missing or redirected");
  }
  if (record.canonicalPath === target) continue;
  const expectedWindowsPath = path.win32.join(expectedWindowsRoot, "workspaces", id);
  if (
    path.win32.normalize(record.canonicalPath).toLowerCase() !== expectedWindowsPath.toLowerCase()
  ) {
    throw new Error("Unexpected Windows workspace path");
  }
  record.canonicalPath = target;
  migrated++;
}

if (migrated === 0) {
  console.log("Workspace registry already uses Linux paths");
  process.exit(0);
}

await access(registryFile, constants.R_OK | constants.W_OK);
const backupHandle = await open(backupFile, "wx", 0o600);
try {
  await backupHandle.writeFile(originalRegistry);
  await backupHandle.sync();
} finally {
  await backupHandle.close();
}
const temporaryFile = path.join(dataRoot, `.workspace-registry-migration-${randomUUID()}.tmp`);
try {
  await writeFile(temporaryFile, JSON.stringify(registry), { flag: "wx", mode: 0o600 });
  const handle = await open(temporaryFile, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryFile, registryFile);
} finally {
  await unlink(temporaryFile).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
console.log(
  `Migrated ${migrated} default workspace paths; original registry saved beside the Linux copy`,
);
