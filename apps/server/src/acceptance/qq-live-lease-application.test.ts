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
import { scopeKey } from "../identity/scope.js";

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
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("isolated provider fixture"));
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
    const caller = await fixture.app.store.identities.resolve(acceptedScope);
    if (!caller) throw new Error("Owner caller was not restored");
    const terminal = await fixture.app.runs.waitForRun(caller, latest.id);
    expect(terminal.status).not.toBe("queued");
    const terminalAudit = await readFile(
      join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
      "utf8",
    );
    expect(terminalAudit).toContain('"event":"lease_revoked"');
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

  it("holds an early queued acceptance Run until its exact binding is ready", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("isolated provider fixture"));
    const captureSpy = vi.spyOn(fixture.app.store.learning, "captureCurrentMessage");
    const scope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private" as const,
      chatId: "10002",
      senderId: "10002",
    };
    const caller = await fixture.app.store.identities.resolve(scope);
    if (!caller) throw new Error("Owner caller was not restored");

    fixture.send(708, "我喜欢简洁的回答。", true);
    let ordinaryRun:
      | Awaited<ReturnType<typeof fixture.app.store.management.listRuns>>["items"][number]
      | undefined;
    await vi.waitFor(async () => {
      ordinaryRun = (await fixture.app.store.management.listRuns("owner")).items[0];
      expect(ordinaryRun?.status).not.toBe("queued");
      expect(ordinaryRun?.status).not.toBe("running");
      expect(ordinaryRun?.status).not.toBe("cancelling");
      expect(captureSpy).toHaveBeenCalledTimes(1);
    });
    if (!ordinaryRun) throw new Error("ordinary Owner message did not create a Run");
    const ordinaryCandidates = await fixture.app.store.learning.listCandidates({ caller });
    expect(
      ordinaryCandidates.some((candidate) => candidate.source.ref === "run:" + ordinaryRun!.id),
    ).toBe(true);

    const marker = "aabbccddeeff00112233445566778899";
    const acceptanceText = "GLASSBOX_ACCEPTANCE_V1 " + marker + "\n我喜欢简洁的回答。";
    const internals = fixture.app as unknown as {
      qqLiveLeases: QqLiveLeaseRegistry;
      qqLiveRunBindings: Map<string, unknown>;
      qqLiveAcceptanceHandoffs: Map<
        string,
        {
          key: string;
          principalId: string;
          scope: typeof scope;
          messageId: string;
          leaseId: string;
          textSha256: string;
          settled: boolean;
          promise: Promise<
            | {
                runId: string;
                runMessageId: string;
                messageId: string;
                textSha256: string;
              }
            | undefined
          >;
        }
      >;
    };
    const registration = await fixture.app.registerQqLiveLease({
      scope,
      marker,
      textSha256: canonicalQqLiveTextSha256(acceptanceText),
      ttlMs: 60_000,
      expiresAt: Date.now() + 60_000,
      tools: [],
    });
    const runOptions = (
      fixture.app.runs as unknown as {
        options: {
          beforeExecution: (input: ExecutionInput) => Promise<unknown>;
          captureLearning: (input: ExecutionInput) => Promise<string | undefined>;
        };
      }
    ).options;
    const beforeExecution = runOptions.beforeExecution;
    let gateInput: ExecutionInput | undefined;
    let gateResult: unknown;
    let leaseActiveAtGateReturn = false;
    let handoffAtGate:
      | {
          key: string;
          principalId: string;
          scope: typeof scope;
          messageId: string;
          leaseId: string;
          textSha256: string;
          settled: boolean;
          promise: Promise<unknown>;
        }
      | undefined;
    const beforeExecutionSpy = vi.fn(async (input: ExecutionInput) => {
      if (input.text === acceptanceText) {
        gateInput = input;
        handoffAtGate = [...internals.qqLiveAcceptanceHandoffs.values()].find(
          (handoff) => !handoff.settled,
        );
      }
      const result = await beforeExecution(input);
      if (input.text === acceptanceText) {
        gateResult = result;
        leaseActiveAtGateReturn = internals.qqLiveLeases.isActive({
          leaseId: registration.leaseId,
          principalId: "owner",
          scope,
          messageId: "709",
          runId: input.run.id,
        });
      }
      return result;
    });
    runOptions.beforeExecution = beforeExecutionSpy;
    const captureLearning = runOptions.captureLearning;
    const captureLearningSpy = vi.fn(captureLearning);
    runOptions.captureLearning = captureLearningSpy;

    const conversations = fixture.app.store.conversations;
    const acceptIncoming = conversations.acceptIncoming.bind(conversations);
    vi.spyOn(conversations, "acceptIncoming").mockImplementation(async (input) => {
      const accepted = await acceptIncoming(input);
      if (input.messageId === "709") {
        // Reproduce a queue poll seeing the committed Run before the ingress callback
        // receives the accepted row and installs its authenticated handoff.
        await fixture.app.runs.enqueueAccepted(accepted);
        await vi.waitFor(() => expect(beforeExecutionSpy).toHaveBeenCalled());
      }
      return accepted;
    });

    fixture.send(709, acceptanceText, true);
    let acceptanceRun:
      | Awaited<ReturnType<typeof fixture.app.store.management.listRuns>>["items"][number]
      | undefined;
    await vi.waitFor(async () => {
      const audit = await readFile(
        join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
        "utf8",
      );
      const bound = audit
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string; messageId?: string; runId?: string })
        .find((event) => event.event === "run_bound" && event.messageId === "709");
      expect(bound?.runId).toBeTruthy();
      acceptanceRun = bound?.runId
        ? (await fixture.app.store.management.listRuns("owner")).items.find(
            (run) => run.id === bound.runId,
          )
        : undefined;
      expect(acceptanceRun).toBeDefined();
    });
    if (!acceptanceRun) throw new Error("acceptance message did not create a Run");
    await vi.waitFor(() => expect(captureLearningSpy).toHaveBeenCalledTimes(1));

    expect(beforeExecutionSpy).toHaveBeenCalled();
    expect(gateInput?.run.id).toBe(acceptanceRun.id);
    expect(handoffAtGate).toBeDefined();
    expect(handoffAtGate?.key).toBe(
      JSON.stringify([
        gateInput?.caller.principalId,
        scopeKey(gateInput!.caller.scope),
        gateInput?.caller.scope.senderId,
        canonicalQqLiveTextSha256(gateInput?.text ?? ""),
      ]),
    );
    const handoffBinding = await handoffAtGate?.promise;
    expect(gateResult).toBeUndefined();
    expect(leaseActiveAtGateReturn).toBe(true);
    expect(handoffBinding).toMatchObject({
      runId: acceptanceRun.id,
      runMessageId: gateInput?.run.messageId,
      messageId: "709",
      textSha256: canonicalQqLiveTextSha256(acceptanceText),
    });
    expect(captureLearningSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const candidatesAfterAcceptance = await fixture.app.store.learning.listCandidates({ caller });
    expect(candidatesAfterAcceptance).toEqual(ordinaryCandidates);
  });

  it("refuses an acceptance Run before learning when its lease expires at the execution gate", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    const scope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private" as const,
      chatId: "10002",
      senderId: "10002",
    };
    const marker = "99887766554433221100ffeeddccbbaa";
    const acceptanceText = "GLASSBOX_ACCEPTANCE_V1 " + marker + "\nReply with one word.";
    const internals = fixture.app as unknown as { qqLiveLeases: QqLiveLeaseRegistry };
    let clockNow = Date.now();
    internals.qqLiveLeases = new QqLiveLeaseRegistry({ now: () => clockNow });
    const registration = await fixture.app.registerQqLiveLease({
      scope,
      marker,
      textSha256: canonicalQqLiveTextSha256(acceptanceText),
      ttlMs: 60_000,
      expiresAt: clockNow + 60_000,
      tools: [],
    });
    const captureSpy = vi.spyOn(fixture.app.store.learning, "captureCurrentMessage");
    const executeSpy = vi.spyOn(PiRunExecutionAdapter.prototype, "execute");
    const runOptions = (
      fixture.app.runs as unknown as {
        options: { beforeExecution: (input: ExecutionInput) => Promise<unknown> };
      }
    ).options;
    const beforeExecution = runOptions.beforeExecution;
    let gateCalled = false;
    runOptions.beforeExecution = vi.fn(async (input: ExecutionInput) => {
      if (input.text === acceptanceText) {
        gateCalled = true;
        clockNow = registration.expiresAt + 1;
      }
      return beforeExecution(input);
    });

    fixture.send(710, acceptanceText, true);
    let runId: string | undefined;
    await vi.waitFor(async () => {
      const audit = await readFile(
        join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
        "utf8",
      );
      const bound = audit
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string; messageId?: string; runId?: string })
        .find((event) => event.event === "run_bound" && event.messageId === "710");
      runId = bound?.runId;
      expect(runId).toBeTruthy();
    });
    if (!runId) throw new Error("expired acceptance message did not create a Run");
    const caller = await fixture.app.store.identities.resolve(scope);
    if (!caller) throw new Error("Owner caller was not restored");
    const terminalRun = await fixture.app.runs.waitForRun(caller, runId);
    expect(terminalRun).toMatchObject({ status: "failed", failureCode: "gate_refused" });
    expect(gateCalled).toBe(true);
    expect(captureSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
    const trace = await fixture.app.trace.readPage(runId);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "run_finished",
        status: "failed",
        failureCode: "gate_refused",
      }),
    );
  });

  it("does not capture learning if the lease is revoked after pre-execution validation", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    const scope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private" as const,
      chatId: "10002",
      senderId: "10002",
    };
    const marker = "1029384756abcdef1029384756abcdef";
    const text = "GLASSBOX_ACCEPTANCE_V1 " + marker + "\nReply with one word.";
    const registration = await fixture.app.registerQqLiveLease({
      scope,
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
      ttlMs: 60_000,
      expiresAt: Date.now() + 60_000,
      tools: [],
    });
    const internals = fixture.app as unknown as { qqLiveLeases: QqLiveLeaseRegistry };
    const captureSpy = vi.spyOn(fixture.app.store.learning, "captureCurrentMessage");
    const runOptions = (
      fixture.app.runs as unknown as {
        options: {
          beforeExecution: (input: ExecutionInput) => Promise<unknown>;
          captureLearning: (input: ExecutionInput) => Promise<string | undefined>;
        };
      }
    ).options;
    const beforeExecution = runOptions.beforeExecution;
    let guardedRunId: string | undefined;
    runOptions.beforeExecution = vi.fn(async (input: ExecutionInput) => {
      if (input.text === text) guardedRunId = input.run.id;
      return beforeExecution(input);
    });
    const captureLearning = runOptions.captureLearning;
    const captureLearningSpy = vi.fn(captureLearning);
    runOptions.captureLearning = captureLearningSpy;

    const authorization = fixture.app.store.authorization;
    const originalCheck = authorization.check.bind(authorization);
    let revokedAtFreshAuthorization = false;
    vi.spyOn(authorization, "check").mockImplementation(async (input) => {
      if (
        guardedRunId &&
        input.runId === guardedRunId &&
        input.action === "run:create" &&
        !revokedAtFreshAuthorization
      ) {
        revokedAtFreshAuthorization = true;
        internals.qqLiveLeases.revoke(registration.leaseId);
      }
      return originalCheck(input);
    });

    fixture.send(711, text, true);
    let runId: string | undefined;
    await vi.waitFor(async () => {
      const audit = await readFile(
        join(fixture.directory, "qq-live-acceptance-audit.jsonl"),
        "utf8",
      );
      const bound = audit
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string; messageId?: string; runId?: string })
        .find((event) => event.event === "run_bound" && event.messageId === "711");
      runId = bound?.runId;
      expect(runId).toBeTruthy();
    });
    if (!runId) throw new Error("revoked acceptance message did not create a Run");
    const caller = await fixture.app.store.identities.resolve(scope);
    if (!caller) throw new Error("Owner caller was not restored");
    const terminalRun = await fixture.app.runs.waitForRun(caller, runId);
    expect(terminalRun).toMatchObject({ status: "failed", failureCode: "gate_refused" });
    expect(revokedAtFreshAuthorization).toBe(true);
    expect(captureLearningSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).not.toHaveBeenCalled();
    const candidates = await fixture.app.store.learning.listCandidates({ caller });
    expect(candidates).toEqual([]);
  });

  it("refuses an early queued Run if its lease expires before handoff completion", async () => {
    const fixture = await fixtures.fixture(
      async (input) => ({ status: "succeeded", text: input.text }),
      { executionRef: "pi:lease-fixture", piModelProfile },
    );
    const scope = {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private" as const,
      chatId: "10002",
      senderId: "10002",
    };
    const marker = "fedcba0987654321fedcba0987654321";
    const text = "GLASSBOX_ACCEPTANCE_V1 " + marker + "\nReply with one word.";
    let clockNow = Date.now();
    const internals = fixture.app as unknown as {
      qqLiveLeases: QqLiveLeaseRegistry;
      qqLiveRunBindings: Map<string, unknown>;
    };
    internals.qqLiveLeases = new QqLiveLeaseRegistry({ now: () => clockNow });
    const registration = await fixture.app.registerQqLiveLease({
      scope,
      marker,
      textSha256: canonicalQqLiveTextSha256(text),
      ttlMs: 60_000,
      expiresAt: clockNow + 60_000,
      tools: [],
    });
    const captureSpy = vi.spyOn(fixture.app.store.learning, "captureCurrentMessage");
    const executeSpy = vi.spyOn(PiRunExecutionAdapter.prototype, "execute");
    const runOptions = (
      fixture.app.runs as unknown as {
        options: { beforeExecution: (input: ExecutionInput) => Promise<unknown> };
      }
    ).options;
    const beforeExecution = runOptions.beforeExecution;
    let signalGateStarted!: () => void;
    const gateStarted = new Promise<void>((resolve) => (signalGateStarted = resolve));
    runOptions.beforeExecution = vi.fn(async (input: ExecutionInput) => {
      if (input.text === text) signalGateStarted();
      return beforeExecution(input);
    });

    const conversations = fixture.app.store.conversations;
    const acceptIncoming = conversations.acceptIncoming.bind(conversations);
    vi.spyOn(conversations, "acceptIncoming").mockImplementation(async (input) => {
      const accepted = await acceptIncoming(input);
      if (input.messageId === "705") {
        await fixture.app.runs.enqueueAccepted(accepted);
        await gateStarted;
        clockNow = registration.expiresAt + 1;
      }
      return accepted;
    });

    fixture.send(705, text, true);
    let queuedRun:
      | Awaited<ReturnType<typeof fixture.app.store.management.listRuns>>["items"][number]
      | undefined;
    await vi.waitFor(async () => {
      queuedRun = (await fixture.app.store.management.listRuns("owner")).items[0];
      expect(queuedRun).toBeDefined();
    });
    if (!queuedRun) throw new Error("queued acceptance message did not create a Run");
    const runId = queuedRun.id;
    const caller = await fixture.app.store.identities.resolve(scope);
    if (!caller) throw new Error("Owner caller was not restored");
    const terminalRun = await fixture.app.runs.waitForRun(caller, runId);
    expect(terminalRun).toMatchObject({ status: "failed", failureCode: "gate_refused" });
    expect(captureSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
    expect(
      internals.qqLiveLeases.isActive({
        leaseId: registration.leaseId,
        principalId: "owner",
        scope,
        messageId: "705",
        runId,
      }),
    ).toBe(false);
    expect(internals.qqLiveRunBindings.has(runId)).toBe(false);
    const audit = await readFile(join(fixture.directory, "qq-live-acceptance-audit.jsonl"), "utf8");
    expect(audit).toContain('"event":"message_denied"');
    expect(audit).toContain('"reason":"run_binding_failed"');
    expect(audit).not.toContain('"event":"run_bound"');
    const trace = await fixture.app.trace.readPage(runId);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "run_finished",
        status: "failed",
        failureCode: "gate_refused",
      }),
    );
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
    // This test models a process exit before queued work is dispatched. Disable the durable
    // poller too, or a slow Windows test run can dispatch the Run before reopen().
    await fixture.app.runs.stop();
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
    const captureSpy = vi.spyOn(reopened.store.learning, "captureCurrentMessage");
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
    expect(captureSpy).not.toHaveBeenCalled();
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
    ).rejects.toThrow("acceptance_lease_action_mismatch");
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
