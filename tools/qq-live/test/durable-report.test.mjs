import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeDurableReport } from "../lib/durable-report.mjs";

test("publishes complete report and retains the old report if file sync fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "report.json");
  await writeFile(path, '{"status":"PENDING"}\n');
  const broken = {
    open: async (...args) => {
      const handle = await open(...args);
      return {
        writeFile: (...values) => handle.writeFile(...values),
        close: () => handle.close(),
        sync: async () => {
          throw new Error("injected sync failure");
        },
      };
    },
    rename,
    rm,
  };
  await assert.rejects(
    writeDurableReport(path, { status: "PASS" }, broken),
    /injected sync failure/,
  );
  assert.equal(JSON.parse(await readFile(path, "utf8")).status, "PENDING");
  assert.deepEqual(await readdir(directory), ["report.json"]);
  await writeDurableReport(path, { status: "INCONCLUSIVE", retained: true });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    status: "INCONCLUSIVE",
    retained: true,
  });
  assert.deepEqual(await readdir(directory), ["report.json"]);
});
