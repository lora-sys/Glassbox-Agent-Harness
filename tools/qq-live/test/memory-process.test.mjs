import test from "node:test";
import assert from "node:assert/strict";
import { captureMemoryProcess, verifyMemoryProcessStopped } from "../lib/memory-process.mjs";

const boot = "01234567-1234-1234-1234-0123456789ab";
const identity = { pid: 123, bootId: boot, startTicks: "456" };
function stat(ticks = "456", pid = 123) {
  return `${pid} (name with ) and spaces) S ${Array(18).fill("0").join(" ")} ${ticks} 0 0\n`;
}
function reader({ currentBoot = boot, processStat = stat(), error } = {}) {
  return async (path) => {
    if (path === "/proc/sys/kernel/random/boot_id") return `${currentBoot}\n`;
    if (error) throw Object.assign(new Error("read failed"), { code: error });
    assert.ok(["/proc/self/stat", "/proc/123/stat"].includes(path));
    return processStat;
  };
}

test("captures Linux boot and process start identity even with parentheses in the name", async () => {
  assert.deepEqual(
    await captureMemoryProcess({ read: reader(), pid: 123, platform: "linux" }),
    identity,
  );
});

test("capture rejects unsupported OS and incomplete or wrong process metadata", async () => {
  await assert.rejects(captureMemoryProcess({ platform: "win32" }), {
    code: "MEMORY_CHECKPOINT_PLATFORM",
  });
  for (const processStat of [stat("456", 124), "123 (truncated) S", stat("0"), stat("abc")])
    await assert.rejects(
      captureMemoryProcess({ read: reader({ processStat }), pid: 123, platform: "linux" }),
      { code: "MEMORY_PROCESS_STAT" },
    );
  await assert.rejects(
    captureMemoryProcess({ read: reader({ currentBoot: "invalid" }), pid: 123, platform: "linux" }),
    { code: "MEMORY_PROCESS_BOOT" },
  );
});

test("a matching original process blocks recovery", async () => {
  await assert.rejects(verifyMemoryProcessStopped(identity, { read: reader() }), {
    code: "MEMORY_PROCESS_RUNNING",
  });
});

test("absent original process, reboot and reused PID prove only the CLI stopped", async () => {
  for (const [options, reason] of [
    [{ error: "ENOENT" }, "process_absent"],
    [{ currentBoot: "01234567-1234-1234-1234-0123456789ac" }, "boot_changed"],
    [{ processStat: stat("789") }, "pid_reused"],
  ])
    assert.deepEqual(await verifyMemoryProcessStopped(identity, { read: reader(options) }), {
      stopped: true,
      reason,
      identity,
    });
});

test("permission failures and malformed live metadata cannot prove stopped", async () => {
  await assert.rejects(
    verifyMemoryProcessStopped(identity, { read: reader({ error: "EACCES" }) }),
    { code: "MEMORY_PROCESS_UNKNOWN" },
  );
  await assert.rejects(
    verifyMemoryProcessStopped(identity, { read: reader({ processStat: stat("456", 124) }) }),
    { code: "MEMORY_PROCESS_STAT" },
  );
  await assert.rejects(
    verifyMemoryProcessStopped({ ...identity, startTicks: undefined }, { read: reader() }),
    { code: "MEMORY_PROCESS_IDENTITY" },
  );
});
