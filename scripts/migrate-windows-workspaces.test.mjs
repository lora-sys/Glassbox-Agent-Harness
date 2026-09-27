import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helper = new URL("./migrate-windows-workspaces.mjs", import.meta.url).pathname;
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

test("moves only default paths and preserves the original registry", async () => {
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

test("rejects unexpected or registered paths without changing registry", async () => {
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
});
