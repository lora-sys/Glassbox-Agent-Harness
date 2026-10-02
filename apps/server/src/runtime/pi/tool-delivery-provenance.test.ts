import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../../application/domain-store.js";
import type { WorkspaceRegistry } from "../../workspace/registry.js";
import { createIsolatedPiTools } from "./sandbox-pi-tools.js";
import { createSkillTools } from "./skill-tools.js";
import { createOwnerModelTools, OWNER_MODEL_ADMIN_TOOL } from "./owner-model-tools.js";
import type { KitLoader } from "./kit-loader.js";

it.each([
  "read",
  "bash",
  "powershell",
  "write",
  "edit",
  "read-error",
  "stream-error",
  "skill",
  "model-list",
  "model-current",
  "model-select",
  "model-clear",
])("requires independent delivery authority for %s content", async (kind) => {
  const store = await openDomainStore({ databasePath: ":memory:" });
  try {
    const scope = {
      connectionId: "fixture",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    };
    const caller = { principalId: "owner", scope };
    await store.conversations.createAgent("personal");
    await store.identities.bindOwner("owner", scope);
    const grant = (resourceId: string, action: string) =>
      store.authorization.grant({
        principalId: "owner",
        resourceId,
        action,
        scope,
        effect: "allow",
      });
    for (const action of [
      "run:create",
      "conversation:read",
      "run:control",
      "delivery:send",
      "trace:write",
    ])
      await grant("agent:personal", action);
    const accepted = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope,
      messageId: "one",
      text: "Read the fixture",
      executionRef: "fake",
    });
    const modelAction = kind.slice("model-".length);
    const mutatesModel = kind === "model-select" || kind === "model-clear";
    const modelInput = {
      action: modelAction,
      ...(kind === "model-select" ? { profileId: "fixture-profile" } : {}),
    };
    const context = {
      caller,
      conversationId: accepted.conversation.id,
      runId: accepted.run.id,
      authorizedSkillNames: ["fixture"],
      ...(mutatesModel
        ? { requiredToolName: OWNER_MODEL_ADMIN_TOOL, requiredToolInput: modelInput }
        : {}),
    };
    const model = kind.startsWith("model-");
    const resourceId =
      kind === "skill" ? "skill-catalog" : model ? "owner-control" : "workspace:fixture";
    const writable = ["bash", "powershell", "write", "edit", "stream-error"].includes(kind);
    const action =
      kind === "skill"
        ? "skill:read"
        : model
          ? mutatesModel
            ? "model:switch"
            : "model:read"
          : writable
            ? "workspace:write"
            : "workspace:read";
    await store.authorization.registerResource({
      id: resourceId,
      kind: "fixture-content",
      visibility: "private",
      ownerId: "owner",
    });
    await grant(resourceId, action);
    const canary = `protected-${kind}`;
    let result: unknown;
    let streamed = false;
    if (kind === "skill") {
      const [tool] = createSkillTools({
        store,
        getContext: () => context,
        isSkillAuthorized: async () => true,
        loader: { readSkillFile: () => canary } as unknown as KitLoader,
      });
      result = await tool!.execute(
        "call",
        { skillName: "fixture" },
        undefined,
        undefined,
        {} as never,
      );
    } else if (model) {
      const [tool] = createOwnerModelTools({
        store,
        getContext: () => context,
        listModels: () => [
          {
            id: "fixture-profile",
            label: canary,
            providerId: "fixture",
            protocol: "openai-completions",
            baseUrl: "https://fixture.invalid",
            model: "fixture-model",
            credentialConfigured: true,
            supportsTools: true,
            contextWindowTokens: 65536,
            maxOutputTokens: 4096,
            routingAvailable: true,
          },
        ],
        currentModel: () => canary,
        selectModel: async () => {},
        recordSelection: async () => {},
      });
      result = await tool!.execute("call", modelInput, undefined, undefined, {} as never);
    } else {
      const name = kind === "read-error" ? "read" : kind === "stream-error" ? "bash" : kind;
      const [tool] = createIsolatedPiTools({
        store,
        workspaceId: "fixture",
        getContext: () => context,
        registry: {
          resolveAuthorized: async () => ({ id: "fixture" }),
        } as unknown as WorkspaceRegistry,
        session: {
          toolDefinitions: [{ name, description: "fixture", parameters: {}, available: true }],
          execute: async (input) => {
            if (kind === "stream-error") {
              input.onUpdate?.({ content: [{ type: "text", text: canary }] });
              throw new Error("fixture failure");
            }
            return {
              content: [{ type: "text", text: canary }],
              ...(kind === "read-error" ? { isError: true } : {}),
            };
          },
          close: async () => {},
        },
      });
      const execution = tool!.execute(
        "call",
        {},
        undefined,
        () => {
          streamed = true;
        },
        {} as never,
      );
      if (kind === "stream-error") await expect(execution).rejects.toThrow("provider_unknown");
      else result = await execution;
    }
    if (kind === "stream-error") expect(streamed).toBe(true);
    else expect(result).toBeDefined();
    const rows = await store.db.transaction((tx) =>
      tx.execute({
        sql: "SELECT delivery_source FROM authorization_decisions WHERE run_id = ? AND resource_id = ? AND decision = 'ALLOW'",
        args: [context.runId, resourceId],
      }),
    );
    expect(rows.rows.some((row) => row.delivery_source === "content_source")).toBe(true);
    const lease = await store.lifecycle.claimQueuedRun(caller, context.runId);
    await lease.settle("succeeded", canary);
    const create = () =>
      store.lifecycle.createDelivery(caller, {
        runId: context.runId,
        dedupKey: "answer",
        destination: scope,
        payloadText: canary,
        payloadKind: "result",
      });
    await expect(create()).rejects.toMatchObject({
      decision: { decision: "DENY", reason: "no_grant" },
    });
    const deliveryGrant = await grant(resourceId, "delivery:send");
    const delivery = await create();
    await store.authorization.revoke(deliveryGrant);
    await expect(
      store.lifecycle.claimDelivery(caller, context.runId, delivery),
    ).rejects.toMatchObject({ decision: { decision: "DENY", reason: "no_grant" } });
  } finally {
    await store.close();
  }
});
