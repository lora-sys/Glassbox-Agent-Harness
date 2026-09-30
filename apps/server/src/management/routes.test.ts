import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { openDomainStore } from "../persistence/index.js";
import { routeManagementRequest, type ManagementRouteDependencies } from "./routes.js";

function request(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as IncomingMessage;
}

function jsonRequest(url: string, body: unknown): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
  }) as IncomingMessage;
}

describe("management routes", () => {
  it("exposes unresolved Run attention to authenticated local management", async () => {
    const items = [{ id: "attention-1", kind: "unanswered_message", conversationId: "conv-1" }];
    const result = await routeManagementRequest(request("GET", "/manage/attention"), {
      store: { tasks: { listAttentionItems: async () => items } },
    } as unknown as ManagementRouteDependencies);
    expect(result).toEqual({ status: 200, body: { items } });
  });

  it("creates a scoped approval policy and one-use approval under local management identity", async () => {
    const store = await openDomainStore({ databasePath: ":memory:" });
    const scope = {
      connectionId: "qq",
      botId: "bot",
      chatType: "private" as const,
      chatId: "owner",
      senderId: "owner",
    };
    try {
      await store.identities.bindOwner("owner", scope);
      await store.conversations.createAgent("personal");
      const dependencies = { store } as unknown as ManagementRouteDependencies;
      const policy = await routeManagementRequest(
        jsonRequest("/manage/auth/approval-policies", {
          principalId: "owner",
          resourceId: "agent:personal",
          action: "run:create",
          scope,
        }),
        dependencies,
      );
      expect(policy?.status).toBe(200);
      const grantId = (policy!.body as { grantId: string }).grantId;
      expect(grantId).toBeTruthy();
      const caller = { principalId: "owner", scope };
      expect(
        (
          await store.authorization.check({
            caller,
            resourceId: "agent:personal",
            action: "run:create",
          })
        ).decision,
      ).toBe("REQUIRES_APPROVAL");
      const approval = await routeManagementRequest(
        jsonRequest("/manage/auth/approvals", {
          grantId,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          approverId: "attacker-controlled-and-ignored",
        }),
        dependencies,
      );
      expect(approval?.status).toBe(200);
      const approvalId = (approval!.body as { approvalId: string }).approvalId;
      expect(
        (
          await store.authorization.check({
            caller,
            resourceId: "agent:personal",
            action: "run:create",
            approvalId,
          })
        ).decision,
      ).toBe("ALLOW");
      expect(
        (
          await store.authorization.check({
            caller,
            resourceId: "agent:personal",
            action: "run:create",
            approvalId,
          })
        ).decision,
      ).toBe("DENY");
      const row = await store.db.transaction((tx) =>
        tx.execute({
          sql: "SELECT approver_id FROM approvals WHERE id = ?",
          args: [approvalId],
        }),
      );
      expect(row.rows[0]?.approver_id).toBe("owner");
      expect(JSON.stringify(await store.tasks.listTraceEvents())).not.toContain(approvalId);
    } finally {
      await store.close();
    }
  });

  it("tool-plane route rechecks run access after reading trace pages", async () => {
    const order: string[] = [];
    const dependencies = {
      runCaller: async () => {
        order.push("caller");
        return {};
      },
      store: {
        evidence: {
          getTrace: async () => {
            order.push("index");
            return { eventCount: 0 };
          },
        },
        conversations: {
          getRun: async () => {
            order.push("recheck");
            return {};
          },
        },
      },
      trace: {
        readPage: async () => {
          order.push("read-page");
          return { records: [], nextCursor: null };
        },
      },
    } as unknown as ManagementRouteDependencies;

    const result = await routeManagementRequest(
      request("GET", "/manage/runs/run-1/tool-plane"),
      dependencies,
    );

    expect(order).toEqual(["caller", "index", "read-page", "recheck"]);
    expect(result?.status).toBe(200);
    expect(result?.body).toEqual({
      runId: "run-1",
      trace: { complete: true, recordsRead: 0, recordCap: 200 },
      surface: {
        observed: false,
        selectedCount: 0,
        excludedCount: 0,
        undescribedCount: 0,
        tools: [],
      },
    });
  });

  it("unmatched management route remains unhandled", async () => {
    const result = await routeManagementRequest(request("GET", "/manage/unknown"), {} as never);
    expect(result).toBeUndefined();
  });

  it("reads an opaque browser Artifact ID without accepting scope from the request", async () => {
    const requested: string[] = [];
    const dependencies = {
      readBrowserArtifact: async (id: string) => {
        requested.push(id);
        return { id, data: "iVBORw0KGgo=", mimeType: "image/png", sizeBytes: 8 };
      },
    } as unknown as ManagementRouteDependencies;
    const id = "123e4567-e89b-42d3-a456-426614174000";

    const result = await routeManagementRequest(
      request("GET", `/manage/browser-artifacts/${id}?principalId=attacker&runId=other`),
      dependencies,
    );

    expect(result).toEqual({
      status: 200,
      body: {
        artifact: { id, data: "iVBORw0KGgo=", mimeType: "image/png", sizeBytes: 8 },
      },
    });
    expect(requested).toEqual([id]);
    await expect(
      routeManagementRequest(request("GET", "/manage/browser-artifacts/not-an-id"), dependencies),
    ).resolves.toBeUndefined();
  });
});
