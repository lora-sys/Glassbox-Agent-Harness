import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import { WebSocketServer, type WebSocket } from "ws";
import { ModelProfileStore } from "../config/model-profiles.js";
import { createManagementAccess } from "../management/access.js";
import { createManagementHandler } from "../management/http.js";
import { ManagementApplication } from "../management/application.js";
import type { ExecutionInput } from "../execution/run-service/types.js";
import { groupResourceId } from "../retrieval/source-resolver.js";
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
    let peerSocket: WebSocket | undefined;
    // The real completion signal for the Owner's message: the reply reached the peer. Waiting
    // for it keeps the run's own provider calls out of every measurement below.
    let resolveReplyDelivered: () => void = () => undefined;
    const replyDelivered = new Promise<void>((resolve) => {
      resolveReplyDelivered = resolve;
    });
    peer.on("connection", (socket) => {
      peerSocket = socket;
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
        if (action.action === "send_private_msg") resolveReplyDelivered();
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
    // The Run the Owner's real message starts. The group assignment below is made *in* it, by
    // the real Owner Action, so the acceptance is measured against authority that came from the
    // product rather than from the fixture writing grants into the database directly.
    let ownerRun: ExecutionInput | undefined;
    let resolveOwnerRun: () => void = () => undefined;
    const ownerRunStarted = new Promise<void>((resolve) => {
      resolveOwnerRun = resolve;
    });
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
            execute: async (input: ExecutionInput) => {
              ownerRun = input;
              resolveOwnerRun();
              return { status: "succeeded" as const, text: "unused fixture" };
            },
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

      // One real Owner-private message, so there is a real Run to assign the group in. It comes
      // before the first probe so nothing the message itself causes is mistaken for the
      // acceptance's own provider calls.
      peerSocket?.send(
        JSON.stringify({
          post_type: "message",
          self_id: 10001,
          user_id: 10002,
          message_id: 1,
          message_type: "private",
          sub_type: "friend",
          anonymous: null,
          message: [{ type: "text", data: { text: "assign the acceptance group" } }],
        }),
      );
      await ownerRunStarted;
      await replyDelivered;

      // Acceptance is not a way around the product's authorization. The group is configured for
      // this Channel, but the Owner has not assigned it, so it has no grants at all: every path
      // is refused, nothing is called, and no report can show the bridge working for a read no
      // Run could perform. A probe that succeeded here would be evidence of the opposite of
      // what acceptance is for.
      const beforeAssign = calls.length;
      expect(
        await runCli(["capabilities", "probe", "qq-test", "10003", "--json"], dependencies),
      ).toBe(0);
      const unassigned = last().data.probe;
      expect(unassigned.observations).toHaveLength(7);
      // Every path that targets the group is refused, because a group the Owner has not
      // assigned has no grants. The one path that is not refused is the provider-free managed
      // listing: it names no group and is authorized on the Agent itself, which the Owner does
      // hold, so it really runs — and reports the empty inventory that is the truth here. The
      // two are told apart on purpose: a refusal to read *this group* is not a refusal to see
      // the Owner's own inventory, and collapsing them would hide which Resource was denied.
      expect(
        unassigned.observations
          .filter((entry) => entry.providerBacked)
          .map((entry) => entry.outcome),
      ).toEqual(Array.from({ length: 6 }, () => "denied"));
      expect(unassigned.observations.find((entry) => entry.operation === null)).toMatchObject({
        tool: "qq_groups",
        groupId: null,
        providerBacked: false,
        outcome: "success",
      });
      // A refusal produced no result, so there is nothing to describe — a shape here would have
      // to come from a call that never happened.
      expect(
        unassigned.observations
          .filter((entry) => entry.outcome === "denied")
          .every((entry) => entry.resultShape === null),
      ).toBe(true);
      expect(unassigned.summary.providerBackedSucceeded).toBe(0);
      expect(unassigned.complete).toBe(false);
      expect(calls).toHaveLength(beforeAssign);

      // Assigning the group is what lets a Run read it, and the acceptance follows the same
      // rule rather than a looser one: the real Owner action, inside the real Run the Owner's
      // message started, then the same seven paths.
      const run = ownerRun;
      if (!run) throw new Error("Expected the Owner message to start a Run");
      await (
        app as unknown as {
          setGroupAccess(
            context: { caller: ExecutionInput["caller"]; conversationId: string; runId: string },
            input: { groupId: string; enabled: boolean },
          ): Promise<unknown>;
        }
      ).setGroupAccess(
        { caller: run.caller, conversationId: run.conversation.id, runId: run.run.id },
        { groupId: "10003", enabled: true },
      );

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
      // `get_group_info` appears twice: once for the acceptance's own metadata path, and once
      // more because the managed listing below is built from the Owner's real inventory, and
      // describing an assigned group's live name is itself a `group:read` provider call.
      expect(calls.slice(before).sort()).toEqual([
        "_get_group_notice",
        "get_essence_msg_list",
        "get_group_info",
        "get_group_info",
        "get_group_member_list",
        "get_group_msg_history",
        "get_group_root_files",
      ]);

      // The managed listing is a local projection, and it is reported as one: its success is
      // not counted as proof that the provider works.
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

      // The evidence describes the result and never carries it. Both probes are in the Trace —
      // the refused one and the successful one — so a reader can tell that the acceptance ran
      // before the group was assigned and what it said at the time.
      const recorded = await app.store.tasks.listTraceEvents({ type: "capability.probed" });
      expect(recorded).toHaveLength(unassigned.observations.length + probe.observations.length);
      // The refusals are in the Trace too, so a reader can tell the acceptance ran against a
      // group the Owner had not assigned and what it said at the time.
      expect(recorded.filter((event) => event.data.outcome === "denied")).toHaveLength(
        unassigned.observations.filter((entry) => entry.outcome === "denied").length,
      );
      expect(recorded.every((event) => event.data.connectionId === "qq-test")).toBe(true);
      expect(recorded.every((event) => event.principalId === "owner")).toBe(true);
      expect(JSON.stringify(recorded)).not.toContain(peerOnly);
      expect(outputs.join("")).not.toContain(peerOnly);
      expect(outputs.join("")).not.toContain(token);

      // Authority comes from the grant, not from the durable policy row. This withdraws exactly
      // the grants the assignment made — the same revocation the real disable path performs —
      // while leaving the transport group configured and the group's own policy still enabling
      // every category. Nothing but the grant changed, so the acceptance must follow the grant:
      // this is the one state where asking the authorization question and reading the Owner's
      // policy give different answers, and a leftover policy row keeping reads alive after the
      // assignment is gone is exactly the failure that would hide.
      await app.store.authorization.revokeScope({
        principalId: run.caller.principalId,
        resourceId: groupResourceId("10003"),
        scope: run.caller.scope,
      });
      const afterRevoke = calls.length;
      expect(
        await runCli(["capabilities", "probe", "qq-test", "10003", "--json"], dependencies),
      ).toBe(0);
      const withdrawn = last().data.probe;
      expect(
        withdrawn.observations
          .filter((entry) => entry.providerBacked)
          .map((entry) => entry.outcome),
      ).toEqual(Array.from({ length: 6 }, () => "denied"));
      expect(withdrawn.summary.providerBackedSucceeded).toBe(0);
      expect(withdrawn.complete).toBe(false);
      expect(calls).toHaveLength(afterRevoke);

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
