import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { runServiceCommand } from "../../../../scripts/agent-service.mjs";

const io = vi.hoisted(() => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
  execFileAsync: vi.fn(),
  execFileSync: vi.fn(),
  securePrivatePath: vi.fn(),
  createConnection: vi.fn(),
  databaseVersion: 25,
}));
vi.mock("node:fs/promises", () => io);
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  openSync: io.openSync,
  closeSync: io.closeSync,
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  Object.defineProperty(io.execFile, promisify.custom, { value: io.execFileAsync });
  return { spawn: io.spawn, execFile: io.execFile, execFileSync: io.execFileSync };
});
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    prepare() {
      return { get: () => ({ user_version: io.databaseVersion }) };
    }
    close() {}
  },
}));
vi.mock("node:net", () => ({ default: { createConnection: io.createConnection } }));
vi.mock("proper-lockfile", () => ({ default: { check: async () => false } }));
vi.mock("./paths.js", () => ({ getServiceDataDir: () => "/fixture/state" }));
vi.mock("./private-path.js", () => ({ securePrivatePath: io.securePrivatePath }));

const originalPlatform = process.platform;
const pid = 321;
const bootId = "12345678-1234-1234-1234-123456789abc";
const linuxIdentity = { bootId, startTimeTicks: "12345" };
const executable = resolve("/usr/bin/node");
const args = ["--import", "tsx", "/srv/Glassbox/apps/server/src/index.ts"];
const baseEntry = {
  name: "glassbox",
  pid,
  executable,
  args,
  cwd: resolve("/srv/Glassbox"),
  startedAt: "2026-10-01T00:00:00.000Z",
  linuxIdentity,
};
let state: Array<Record<string, unknown>>;
let processAlive: boolean;
let observedTicks: string;
let observedArgs: string[];
let observedExecutable: string;
let observedState: string;
let onSignal: ((signal: string | number) => void) | undefined;
let pendingState: Array<Record<string, unknown>> | undefined;
const kill = vi.spyOn(process, "kill");
const stdout = vi.spyOn(process.stdout, "write");
const procStat = () =>
  `${pid} (node (worker)) ${observedState} ${Array.from({ length: 18 }, () => "0").join(" ")} ${observedTicks} 0\n`;
const missing = () => Object.assign(new Error("missing fixture"), { code: "ENOENT" });

