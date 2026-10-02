import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  isLinuxProcessIdentity,
  linuxCommandMatches,
  linuxStartTimeTicks,
  readLinuxProcessIdentity,
  verifyLinuxProcess,
} from "../../../../scripts/service-process-identity.mjs";

const fs = vi.hoisted(() => ({ readFile: vi.fn(), realpath: vi.fn() }));
vi.mock("node:fs/promises", () => fs);

const pid = 123;
const bootId = "12345678-1234-1234-1234-123456789abc";
const startTimeTicks = "12345678901234567";
const executable = "/usr/bin/node";
const args = ["--import", "tsx", "/srv/Glassbox/apps/server/src/index.ts"];
const entry = { pid, executable, args, linuxIdentity: { bootId, startTimeTicks } };
const commandLine = (argv: string[]) => `${[executable, ...argv].join("\0")}\0`;
const procStat = (name = "node", ticks = startTimeTicks) =>
  `${pid} (${name}) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${ticks} 0 0 0\n`;

beforeEach(() => {
  vi.resetAllMocks();
  fs.realpath.mockResolvedValue(executable);
  fs.readFile.mockImplementation(async (path: string) => {
    if (path === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
    if (path === `/proc/${pid}/stat`) return procStat();
    if (path === `/proc/${pid}/cmdline`) return commandLine(args);
    throw new Error(`Unexpected fixture path ${path}`);
  });
});

describe("Linux service argv", () => {
  it("matches the entire case-sensitive argument sequence", () => {
    expect(linuxCommandMatches(commandLine(args), args)).toBe(true);
    expect(
      linuxCommandMatches(commandLine(["", "a b", "C:\\literal"]), ["", "a b", "C:\\literal"]),
    ).toBe(true);
    expect(linuxCommandMatches(commandLine([]), [])).toBe(true);
  });

  it.each([
    ["path suffix", ["--import", "tsx", `${args[2]}.backup`]],
    ["path prefix", ["--import", "tsx", `/backup${args[2]}`]],
    ["different case", ["--import", "tsx", args[2]!.toLowerCase()]],
    ["embedded text", [`--value=${args.join(" ")}`]],
    ["extra argument", [...args, "--other-service"]],
    ["reordered arguments", [args[2]!, "--import", "tsx"]],
    ["missing argument", ["tsx", args[2]!]],
    ["relative path", ["--import", "tsx", "apps/server/src/index.ts"]],
  ])("rejects %s", (_name, actual) => {
    expect(linuxCommandMatches(commandLine(actual), args)).toBe(false);
  });

  it("rejects an absent or incomplete cmdline", () => {
    for (const value of ["", "\0", commandLine(args).slice(0, -1)])
      expect(linuxCommandMatches(value, args)).toBe(false);
  });
});

describe("Linux process birth identity", () => {
  it.each(["node", "node worker", "worker (pool)", "worker ) ( pool))", "worker\nname"])(
    "reads field 22 after the complete comm value %j without numeric precision loss",
    (name) => {
      expect(linuxStartTimeTicks(procStat(name), pid)).toBe(startTimeTicks);
    },
  );

  it.each([
    "",
    "123 (node)",
    "123 (node) S 1",
    procStat().replace(startTimeTicks, "-1"),
    procStat().replace("123 (", "456 ("),
  ])("rejects malformed or mismatched stat %j", (source) => {
    expect(linuxStartTimeTicks(source, pid)).toBeUndefined();
  });

  it.each([
    undefined,
    {},
    { bootId, startTimeTicks: 123 },
    { bootId, startTimeTicks: "-1" },
    { bootId, startTimeTicks, extra: "unexpected" },
    { bootId: "unknown", startTimeTicks },
  ])("rejects invalid persisted identity %j", (value) => {
    expect(isLinuxProcessIdentity(value)).toBe(false);
  });

  it("reads and verifies a matching identity", async () => {
    expect(await readLinuxProcessIdentity(pid)).toEqual(entry.linuxIdentity);
    expect(await verifyLinuxProcess(entry)).toBe(true);
  });

  it("requires a birth token even when executable and arguments match", async () => {
    expect(await verifyLinuxProcess({ pid, executable, args })).toBe(false);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it.each([
    { bootId, startTimeTicks: "12345678901234568" },
    { bootId: "87654321-4321-4321-4321-cba987654321", startTimeTicks },
  ])("rejects PID reuse or a different boot %j", async (linuxIdentity) => {
    expect(await verifyLinuxProcess({ ...entry, linuxIdentity })).toBe(false);
  });

  it("rejects a PID whose birth changes during observation", async () => {
    let statReads = 0;
    fs.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("boot_id")) return bootId;
      if (path.endsWith("cmdline")) return commandLine(args);
      statReads += 1;
      return procStat("node", statReads === 1 ? startTimeTicks : "999");
    });
    expect(await verifyLinuxProcess(entry)).toBe(false);
  });

  it("rejects a changed executable", async () => {
    fs.realpath.mockImplementation(async (path: string) =>
      path.startsWith("/proc/") ? "/usr/bin/other-node" : executable,
    );
    expect(await verifyLinuxProcess(entry)).toBe(false);
  });

  it("rejects mismatched argv even with a matching birth token", async () => {
    fs.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("boot_id")) return bootId;
      if (path.endsWith("stat")) return procStat();
      return commandLine(["--import", "tsx", `${args[2]}.backup`]);
    });
    expect(await verifyLinuxProcess(entry)).toBe(false);
  });

  it("fails closed when proc identity cannot be read", async () => {
    fs.readFile.mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect(await readLinuxProcessIdentity(pid)).toBeUndefined();
    expect(await verifyLinuxProcess(entry)).toBe(false);
  });
});
