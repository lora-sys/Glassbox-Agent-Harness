import { expect, it } from "vite-plus/test";
import { openDomainStore } from "../../application/domain-store.js";
import { createWebTools } from "./web-tools.js";
import type { WebService } from "../../web/web-service.js";

it.each([
  ["auth_missing", "web_provider_auth_missing"],
  ["rate_limited", "web_provider_rate_limited"],
  ["quota_exhausted", "web_provider_quota_exhausted"],
  ["timeout", "web_provider_timeout"],
])("preserves the safe %s reason through actual web Tool errors", async (providerStatus, code) => {
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
    await store.identities.bindOwner("owner", scope);
    await store.conversations.createAgent("personal");
    await store.authorization.grant({
      principalId: "owner",
      resourceId: "agent:personal",
      action: "run:create",
      scope,
      effect: "allow",
    });
    const run = await store.conversations.acceptIncoming({
      agentId: "personal",
      scope,
      messageId: "one",
      text: "search public documents",
      executionRef: "fake",
    });
    await store.authorization.registerResource({
      id: "web:public",
      kind: "web-public",
      visibility: "public",
    });
    for (const action of ["web:search", "web:fetch"])
      await store.authorization.grant({
        principalId: "owner",
        resourceId: "web:public",
        action,
        scope,
        effect: "allow",
      });
    const failure = {
      status: providerStatus === "timeout" ? "failed" : "unavailable",
      providerStatus,
    };
    const tools = createWebTools({
      store,
      getContext: () => ({ caller, conversationId: run.conversation.id, runId: run.run.id }),
      isEnabled: async () => true,
      service: { search: async () => failure, fetch: async () => failure } as unknown as WebService,
    });
    for (const tool of tools) {
      await expect(
        tool.execute(
          "call",
          tool.name === "web_search" ? { query: "public" } : { url: "https://example.com" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toMatchObject({ name: "ProviderCallError", message: code });
    }
  } finally {
    await store.close();
  }
});
