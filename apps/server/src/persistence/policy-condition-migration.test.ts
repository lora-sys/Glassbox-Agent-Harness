import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vite-plus/test";
import { runFixtureProcess } from "./test-fixture-process.js";
import { policyConditionReopenFixtureScript } from "./policy-condition-reopen-fixture.js";

it.for(["fresh", "upgrade"])(
  "preserves %s policy conditions through archive and reopen",
  { timeout: 30_000 },
  async (scenario, { signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-policy-"));
    try {
      await runFixtureProcess(
        policyConditionReopenFixtureScript,
        [join(directory, "state.db"), scenario],
        signal,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
