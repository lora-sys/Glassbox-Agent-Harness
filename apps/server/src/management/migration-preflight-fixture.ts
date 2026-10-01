import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { ModelProfileStore } from "../config/model-profiles.js";
import { localDatabaseUrl } from "../persistence/database.js";
import {
  baseSchema,
  learningSchema,
  schemaV7Statements,
  schemaV8Migration,
} from "../persistence/schema.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { ManagementApplication } from "./application.js";

export const migrationPreflightFixtureScript = new URL(import.meta.url);
async function runFixture() {
  const [root, kind] = process.argv.slice(2);
  assert.ok(root);
  if (kind === "valid") {
    const dataRoot = join(root, "data");
    const project = join(root, "project");
    await mkdir(project);
    const registry = await WorkspaceRegistry.open({ dataRoot });
    const own = await registry.ensureDefault("owner");
    const imported = await registry.registerExistingTrusted({
      path: project,
      label: "Project",
      ownerPrincipalId: "owner",
    });
    await registry.grantTrusted(imported.id, "reader", "read");
    const before = await readFile(join(dataRoot, "workspace-registry.json"));
    await WorkspaceRegistry.preflight({ dataRoot });
    assert.deepEqual(await readFile(join(dataRoot, "workspace-registry.json")), before);
    const reopened = await WorkspaceRegistry.open({ dataRoot });
    assert.equal((await reopened.resolveSelected("owner", "write")).id, own.id);
    assert.equal((await reopened.resolveAuthorized("reader", imported.id, "read")).id, imported.id);
    const models = await ModelProfileStore.open(dataRoot);
    const application = await ManagementApplication.open({
      dataDirectory: dataRoot,
      models,
      piAgentDirectory: null,
    });
    await application.close();
    assert.deepEqual(await readFile(join(dataRoot, "workspace-registry.json")), before);
  } else {
    const file = join(root, "glassbox.db");
    const legacy = createClient({ url: localDatabaseUrl(file) });
    await legacy.batch([
      ...baseSchema,
      ...schemaV7Statements,
      ...schemaV8Migration,
      ...learningSchema,
    ]);
    await legacy.execute("PRAGMA user_version=11");
    legacy.close();
    const models = await ModelProfileStore.open(root);
    const id = `default-${"a".repeat(32)}`;
    const state = {
      version: kind === "unknown version" ? 2 : 1,
      workspaces: {
        [id]: {
          id,
          label: "Default workspace",
          canonicalPath:
            kind === "windows"
              ? `C:\\Users\\Owner\\.glassbox\\workspaces\\${id}`
              : join(root, "workspaces", id),
          kind: "default",
          ownerPrincipalId: "owner",
          grants: { owner: "write" },
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      selected: { owner: id },
    };
    const registry = kind === "malformed" ? "{invalid json" : JSON.stringify(state);
    await writeFile(join(root, "workspace-registry.json"), registry);
    const before = await readFile(file);
    const files = await readdir(root);
    await assert.rejects(
      ManagementApplication.open({ dataDirectory: root, models, piAgentDirectory: null }),
      /Workspace registry preflight failed/,
    );
    await assert.rejects(
      WorkspaceRegistry.open({ dataRoot: root }),
      /Workspace registry preflight failed/,
    );
    assert.deepEqual(await readFile(file), before);
    assert.equal(await readFile(join(root, "workspace-registry.json"), "utf8"), registry);
    assert.deepEqual(await readdir(root), files);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 11);
    } finally {
      db.close();
    }
  }
  console.log(JSON.stringify({ kind, passed: true }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runFixture();
