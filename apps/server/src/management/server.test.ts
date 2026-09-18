import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { openManagementRuntime, serverPort } from "./runtime.js";

const execute = promisify(execFile);
const factory = vi.hoisted(() => ({ calls: 0, stop: vi.fn() }));
vi.mock("../provider/index.js", () => ({
  createAdapter: () => ({
    start() {
      if (factory.calls++ === 0) throw new Error("fixture start failure");
    },
    initialize: () => Promise.resolve({}),
    stop: factory.stop,
  }),
}));

describe("local service integration", () => {
  let directory: string;
  let application: typeof import("../index.js");
  let baseUrl: string;
  let token: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "glassbox-service-"));
    vi.stubEnv("GLASSBOX_DATA_DIR", directory);
    for (const name of ["CODEX", "CLAUDE", "DEMO"])
      vi.stubEnv(`GLASSBOX_WORKSPACE_${name}`, join(directory, name));
    application = await import("../index.js");
    const service = await application.startServer({
      port: 0,
      quiet: true,
      databasePath: ":memory:",
    });
    baseUrl = service.baseUrl;
    token = (await readFile(service.credentialFile, "utf8")).trim();
  });
  afterAll(async () => {
    await application?.stopServer();
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const headers = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

  it("starts without a provider and protects both management and retained Workbench", async () => {
    expect(factory.calls).toBe(0);
    for (const path of ["/manage/status", "/", "/trace/fixture"]) {
      expect((await fetch(`${baseUrl}${path}`)).status).toBe(401);
    }
    const response = await fetch(`${baseUrl}/manage/status`, { headers: headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({
      service: "glassbox",
      capabilities: { modelConfiguration: true, channels: true },
    });
    expect(
      (
        await fetch(`${baseUrl}/manage/models`, {
          headers: { ...headers(), origin: "https://untrusted.example" },
        })
      ).status,
    ).toBe(403);
  });

  it("retains exclusive data ownership across ports", async () => {
    await expect(
      openManagementRuntime({
        dataDirectory: directory,
        hosts: ["localhost:9999"],
        origins: [],
        status: () => ({}),
        doctor: () => ({}),
      }),
    ).rejects.toMatchObject({ code: "ELOCKED" });
  });

  it("keeps Ops grant and revoke actions behind management authentication", async () => {
    for (const path of ["/manage/ops/grants", "/manage/ops/grants/example/revoke"]) {
      expect(
        (
          await fetch(`${baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await fetch(`${baseUrl}/manage/ops/grants`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ principalId: "owner", actions: ["raw-shell"] }),
        })
      ).status,
    ).toBe(400);
  });

  it("CLI reads the same profiles without exposing credentials", async () => {
    const response = await fetch(`${baseUrl}/manage/models`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        id: "test-model",
        label: "测试模型",
        protocol: "openai-completions",
        baseUrl: "https://model.invalid/v1",
        model: "fixture",
        apiKey: "private-fixture-key",
      }),
    });
    expect(response.status).toBe(200);
    const { stdout, stderr } = await execute(
      process.execPath,
      ["--import", "tsx", "apps/server/src/cli.ts", "models", "list", "--json"],
      { env: { ...process.env, PORT: new URL(baseUrl).port }, timeout: 10000 },
    );
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      data: { profiles: [{ id: "test-model", credentialConfigured: true }] },
    });
    expect(stdout).not.toContain("private-fixture-key");
    expect(stdout).not.toContain(token);
  });

  it("requires a fresh session-bound ticket for WebSocket access", async () => {
    const connect = (suffix: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws${suffix}`);
        socket.once("open", () => resolve(socket));
        socket.once("error", reject);
      });
    await expect(connect("?sessionId=fixture")).rejects.toThrow();
    const response = await fetch(`${baseUrl}/manage/ws-ticket`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ sessionId: "fixture" }),
    });
    const body = (await response.json()) as { ticket: string };
    const socket = await connect(`?sessionId=fixture&ticket=${body.ticket}`);
    const rejected = new Promise<string>((resolve) => {
      socket.on("message", (raw) => {
        const value = raw instanceof Buffer ? raw.toString("utf8") : "";
        if (value.includes("session access denied")) resolve(value);
      });
    });
    socket.send(JSON.stringify({ action: "subscribe", sessionId: "another-session" }));
    expect(await rejected).toContain("session access denied");
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
    await expect(connect(`?sessionId=fixture&ticket=${body.ticket}`)).rejects.toThrow();
  });

  it("does not cache a synchronous provider startup failure", async () => {
    await expect(application.getOrInitAdapter("codex")).rejects.toThrow("fixture start failure");
    expect(factory.stop).toHaveBeenCalledTimes(1);
    await expect(application.getOrInitAdapter("codex")).resolves.toBeDefined();
    expect(factory.calls).toBe(2);
  });

  it("releases ownership and accepts requests after a clean restart", async () => {
    await application.stopServer();
    const service = await application.startServer({
      port: 0,
      quiet: true,
      databasePath: ":memory:",
    });
    baseUrl = service.baseUrl;
    expect((await fetch(`${baseUrl}/manage/models`, { headers: headers() })).status).toBe(200);
    expect((await readFile(service.credentialFile, "utf8")).trim()).toBe(token);
  });
});

it("validates port and directory before opening runtime state", async () => {
  for (const port of ["3000extra", "-1", "65536", "3.5", ""])
    expect(() => serverPort(port)).toThrow();
  expect(serverPort("0")).toBe(0);
  await expect(
    openManagementRuntime({
      dataDirectory: "relative",
      hosts: [],
      origins: [],
      status: () => ({}),
      doctor: () => ({}),
    }),
  ).rejects.toThrow("absolute");
});
