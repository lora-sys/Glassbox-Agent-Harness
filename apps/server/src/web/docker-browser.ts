import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BrowserCliResult, BrowserCliRunner } from "./browser-bridge.js";
import type { BrowserProxyHandle } from "./browser-proxy.js";

const IMAGE = "glassbox-browser-sandbox:issue20";
const PROXY_ENDPOINT = "http://proxy:8765";
const MAX_DOCKER_OUTPUT = 40_000;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function docker(args: readonly string[], timeoutMs = 30_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      child.kill();
      end(new Error("browser_docker_timeout"));
    }, timeoutMs);
    const end = (error?: Error, code = 1) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ code, stdout, stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(0, MAX_DOCKER_OUTPUT);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, 2_000);
    });
    child.on("error", () => end(new Error("browser_docker_unavailable")));
    child.on("close", (code) => end(undefined, code ?? 1));
  });
}

async function requiredDocker(args: readonly string[], timeoutMs?: number): Promise<string> {
  const result = await docker(args, timeoutMs);
  if (result.code !== 0) throw new Error("browser_docker_failed");
  return result.stdout.trim();
}

/** One Run gets one internal network, one guarded proxy sidecar and one ephemeral browser. */
export class DockerBrowserEnvironment implements BrowserProxyHandle {
  private readonly suffix = randomBytes(8).toString("hex");
  private readonly network = `glassbox-web-${this.suffix}`;
  private readonly proxy = `glassbox-proxy-${this.suffix}`;
  private readonly browser = `glassbox-browser-${this.suffix}`;
  private networkCreated = false;
  private proxyCreated = false;
  private browserCreated = false;
  private started = false;

  readonly run: BrowserCliRunner = async (args, timeoutMs, context): Promise<BrowserCliResult> => {
    if (!this.started || context.proxyServer !== PROXY_ENDPOINT)
      throw new Error("browser_sandbox_not_ready");
    return docker(
      [
        "exec",
        "-e",
        `GLASSBOX_PROXY_SERVER=${PROXY_ENDPOINT}`,
        this.browser,
        "node",
        "/app/cli-entrypoint.mjs",
        ...args,
      ],
      timeoutMs,
    );
  };

  async start(): Promise<string> {
    if (this.started) return PROXY_ENDPOINT;
    try {
      await requiredDocker(["image", "inspect", IMAGE]);
      await requiredDocker(["network", "create", "--internal", "--driver", "bridge", this.network]);
      this.networkCreated = true;
      await requiredDocker([
        "run",
        "--detach",
        "--rm",
        "--name",
        this.proxy,
        "--network",
        this.network,
        "--network-alias",
        "proxy",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=16m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "128m",
        "--pids-limit",
        "64",
        IMAGE,
        "node",
        "/app/proxy-entrypoint.mjs",
      ]);
      this.proxyCreated = true;
      await requiredDocker(["network", "connect", "bridge", this.proxy]);
      await requiredDocker([
        "run",
        "--detach",
        "--rm",
        "--name",
        this.browser,
        "--network",
        this.network,
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=256m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "768m",
        "--pids-limit",
        "128",
        "--shm-size",
        "256m",
        "--user",
        "1000:1000",
        IMAGE,
      ]);
      this.browserCreated = true;
      this.started = true;
      return PROXY_ENDPOINT;
    } catch {
      await this.close();
      throw new Error("browser_sandbox_start_failed");
    }
  }

  async close(): Promise<void> {
    this.started = false;
    if (this.browserCreated) {
      await docker(["stop", "--time", "2", this.browser]).catch(() => undefined);
      this.browserCreated = false;
    }
    if (this.proxyCreated) {
      await docker(["stop", "--time", "2", this.proxy]).catch(() => undefined);
      this.proxyCreated = false;
    }
    if (this.networkCreated) {
      await docker(["network", "rm", this.network]).catch(() => undefined);
      this.networkCreated = false;
    }
  }
}
