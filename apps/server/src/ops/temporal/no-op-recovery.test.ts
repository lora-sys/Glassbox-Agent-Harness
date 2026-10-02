import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { runFixtureProcess } from "../../persistence/test-fixture-process.js";
import { noOpRecoveryFixtureScript } from "./no-op-recovery-fixture.js";

it.for([
  ["join", false],
  ["timer_wait", false],
  ["join", true],
  ["timer_wait", true],
] as const)(
  "recovers a %s committed running before a crash with cancellation=%s",
  async ([kind, cancel], { signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-no-op-recovery-"));
    try {
      const output = await runFixtureProcess(
        noOpRecoveryFixtureScript,
        [join(directory, "state.db"), kind, String(cancel)],
        signal,
      );
      expect(JSON.parse(output)).toEqual({ completed: "no-op-recovery" });
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
