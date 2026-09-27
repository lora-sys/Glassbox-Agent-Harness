import { expect, it, vi } from "vite-plus/test";
import type { PublicModelProfile } from "../../config/model-profiles.js";
import { openDomainStore } from "../../persistence/index.js";
import { createOwnerModelTools, OWNER_MODEL_ADMIN_TOOL } from "./owner-model-tools.js";

const dottedModel: PublicModelProfile = {
  id: "pi-7f38cfd90123a4567890abcd",
  label: "MiniMax CN / MiniMax-M2.7",
  providerId: "minimax-cn",
  protocol: "openai-completions",
  baseUrl: "https://models.example.invalid/v1",
  model: "MiniMax-M2.7",
  credentialConfigured: true,
  supportsTools: true,
  contextWindowTokens: 65_536,
  maxOutputTokens: 8_192,
  routingAvailable: true,
};

async function createFixture(models: readonly PublicModelProfile[], requestedModel: string) {
  const store = await openDomainStore({ databasePath: ":memory:" });
  const caller = {
    principalId: "owner",
    scope: {
      connectionId: "qq",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    },
  };
  await store.identities.bindOwner("owner", caller.scope);
  await store.conversations.createAgent("personal");
  await store.authorization.grant({
    principalId: "owner",
    resourceId: "agent:personal",
    action: "run:create",
    scope: caller.scope,
    effect: "allow",
  });
  const accepted = await store.conversations.acceptIncoming({
    agentId: "personal",
    scope: caller.scope,
    messageId: "message",
    text: `切换到 ${requestedModel}`,
    executionRef: "pi:test",
  });
  await store.authorization.registerResource({
    id: "owner-control",
    kind: "owner-control",
    visibility: "private",
    ownerId: "owner",
  });
  for (const action of ["model:read", "model:switch"]) {
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "owner-control",
      action,
      scope: caller.scope,
      effect: "allow",
    });
  }
  const selection = vi.fn(async (_context, _profileId: string | null) => undefined);
  const recordSelection = vi.fn(async (_context, _profileId: string | null) => undefined);
  const [tool] = createOwnerModelTools({
    store,
    getContext: () => ({
      caller,
      runId: accepted.run.id,
      conversationId: accepted.conversation.id,
      requiredToolName: OWNER_MODEL_ADMIN_TOOL,
      requiredToolInput: { action: "select", profileId: requestedModel },
    }),
    listModels: () => models,
    currentModel: () => undefined,
    selectModel: selection,
    recordSelection,
  });
  return { store, tool: tool!, selection, recordSelection };
}

it("selects a Pi model by its provider model ID, including punctuation", async () => {
  const f = await createFixture([dottedModel], dottedModel.model);
  try {
    expect(f.tool.parameters).toMatchObject({
      properties: { profileId: { minLength: 1, maxLength: 160 } },
    });
    const result = await f.tool.execute(
      "select-model",
      { action: "select", profileId: dottedModel.model },
      undefined,
      undefined,
      {} as never,
    );

    expect(f.selection).toHaveBeenCalledWith(expect.anything(), dottedModel.id);
    expect(f.recordSelection).toHaveBeenCalledWith(expect.anything(), dottedModel.id);
    expect(result.details).toMatchObject({ selected: { profileId: dottedModel.id } });
  } finally {
    await f.store.close();
  }
});

it("rejects ambiguous model names without changing the selected model", async () => {
  const secondModel: PublicModelProfile = {
    ...dottedModel,
    id: "pi-another-model-profile",
    providerId: "another-provider",
  };
  const f = await createFixture([dottedModel, secondModel], dottedModel.model);
  try {
    await expect(
      f.tool.execute(
        "ambiguous-model",
        { action: "select", profileId: dottedModel.model },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("protected_tool_failed");
    expect(f.selection).not.toHaveBeenCalled();
    expect(f.recordSelection).not.toHaveBeenCalled();
  } finally {
    await f.store.close();
  }
});

it("marks a configured model with unknown capacity as unavailable for selection", async () => {
  const incomplete: PublicModelProfile = {
    ...dottedModel,
    id: "pi-incomplete-model",
    providerId: "amd",
    model: "DeepSeek-V4-Flash",
    contextWindowTokens: undefined,
    maxOutputTokens: undefined,
  };
  const f = await createFixture([dottedModel, incomplete], incomplete.model);
  try {
    const result = await f.tool.execute(
      "list-models",
      { action: "list" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toMatchObject({
      models: [
        { profileId: dottedModel.id, routingAvailable: true },
        {
          profileId: incomplete.id,
          routingAvailable: false,
          unavailableReason: "capacity_unknown",
        },
      ],
    });
  } finally {
    await f.store.close();
  }
});
