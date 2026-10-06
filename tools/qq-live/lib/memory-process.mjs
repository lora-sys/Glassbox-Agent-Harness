import { readFile } from "node:fs/promises";
import { fail } from "./core.mjs";

const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TICKS = /^[1-9]\d{0,31}$/;
const BOOT_PATH = "/proc/sys/kernel/random/boot_id";

function requireIdentity(identity) {
  if (
    !identity ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid < 1 ||
    !BOOT_ID.test(identity.bootId ?? "") ||
    !TICKS.test(identity.startTicks ?? "")
  )
    fail("MEMORY_PROCESS_IDENTITY", "没有完整的 Linux 测试进程身份。", "INCONCLUSIVE");
}

function startTicks(stat, pid) {
  if (typeof stat !== "string" || !stat.startsWith(`${pid} (`) || stat.lastIndexOf(")") < 0)
    fail("MEMORY_PROCESS_STAT", "测试进程信息与预期 PID 不一致。", "INCONCLUSIVE");
  const value = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/)[19];
  if (!TICKS.test(value ?? ""))
    fail("MEMORY_PROCESS_STAT", "没有取得测试进程的启动标识。", "INCONCLUSIVE");
  return value;
}

async function bootId(read) {
  try {
    const value = (await read(BOOT_PATH, "utf8")).trim();
    if (!BOOT_ID.test(value)) throw new Error("invalid boot identity");
    return value;
  } catch {
    fail("MEMORY_PROCESS_BOOT", "无法核实 Linux 启动身份。", "INCONCLUSIVE");
  }
}

export async function captureMemoryProcess({
  read = readFile,
  pid = process.pid,
  platform = process.platform,
} = {}) {
  if (platform !== "linux")
    fail("MEMORY_CHECKPOINT_PLATFORM", "固定记忆测试需要 Linux 的进程身份与持久化目录支持。");
  let stat;
  try {
    stat = await read("/proc/self/stat", "utf8");
  } catch {
    fail("MEMORY_PROCESS_STAT", "无法取得本轮测试进程信息。", "INCONCLUSIVE");
  }
  const identity = { pid, bootId: await bootId(read), startTicks: startTicks(stat, pid) };
  requireIdentity(identity);
  return identity;
}

/** Only proves the original CLI stopped; server Runs and effects need separate evidence. */
export async function verifyMemoryProcessStopped(identity, { read = readFile } = {}) {
  requireIdentity(identity);
  const currentBootId = await bootId(read);
  if (currentBootId !== identity.bootId) return { stopped: true, reason: "boot_changed", identity };
  let stat;
  try {
    stat = await read(`/proc/${identity.pid}/stat`, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { stopped: true, reason: "process_absent", identity };
    fail("MEMORY_PROCESS_UNKNOWN", "无法确认原测试进程已经停止。", "INCONCLUSIVE");
  }
  if (startTicks(stat, identity.pid) !== identity.startTicks)
    return { stopped: true, reason: "pid_reused", identity };
  fail("MEMORY_PROCESS_RUNNING", "原测试进程仍在运行，禁止并发恢复。", "BLOCKED");
}
