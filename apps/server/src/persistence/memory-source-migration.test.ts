import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vite-plus/test";
import { runFixtureProcess } from "./test-fixture-process.js";
import { sourcePolicyReopenFixtureScript } from "../learning/source-policy-reopen-fixture.js";

it.for(["fresh", "upgrade"])(
  "preserves %s Memory provenance through archive and process reopen",
  { timeout: 30_000 },
  async (scenario, { signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-memory-source-"));
    try {
      for (const phase of ["prepare", "verify", "reopen"])
        await runFixtureProcess(
          sourcePolicyReopenFixtureScript,
          [join(directory, "state.db"), phase, scenario],
          signal,
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
