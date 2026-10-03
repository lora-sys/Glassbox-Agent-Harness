import { execFile as execFileCallback, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getServiceDataDir } from "../apps/server/src/platform/paths.js";
import { securePrivatePath } from "../apps/server/src/platform/private-path.js";
import { persistedEnvironment, serviceEnvironmentKeys } from "./service-environment.mjs";
import {
  isLinuxProcessIdentity,
  linuxProcessHasExited,
  readLinuxProcessIdentity,
  verifyLinuxProcess,
  type LinuxProcessIdentity,
} from "./service-process-identity.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDirectory = getServiceDataDir();
const statePath = join(dataDirectory, "service-processes.json");
const priorStatePath = `${statePath}.previous`;
const configPath = join(dataDirectory, "service-launch.json");
const logPath = join(dataDirectory, "service.log");

type ProcessName = "herdr" | "napcat" | "glassbox";

interface ProcessConfig {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

interface GlassboxConfig {
  env?: Record<string, string>;
}

interface LaunchConfig {
  version: 1;
  herdr?: ProcessConfig;
  napcat?: ProcessConfig;
  glassbox?: GlassboxConfig;
}

interface ProcessState extends ProcessConfig {
  name: ProcessName;
  pid: number;
  startedAt: string;
  linuxIdentity?: LinuxProcessIdentity;
}

type ProcessStatus = "running" | "stopped" | "unknown";

interface StartOptions {
  skipNapcat?: boolean;
  checkout?: string;
}

async function checkoutRoot(input?: string): Promise<string> {
  const candidate = input ?? repoRoot;
  if (!isAbsolute(candidate)) throw new Error("Checkout path must be absolute");
  const root = await realpath(candidate);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name?: unknown;
  };
  if (manifest.name !== "glassbox") throw new Error("Checkout is not Glassbox");
  if (!(await stat(join(root, "apps/server/src/index.ts"))).isFile())
    throw new Error("Glassbox server entry is unavailable");
  if (!(await stat(join(root, "node_modules/tsx"))).isDirectory())
    throw new Error("Checkout dependencies are unavailable; install them before switching");
  return root;
}

async function assertDatabaseCompatible(checkout: string): Promise<void> {
  const databasePath = join(dataDirectory, "glassbox.db");
  try {
    if (!(await stat(databasePath)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const schemaSource = await readFile(
    join(checkout, "apps/server/src/persistence/schema.ts"),
    "utf8",
  );
  const supported = /export\s+const\s+CURRENT_SCHEMA_VERSION\s*=\s*(\d+)\s*;/u.exec(schemaSource);
  if (!supported) throw new Error("Target checkout does not declare a readable database version");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let current: number;
  try {
    current = Number(
      (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
  } finally {
    database.close();
  }
  if (current > Number(supported[1]))
    throw new Error(
      `Target checkout supports database version ${supported[1]}, but shared data uses ${current}`,
    );
}

function environment(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name} environment`);
  const entries = Object.entries(value);
  if (
    entries.length > 32 ||
    entries.some(
      ([key, item]) =>
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) ||
        !serviceEnvironmentKeys.has(key) ||
        typeof item !== "string" ||
        item.length > 4096,
    )
  )
    throw new Error(`Invalid ${name} environment`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function processConfig(value: unknown, name: string): ProcessConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${name} launch configuration`);
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => !["executable", "args", "cwd", "env"].includes(key)) ||
    typeof item.executable !== "string" ||
    !isAbsolute(item.executable) ||
    !Array.isArray(item.args) ||
    item.args.length > 32 ||
    item.args.some((arg) => typeof arg !== "string" || arg.length > 2048) ||
    (item.cwd !== undefined && (typeof item.cwd !== "string" || !isAbsolute(item.cwd)))
  )
    throw new Error(`Invalid ${name} launch configuration`);
  return {
    executable: resolve(item.executable),
    args: [...(item.args as string[])],
    ...(item.cwd === undefined ? {} : { cwd: resolve(item.cwd as string) }),
    ...(item.env === undefined ? {} : { env: environment(item.env, name) }),
  };
}

function glassboxConfig(value: unknown): GlassboxConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Glassbox launch configuration");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => key !== "env"))
    throw new Error("Invalid Glassbox launch configuration");
  return item.env === undefined ? {} : { env: environment(item.env, "Glassbox") };
}

