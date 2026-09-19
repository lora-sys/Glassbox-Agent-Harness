import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { WebSocketServer } from "ws";
import { ModelProfileStore } from "../config/model-profiles.js";
import { createManagementAccess } from "../management/access.js";
import { createManagementHandler } from "../management/http.js";
import { ManagementApplication } from "../management/application.js";
import { runCli } from "./run.ts";

describe("CLI with the shared local management server", () => {
  it("saves and manages a channel over HTTP using only a disposable local OneBot peer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-cli-channel-"));
    const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    peer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        const action = JSON.parse(bytes.toString("utf8")) as { action: string; echo: string };
        socket.send(
          JSON.stringify({ echo: action.echo, status: "ok", retcode: 0, data: { user_id: 10001 } }),
        );
      });
    });
    await once(peer, "listening");
    const models = await ModelProfileStore.open(directory);
    const execute = vi.fn(async () => ({ status: "succeeded" as const, text: "unused fixture" }));
    const app = await ManagementApplication.open({
      dataDirectory: directory,
      databasePath: ":memory:",
      models,
      executors: new Map([["claude-code", { supportsGroup: true, execute }]]),
    });
    const token = "m".repeat(43);
    let port = 0;
    const handler = createManagementHandler({
      models,
      status: () => ({ status: "ready" }),
      doctor: () => ({ checks: [] }),
      route: (request) => app.route(request),
      authorize(request) {
        createManagementAccess({ token, allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [] })(
          request,
        );
      },
    });
    const http = createServer((request, response) => {
      void handler(request, response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(0, "127.0.0.1", resolve);
      });
      port = (http.address() as AddressInfo).port;
      const endpoint = `ws://127.0.0.1:${(peer.address() as AddressInfo).port}/`;
      const input = {
        id: "qq-test",
        label: "Disposable channel",
        kind: "qq-onebot",
        endpoint,
        botId: "10001",
        ownerId: "10002",
        groupIds: ["10003"],
        executionRef: "claude-code",
        token: "disposable-onebot-token",
      };
      const outputs: string[] = [];
      const dependencies = {
        resolveConnection: async () => ({ baseUrl: `http://127.0.0.1:${port}`, token }),
        readInput: async () => JSON.stringify(input, null, 2),
        stdout: (text: string) => {
          outputs.push(text);
        },
        stderr: (text: string) => {
          outputs.push(text);
        },
      };
      const last = () =>
        JSON.parse(outputs.at(-1) ?? "") as {
          ok: boolean;
          data: { channel: { connectionState: string; autoConnect: boolean }; channels: unknown[] };
          error?: { code: string };
        };
      expect(await runCli(["channels", "save", "--json"], dependencies)).toBe(0);
      expect(last().data.channel).toMatchObject({
        connectionState: "disconnected",
        autoConnect: false,
      });
      expect(await runCli(["channels", "list", "--json"], dependencies)).toBe(0);
      expect(last().data.channels).toEqual(app.listChannels());
      expect(await runCli(["channels", "connect", "qq-test", "--json"], dependencies)).toBe(0);
      expect(last().data.channel).toMatchObject({
        connectionState: "connected",
        autoConnect: true,
      });
      expect(await runCli(["channels", "save", "--json"], dependencies)).toBe(1);
      expect(last().error?.code).toBe("CHANNEL_ACTIVE");
      expect(await runCli(["channels", "disconnect", "qq-test", "--json"], dependencies)).toBe(0);
      expect(last().data.channel).toMatchObject({
        connectionState: "disconnected",
        autoConnect: false,
      });
      expect(await runCli(["conversations", "list", "--json"], dependencies)).toBe(0);
      expect(await runCli(["runs", "list", "--json"], dependencies)).toBe(0);
      expect(execute).not.toHaveBeenCalled();
      expect(outputs.join("")).not.toContain(input.token);
      expect(outputs.join("")).not.toContain(token);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      for (const socket of peer.clients) socket.terminate();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists a model once and reads the same public configuration over HTTP and after reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-cli-integration-"));
    const outputs: string[] = [];
    const token = "a".repeat(43);
    let port = 0;
    const models = await ModelProfileStore.open(directory);
    const handler = createManagementHandler({
      models,
      authorize(request) {
        createManagementAccess({ token, allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [] })(
          request,
        );
      },
      status: () => ({ status: "ready" }),
      doctor: () => ({ checks: [] }),
    });
    const server = createServer((request, response) => {
      void handler(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected an ephemeral TCP port");
      port = address.port;
      const dependencies = {
        resolveConnection: async () => ({ baseUrl: `http://127.0.0.1:${port}`, token }),
        readSecret: async () => "disposable-model-key",
        stdout: (text: string) => {
          outputs.push(text);
        },
        stderr: (text: string) => {
          outputs.push(text);
        },
      };
      expect(
        await runCli(
          [
            "models",
            "set",
            "integration",
            "--label",
            "Disposable profile",
            "--protocol",
            "openai-completions",
            "--base-url",
            "https://api.example.test/v1",
            "--model",
            "fake-model",
            "--api-key-stdin",
            "--json",
          ],
          dependencies,
        ),
      ).toBe(0);
      expect(await runCli(["models", "list", "--json"], dependencies)).toBe(0);
      const saved = JSON.parse(outputs[0] ?? "").data.profile;
      const listed = JSON.parse(outputs[1] ?? "").data.profiles;
      expect(listed).toEqual([saved]);
      expect(saved.credentialConfigured).toBe(true);
      expect((await ModelProfileStore.open(directory)).list()).toEqual(listed);
      expect(outputs.join("")).not.toContain("disposable-model-key");
      expect(outputs.join("")).not.toContain(token);
      expect(await runCli(["runs", "list", "--json"], dependencies)).toBe(1);
      expect(JSON.parse(outputs[2] ?? "")).toMatchObject({
        ok: false,
        error: { code: "NOT_AVAILABLE" },
      });
      expect(
        await runCli(["models", "list", "--json"], {
          ...dependencies,
          resolveConnection: async () => ({
            baseUrl: `http://127.0.0.1:${port}`,
            token: "wrong-key",
          }),
        }),
      ).toBe(1);
      expect(JSON.parse(outputs[3] ?? "")).toMatchObject({
        ok: false,
        error: { code: "AUTH_REQUIRED" },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
