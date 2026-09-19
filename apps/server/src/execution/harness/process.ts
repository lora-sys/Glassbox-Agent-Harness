import { spawn } from "node:child_process";
import path from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { HarnessFailure } from "./types.js";

export type ProcessEnd =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "spawn-error" };

export function observeProcess(child: SpawnedProcess & { pid?: number }): Promise<ProcessEnd> {
  if (child.exitCode !== null || child.signalCode) {
    return Promise.resolve({
      kind: "exit",
      code: child.exitCode,
      signal: child.signalCode ?? null,
    });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ kind: "exit", code, signal }));
    child.once("error", () => {
      // A failed spawn has no pid. An error from a running child is not exit evidence.
      if (child.pid === undefined) resolve({ kind: "spawn-error" });
    });
  });
}

async function deadline<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tracks the actual installed child, independently of SDK iterator completion or abort acknowledgement. */
export class InstalledProcess {
  private child?: SpawnedProcess;
  private ended?: Promise<ProcessEnd>;
  private removeSignal?: () => void;

  constructor(
    private readonly config: {
      executablePath: string;
      workspace: string;
      env: Record<string, string>;
    },
  ) {}

  spawn = (options: SpawnOptions): SpawnedProcess => {
    if (this.child) throw new HarnessFailure("ISOLATION_VIOLATION");
    const isScript = /\.(?:mjs|js)$/iu.test(this.config.executablePath);
    if (isScript && path.resolve(options.args[0] ?? "") !== this.config.executablePath) {
      throw new HarnessFailure("ISOLATION_VIOLATION");
    }
    if (!isScript && path.resolve(options.command) !== this.config.executablePath) {
      throw new HarnessFailure("ISOLATION_VIOLATION");
    }
    const child = spawn(isScript ? process.execPath : this.config.executablePath, options.args, {
      cwd: this.config.workspace,
      env: this.config.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    this.ended = observeProcess(child);
    const stop = () => {
      child.kill("SIGTERM");
    };
    options.signal.addEventListener("abort", stop, { once: true });
    if (options.signal.aborted) stop();
    this.removeSignal = () => options.signal.removeEventListener("abort", stop);
    return child;
  };

  get started(): boolean {
    return this.child !== undefined;
  }

  async finish(timeoutMs: number): Promise<ProcessEnd | null> {
    if (!this.child || !this.ended) return null;
    let result = await deadline(this.ended, timeoutMs);
    if (!result) {
      this.child.kill("SIGTERM");
      result = await deadline(this.ended, timeoutMs);
    }
    if (!result) {
      this.child.kill("SIGKILL");
      result = await deadline(this.ended, timeoutMs);
    }
    this.removeSignal?.();
    return result;
  }
}