async function loadConfig(): Promise<LaunchConfig> {
  try {
    const value = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      Object.keys(value).some((key) => !["version", "herdr", "napcat", "glassbox"].includes(key))
    )
      throw new Error("Invalid service launch configuration");
    return {
      version: 1,
      ...(value.herdr === undefined ? {} : { herdr: processConfig(value.herdr, "Herdr") }),
      ...(value.napcat === undefined ? {} : { napcat: processConfig(value.napcat, "NapCat") }),
      ...(value.glassbox === undefined ? {} : { glassbox: glassboxConfig(value.glassbox) }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw error;
  }
}

function stateEntry(value: unknown): ProcessState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid service state");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) =>
        !["name", "pid", "startedAt", "executable", "args", "cwd", "env", "linuxIdentity"].includes(
          key,
        ),
    ) ||
    !["herdr", "napcat", "glassbox"].includes(String(item.name)) ||
    !Number.isSafeInteger(item.pid) ||
    (item.pid as number) < 1 ||
    typeof item.startedAt !== "string" ||
    Number.isNaN(Date.parse(item.startedAt)) ||
    (item.linuxIdentity !== undefined && !isLinuxProcessIdentity(item.linuxIdentity))
  )
    throw new Error("Invalid service state");
  const config = processConfig(
    {
      executable: item.executable,
      args: item.args,
      ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
      ...(item.env === undefined ? {} : { env: item.env }),
    },
    "saved process",
  );
  if (!config) throw new Error("Invalid service state");
  return {
    name: item.name as ProcessName,
    pid: item.pid as number,
    startedAt: item.startedAt,
    ...(item.linuxIdentity === undefined ? {} : { linuxIdentity: item.linuxIdentity }),
    ...config,
  };
}

