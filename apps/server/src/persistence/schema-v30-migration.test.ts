import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vite-plus/test";
import { runFixtureProcess } from "./test-fixture-process.js";
import { knowledgeMigrationFixtureScript } from "./knowledge-migration-fixture.js";
it(
  "upgrades version 29 and preserves identity after reopen",
  { timeout: 30000 },
  async ({ signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-v30-"));
    try {
      await runFixtureProcess(
        knowledgeMigrationFixtureScript,
        [join(directory, "state.db")],
        signal,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
