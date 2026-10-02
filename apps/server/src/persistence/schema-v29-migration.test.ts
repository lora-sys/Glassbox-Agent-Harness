import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vite-plus/test";
import { runFixtureProcess } from "./test-fixture-process.js";
import { ownerRoutingReopenFixtureScript } from "./owner-routing-reopen-fixture.js";

it.for(["upgrade", "missing-runs", "reopen"])(
  "preserves bounded Owner routing provenance: %s",
  { timeout: 30_000 },
  async (scenario, { signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-owner-routing-"));
    try {
      await runFixtureProcess(
        ownerRoutingReopenFixtureScript,
        [join(directory, "state.db"), scenario],
        signal,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
