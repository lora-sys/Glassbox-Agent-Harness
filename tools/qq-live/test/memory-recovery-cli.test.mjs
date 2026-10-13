import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, rename, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  releaseRecoveryLock,
  runMemoryRecoveryCli,
  recoveryStopFingerprint,
} from "../lib/memory-recovery-cli.mjs";

test("recovery STOP evidence detects creation and same-size content replacement", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qq-recovery-stop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "STOP");
  assert.equal(await recoveryStopFingerprint(path), null);
  await writeFile(path, "original");
  const first = await recoveryStopFingerprint(path);
  await writeFile(path, "replaced");
  assert.notEqual(await recoveryStopFingerprint(path), first);
  await writeFile(path, "x".repeat(16385));
  await assert.rejects(recoveryStopFingerprint(path), { code: "RECOVERY_STOP" });
});

test("recovery releases only the file held by its lock handle", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "qq-recovery-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "account.lock");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile("original");
    await rename(path, join(dir, "old.lock"));
    await writeFile(path, "another process");
    await assert.rejects(releaseRecoveryLock(path, handle), { code: "RUN_LOCKED" });
    assert.equal(await readFile(path, "utf8"), "another process");
  } finally {
    await handle.close();
  }
  const owned = await open(path, "r");
  try {
    await releaseRecoveryLock(path, owned);
  } finally {
    await owned.close();
  }
  await assert.rejects(readFile(path), { code: "ENOENT" });
});

test("recovery refuses disabled or missing runtime configuration before any effects", async () => {
  await assert.rejects(runMemoryRecoveryCli({}, {}, "unused"), { code: "MEMORY_FIXTURE_DISABLED" });
  await assert.rejects(
    runMemoryRecoveryCli({ runtime: {}, memoryFixtures: { enabled: true } }, {}, "unused"),
    { code: "MEMORY_FIXTURE_DISABLED" },
  );
});

test("recovery rejects custom messages and cases before process or service access", async () => {
  const config = { runtime: {}, memoryFixtures: { enabled: true, retainAuditConfirmed: true } };
  for (const options of [{ case: "private" }, { scenarios: "custom.json" }])
    await assert.rejects(runMemoryRecoveryCli(config, options, "unused"), { code: "ARGUMENT" });
});
