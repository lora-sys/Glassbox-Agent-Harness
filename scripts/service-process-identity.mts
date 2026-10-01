import { readFile, realpath } from "node:fs/promises";

export interface LinuxProcessIdentity {
  bootId: string;
  startTimeTicks: string;
}

export function isLinuxProcessIdentity(value: unknown): value is LinuxProcessIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).length === 2 &&
    typeof item.bootId === "string" &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(item.bootId) &&
    typeof item.startTimeTicks === "string" &&
    /^(?:0|[1-9]\d{0,19})$/u.test(item.startTimeTicks)
  );
}

function linuxProcessStat(
  source: string,
  pid: number,
): { state: string; startTimeTicks: string } | undefined {
  if (!source.startsWith(`${pid} (`)) return undefined;
  // comm (field 2) can contain spaces, newlines, and parentheses. Only the final
  // closing parenthesis separates it from the remaining stat fields.
  const end = source.lastIndexOf(")");
  if (source[end + 1] !== " ") return undefined;
  const fields = source
    .slice(end + 2)
    .trim()
    .split(/\s+/u);
  const ticks = fields[19]; // starttime is field 22; fields begins at state (3).
  if (!/^[A-Za-z]$/u.test(fields[0] ?? "") || !/^(?:0|[1-9]\d{0,19})$/u.test(ticks ?? ""))
    return undefined;
  return { state: fields[0]!, startTimeTicks: ticks! };
}

export function linuxStartTimeTicks(source: string, pid: number): string | undefined {
  return linuxProcessStat(source, pid)?.startTimeTicks;
}

export async function linuxProcessHasExited(pid: number): Promise<boolean> {
  try {
    const status = linuxProcessStat(await readFile(`/proc/${pid}/stat`, "utf8"), pid)?.state;
    return status === "Z" || status === "X" || status === "x";
  } catch {
    return false;
  }
}

export function linuxCommandMatches(commandLine: string, args: readonly string[]): boolean {
  if (!commandLine.endsWith("\0")) return false;
  const argv = commandLine.slice(0, -1).split("\0");
  return (
    argv[0] !== "" &&
    argv.length === args.length + 1 &&
    args.every((arg, index) => argv[index + 1] === arg)
  );
}

export async function readLinuxProcessIdentity(
  pid: number,
): Promise<LinuxProcessIdentity | undefined> {
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const startTimeTicks = linuxStartTimeTicks(await readFile(`/proc/${pid}/stat`, "utf8"), pid);
    const identity = { bootId, startTimeTicks };
    return isLinuxProcessIdentity(identity) ? identity : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyLinuxProcess(entry: {
  pid: number;
  executable: string;
  args: readonly string[];
  linuxIdentity?: LinuxProcessIdentity;
}): Promise<boolean> {
  const expected = entry.linuxIdentity;
  if (!isLinuxProcessIdentity(expected)) return false;
  const sameIdentity = (actual: LinuxProcessIdentity | undefined) =>
    actual?.bootId === expected.bootId && actual.startTimeTicks === expected.startTimeTicks;
  try {
    if (!sameIdentity(await readLinuxProcessIdentity(entry.pid))) return false;
    const executable = await realpath(`/proc/${entry.pid}/exe`);
    const commandLine = await readFile(`/proc/${entry.pid}/cmdline`, "utf8");
    const expectedExecutable = await realpath(entry.executable);
    // Recheck after reading exe/argv so a PID change during those reads fails closed.
    return (
      executable === expectedExecutable &&
      linuxCommandMatches(commandLine, entry.args) &&
      sameIdentity(await readLinuxProcessIdentity(entry.pid))
    );
  } catch {
    return false;
  }
}
