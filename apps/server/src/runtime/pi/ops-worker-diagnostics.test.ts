// test-contract-change: ISSUE-194 preserve test assertions in a child process to release Windows native SQLite handles
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { runFixtureProcess } from "../../persistence/test-fixture-process.js";
import { opsWorkerDiagnosticsFixtureScript } from "./ops-worker-diagnostics-fixture.js";

it(
  "explains an ungranted configured Worker workspace without leaking paths or inventing a running Worker",
  { timeout: 30_000 },
  async ({ signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-worker-diagnostic-"));
    try {
      const output = await runFixtureProcess(
        opsWorkerDiagnosticsFixtureScript,
        [directory],
        signal,
      );
      expect(output).toContain('{"completed":true}');
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
