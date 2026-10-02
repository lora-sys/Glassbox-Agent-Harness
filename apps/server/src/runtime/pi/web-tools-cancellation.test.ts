import { expect, it, vi } from "vite-plus/test";
import { openDomainStore } from "../../application/domain-store.js";
import { createWebTools } from "./web-tools.js";
import { WebService } from "../../web/web-service.js";

it.each(["web_search", "web_fetch"])(
  "passes cancellation through the actual %s Tool and records no false result",
  async (name) => {
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

      const controller = new AbortController();
      const seen: Array<AbortSignal | undefined> = [];
      const failed = async (signal?: AbortSignal) => {
        seen.push(signal);
        controller.abort();
        return { status: "failed" as const, results: [] as const };
      };
      const fallback = vi.fn(async () => ({ status: "failed" as const, results: [] }));
      const evidence = vi.fn(async () => {});
      const service = new WebService({
        planner: {
          plan: async (query) => ({ mode: "fast", queryVariants: [query], jevUsed: false }),
          rerank: async () => [],
        },
        provider: {
          search: (_input, signal) => failed(signal),
          contents: (_url, _query, signal) => failed(signal),
        },
        browserFallback: { search: fallback, fetch: fallback },
        resolveHost: async () => ["93.184.216.34"],
      });
      const tools = createWebTools({
        store,
        service,
        getContext: () => ({ caller, conversationId: run.conversation.id, runId: run.run.id }),
        isEnabled: async () => true,
        recordEvidence: evidence,
      });
      const tool = tools.find((item) => item.name === name)!;
      await expect(
        tool.execute(
          "call",
          name === "web_search" ? { query: "public" } : { url: "https://example.com/" },
          controller.signal,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("Operation cancelled");
      expect(seen).toEqual([controller.signal]);
      expect(fallback).not.toHaveBeenCalled();
      expect(evidence).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  },
);
