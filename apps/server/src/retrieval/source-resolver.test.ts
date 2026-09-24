import type { Transaction } from "@libsql/client";
import { expect, it } from "vite-plus/test";
import type { CallerContext } from "../identity/scope.js";
import type { DomainDatabase } from "../persistence/database.js";
import type { RetrievalStorePort } from "./ports.js";
import { resolveAuthorizedHistorySources } from "./source-resolver.js";

function store(
  options: {
    grants?: readonly string[];
    decision?: "ALLOW" | "DENY" | "REQUIRES_APPROVAL";
  } = {},
): RetrievalStorePort {
  return {
    db: {
      transaction: async <T>(operation: (tx: Transaction) => Promise<T>) =>
        operation({
          execute: async () => ({
            rows: (options.grants ?? []).map((resource_id) => ({ resource_id })),
          }),
        } as unknown as Transaction),
    } as unknown as DomainDatabase,
    authorization: {
      check: async () => ({
        id: "decision",
        decision: options.decision ?? "ALLOW",
        reason: "explicit_grant",
        grantId: "grant",
        approvalId: null,
      }),
    },
    capabilities: {
      read: async () => undefined,
    },
  };
}

const privateCaller: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "qq",
    botId: "bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};

it("intersects requested private history groups with the caller's grants", async () => {
  const result = await resolveAuthorizedHistorySources(
    store({ grants: ["group:100", "group:200", "agent:personal"] }),
    privateCaller,
    ["200", "300"],
  );

  expect(result).toEqual(["200"]);
});

it("returns no group history source when the current group grant is denied", async () => {
  const groupCaller: CallerContext = {
    ...privateCaller,
    scope: { ...privateCaller.scope, chatType: "group", chatId: "100" },
  };

  expect(await resolveAuthorizedHistorySources(store({ decision: "DENY" }), groupCaller)).toEqual(
    [],
  );
});