beforeEach(() => {
  vi.resetAllMocks();
  io.execFileSync.mockImplementation((_command: string, args: string[]) =>
    args[0] === "rev-parse" ? "a".repeat(40) : "",
  );
  Object.defineProperty(process, "platform", { value: "linux" });
  state = [{ ...baseEntry }];
  processAlive = true;
  io.databaseVersion = 25;
  observedTicks = linuxIdentity.startTimeTicks;
  observedArgs = [...args];
  observedExecutable = executable;
  observedState = "S";
  onSignal = undefined;
  pendingState = undefined;
  kill.mockImplementation((_pid, signal = 0) => {
    if (!processAlive) throw Object.assign(new Error("no process"), { code: "ESRCH" });
    if (signal !== 0) {
      if (onSignal) onSignal(signal);
      else processAlive = false;
    }
    return true;
  });
  stdout.mockReturnValue(true);
  io.realpath.mockImplementation(async (path: string) =>
    path === `/proc/${pid}/exe` ? observedExecutable : path,
  );
  io.stat.mockImplementation(async (path: string) => {
    if (path.endsWith("glassbox.db")) throw missing();
    return { isFile: () => true, isDirectory: () => true };
  });
  io.readFile.mockImplementation(async (path: string) => {
    if (path.endsWith("service-processes.json")) return JSON.stringify(state);
    if (path.endsWith("service-launch.json")) return '{"version":1}';
    if (path.endsWith("package.json")) return '{"name":"glassbox"}';
    if (path.endsWith("boot_id")) return bootId;
    if (path === `/proc/${pid}/stat`) return procStat();
    if (path === `/proc/${pid}/cmdline`)
      return `${[observedExecutable, ...observedArgs].join("\0")}\0`;
    throw missing();
  });
  io.writeFile.mockImplementation(async (_path: string, content: string) => {
    pendingState = JSON.parse(content) as Array<Record<string, unknown>>;
  });
  io.rename.mockImplementation(async (_source: string, target: string) => {
    if (target === join("/fixture/state", "service-processes.json") && pendingState)
      state = pendingState;
  });
  io.rm.mockResolvedValue(undefined);
  io.mkdir.mockResolvedValue(undefined);
  io.securePrivatePath.mockResolvedValue(undefined);
  io.openSync.mockReturnValue(55);
  io.spawn.mockImplementation((command: string, spawnedArgs: string[]) => {
    processAlive = true;
    observedArgs = spawnedArgs;
    observedExecutable = command;
    return { pid, unref: vi.fn(), exitCode: null, signalCode: null };
  });
  io.createConnection.mockImplementation(() => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn() });
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("service commands with unverified Linux ownership", () => {
  const unknownCases = [
    "legacy",
    "reused PID",
    "wrong argv",
    "different executable",
    "unreadable proc",
  ];
  for (const command of ["up", "down", "switch"]) {
    it.each(unknownCases)(
      `${command} preserves %s state without signaling or starting a replacement`,
      async (reason) => {
        if (reason === "legacy") delete state[0]!.linuxIdentity;
        if (reason === "reused PID") observedTicks = "99999";
        if (reason === "wrong argv") observedArgs[2] += ".backup";
        if (reason === "different executable") observedExecutable = "/usr/bin/other-node";
        if (reason === "unreadable proc") {
          const fixtureRead = io.readFile.getMockImplementation()!;
          io.readFile.mockImplementation(async (path: string) => {
            if (path.startsWith("/proc/"))
              throw Object.assign(new Error("denied"), { code: "EACCES" });
            return fixtureRead(path);
          });
        }
        await expect(runServiceCommand(command, [])).rejects.toThrow(
          "Cannot verify glassbox PID 321",
        );
        expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
        expect(io.spawn).not.toHaveBeenCalled();
        expect(io.writeFile).not.toHaveBeenCalled();
        expect(io.rename).not.toHaveBeenCalled();
        expect(io.rm).not.toHaveBeenCalled();
        expect(stdout).not.toHaveBeenCalled();
      },
    );
  }

  it("does not interpret a permission-denied PID probe as a missing process", async () => {
    kill.mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    delete state[0]!.linuxIdentity;
    await expect(runServiceCommand("up", [])).rejects.toThrow("Cannot verify");
    expect(io.spawn).not.toHaveBeenCalled();
    expect(io.writeFile).not.toHaveBeenCalled();
  });

  it("reports unknown separately from stopped", async () => {
    delete state[0]!.linuxIdentity;
    await runServiceCommand("status", []);
    const result = JSON.parse(String(stdout.mock.calls[0]![0])) as {
      processes: Array<{ status: string; running: boolean; pid?: number }>;
    };
    expect(result.processes[0]).toMatchObject({ status: "unknown", running: false, pid });
    expect(io.spawn).not.toHaveBeenCalled();
    expect(io.rm).not.toHaveBeenCalled();
  });

  it("can clear a dead legacy record without signaling it", async () => {
    delete state[0]!.linuxIdentity;
    processAlive = false;
    await runServiceCommand("down", []);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(io.rm).toHaveBeenCalledWith(join("/fixture/state", "service-processes.json"), {
      force: true,
    });
  });

  it("stops a matching process and removes its record only after it exits", async () => {
    await runServiceCommand("down", []);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[pid, "SIGTERM"]]);
    expect(io.rm).toHaveBeenCalledWith(join("/fixture/state", "service-processes.json"), {
      force: true,
    });
  });

  it("treats an unreaped zombie as exited without signaling it", async () => {
    observedState = "Z";
    observedArgs = [];
    await runServiceCommand("down", []);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(io.rm).toHaveBeenCalledWith(join("/fixture/state", "service-processes.json"), {
      force: true,
    });
  });

  it("accepts a zombie after graceful shutdown without misreporting unknown ownership", async () => {
    onSignal = () => {
      observedState = "Z";
      observedArgs = [];
    };
    await runServiceCommand("down", []);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[pid, "SIGTERM"]]);
    expect(io.rm).toHaveBeenCalledWith(join("/fixture/state", "service-processes.json"), {
      force: true,
    });
  });

  it("preserves the record and never escalates when the PID is reused after SIGTERM", async () => {
    onSignal = () => {
      observedTicks = "99999";
    };
    await expect(runServiceCommand("down", [])).rejects.toThrow("Cannot verify");
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[pid, "SIGTERM"]]);
    expect(io.rm).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("escalates only while the same process identity remains verified", async () => {
    vi.useFakeTimers();
    try {
      onSignal = (signal) => {
        if (signal === "SIGKILL") processAlive = false;
      };
      const stopped = runServiceCommand("down", []);
      await vi.advanceTimersByTimeAsync(5_000);
      await stopped;
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [pid, "SIGTERM"],
        [pid, "SIGKILL"],
      ]);
      expect(io.rm).toHaveBeenCalledWith(join("/fixture/state", "service-processes.json"), {
        force: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the birth token when starting a new service", async () => {
    state = [];
    await runServiceCommand("up", []);
    const persisted = JSON.parse(String(io.writeFile.mock.calls.at(-1)![1])) as unknown[];
    expect(persisted).toEqual([
      expect.objectContaining({
        pid,
        linuxIdentity,
        launchCommit: "a".repeat(40),
        launchClean: true,
      }),
    ]);
    expect(io.spawn).toHaveBeenCalledOnce();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("retains a new record if birth identity cannot be captured", async () => {
    state = [];
    const fixtureRead = io.readFile.getMockImplementation()!;
    io.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("boot_id")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return fixtureRead(path);
    });
    await expect(runServiceCommand("up", [])).rejects.toThrow("Cannot verify");
    expect(io.spawn).toHaveBeenCalledOnce();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    const persisted = JSON.parse(String(io.writeFile.mock.calls.at(-1)![1])) as unknown[];
    expect(persisted).toEqual([expect.objectContaining({ pid })]);
    expect(io.rm).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("does not adopt a birth token after the spawned child has exited", async () => {
    state = [];
    const fixtureSpawn = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation((command: string, spawnedArgs: string[]) => ({
      ...fixtureSpawn(command, spawnedArgs),
      exitCode: 0,
    }));
    await expect(runServiceCommand("up", [])).rejects.toThrow("Cannot verify");
    expect(state[0]!.linuxIdentity).toBeUndefined();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(io.rm).not.toHaveBeenCalled();
  });

  it("does not start a rollback replacement while the new process has unknown ownership", async () => {
    const fixtureRead = io.readFile.getMockImplementation()!;
    io.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith("boot_id") && io.spawn.mock.calls.length > 0)
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      return fixtureRead(path);
    });
    await expect(runServiceCommand("switch", [])).rejects.toThrow(
      "Checkout switch and rollback failed",
    );
    expect(io.spawn).toHaveBeenCalledOnce();
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[pid, "SIGTERM"]]);
    expect(state).toEqual([expect.objectContaining({ pid })]);
    expect(state[0]!.linuxIdentity).toBeUndefined();
    expect(io.rm).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it("refuses an older rollback after a failed candidate upgrades the shared schema", async () => {
    const candidate = resolve("/srv/candidate");
    const previousSchema = join(baseEntry.cwd, "apps/server/src/persistence/schema.ts");
    const candidateSchema = join(candidate, "apps/server/src/persistence/schema.ts");
    io.stat.mockResolvedValue({ isFile: () => true, isDirectory: () => true });
    const fixtureRead = io.readFile.getMockImplementation()!;
    io.readFile.mockImplementation(async (path: string) => {
      if (path === previousSchema) return "export const CURRENT_SCHEMA_VERSION = 25;";
      if (path === candidateSchema) return "export const CURRENT_SCHEMA_VERSION = 28;";
      return fixtureRead(path);
    });
    io.spawn.mockImplementation(() => {
      io.databaseVersion = 28;
      throw new Error("candidate failed after migration");
    });
    const error = await runServiceCommand("switch", ["--checkout", candidate]).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((item: Error) => item.message)).toEqual([
      "candidate failed after migration",
      "Target checkout supports database version 25, but shared data uses 28",
    ]);
    expect(io.spawn).toHaveBeenCalledOnce();
    expect(io.databaseVersion).toBe(28);
    expect(io.readFile).toHaveBeenCalledWith(candidateSchema, "utf8");
    expect(io.readFile).toHaveBeenCalledWith(previousSchema, "utf8");
    expect(state).toEqual([]);
    expect(io.rm).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted birth identity without changing state", async () => {
    state[0]!.linuxIdentity = { bootId, startTimeTicks: 12345 };
    await expect(runServiceCommand("down", [])).rejects.toThrow("Invalid service state");
    expect(kill).not.toHaveBeenCalled();
    expect(io.spawn).not.toHaveBeenCalled();
    expect(io.rm).not.toHaveBeenCalled();
  });
});

