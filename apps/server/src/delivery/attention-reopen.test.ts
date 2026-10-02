import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { runFixtureProcess } from "../persistence/test-fixture-process.js";
import { deliveryAttentionFixtureScript } from "./attention-reopen-fixture.js";

it(
  "preserves timeout attention and Owner acknowledgement across actual process restarts",
  { timeout: 30_000 },
  async ({ signal }) => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-delivery-attention-"));
    try {
      const result = JSON.parse(
        await runFixtureProcess(deliveryAttentionFixtureScript, [directory, "write"], signal),
      ) as { runId: string };
      for (const stage of ["read", "read", "ack", "read-ack", "read-ack"])
        expect(
          JSON.parse(
            await runFixtureProcess(
              deliveryAttentionFixtureScript,
              [directory, stage, result.runId],
              signal,
            ),
          ),
        ).toEqual({ passed: true });
    } finally {
      // The fixture runner awaits close, including aborts, before native DB files are removed.
      await rm(directory, { recursive: true, force: true });
    }
  },
);
