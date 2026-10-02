import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it, vi } from "vite-plus/test";
import { runFixtureProcess } from "./test-fixture-process.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { createRequire: vi.fn(actual.createRequire) };
});

it("passes an encoded file URL to --import, including native Windows drive paths", async ({
  signal,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-process-loader-"));
  try {
    const loader = join(directory, "loader with spaces #100%.mjs");
    const script = join(directory, "proof.mjs");
    await writeFile(loader, "export {};");
    await writeFile(script, "console.log('loaded');");
    const { createRequire: actualCreateRequire } =
      await vi.importActual<typeof import("node:module")>("node:module");
    vi.mocked(createRequire).mockImplementationOnce((filename) => {
      const require = actualCreateRequire(filename);
      require.resolve = Object.assign(() => loader, {
        paths: require.resolve.paths.bind(require.resolve),
      });
      return require;
    });

    expect(await runFixtureProcess(pathToFileURL(script), [], signal)).toBe("loaded\n");
    const args = vi.mocked(spawn).mock.lastCall?.[1];
    expect(args?.[0]).toBe("--import");
    const importUrl = args?.[1];
    expect(importUrl).toBe(pathToFileURL(loader).href);
    expect(importUrl).toContain("file:///");
    expect(importUrl).toContain("loader%20with%20spaces%20%23100%25.mjs");
    expect(fileURLToPath(importUrl!)).toBe(loader);
    if (process.platform === "win32") expect(importUrl).toMatch(/^file:\/\/\/[A-Za-z]:\//);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("returns fixture output only after the child has exited", async ({ signal }) => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-process-proof-"));
  try {
    const script = join(directory, "proof.mjs");
    await writeFile(script, "console.log(JSON.stringify({ pid: process.pid }));");
    const proof = JSON.parse(await runFixtureProcess(pathToFileURL(script), [], signal)) as {
      pid: number;
    };
    expect(Number.isInteger(proof.pid)).toBe(true);
    expect(() => process.kill(proof.pid, 0)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("propagates a child fixture assertion failure", async ({ signal }) => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-process-failure-"));
  try {
    const script = join(directory, "failure.mjs");
    await writeFile(
      script,
      "import assert from 'node:assert/strict'; assert.equal('actual', 'expected', 'fixture assertion failed');",
    );
    await expect(runFixtureProcess(pathToFileURL(script), [], signal)).rejects.toThrow(
      "fixture assertion failed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("waits for a cancelled child's close before rejecting the caller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-process-cancel-"));
  const marker = join(directory, "exited.txt");
  let release = () => {};
  let exited = Promise.resolve();
  let ready: (pid: number) => void = () => {};
  const started = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const controller = new AbortController();
  const { spawn: actualSpawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  try {
    const script = join(directory, "cancel.mjs");
    await writeFile(
      script,
      `
      import { writeFileSync } from 'node:fs';
      process.stdin.resume();
      process.stdin.on('end', () => { writeFileSync(${JSON.stringify(marker)}, 'exited'); process.exit(0); });
      process.stdout.write('ready');
    `,
    );
    vi.mocked(spawn).mockImplementationOnce((command, args, options) => {
      // Model Node's abort error before its later close, without relying on
      // platform-specific signals. This child exits only when the test releases stdin.
      const child = actualSpawn(command, args ?? [], {
        ...options,
        signal: undefined,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.once("data", () => ready(child.pid!));
      options?.signal?.addEventListener(
        "abort",
        () => {
          child.emit("error", Object.assign(new Error("Fixture aborted"), { name: "AbortError" }));
        },
        { once: true },
      );
      release = () => {
        child.stdin.end();
      };
      exited = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      return child;
    });
    const operation = runFixtureProcess(pathToFileURL(script), [], controller.signal);
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const pid = await started;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(existsSync(marker)).toBe(false);
    release();
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(marker, "utf8")).toBe("exited");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    release();
    await exited;
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
