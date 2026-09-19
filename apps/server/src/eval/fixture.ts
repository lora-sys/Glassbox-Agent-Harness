/** Disposable test fixture, never imported by the application. */
import {
  agentResourceId,
  openDomainStore,
  type TrustedChannelScope,
} from "../persistence/index.js";
import { RunTraceStore } from "../trace/run-store.js";
import {
  RunService,
  type ExecutionResult,
  type RunServiceEvent,
  type SendOutcome,
} from "../execution/run-service/index.js";

export const evalGroup: TrustedChannelScope = {
  connectionId: "eval-fixture",
  botId: "eval-bot",
  chatType: "group",
  chatId: "eval-group",
  senderId: "eval-owner",
};
export const evalOwner = { principalId: "owner", scope: evalGroup };

export async function openEvalFixture(
  dataDirectory: string,
  options: {
    databasePath?: string;
    result?: ExecutionResult;
    delivery?: SendOutcome;
    includeEvent?: (event: RunServiceEvent) => boolean;
  } = {},
) {
  const store = await openDomainStore({ databasePath: options.databasePath ?? ":memory:" });
  const trace = new RunTraceStore({ dataDirectory, maxEventBytes: 64 * 1024 });
  const grants = new Map<string, string>();
  await store.conversations.createAgent("personal");
  await store.identities.bindOwner("owner", evalGroup);
  for (const action of [
    "run:create",
    "run:control",
    "delivery:send",
    "conversation:read",
    "trace:write",
    "eval:write",
  ]) {
    grants.set(
      action,
      await store.authorization.grant({
        principalId: "owner",
        resourceId: agentResourceId("personal"),
        scope: evalGroup,
        action,
        effect: "allow",
      }),
    );
  }
  let executions = 0;
  let sends = 0;
  const service = new RunService({
    store,
    resolveExecution: () => ({
      supportsGroup: true,
      execute: async () => {
        executions++;
        return options.result ?? { status: "succeeded", text: "PRIVATE-PAYLOAD-NOT-IN-EVAL" };
      },
    }),
    transport: {
      send: async ({ delivery }) => {
        sends++;
        void delivery;
        return options.delivery ?? { status: "sent" };
      },
    },
    onEvent: async (event) => {
      if (!("runId" in event) || options.includeEvent?.(event) === false) return;
      await store.evidence.advanceTrace(
        evalOwner,
        await trace.append(event.runId, event, "glassbox-run"),
      );
    },
  });
  return {
    store,
    trace,
    grants,
    service,
    counts: () => ({ executions, sends }),
    run: async () => {
      await service.start();
      const accepted = await service.receive({
        agentId: "personal",
        scope: evalGroup,
        messageId: "eval-input",
        text: "PRIVATE-PROMPT-NOT-IN-EVAL",
        executionRef: "fake-fixture",
      });
      await service.drain();
      return accepted.run.id;
    },
    close: async () => {
      await service.stop({ wait: true });
      await store.close();
    },
  };
}
