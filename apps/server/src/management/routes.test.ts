import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import { routeManagementRequest, type ManagementRouteDependencies } from "./routes.js";

function request(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as IncomingMessage;
}

function jsonRequest(url: string, body: unknown): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as Readable & IncomingMessage;
  Object.assign(stream, {
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
  });
  return stream;
}

describe("management routes", () => {
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

  it("validates signal fields before resolving a Run caller", async () => {
    let callerLookups = 0;
    const dependencies = {
      runCaller: async () => {
        callerLookups += 1;
        return {};
      },
      opsSignal: async () => ({ disposition: "applied" }),
    } as unknown as ManagementRouteDependencies;

    await expect(
      routeManagementRequest(
        jsonRequest("/manage/ops/tasks/task-1/signal", {
          runId: "run-1",
          stepId: "step-1",
          targetStepVersion: 1,
          type: "continue",
          idempotencyKey: "key-1",
          extra: "rejected",
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(callerLookups).toBe(0);
  });

  it("uses the authenticated Run caller and keeps approval on the human route", async () => {
    const caller = { principalId: "owner", scope: { connectionId: "local" } };
    const calls: unknown[][] = [];
    const dependencies = {
      runCaller: async (runId: string) => {
        expect(runId).toBe("run-1");
        return caller;
      },
      opsSignal: async (...args: unknown[]) => {
        calls.push(args);
        return { disposition: "applied" };
      },
    } as unknown as ManagementRouteDependencies;

    const result = await routeManagementRequest(
      jsonRequest("/manage/ops/tasks/task-1/signal", {
        runId: "run-1",
        stepId: "step-1",
        targetStepVersion: 3,
        targetAttemptId: "attempt-1",
        type: "approve",
        idempotencyKey: "human-key-1",
        approval: true,
      }),
      dependencies,
    );

    expect(result).toEqual({ status: 200, body: { signal: { disposition: "applied" } } });
    expect(calls).toEqual([
      [
        caller,
        "task-1",
        {
          stepId: "step-1",
          targetStepVersion: 3,
          targetAttemptId: "attempt-1",
          type: "approve",
          idempotencyKey: "human-key-1",
          approval: true,
        },
        "run-1",
      ],
    ]);
  });

  it("does not signal when the Run is unavailable to the local caller", async () => {
    let signals = 0;
    const dependencies = {
      runCaller: async () => {
        throw Object.assign(new Error("Run unavailable"), { status: 404 });
      },
      opsSignal: async () => {
        signals += 1;
      },
    } as unknown as ManagementRouteDependencies;

    await expect(
      routeManagementRequest(
        jsonRequest("/manage/ops/tasks/task-1/signal", {
          runId: "run-1",
          stepId: "step-1",
          targetStepVersion: 1,
          type: "continue",
          idempotencyKey: "key-1",
        }),
        dependencies,
      ),
    ).rejects.toThrow("Run unavailable");
    expect(signals).toBe(0);
  });
});
