import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("really reads one acceptance group and records the observation without its content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-cli-probe-"));
    const calls: string[] = [];
    // A value only the peer could know. If it reaches the CLI output or the Trace, the
    // acceptance copied group content into evidence instead of describing the result's shape.
    const peerOnly = "peer-only-group-content";
    const peer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    peer.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        const action = JSON.parse(bytes.toString("utf8")) as {
          action: string;
          echo: string;
          params: { group_id?: number };
        };
        calls.push(action.action);
        const data =
          action.action === "get_login_info"
            ? { user_id: 10001 }
            : action.action === "get_group_info"
              ? { group_id: action.params.group_id, group_name: peerOnly }
              : action.action === "get_group_member_list"
                ? [{ user_id: 10004, nickname: peerOnly }]
                : action.action === "_get_group_notice"
                  ? { notices: [{ notice_id: 1, message: { text: peerOnly } }] }
                  : action.action === "get_essence_msg_list"
                    ? [{ message_id: 1, content: peerOnly }]
                    : action.action === "get_group_root_files"
                      ? { files: [{ file_name: peerOnly }], folders: [] }
                      : action.action === "get_group_msg_history"
                        ? { messages: [{ message_id: 1, raw_message: peerOnly }] }
                        : {};
        socket.send(JSON.stringify({ echo: action.echo, status: "ok", retcode: 0, data }));
      });
    });
    await once(peer, "listening");
    const models = await ModelProfileStore.open(directory);
    const app = await ManagementApplication.open({
      dataDirectory: directory,
      databasePath: ":memory:",
      kitPath: fileURLToPath(new URL("../runtime/pi/fixtures/lora-pi-kit", import.meta.url)),
      models,
      executors: new Map([
        [
          "claude-code",
          {
            supportsGroup: true,
            execute: async () => ({ status: "succeeded" as const, text: "unused fixture" }),
          },
        ],
      ]),
    });
    const token = "p".repeat(43);
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
      const outputs: string[] = [];
      const dependencies = {
        resolveConnection: async () => ({ baseUrl: `http://127.0.0.1:${port}`, token }),
        readInput: async () =>
          JSON.stringify({
            id: "qq-test",
            label: "Disposable channel",
            kind: "qq-onebot",
            endpoint: `ws://127.0.0.1:${(peer.address() as AddressInfo).port}/`,
            botId: "10001",
            ownerId: "10002",
            groupIds: ["10003"],
            executionRef: "claude-code",
            token: "disposable-onebot-token",
          }),
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
          data: {
            probe: {
              complete: boolean;
              summary: { providerBacked: number; providerBackedSucceeded: number };
              observations: Array<{
                tool: string;
                operation: string | null;
                groupId: string | null;
                providerBacked: boolean;
                outcome: string;
                resultShape: unknown;
              }>;
            };
          };
          error?: { code: string };
        };
      expect(await runCli(["channels", "save", "--json"], dependencies)).toBe(0);
      expect(await runCli(["channels", "connect", "qq-test", "--json"], dependencies)).toBe(0);

      const before = calls.length;
      expect(
        await runCli(["capabilities", "probe", "qq-test", "10003", "--json"], dependencies),
      ).toBe(0);
      const probe = last().data.probe;

      // Every named read path was really attempted against the live peer, and the provider
      // answered each of them: this is what makes the acceptance an observation and not a claim.
      expect(probe.observations).toHaveLength(7);
      expect(probe.summary.providerBacked).toBe(6);
      expect(probe.summary.providerBackedSucceeded).toBe(6);
      expect(probe.complete).toBe(true);
      expect(calls.slice(before).sort()).toEqual([
        "_get_group_notice",
        "get_essence_msg_list",
        "get_group_info",
        "get_group_member_list",
        "get_group_msg_history",
        "get_group_root_files",
      ]);

      // The managed listing is a local projection: it is reported, and it is not counted as
      // proof that the provider works. This Owner has assigned no managed group, so the
      // inventory really is empty — a successful projection, described by its shape.
      expect(probe.observations.find((entry) => entry.operation === null)).toMatchObject({
        tool: "qq_groups",
        groupId: null,
        providerBacked: false,
        outcome: "success",
        resultShape: { kind: "object", fields: ["connectionId", "groups"] },
      });
      expect(
        probe.observations.find((entry) => entry.operation === "get_group_member_list"),
      ).toMatchObject({
        groupId: "10003",
        providerBacked: true,
        outcome: "success",
        resultShape: { kind: "array", count: 1, elementFields: ["nickname", "user_id"] },
      });

      // The evidence describes the result and never carries it.
      const recorded = await app.store.tasks.listTraceEvents({ type: "capability.probed" });
      expect(recorded).toHaveLength(probe.observations.length);
      expect(recorded.every((event) => event.data.connectionId === "qq-test")).toBe(true);
      expect(recorded.every((event) => event.principalId === "owner")).toBe(true);
      expect(JSON.stringify(recorded)).not.toContain(peerOnly);
      expect(outputs.join("")).not.toContain(peerOnly);
      expect(outputs.join("")).not.toContain(token);

      // A probe that cannot reach the named group reports that and calls nothing.
      const afterProbe = calls.length;
      expect(
        await runCli(["capabilities", "probe", "qq-test", "10009", "--json"], dependencies),
      ).toBe(1);
      expect(last().error?.code).toBe("INVALID_REQUEST");
      expect(calls).toHaveLength(afterProbe);

      // An acceptance is only meaningful against a live connection, so a disconnected
      // channel refuses rather than reporting cached health.
      expect(await runCli(["channels", "disconnect", "qq-test", "--json"], dependencies)).toBe(0);
      expect(
        await runCli(["capabilities", "probe", "qq-test", "10003", "--json"], dependencies),
      ).toBe(1);
      expect(last().error?.code).toBe("NOT_FOUND");
      expect(calls).toHaveLength(afterProbe);
    } finally {
      await app.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      for (const socket of peer.clients) socket.terminate();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
