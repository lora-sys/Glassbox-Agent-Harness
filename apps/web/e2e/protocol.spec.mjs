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

test("Workbench retains approvals and running state across continued turns", async ({ page }) => {
  let socket;
  let socketCount = 0;
  let closed = false;
  let steerRequests = 0;
  await page.route("**/api/run-demo", (route) =>
    route.fulfill({ json: { sessionId: "continuation-fixture", workspace: "/tmp/fixture" } }),
  );
  await page.routeWebSocket("**/ws?sessionId=continuation-fixture", (route) => {
    socket = route;
    socketCount++;
    route.onClose(() => {
      closed = true;
    });
    route.send(JSON.stringify({ type: "subscribed", sessionId: "continuation-fixture" }));
  });
  await page.route("**/api/steer", async (route) => {
    steerRequests++;
    if (steerRequests === 1)
      socket.send(
        JSON.stringify({
          type: "approval",
          itemId: "continued-approval",
          turnId: "turn-2",
          threadId: "thread",
          reason: "continued turn edit review",
          startedAtMs: 1,
          grantRoot: null,
        }),
      );
    await route.fulfill({
      json: { turnId: "turn-2", turnStatus: steerRequests === 1 ? "inProgress" : "completed" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Run demo", exact: true }).click();
  await expect.poll(() => socketCount).toBe(1);
  await expect(page.locator("body")).toContainText("WS connected");
  socket.send(JSON.stringify({ type: "sessionEnded", sessionId: "continuation-fixture" }));
  await expect(page.getByRole("button", { name: "Run demo", exact: true })).toBeEnabled();
  expect(closed).toBe(false);
  await page.getByPlaceholder("Steer: type instruction...").fill("continue with review");
  await page.getByPlaceholder("Steer: type instruction...").press("Enter");
  await expect.poll(() => steerRequests).toBe(1);
  await expect(page.locator("body")).toContainText("continued turn edit review");
  socket.send(
    JSON.stringify({
      type: "event",
      event: { method: "turn/completed", params: { turnId: "turn-2" } },
    }),
  );
  await expect(page.getByRole("button", { name: "Run demo", exact: true })).toBeEnabled();
  await page.getByPlaceholder("Steer: type instruction...").fill("one more completed turn");
  await page.getByPlaceholder("Steer: type instruction...").press("Enter");
  await expect.poll(() => steerRequests).toBe(2);
  await expect(page.getByRole("button", { name: "Run demo", exact: true })).toBeEnabled();
  expect(socketCount).toBe(1);
  await socket.close();
  await expect(page.locator("body")).toContainText("WS closed");
  await page
    .getByPlaceholder("Steer: type instruction...")
    .fill("must not start while disconnected");
  await page.getByPlaceholder("Steer: type instruction...").press("Enter");
  await expect(page.locator("body")).toContainText("reload this session before continuing");
  expect(steerRequests).toBe(2);
});

test("Workbench keeps a newer turn running and retires old-session approvals", async ({ page }) => {
  const sockets = new Map();
  let resolveSteer;
  const steering = new Promise((resolve) => {
    resolveSteer = resolve;
  });
  let decidePayload;
  let releaseDecision;
  const decisionResponse = new Promise((resolve) => {
    releaseDecision = resolve;
  });
  await page.route("**/api/run-demo", (route) =>
    route.fulfill({ json: { sessionId: "old-session", derivedState: { task: "old task" } } }),
  );
  await page.route("**/api/state/new-session", (route) =>
    route.fulfill({ json: { derivedState: { task: "new task" } } }),
  );
  await page.route("**/api/trace/new-session", (route) => route.fulfill({ json: { entries: [] } }));
  await page.routeWebSocket("**/ws?sessionId=*", (socket) => {
    const sid = new URL(socket.url()).searchParams.get("sessionId");
    sockets.set(sid, socket);
    socket.send(JSON.stringify({ type: "subscribed", sessionId: sid }));
  });
  await page.route("**/api/steer", async (route) => {
    resolveSteer();
    await route.fulfill({ json: { turnId: "new-turn", turnStatus: "inProgress" } });
  });
  await page.route("**/api/decide", async (route) => {
    decidePayload = route.request().postDataJSON();
    await decisionResponse;
    await route.fulfill({ json: { derivedState: { task: "stale decision response" } } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Run demo", exact: true }).click();
  await expect.poll(() => sockets.has("old-session")).toBe(true);
  const socket = sockets.get("old-session");
  socket.send(
    JSON.stringify({
      type: "event",
      event: { method: "turn/started", params: { turnId: "old-turn" } },
    }),
  );
  await page.getByPlaceholder("Steer: type instruction...").fill("redirect the active turn");
  await page.getByPlaceholder("Steer: type instruction...").press("Enter");
  await steering;
  socket.send(
    JSON.stringify({
      type: "event",
      event: { method: "turn/interrupted", params: { turnId: "old-turn" } },
    }),
  );
  socket.send(
    JSON.stringify({
      type: "event",
      event: { method: "turn/started", params: { turnId: "new-turn" } },
    }),
  );
  socket.send(
    JSON.stringify({ type: "sessionEnded", sessionId: "old-session", turnId: "old-turn" }),
  );
  await expect(page.getByRole("button", { name: "Running...", exact: true })).toBeDisabled();
  socket.send(
    JSON.stringify({
      type: "approval",
      itemId: "pending-approval-old",
      turnId: "new-turn",
      threadId: "thread",
      reason: "review this pending change",
      startedAtMs: 1,
      grantRoot: null,
    }),
  );
  await page.getByTestId("canvas").getByText("DECISION NEEDED", { exact: true }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect
    .poll(() => decidePayload)
    .toEqual({ sessionId: "old-session", itemId: "pending-approval-old", approved: true });
  await page.getByPlaceholder("Reopen session...").fill("new-session");
  await page.getByPlaceholder("Reopen session...").press("Enter");
  await expect.poll(() => sockets.has("new-session")).toBe(true);
  await expect(page.getByText(/DECISION NEEDED/)).toHaveCount(0);
  releaseDecision();
  await expect(
    page.getByTestId("canvas").getByText("Task: new task", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Task: stale decision response", { exact: true })).toHaveCount(0);
});
