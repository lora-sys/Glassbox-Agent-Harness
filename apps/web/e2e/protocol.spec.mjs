import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
let service;
let fixtureRoot;
let credentialFile;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fixtureRoot = await mkdtemp(join(tmpdir(), "glassbox-web-protocol-"));
  service = spawn(
    process.execPath,
    ["--import", "tsx", "apps/web/e2e/fixtures/protocol-server.mts"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        GLASSBOX_DATA_DIR: join(fixtureRoot, "data"),
        GLASSBOX_WORKSPACE_CODEX: join(fixtureRoot, "codex"),
        GLASSBOX_WORKSPACE_CLAUDE: join(fixtureRoot, "claude"),
        GLASSBOX_WORKSPACE_DEMO: join(fixtureRoot, "demo"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  service.stderr.resume();
  const ready = await new Promise((resolveReady, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Isolated server startup timed out")),
      150_000,
    );
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    service.once("error", fail);
    service.once("exit", (code) => fail(new Error(`Isolated server exited: ${code}`)));
    service.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      for (const line of output.split(/\r?\n/)) {
        if (!line.startsWith("E2E_SERVER_READY ")) continue;
        clearTimeout(timeout);
        resolveReady(JSON.parse(line.slice("E2E_SERVER_READY ".length)));
      }
    });
  });
  expect(ready.baseUrl).toBe("http://127.0.0.1:3030");
  credentialFile = ready.credentialFile;
});

test.afterAll(async () => {
  if (service && service.exitCode === null) {
    const exited = new Promise((resolveExit) => service.once("exit", resolveExit));
    service.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
    if (service.exitCode === null) service.kill("SIGKILL");
  }
  if (fixtureRoot) {
    const resolved = resolve(fixtureRoot);
    if (
      resolve(resolved, "..") !== resolve(tmpdir()) ||
      !resolved.split(/[\\/]/).at(-1)?.startsWith("glassbox-web-protocol-")
    )
      throw new Error("Refusing to remove directory outside the test fixture");
    await rm(resolved, { recursive: true, force: true });
  }
});

test("Web proxy reaches the real management HTTP boundary", async ({ page }) => {
  await page.goto("/");
  const token = (await readFile(credentialFile, "utf8")).trim();
  const result = await page.evaluate(async (credential) => {
    const unauthenticated = await fetch("/api/manage/status");
    const unauthorizedBody = await unauthenticated.json();
    const authenticated = await fetch("/api/manage/status", {
      headers: { Authorization: `Bearer ${credential}` },
    });
    return {
      unauthenticated: unauthenticated.status,
      unauthorizedCode: unauthorizedBody.error?.code,
      authenticated: authenticated.status,
      status: (await authenticated.json()).status,
    };
  }, token);
  expect(result).toEqual({
    unauthenticated: 401,
    unauthorizedCode: "UNAUTHORIZED",
    authenticated: 200,
    status: "ready",
  });
});