async function loadState(): Promise<ProcessState[]> {
  try {
    await securePrivatePath(dataDirectory, true);
    for (const path of [statePath, priorStatePath]) {
      try {
        await stat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
      await securePrivatePath(path, false);
    }
    let source: string;
    try {
      source = await readFile(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      source = await readFile(priorStatePath, "utf8");
      await rename(priorStatePath, statePath).catch(() => undefined);
    }
    const value = JSON.parse(source) as unknown;
    if (!Array.isArray(value) || value.length > 3) throw new Error("Invalid service state");
    return value.map(stateEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeState(state: ProcessState[]): Promise<void> {
  const temporary = `${statePath}.${process.pid}.tmp`;
  const persisted = state.map(({ env, ...entry }) => ({
    ...entry,
    ...(env
      ? {
          env: persistedEnvironment(env),
        }
      : {}),
  }));
  await securePrivatePath(dataDirectory, true);
  await writeFile(temporary, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  try {
    await securePrivatePath(temporary, false);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    await rename(temporary, statePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(temporary, { force: true });
      throw error;
    }
    await rm(priorStatePath, { force: true });
    await rename(statePath, priorStatePath);
    try {
      await rename(temporary, statePath);
      await rm(priorStatePath, { force: true });
    } catch (replacementError) {
      await rename(priorStatePath, statePath).catch(() => undefined);
      await rm(temporary, { force: true });
      throw replacementError;
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Lack of permission is not evidence that the PID is unused.
    return process.platform === "linux" && (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function herdrSessionName(entry: ProcessState): string | undefined {
  if (entry.name !== "herdr") return undefined;
  const marker = entry.args.indexOf("--session");
  const name = marker >= 0 ? entry.args[marker + 1] : undefined;
  return name && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u.test(name) ? name : undefined;
}

async function herdrSessionRunning(entry: ProcessState, name: string): Promise<boolean> {
  const result = await execFile(entry.executable, ["session", "list", "--json"], {
    cwd: entry.cwd ?? repoRoot,
    env: { ...process.env, ...entry.env },
  }).catch(() => ({ stdout: "" }));
  if (!result.stdout.trim()) return false;
  try {
    const value = JSON.parse(result.stdout) as {
      sessions?: Array<{ name?: string; running?: boolean }>;
    };
    return (
      value.sessions?.some((session) => session.name === name && session.running === true) ?? false
    );
  } catch {
    return false;
  }
}

async function processStatus(entry: ProcessState): Promise<ProcessStatus> {
  const sessionName = herdrSessionName(entry);
  if (sessionName && (await herdrSessionRunning(entry, sessionName))) return "running";
  if (!alive(entry.pid)) return "stopped";
  if (await linuxProcessHasExited(entry.pid)) return "stopped";
  if (await verifyLinuxProcess(entry)) return "running";
  if (await linuxProcessHasExited(entry.pid)) return "stopped";
  return alive(entry.pid) ? "unknown" : "stopped";
}

async function knownProcessStatus(entry: ProcessState): Promise<"running" | "stopped"> {
  const status = await processStatus(entry);
  if (status !== "unknown") return status;
  throw new Error(
    `Cannot verify ${entry.name} PID ${entry.pid}; service state was preserved. ` +
      "Inspect and stop the original service through its verified owner before retrying. " +
      "Do not delete the record or adopt the current PID as proof of ownership.",
  );
}

async function runningState(state: ProcessState[]): Promise<ProcessState[]> {
  const running: ProcessState[] = [];
  for (const entry of state)
    if ((await knownProcessStatus(entry)) === "running") running.push(entry);
  return running;
}

async function startProcess(name: ProcessName, config: ProcessConfig): Promise<ProcessState> {
  if (!(await stat(config.executable)).isFile())
    throw new Error(`${name} executable is unavailable`);
  if (config.cwd && !(await stat(config.cwd)).isDirectory())
    throw new Error(`${name} working directory is unavailable`);
  const descriptor = openSync(logPath, "a");
  try {
    const child = spawn(config.executable, config.args, {
      cwd: config.cwd ?? repoRoot,
      detached: true,
      stdio: ["ignore", descriptor, descriptor],
      env: { ...process.env, ...config.env, GLASSBOX_DATA_DIR: dataDirectory },
    });
    if (!child.pid) throw new Error(`${name} did not start`);
    child.unref();
    let linuxIdentity =
      process.platform === "linux" ? await readLinuxProcessIdentity(child.pid) : undefined;
    if (child.exitCode !== null || child.signalCode !== null) linuxIdentity = undefined;
    return {
      name,
      ...config,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      ...(linuxIdentity === undefined ? {} : { linuxIdentity }),
    };
  } finally {
    closeSync(descriptor);
  }
}

function endpointAvailable(endpoint: string | { host: string; port: number }): Promise<boolean> {
  return new Promise((resolveAvailable) => {
    const socket =
      typeof endpoint === "string"
        ? net.createConnection(endpoint)
        : net.createConnection(endpoint.port, endpoint.host);
    const done = (available: boolean) => {
      socket.destroy();
      resolveAvailable(available);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForDataLockRelease(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const lockfilePath = join(dataDirectory, "server.lock");
  while (Date.now() < deadline) {
    if (!(await lockfile.check(dataDirectory, { lockfilePath, stale: 10_000 }))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("Previous Glassbox service still owns the data directory");
}

async function waitFor(
  entry: ProcessState,
  probe: () => Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await knownProcessStatus(entry)) === "stopped")
      throw new Error(`${entry.name} exited before ${description}`);
    if (await probe()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error(`${entry.name} did not become ${description}`);
}

async function herdrEndpoint(): Promise<string | undefined> {
  try {
    const value = JSON.parse(
      await readFile(join(dataDirectory, "agent-operations.json"), "utf8"),
    ) as Record<string, unknown>;
    if (typeof value.socketPath !== "string" || !isAbsolute(value.socketPath)) return undefined;
    return value.socketPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Invalid agent operations configuration");
  }
}

async function stopEntry(entry: ProcessState): Promise<void> {
  const sessionName = herdrSessionName(entry);
  if (sessionName && (await herdrSessionRunning(entry, sessionName))) {
    await execFile(entry.executable, ["session", "stop", sessionName], {
      cwd: entry.cwd ?? repoRoot,
      env: { ...process.env, ...entry.env },
    });
    const deadline = Date.now() + 10_000;
    while ((await herdrSessionRunning(entry, sessionName)) && Date.now() < deadline)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    if (await herdrSessionRunning(entry, sessionName))
      throw new Error(`Herdr session ${sessionName} did not stop`);
    return;
  }
  if ((await knownProcessStatus(entry)) === "stopped") return;
  process.kill(entry.pid, "SIGTERM");
  const gracefulDeadline = Date.now() + 5_000;
  const stillRunning = async () => (await knownProcessStatus(entry)) === "running";
  while ((await stillRunning()) && Date.now() < gracefulDeadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  if (!(await stillRunning())) return;
  if ((await knownProcessStatus(entry)) === "stopped") return;
  process.kill(entry.pid, "SIGKILL");
  const forcedDeadline = Date.now() + 5_000;
  while ((await stillRunning()) && Date.now() < forcedDeadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  if (await stillRunning()) throw new Error(`${entry.name} did not stop`);
}

async function up(options: StartOptions = {}): Promise<void> {
  const checkout = await checkoutRoot(options.checkout);
  await assertDatabaseCompatible(checkout);
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const prior = await loadState();
  const live = await runningState(prior);
  await writeState(live);
  const config = await loadConfig();
  const desired: Array<[ProcessName, ProcessConfig | undefined]> = [
    ["herdr", config.herdr],
    ["napcat", options.skipNapcat ? undefined : config.napcat],
    [
      "glassbox",
      {
        executable: process.execPath,
        args: ["--import", "tsx", join(checkout, "apps/server/src/index.ts")],
        cwd: checkout,
        env: config.glassbox?.env,
      },
    ],
  ];
  const started: ProcessState[] = [];
  try {
    for (const [name, item] of desired) {
      if (!item || live.some((entry) => entry.name === name)) continue;
      if (name === "glassbox") await waitForDataLockRelease();
      const entry = await startProcess(name, item);
      live.push(entry);
      started.push(entry);
      await writeState(live);
      if (process.platform === "linux" && (await knownProcessStatus(entry)) === "stopped")
        throw new Error(`${name} exited during startup`);
      if (name === "herdr") {
        const endpoint = await herdrEndpoint();
        if (endpoint)
          await waitFor(entry, () => endpointAvailable(endpoint), "ready for Glassbox connections");
      }
      if (name === "glassbox") {
        const portText = item.env?.PORT ?? process.env.PORT ?? "3030";
        if (!/^\d{1,5}$/u.test(portText) || Number(portText) < 1 || Number(portText) > 65535)
          throw new Error("Glassbox service mode requires PORT between 1 and 65535");
        await waitFor(
          entry,
          () => endpointAvailable({ host: "127.0.0.1", port: Number(portText) }),
          "ready for connections",
          60_000,
        );
      }
    }
  } catch (error) {
    for (const entry of [...started].reverse()) await stopEntry(entry);
    await writeState(live.filter((entry) => !started.includes(entry)));
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ status: "started", processes: live.map(({ name, pid }) => ({ name, pid })), logPath })}\n`,
  );
}

async function switchCheckout(options: StartOptions = {}): Promise<void> {
  const checkout = await checkoutRoot(options.checkout);
  await assertDatabaseCompatible(checkout);
  const prior = await loadState();
  const live = await runningState(prior);
  const previous = live.find((entry) => entry.name === "glassbox");
  let stoppedPrevious = false;
  try {
    if (previous) {
      await stopEntry(previous);
      stoppedPrevious = true;
      await writeState(live.filter((entry) => entry !== previous));
    }
    await up({ ...options, checkout });
  } catch (error) {
    if (!previous || !stoppedPrevious) throw error;
    try {
      const current = await loadState();
      if ((await runningState(current)).some((entry) => entry.name === "glassbox"))
        throw new Error("Cannot restore the previous checkout while Glassbox is still running");
      const config = await loadConfig();
      await waitForDataLockRelease();
      // The candidate may have migrated shared data before failing. Never blindly restart
      // an older checkout or restore an old snapshot over newer durable state.
      if (!previous.cwd) throw new Error("Cannot verify previous checkout for rollback");
      await assertDatabaseCompatible(await checkoutRoot(previous.cwd));
      const restored = await startProcess("glassbox", {
        executable: previous.executable,
        args: previous.args,
        cwd: previous.cwd,
        env: { ...previous.env, ...config.glassbox?.env },
      });
      await writeState([...current, restored]);
      const port = Number(restored.env?.PORT ?? "3030");
      await waitFor(
        restored,
        () => endpointAvailable({ host: "127.0.0.1", port }),
        "restored after failed checkout switch",
        60_000,
      );
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Checkout switch and rollback failed");
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ status: "switched", checkout })}\n`);
}

async function status(): Promise<void> {
  const state = await loadState();
  const config = await loadConfig();
  const processes = await Promise.all(
    state.map(async (entry) => {
      const status = await processStatus(entry);
      return {
        name: entry.name,
        ...(alive(entry.pid) ? { pid: entry.pid } : {}),
        running: status === "running",
        status,
        ...(entry.name === "glassbox" ? { checkout: entry.cwd ?? null } : {}),
      };
    }),
  );
  const port = Number(config.glassbox?.env?.PORT ?? process.env.PORT ?? "3030");
  const glassboxReady =
    Number.isInteger(port) && port > 0 && port <= 65535
      ? await endpointAvailable({ host: "127.0.0.1", port })
      : false;
  const onebotReady = await endpointAvailable({ host: "127.0.0.1", port: 6700 });
  process.stdout.write(
    `${JSON.stringify({ dataDirectory, configPath, processes, glassboxReady, onebotReady }, null, 2)}\n`,
  );
}

async function down(): Promise<void> {
  const state = await loadState();
  await runningState(state);
  for (const entry of [...state].reverse()) await stopEntry(entry);
  await rm(statePath, { force: true });
  await rm(priorStatePath, { force: true });
  process.stdout.write(`${JSON.stringify({ status: "stopped" })}\n`);
}

async function logs(): Promise<void> {
  const content = await readFile(logPath, "utf8").catch(() => "");
  process.stdout.write(content.split(/\r?\n/u).slice(-200).join("\n"));
}

export async function runServiceCommand(
  command: string | undefined,
  args: string[],
): Promise<void> {
  const startOptions: StartOptions = {};
  if (command === "up" || command === "switch") {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--skip-napcat") startOptions.skipNapcat = true;
      else if (args[index] === "--checkout" && args[index + 1])
        startOptions.checkout = args[++index];
      else throw new Error("Unsupported service option");
    }
  } else if (args.length > 0) throw new Error("This service command does not accept options");
  if (command === "up") await up(startOptions);
  else if (command === "switch") await switchCheckout(startOptions);
  else if (command === "status") await status();
  else if (command === "down") await down();
  else if (command === "logs") await logs();
  else throw new Error("Use up, switch, status, down, or logs");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runServiceCommand(process.argv[2], process.argv.slice(3));
