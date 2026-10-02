import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { OneBotAdapter } from "../channels/onebot/adapter.js";
import { createApplicationFixtureScope } from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(async () => {
  vi.restoreAllMocks();
  await afterEachCleanup();
});

describe("Management delivery outcome visibility", () => {
  it("preserves a provider timeout and durable Owner attention without replaying the send", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "disposable answer" }));
    const send = vi.spyOn(OneBotAdapter.prototype, "send").mockResolvedValue({
      status: "unknown",
      code: "timeout",
    });
    f.send(110, "disposable request");
    const input = await f.started.take();
    await f.app.runs.waitForRun(input.caller, input.run.id);
    await f.app.runs.drain();
    const deliveries = (await f.app.store.lifecycle.listDeliveries(input.caller, input.run.id))
      .items;
    const result = deliveries.find((delivery) => delivery.payloadKind === "result")!;
    expect(result.status).toBe("unknown");
    expect((await f.app.runs.getRun(input.caller, input.run.id)).status).toBe("succeeded");
    await expect(f.app.runs.retryDelivery(input.caller, input.run.id, result.id)).rejects.toThrow();
    const before = send.mock.calls.length;
    await f.app.runs.drain();
    expect(send).toHaveBeenCalledTimes(before);
    const trace = await f.app.trace.readPage(input.run.id);
    expect.soft(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "delivery_changed",
        deliveryId: result.id,
        status: "unknown",
        reason: "timeout",
      }),
    );
    const attention = await f.app.store.tasks.listAttentionItems();
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({
      kind: "delivery_failed",
      conversationId: input.conversation.id,
    });
    expect(attention[0]!.summary).toContain("unconfirmed");
    expect(attention[0]!.summary).toContain("timeout");
    expect(JSON.stringify(attention)).not.toContain("disposable answer");
    expect((await f.app.store.tasks.getOpsSnapshot(input.caller)).attention.total).toBe(0);
  });
  it.each([
    "api_rejected",
    "invalid_response",
    "async_response",
    "disconnected",
    "send_error",
  ] as const)("preserves the bounded %s provider reason", async (code) => {
    const f = await fixture(async () => ({ status: "succeeded", text: "safe answer" }));
    const status = code === "api_rejected" ? "failed" : "unknown";
    vi.spyOn(OneBotAdapter.prototype, "send").mockResolvedValue({ status, code } as Awaited<
      ReturnType<OneBotAdapter["send"]>
    >);
    f.send(111, "safe request");
    const input = await f.started.take();
    await f.app.runs.waitForRun(input.caller, input.run.id);
    await f.app.runs.drain();
    const trace = await f.app.trace.readPage(input.run.id);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({ type: "delivery_changed", status, reason: code }),
    );
    expect((await f.app.store.tasks.listAttentionItems())[0]!.summary).toContain(`Reason: ${code}`);
  });
});
