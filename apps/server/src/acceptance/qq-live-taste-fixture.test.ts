// test-contract-change: ISSUE-194 preserve test assertions in a child process to release Windows native SQLite handles
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { runFixtureProcess } from "../persistence/test-fixture-process.js";
import { qqLiveTasteFixtureScript } from "./qq-live-taste-fixture-process.js";

it(
  "observes the Taste lifecycle written by LearningStore from its persisted SQLite database",
  { timeout: 30_000 },
  async ({ signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "qq-live-taste-store-"));
    try {
      const output = await runFixtureProcess(
        qqLiveTasteFixtureScript,
        [join(directory, "glassbox.db")],
        signal,
      );
      expect(output).toContain('{"completed":true}');
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
