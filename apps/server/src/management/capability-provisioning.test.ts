import { expect, it, vi } from "vite-plus/test";
import { openDomainStore } from "../application/domain-store.js";
import { ManagementApplication } from "./application.js";

it.each(["private", "group"] as const)(
  "provisions a %s capability discovery scope with one atomic authorization transaction",
  async (chatType) => {
    const store = await openDomainStore({ databasePath: ":memory:" });
    try {
      const scope = {
        connectionId: "fixture",
        botId: "bot",
        chatType,
        chatId: "group",
        senderId: "owner",
      };
      await store.identities.bindOwner("owner", scope);
      const transaction = vi.spyOn(store.db, "transaction");
      const provision = (
        ManagementApplication.prototype as unknown as {
          grantCapabilityDiscovery(
            this: { store: typeof store },
            input: {
              initialOnly: boolean;
              principalId: string;
              scope: typeof scope;
            },
          ): Promise<void>;
        }
      ).grantCapabilityDiscovery.bind({ store });
      await provision({ initialOnly: true, principalId: "owner", scope });
      // One identity read, then one atomic authorization batch, independent of Tool count.
      expect(transaction).toHaveBeenCalledTimes(2);
      transaction.mockRestore();
      const rows = await store.db.transaction(async (tx) => ({
        grants: (await tx.execute("SELECT id FROM grants")).rows,
        decisions: (await tx.execute("SELECT decision FROM authorization_decisions")).rows,
      }));
      expect(rows.grants.length).toBeGreaterThan(1);
      expect(rows.decisions).toHaveLength(rows.grants.length);
      expect(rows.decisions.every((row) => row.decision === "DENY")).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await store.close();
    }
  },
);
