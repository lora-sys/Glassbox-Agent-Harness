import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { runFixtureProcess } from "../persistence/test-fixture-process.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { migrationPreflightFixtureScript } from "./migration-preflight-fixture.js";

describe("read-only migration preflight", () => {
  it.for(["windows", "malformed", "unknown version", "missing path"])(
    "rejects %s registry before migrating a real v11 database",
    { timeout: 30_000 },
    async (kind, { signal }) => {
      const root = await mkdtemp(join(tmpdir(), "glassbox-preflight-"));
      try {
        const output = await runFixtureProcess(
          migrationPreflightFixtureScript,
          [root, kind],
          signal,
        );
        expect(JSON.parse(output)).toEqual({ kind, passed: true });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("accepts a new install without creating the missing data root", async () => {
    const root = await mkdtemp(join(tmpdir(), "glassbox-preflight-"));
    try {
      await WorkspaceRegistry.preflight({ dataRoot: join(root, "new") });
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "accepts valid local default and registered workspaces without rewriting IDs or grants",
    { timeout: 30_000 },
    async ({ signal }) => {
      const root = await mkdtemp(join(tmpdir(), "glassbox-preflight-"));
      try {
        const output = await runFixtureProcess(
          migrationPreflightFixtureScript,
          [root, "valid"],
          signal,
        );
        expect(JSON.parse(output)).toEqual({ kind: "valid", passed: true });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