describe("existing service ownership contracts", () => {
  it("keeps Windows case-insensitive command matching without requiring a Linux token", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    delete state[0]!.linuxIdentity;
    io.execFileAsync.mockResolvedValue({
      stdout: JSON.stringify({
        ExecutablePath: executable.toUpperCase(),
        CommandLine: [executable, ...args].join(" ").toUpperCase(),
      }),
    });
    await runServiceCommand("status", []);
    const result = JSON.parse(String(stdout.mock.calls[0]![0])) as {
      processes: Array<{ running: boolean }>;
    };
    expect(result.processes[0]!.running).toBe(true);
    expect(io.readFile.mock.calls.some(([path]) => String(path).startsWith("/proc/"))).toBe(false);
  });

  it("stops named Herdr sessions through the public session command without signaling their saved PID", async () => {
    state = [
      {
        ...baseEntry,
        name: "herdr",
        args: ["--session", "fixture-session"],
        linuxIdentity: undefined,
      },
    ];
    let sessionRunning = true;
    io.execFileAsync.mockImplementation(async (_command: string, commandArgs: string[]) => {
      if (commandArgs[1] === "stop") sessionRunning = false;
      return {
        stdout: JSON.stringify({
          sessions: [{ name: "fixture-session", running: sessionRunning }],
        }),
      };
    });
    await runServiceCommand("down", []);
    expect(io.execFileAsync).toHaveBeenCalledWith(
      executable,
      ["session", "stop", "fixture-session"],
      expect.anything(),
    );
    expect(kill).not.toHaveBeenCalled();
    expect(io.spawn).not.toHaveBeenCalled();
  });
});
