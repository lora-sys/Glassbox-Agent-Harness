import { readFile, writeFile } from "node:fs/promises";
import { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createApplicationFixtureScope } from "../management/application-test-helpers.js";
import type { ExecutionInput } from "../execution/run-service/types.js";
import { PiRunExecutionAdapter } from "../runtime/pi/run-adapter.js";
import {
  canonicalQqLiveToolsSha256,
  canonicalQqLiveTextSha256,
  QqLiveLeaseRegistry,
  type QqLiveLeaseBinding,
} from "./qq-live-lease.js";
import type { PiRunContext } from "../runtime/pi/types.js";
import { OWNER_MODEL_ADMIN_TOOL } from "../runtime/pi/owner-model-tools.js";

const fixtures = createApplicationFixtureScope();
const piModelProfile = {
  id: "lease-fixture",
  label: "Lease fixture",
  protocol: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
  model: "fixture-model",
  apiKey: null,
  supportsTools: true,
  contextWindowTokens: 8_192,
  maxOutputTokens: 1_024,
};

afterEach(async () => {
  vi.restoreAllMocks();
  await fixtures.afterEachCleanup();
});

describe("QQ live lease application wiring", () => {
  it("denies unregistered marked private and group messages before creating Runs", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile: piModelProfile },
    );
    const before = (await fixture.app.store.management.listRuns("owner")).items.length;
    fixture.send(
      702,
      "GLASSBOX_ACCEPTANCE_V1 11112222333344445555666677778888\nprivate test",
      true,
    );
    fixture.send(703, "GLASSBOX_ACCEPTANCE_V1 88887777666655554444333322221111\ngroup test", false);
    await vi.waitFor(async () => {
      const audit = await readFile(
        join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
        "utf8",
      );
      expect(audit).toContain('"messageId":"702"');
      expect(audit).toContain('"messageId":"703"');
      expect(audit.match(/"event":"message_denied"/gu)).toHaveLength(2);
    });
    expect((await fixture.app.store.management.listRuns("owner")).items).toHaveLength(before);
    const audit = await readFile(join(fixture.directory, "qq-live-acceptance-audit.jsonl"), "utf8");
    expect(audit).not.toContain("private test");
    expect(audit).not.toContain("group test");
  });

  it("registers through management, then accepts and binds the exact Pi message", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    const marker = "1234567890abcdef1234567890abcdef";
    const text = `GLASSBOX_ACCEPTANCE_V1 ${marker}\nReply with one word.`;
    const registration = await fixture.app.registerQqLiveLease({
      scope: {
        connectionId: "fixture",
        botId: "10001",
        chatType: "private",
        chatId: "10002",
        senderId: "10002",
      },
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
      ttlMs: 60_000,
      expiresAt: Date.now() + 60_000,
      tools: [],
    });
    expect(registration.toolsSha256).toBe(canonicalQqLiveToolsSha256([]));
    expect(registration.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
    fixture.send(704, text, true);
    const acceptedScope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private" as const,
      chatId: "10002",
      senderId: "10002",
    };
    await vi.waitFor(async () => {
      const audit = await readFile(
        join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
        "utf8",
      );
      expect(audit).toContain('"event":"run_bound"');
      expect(audit).toContain('"messageId":"704"');
      expect(audit).toContain(`"toolsSha256":"${registration.toolsSha256}"`);
    });
    const latest = (await fixture.app.store.management.listRuns("owner")).items[0];
    if (!latest) throw new Error("marked message did not create a Run");
    const auditEvents = (
      await readFile(join(fixture.directory, "qq-live-acceptance-audit.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const runBound = auditEvents.find((event) => event.event === "run_bound");
    expect(runBound).toMatchObject({
      messageId: "704",
      runId: latest.id,
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
    });
    expect(JSON.stringify(runBound)).not.toContain("Reply with one word.");
    expect(JSON.stringify(runBound)).not.toContain(text);
    if (latest && (latest.status === "queued" || latest.status === "running"))
      await fixture.app.runs.cancel(
        (await fixture.app.store.identities.resolve(acceptedScope))!,
        latest.id,
      );
    await vi.waitFor(async () => {
      const terminalAudit = await readFile(
        join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
        "utf8",
      );
      expect(terminalAudit).toContain('"event":"lease_revoked"');
    });
    const internals = fixture.app as unknown as {
      qqLiveLeases: QqLiveLeaseRegistry;
      qqLiveRunBindings: Map<string, unknown>;
    };
    expect(
      internals.qqLiveLeases.isActive({
        leaseId: registration.leaseId,
        principalId: "owner",
        scope: acceptedScope,
        messageId: "704",
        runId: latest.id,
      }),
    ).toBe(false);
    expect(internals.qqLiveRunBindings.has(latest.id)).toBe(false);
  });

  it("revokes a lease when a queued Run finishes before its binding is recorded", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    const marker = "fedcba0987654321fedcba0987654321";
    const text = `GLASSBOX_ACCEPTANCE_V1 ${marker}\nReply with one word.`;
    const registration = await fixture.app.registerQqLiveLease({
      scope: {
        connectionId: "fixture",
        botId: "10001",
        chatType: "private",
        chatId: "10002",
        senderId: "10002",
      },
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
      ttlMs: 60_000,
      expiresAt: Date.now() + 60_000,
      tools: [],
    });
    const conversations = fixture.app.store.conversations;
    const acceptIncoming = conversations.acceptIncoming.bind(conversations);
    let completeInterleaving!: (result: { runId: string; error?: unknown }) => void;
    const interleavingComplete = new Promise<{ runId: string; error?: unknown }>(
      (resolve) => (completeInterleaving = resolve),
    );
    vi.spyOn(conversations, "acceptIncoming").mockImplementation(async (input) => {
      const accepted = await acceptIncoming(input);
      try {
        await fixture.app.runs.enqueueAccepted(accepted);
        const terminalRun = await fixture.app.runs.waitForRun(accepted.caller, accepted.run.id);
        expect(terminalRun).toMatchObject({ status: "failed", failureCode: "gate_refused" });
        await fixture.app.runs.drain();
        completeInterleaving({ runId: accepted.run.id });
      } catch (error) {
        completeInterleaving({ runId: accepted.run.id, error });
      }
      return accepted;
    });

    fixture.send(705, text, true);
    const interleaving = await interleavingComplete;
    if (interleaving.error) throw interleaving.error;
    const terminalRunId = interleaving.runId;
    await vi.waitFor(async () => {
      const audit = await readFile(
        join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
        "utf8",
      );
      expect(audit).toContain('"event":"run_bound"');
      expect(audit).toContain('"event":"lease_revoked"');
    });

    const internals = fixture.app as unknown as {
      qqLiveLeases: QqLiveLeaseRegistry;
      qqLiveRunBindings: Map<string, unknown>;
    };
    const acceptedScope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private" as const,
      chatId: "10002",
      senderId: "10002",
    };
    expect(
      internals.qqLiveLeases.isActive({
        leaseId: registration.leaseId,
        principalId: "owner",
        scope: acceptedScope,
        messageId: "705",
        runId: terminalRunId!,
      }),
    ).toBe(false);
    expect(internals.qqLiveRunBindings.has(terminalRunId!)).toBe(false);
  });

  it("revokes a lease and refuses the Run when run-bound audit persistence fails", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    const executeSpy = vi.spyOn(PiRunExecutionAdapter.prototype, "execute");
    const marker = "0123456789abcdef0123456789abcdef";
    const text = `GLASSBOX_ACCEPTANCE_V1 ${marker}\nReply with one word.`;
    const registration = await fixture.app.registerQqLiveLease({
      scope: {
        connectionId: "fixture",
        botId: "10001",
        chatType: "private",
        chatId: "10002",
        senderId: "10002",
      },
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
      ttlMs: 60_000,
      expiresAt: Date.now() + 60_000,
      tools: [],
    });
    const appOptions = (fixture.app as unknown as { options: { dataDirectory: string } }).options;
    const originalDataDirectory = appOptions.dataDirectory;
    const nonDirectoryPath = join(fixture.directory, "audit-path-is-a-file");
    await writeFile(nonDirectoryPath, "isolated test fixture", "utf8");
    appOptions.dataDirectory = nonDirectoryPath;
    try {
      fixture.send(706, text, true);
      let terminalRun:
        | Awaited<ReturnType<typeof fixture.app.store.management.listRuns>>["items"][number]
        | undefined;
      await vi.waitFor(async () => {
        terminalRun = (await fixture.app.store.management.listRuns("owner")).items[0];
        expect(terminalRun).toMatchObject({ status: "failed", failureCode: "gate_refused" });
      });
      const failedRun = terminalRun;
      if (!failedRun) throw new Error("audit failure did not create a Run");

      const internals = fixture.app as unknown as {
        qqLiveLeases: QqLiveLeaseRegistry;
        qqLiveRunBindings: Map<string, unknown>;
      };
      expect(
        internals.qqLiveLeases.isActive({
          leaseId: registration.leaseId,
          principalId: "owner",
          scope: {
            connectionId: "fixture",
            botId: "10001",
            chatType: "private",
            chatId: "10002",
            senderId: "10002",
          },
          messageId: "706",
          runId: failedRun.id,
        }),
      ).toBe(false);
      expect(internals.qqLiveRunBindings.has(failedRun.id)).toBe(false);
      await vi.waitFor(async () => {
        const trace = await fixture.app.trace.readPage(failedRun.id);
        expect(trace.records.map((record) => record.event)).toContainEqual(
          expect.objectContaining({
            type: "run_finished",
            status: "failed",
            failureCode: "gate_refused",
          }),
        );
      });
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      appOptions.dataDirectory = originalDataDirectory;
      executeSpy.mockRestore();
    }
    const audit = await readFile(join(fixture.directory, "qq-live-acceptance-audit.jsonl"), "utf8");
    expect(audit).toContain('"event":"lease_registered"');
    expect(audit).not.toContain('"event":"run_bound"');
  });

  it("refuses a queued marker Run after restart when its in-memory lease is lost", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile, persistentDatabase: true },
    );
    const executeSpy = vi.spyOn(PiRunExecutionAdapter.prototype, "execute");
    const marker = "abcdef0123456789abcdef0123456789";
    const text = `GLASSBOX_ACCEPTANCE_V1 ${marker}\nReply with one word.`;
    await fixture.app.registerQqLiveLease({
      scope: {
        connectionId: "fixture",
        botId: "10001",
        chatType: "private",
        chatId: "10002",
        senderId: "10002",
      },
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
      ttlMs: 60_000,
      expiresAt: Date.now() + 60_000,
      tools: [],
    });
    vi.spyOn(fixture.app.runs, "enqueueAccepted").mockResolvedValue();
    fixture.send(707, text, true);

    let queuedRun:
      | Awaited<ReturnType<typeof fixture.app.store.management.listRuns>>["items"][number]
      | undefined;
    await vi.waitFor(async () => {
      queuedRun = (await fixture.app.store.management.listRuns("owner")).items[0];
      expect(queuedRun?.status).toBe("queued");
      const audit = await readFile(
        join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
        "utf8",
      );
      expect(audit).toContain('"event":"run_bound"');
    });
    const acceptedRun = queuedRun;
    if (!acceptedRun) throw new Error("marked message did not create a queued Run");
    await vi.waitFor(async () => {
      const trace = await fixture.app.trace.readPage(acceptedRun.id);
      expect(trace.records.map((record) => record.event)).toContainEqual(
        expect.objectContaining({ type: "message_received", externalId: "707" }),
      );
    });

    const reopened = await fixture.reopen();
    const caller = await reopened.store.identities.resolve({
      connectionId: "fixture",
      botId: "10001",
      chatType: "private",
      chatId: "10002",
      senderId: "10002",
    });
    if (!caller) throw new Error("Owner caller was not restored");
    const recoveredRun = await reopened.runs.waitForRun(caller, acceptedRun.id);
    expect(recoveredRun).toMatchObject({ status: "failed", failureCode: "gate_refused" });
    await vi.waitFor(async () => {
      const trace = await reopened.trace.readPage(acceptedRun.id);
      expect(trace.records.map((record) => record.event)).toContainEqual(
        expect.objectContaining({
          type: "run_finished",
          status: "failed",
          failureCode: "gate_refused",
        }),
      );
    });
    expect(executeSpy).not.toHaveBeenCalled();
    executeSpy.mockRestore();
  });

  it("cancels a registration held across async Owner resolution", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    const marker = "abcdef0123456789abcdef0123456789";
    const text = `GLASSBOX_ACCEPTANCE_V1 ${marker}`;
    let signalStarted!: () => void;
    let releaseResolution!: () => void;
    const started = new Promise<void>((resolve) => (signalStarted = resolve));
    const holdResolution = new Promise<void>((resolve) => (releaseResolution = resolve));
    const identities = fixture.app.store.identities;
    const originalResolve = identities.resolve.bind(identities);
    vi.spyOn(identities, "resolve").mockImplementation(async (channelScope) => {
      signalStarted();
      await holdResolution;
      return originalResolve(channelScope);
    });

    const registration = fixture.app.registerQqLiveLease({
      scope: {
        connectionId: "fixture",
        botId: "10001",
        chatType: "private",
        chatId: "10002",
        senderId: "10002",
      },
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
      ttlMs: 60_000,
      expiresAt: Date.now() + 60_000,
      tools: [],
    });
    await started;
    await expect(fixture.app.revokeQqLiveLeaseByMarker(marker)).resolves.toEqual({
      revoked: false,
      active: false,
    });
    releaseResolution();
    await expect(registration).rejects.toThrow("Lease could not be registered");
  });

  it("routes lease registration and confirms both revocation forms", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    const body = (marker: string, tools: unknown[] = []) => {
      const text = `GLASSBOX_ACCEPTANCE_V1 ${marker}`;
      return {
        scope: {
          connectionId: "fixture",
          botId: "10001",
          chatType: "private",
          chatId: "10002",
          senderId: "10002",
        },
        marker,
        textSha256: canonicalQqLiveTextSha256(text),
        ttlMs: 60_000,
        expiresAt: Date.now() + 60_000,
        tools,
      };
    };
    const request = (method: string, url: string, value?: unknown) => {
      const readable = Readable.from(
        value === undefined ? [] : [Buffer.from(JSON.stringify(value))],
      );
      return Object.assign(readable, {
        method,
        url,
        headers: { "content-type": "application/json" },
      }) as IncomingMessage;
    };
    const registeredById = await fixture.app.route(
      request("POST", "/manage/qq-live/leases", body("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
    );
    if (!registeredById) throw new Error("missing lease management route response");
    const id = (registeredById.body as { leaseId: string }).leaseId;
    await expect(
      fixture.app.route(request("DELETE", `/manage/qq-live/leases/${id}`)),
    ).resolves.toMatchObject({ body: { revoked: true, active: false } });

    await fixture.app.route(
      request(
        "POST",
        "/manage/qq-live/leases",
        body("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [
          {
            name: "qq_account_status",
            operations: [
              {
                action: "account:status:read",
                resourceId: "agent:personal",
                inputConstraint: { operation: "get_status" },
              },
            ],
          },
          {
            name: "qq_groups",
            operations: [
              { action: "group:read", resourceId: "agent:personal", inputConstraint: {} },
            ],
          },
        ]),
      ),
    );
    await expect(
      fixture.app.route(
        request("DELETE", "/manage/qq-live/leases/by-marker/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      ),
    ).resolves.toMatchObject({ body: { revoked: true, active: false } });
    await expect(
      fixture.app.route(
        request("DELETE", "/manage/qq-live/leases/by-marker/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      ),
    ).resolves.toMatchObject({ body: { revoked: false, active: false } });
  });

  it("intersects the real app Tool surface and checks its protected call", async () => {
    const fixture = await fixtures.fixture(async (input) => ({
      status: "succeeded",
      text: input.text,
    }));
    fixture.send(701, "prepare a regular Owner run", true);
    const input = await fixture.started.take();
    await fixture.reply("prepare a regular Owner run");

    const marker = "00112233445566778899aabbccddeeff";
    const text = `GLASSBOX_ACCEPTANCE_V1 ${marker}\nList available models.`;
    const api = fixture.app as unknown as {
      qqLiveLeases: QqLiveLeaseRegistry;
      qqLiveRunBindings: Map<string, QqLiveLeaseBinding & { marker: string; toolsSha256: string }>;
      resolveQqLiveRunLease(input: ExecutionInput): PiRunContext["acceptanceLease"] | undefined;
      createRuntimeTools(getContext: () => PiRunContext | undefined): ToolDefinition[];
    };
    const lease = api.qqLiveLeases.register({
      principalId: input.caller.principalId,
      scope: input.caller.scope,
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
      ttlMs: 60_000,
      expiresAt: Date.now() + 60_000,
      tools: [
        {
          name: OWNER_MODEL_ADMIN_TOOL,
          operations: [
            {
              action: "model:read",
              resourceId: "owner-control",
              inputConstraint: { action: "list" },
            },
          ],
        },
      ],
    });
    const inbound = api.qqLiveLeases.resolveInbound({
      principalId: input.caller.principalId,
      scope: input.caller.scope,
      messageId: "701",
      text,
    });
    expect(inbound).toMatchObject({
      kind: "acceptance",
      leaseId: lease.leaseId,
      toolsSha256: lease.toolsSha256,
    });
    if (inbound.kind !== "acceptance") throw new Error("lease inbound was not accepted");
    const binding = {
      leaseId: lease.leaseId,
      principalId: input.caller.principalId,
      scope: input.caller.scope,
      messageId: "701",
      runId: input.run.id,
    };
    expect(api.qqLiveLeases.bindRun(binding)).toBe(true);
    api.qqLiveRunBindings.set(input.run.id, {
      ...binding,
      marker,
      toolsSha256: inbound.toolsSha256,
    });
    const acceptanceLease = api.resolveQqLiveRunLease(input);
    expect(acceptanceLease).toBeDefined();
    expect(acceptanceLease?.toolsSha256).toBe(lease.toolsSha256);

    const context: PiRunContext = {
      caller: input.caller,
      conversationId: input.conversation.id,
      runId: input.run.id,
      acceptanceLease,
    };
    const candidates = await fixture.app.resolveRunToolCandidates(context);
    expect(
      candidates
        .filter((candidate) => candidate.exclusion === null)
        .map((candidate) => candidate.name),
    ).toEqual([OWNER_MODEL_ADMIN_TOOL]);

    const tool = api
      .createRuntimeTools(() => context)
      .find((entry) => entry.name === OWNER_MODEL_ADMIN_TOOL);
    if (!tool) throw new Error("missing Owner model Tool");
    await expect(
      tool.execute("list", { action: "list" }, undefined, undefined, {} as never),
    ).resolves.toBeDefined();
    await expect(
      tool.execute(
        "select",
        { action: "select", profileId: "fixture" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("acceptance_lease_denied");
  });

  it("refuses to register a lease for a direct execution backend", async () => {
    const fixture = await fixtures.fixture(async (input) => ({
      status: "succeeded",
      text: input.text,
    }));
    const marker = "ffeeddccbbaa99887766554433221100";
    await expect(
      fixture.app.registerQqLiveLease({
        scope: {
          connectionId: "fixture",
          botId: "10001",
          chatType: "private",
          chatId: "10002",
          senderId: "10002",
        },
        marker,
        textSha256: canonicalQqLiveTextSha256(`GLASSBOX_ACCEPTANCE_V1 ${marker}`),
        ttlMs: 10_000,
        expiresAt: Date.now() + 10_000,
        tools: [],
      }),
    ).rejects.toThrow("configured Pi channel");
  });
});
