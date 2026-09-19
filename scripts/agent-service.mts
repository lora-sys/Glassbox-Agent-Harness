import { execFile as execFileCallback, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDirectory = resolve(process.env.GLASSBOX_DATA_DIR ?? join(repoRoot, ".glassbox"));
const statePath = join(dataDirectory, "service-processes.json");
const priorStatePath = `${statePath}.previous`;
const configPath = join(dataDirectory, "service-launch.json");
const logPath = join(dataDirectory, "service.log");
const serviceEnvironmentKeys = new Set([
  "PORT",
  "LORA_PI_KIT_PATH",
  "GLASSBOX_RUNTIME_DIR",
  "GLASSBOX_REPO_ROOT",
  "GLASSBOX_WORKSPACE_CODEX",
  "GLASSBOX_WORKSPACE_CLAUDE",
  "GLASSBOX_WORKSPACE_DEMO",
  "NAPCAT_DISABLE_MULTI_PROCESS",
  "NAPCAT_INJECT_PATH",
  "NAPCAT_WORKDIR",
  "NAPCAT_LOAD_PATH",
  "NAPCAT_MAIN_PATH",
  "NAPCAT_PATCH_PACKAGE",
  "NAPCAT_LAUNCHER_PATH",
]);

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
      (key) => !["name", "pid", "startedAt", "executable", "args", "cwd", "env"].includes(key),
    ) ||
    !["herdr", "napcat", "glassbox"].includes(String(item.name)) ||
    !Number.isSafeInteger(item.pid) ||
    (item.pid as number) < 1 ||
    typeof item.startedAt !== "string" ||
    Number.isNaN(Date.parse(item.startedAt))
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
    ...config,
  };
}

async function loadState(): Promise<ProcessState[]> {
  try {
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
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
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
  } catch {
    return false;
  }
}

function commandHasArgs(commandLine: string, args: readonly string[]): boolean {
  return args.every((arg) => commandLine.includes(arg));
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
    windowsHide: true,
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

async function verified(entry: ProcessState): Promise<boolean> {
  const sessionName = herdrSessionName(entry);
  if (sessionName && (await herdrSessionRunning(entry, sessionName))) return true;
  if (!alive(entry.pid)) return false;
  if (process.platform === "win32") {
    const command =
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${entry.pid}";` +
      "if($p){[pscustomobject]@{ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine}|ConvertTo-Json -Compress}";
    const result = await execFile("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
    }).catch(() => ({ stdout: "" }));
    if (!result.stdout.trim()) return false;
    const processInfo = JSON.parse(result.stdout) as {
      ExecutablePath?: string;
      CommandLine?: string;
    };
    return (
      typeof processInfo.ExecutablePath === "string" &&
      resolve(processInfo.ExecutablePath).toLowerCase() ===
        resolve(entry.executable).toLowerCase() &&
      typeof processInfo.CommandLine === "string" &&
      commandHasArgs(processInfo.CommandLine, entry.args)
    );
  }
  const executable = await realpath(`/proc/${entry.pid}/exe`).catch(() => "");
  const commandLine = await readFile(`/proc/${entry.pid}/cmdline`, "utf8").catch(() => "");
  return (
    executable === (await realpath(entry.executable).catch(() => entry.executable)) &&
    commandHasArgs(commandLine, entry.args)
  );
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
      windowsHide: true,
      stdio: ["ignore", descriptor, descriptor],
      env: { ...process.env, ...config.env, GLASSBOX_DATA_DIR: dataDirectory },
    });
    if (!child.pid) throw new Error(`${name} did not start`);
    child.unref();
    return { name, ...config, pid: child.pid, startedAt: new Date().toISOString() };
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

async function waitFor(
  entry: ProcessState,
  probe: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await verified(entry))) throw new Error(`${entry.name} exited before ${description}`);
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
    if (process.platform !== "win32") return value.socketPath;
    return value.socketPath.startsWith("\\\\.\\pipe\\")
      ? value.socketPath
      : `\\\\.\\pipe\\${resolve(value.socketPath)}`;
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
      windowsHide: true,
    });
    const deadline = Date.now() + 10_000;
    while ((await herdrSessionRunning(entry, sessionName)) && Date.now() < deadline)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    if (await herdrSessionRunning(entry, sessionName))
      throw new Error(`Herdr session ${sessionName} did not stop`);
    return;
  }
  if (!(await verified(entry))) return;
  if (process.platform === "win32") {
    await execFile("taskkill.exe", ["/PID", String(entry.pid), "/T"]).catch(() => undefined);
  } else {
    process.kill(entry.pid, "SIGTERM");
  }
  const gracefulDeadline = Date.now() + 5_000;
  while (alive(entry.pid) && Date.now() < gracefulDeadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  if (!alive(entry.pid)) return;
  if (!(await verified(entry))) return;
  if (process.platform === "win32")
    await execFile("taskkill.exe", ["/PID", String(entry.pid), "/T", "/F"]);
  else process.kill(entry.pid, "SIGKILL");
  const forcedDeadline = Date.now() + 5_000;
  while (alive(entry.pid) && Date.now() < forcedDeadline)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  if (alive(entry.pid)) throw new Error(`${entry.name} did not stop`);
}

async function up(): Promise<void> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const prior = await loadState();
  const live: ProcessState[] = [];
  for (const entry of prior) if (await verified(entry)) live.push(entry);
  await writeState(live);
  const config = await loadConfig();
  const desired: Array<[ProcessName, ProcessConfig | undefined]> = [
    ["herdr", config.herdr],
    ["napcat", config.napcat],
    [
      "glassbox",
      {
        executable: process.execPath,
        args: ["--import", "tsx", join(repoRoot, "apps/server/src/index.ts")],
        cwd: repoRoot,
        env: config.glassbox?.env,
      },
    ],
  ];
  const started: ProcessState[] = [];
  try {
    for (const [name, item] of desired) {
      if (!item || live.some((entry) => entry.name === name)) continue;
      const entry = await startProcess(name, item);
      live.push(entry);
      started.push(entry);
      await writeState(live);
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

async function status(): Promise<void> {
  const state = await loadState();
  const processes = await Promise.all(
    state.map(async (entry) => ({
      name: entry.name,
      ...(alive(entry.pid) ? { pid: entry.pid } : {}),
      running: await verified(entry),
    })),
  );
  process.stdout.write(`${JSON.stringify({ dataDirectory, configPath, processes }, null, 2)}\n`);
}

async function down(): Promise<void> {
  const state = await loadState();
  for (const entry of [...state].reverse()) await stopEntry(entry);
  await rm(statePath, { force: true });
  await rm(priorStatePath, { force: true });
  process.stdout.write(`${JSON.stringify({ status: "stopped" })}\n`);
}

async function logs(): Promise<void> {
  const content = await readFile(logPath, "utf8").catch(() => "");
  process.stdout.write(content.split(/\r?\n/u).slice(-200).join("\n"));
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "status") await status();
else if (command === "down") await down();
else if (command === "logs") await logs();
else throw new Error("Use up, status, down, or logs");
