import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
// A URL's pathname is not a filesystem path: on Windows it keeps the leading slash, which Node
// resolves against the current drive root and turns into C:\C:\...
const helper = fileURLToPath(new URL("./migrate-windows-workspaces.mjs", import.meta.url));
// The helper refuses any host that is not Linux, because it rewrites the registry to POSIX paths
// in one direction and a Windows host would end up pointing at paths its own data cannot use.
// Spawning it anyway fails on that guard, so the suite states its own requirement instead.
const linuxHostOnly = { skip: process.platform !== "linux" };
const id = `default-${"a".repeat(32)}`;
const windowsRoot = "C:\\Users\\Owner\\.glassbox";

async function fixture(recordPath, kind = "default") {
  const root = await mkdtemp(path.join(tmpdir(), "glassbox-workspace-migration-"));
  await mkdir(path.join(root, "workspaces", id), { recursive: true });
  const registry = {
    version: 1,
    workspaces: {
      [id]: {
        id,
        label: "Default workspace",
        canonicalPath: recordPath,
        kind,
        ownerPrincipalId: "owner",
        grants: { owner: "write" },
        createdAt: "2026-01-01T00:00:00Z",
      },
    },
    selected: { owner: id },
  };
  const file = path.join(root, "workspace-registry.json");
  await writeFile(file, JSON.stringify(registry));
  return { root, registry, file };
}

test("moves only default paths and preserves the original registry", linuxHostOnly, async () => {
  const originalPath = path.win32.join(windowsRoot, "workspaces", id);
  const { root, registry, file } = await fixture(originalPath);
  try {
    await execFileAsync(process.execPath, [helper, root, windowsRoot]);
    const migrated = JSON.parse(await readFile(file, "utf8"));
    assert.equal(migrated.workspaces[id].canonicalPath, path.join(root, "workspaces", id));
    assert.deepEqual(migrated.workspaces[id].grants, registry.workspaces[id].grants);
    assert.deepEqual(migrated.selected, registry.selected);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, "workspace-registry.windows.json"), "utf8")),
      registry,
    );
    await execFileAsync(process.execPath, [helper, root, windowsRoot]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "rejects unexpected or registered paths without changing registry",
  linuxHostOnly,
  async () => {
    for (const [recordPath, kind] of [
      ["C:\\Users\\Owner\\other", "default"],
      [path.win32.join(windowsRoot, "workspaces", id), "registered"],
    ]) {
      const { root, registry, file } = await fixture(recordPath, kind);
      try {
        await assert.rejects(execFileAsync(process.execPath, [helper, root, windowsRoot]));
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), registry);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
