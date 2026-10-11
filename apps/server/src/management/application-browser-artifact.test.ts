import { OneBotAdapter } from "../channels/onebot/adapter.js";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BrowserArtifactStore } from "../web/browser-artifact-store.js";
import { ManagementError } from "./access.js";
import { createApplicationFixtureScope } from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await afterEachCleanup();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it("delivers a persisted screenshot only to the Run's original, currently authorized scope", async () => {
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }));
  f.send(772, "artifact fixture", true);
  const run = await f.started.take();
  await f.reply("artifact fixture");

  const directory = await mkdtemp(join(tmpdir(), "glassbox-artifact-delivery-"));
  directories.push(directory);
  const artifacts = await BrowserArtifactStore.open(directory);
  (f.app as unknown as { browserArtifacts: BrowserArtifactStore }).browserArtifacts = artifacts;
  const binding = {
    runId: run.run.id,
    conversationId: run.conversation.id,
    principalId: run.caller.principalId,
    workspaceId: `web-${run.run.id}`,
    policyVersion: "workspace-sandbox-v1",
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const artifact = await artifacts.write(binding, png.toString("base64"), 1024);

  await expect(f.app.readBrowserArtifactById(artifact.id)).resolves.toEqual({
    id: artifact.id,
    data: png.toString("base64"),
    mimeType: "image/png",
    sizeBytes: png.length,
  });
  await expect(
    f.app.readBrowserArtifact({ id: artifact.id, binding, caller: run.caller }),
  ).resolves.toEqual({ data: png, mimeType: "image/png", sizeBytes: png.length });
  await expect(
    f.app.readBrowserArtifact({
      id: artifact.id,
      binding,
      caller: { ...run.caller, scope: { ...run.caller.scope, chatId: "other-chat" } },
    }),
  ).rejects.toThrow("browser_artifact_denied");
  const deliveryGrant = await f.app.store.authorization.grant({
    principalId: run.caller.principalId,
    resourceId: "web:public",
    action: "browser:deliver",
    scope: run.caller.scope,
    effect: "allow",
  });
  await f.app.store.authorization.revoke(deliveryGrant);
  await expect(
    f.app.readBrowserArtifact({ id: artifact.id, binding, caller: run.caller }),
  ).rejects.toThrow("browser_artifact_denied");
  await f.app.store.authorization.grant({
    principalId: run.caller.principalId,
    resourceId: "web:public",
    action: "browser:deliver",
    scope: run.caller.scope,
    effect: "allow",
  });
  await f.app.store.authorization.revokeScope({
    principalId: run.caller.principalId,
    resourceId: "web:public",
    scope: run.caller.scope,
  });
  await expect(
    f.app.readBrowserArtifact({ id: artifact.id, binding, caller: run.caller }),
  ).rejects.toThrow("browser_artifact_denied");
  await expect(f.app.readBrowserArtifactById(artifact.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
    status: 404,
  } satisfies Partial<ManagementError>);
  await expect(
    f.app.readBrowserArtifactById("123e4567-e89b-42d3-a456-426614174000"),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
});

it.each([false, true])(
  "delivers a same-Run screenshot without assuming a thrown send failed (throws=%s)",
  async (throws) => {
    let complete!: (value: { status: "succeeded"; text: string }) => void;
    const result = new Promise<{ status: "succeeded"; text: string }>((resolve) => {
      complete = resolve;
    });
    const f = await fixture(async () => result);
    f.send(773, "take screenshot", true);
    const started = await f.started.take();
    const directory = await mkdtemp(join(tmpdir(), "glassbox-artifact-send-"));
    directories.push(directory);
    const artifacts = await BrowserArtifactStore.open(directory);
    (f.app as unknown as { browserArtifacts: BrowserArtifactStore }).browserArtifacts = artifacts;
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const artifact = await artifacts.write(
      {
        runId: started.run.id,
        conversationId: started.conversation.id,
        principalId: started.caller.principalId,
        workspaceId: `web-${started.run.id}`,
        policyVersion: "workspace-sandbox-v1",
      },
      pngBase64,
      1024,
    );
    let imageSends = 0;
    const connection = (
      f.app as unknown as { connections: Map<string, OneBotAdapter> }
    ).connections.get("fixture")!;
    const original = connection.send.bind(connection);
    vi.spyOn(connection, "send").mockImplementation(async (input) => {
      if (input.image) {
        imageSends++;
        if (throws) throw new Error("private-provider-error-canary");
      }
      return original(input);
    });
    complete({ status: "succeeded", text: `截图 Artifact：${artifact.id}` });
    await f.app.runs.waitForRun(started.caller, started.run.id);
    await f.app.runs.drain();

    const deliveries = (await f.app.store.lifecycle.listDeliveries(started.caller, started.run.id))
      .items;
    if (throws) {
      const delivery = deliveries.find((item) => item.payloadKind === "browser_artifact")!;
      expect(delivery.status).toBe("unknown");
      const attention = await f.app.store.tasks.listAttentionItems();
      expect(attention).toHaveLength(1);
      expect(attention[0]!.summary).toContain("transport_error");
      const trace = await f.app.trace.readPage(started.run.id);
      expect(trace.records.map((record) => record.event)).toContainEqual(
        expect.objectContaining({
          type: "delivery_changed",
          deliveryId: delivery.id,
          status: "unknown",
          reason: "transport_error",
        }),
      );
      expect(JSON.stringify({ attention, trace })).not.toContain("private-provider-error-canary");
      await expect(
        f.app.runs.retryDelivery(started.caller, started.run.id, delivery.id),
      ).rejects.toThrow();
      await f.app.runs.drain();
      expect(imageSends).toBe(1);
      return;
    }
    expect(deliveries.map((delivery) => [delivery.payloadKind, delivery.status])).toEqual([
      ["result", "sent"],
      ["browser_artifact", "sent"],
    ]);
    const sends = f.actionLog.filter((action) => action.action === "send_private_msg");
    expect(sends).toHaveLength(2);
    expect(sends[0]?.params.message).toContainEqual({
      type: "text",
      data: { text: `截图 Artifact：${artifact.id}` },
    });
    expect(sends[1]?.params.message).toContainEqual({
      type: "image",
      data: { file: `base64://${pngBase64}` },
    });
  },
);

it.each([false, true])(
  "delivers a same-Run private media Asset without assuming a thrown send failed (throws=%s)",
  async (throws) => {
    let complete!: (value: { status: "succeeded"; text: string }) => void;
    const result = new Promise<{ status: "succeeded"; text: string }>((resolve) => {
      complete = resolve;
    });
    const f = await fixture(async () => result);
    f.send(774, "生成一张图", true);
    const started = await f.started.take();
    const mediaAssets = (
      f.app as unknown as { mediaAssets: import("../media/media-asset-store.js").MediaAssetStore }
    ).mediaAssets;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    const asset = await mediaAssets.write(
      {
        runId: started.run.id,
        conversationId: started.conversation.id,
        principalId: started.caller.principalId,
      },
      "image/png",
      png,
      1024,
    );
    let imageSends = 0;
    const connection = (
      f.app as unknown as { connections: Map<string, OneBotAdapter> }
    ).connections.get("fixture")!;
    const original = connection.send.bind(connection);
    vi.spyOn(connection, "send").mockImplementation(async (input) => {
      if (input.image) {
        imageSends++;
        if (throws) throw new Error("private-provider-error-canary");
      }
      return original(input);
    });
    complete({ status: "succeeded", text: `图片已完成。[asset:${asset.id}]` });
    await f.app.runs.waitForRun(started.caller, started.run.id);
    await f.app.runs.drain();

    const deliveries = (await f.app.store.lifecycle.listDeliveries(started.caller, started.run.id))
      .items;
    if (throws) {
      const delivery = deliveries.find((item) => item.payloadKind === "media_artifact")!;
      expect(delivery.status).toBe("unknown");
      const attention = await f.app.store.tasks.listAttentionItems();
      expect(attention).toHaveLength(1);
      expect(attention[0]!.summary).toContain("transport_error");
      const trace = await f.app.trace.readPage(started.run.id);
      expect(trace.records.map((record) => record.event)).toContainEqual(
        expect.objectContaining({
          type: "delivery_changed",
          deliveryId: delivery.id,
          status: "unknown",
          reason: "transport_error",
        }),
      );
      expect(JSON.stringify({ attention, trace })).not.toContain("private-provider-error-canary");
      await expect(
        f.app.runs.retryDelivery(started.caller, started.run.id, delivery.id),
      ).rejects.toThrow();
      await f.app.runs.drain();
      expect(imageSends).toBe(1);
      return;
    }
    expect(deliveries.map((delivery) => [delivery.payloadKind, delivery.status])).toEqual([
      ["result", "sent"],
      ["media_artifact", "sent"],
    ]);
    const sends = f.actionLog.filter((action) => action.action === "send_private_msg");
    expect(sends).toHaveLength(2);
    expect(sends[0]?.params.message).toContainEqual({
      type: "text",
      data: { text: "图片已完成。" },
    });
    expect(sends[1]?.params.message).toContainEqual({
      type: "image",
      data: { file: `base64://${png.toString("base64")}` },
    });
    const trace = await f.app.trace.readPage(started.run.id);
    const witnessRows = trace.records.filter(
      (record) =>
        (record.event as { type?: unknown }).type === "media_delivery_sent" &&
        (record.event as { assetId?: unknown }).assetId === asset.id,
    );
    expect(witnessRows).toHaveLength(1);
    expect(witnessRows[0]).toMatchObject({
      provenance: "glassbox-media-delivery",
      event: {
        schemaVersion: 1,
        runId: started.run.id,
        deliveryId: deliveries[1]!.id,
        assetId: asset.id,
        externalId: deliveries[1]!.externalId,
        mimeType: "image/png",
        sizeBytes: png.byteLength,
        sha256: createHash("sha256").update(png).digest("hex"),
      },
    });
  },
);

it.each(["append", "advance"] as const)(
  "does not retry a confirmed media send when witness %s fails",
  async (failurePoint) => {
    let complete!: (value: { status: "succeeded"; text: string }) => void;
    const result = new Promise<{ status: "succeeded"; text: string }>((resolve) => {
      complete = resolve;
    });
    const f = await fixture(async () => result);
    f.send(775, "生成一张图", true);
    const started = await f.started.take();
    const mediaAssets = (
      f.app as unknown as { mediaAssets: import("../media/media-asset-store.js").MediaAssetStore }
    ).mediaAssets;
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    const asset = await mediaAssets.write(
      {
        runId: started.run.id,
        conversationId: started.conversation.id,
        principalId: started.caller.principalId,
      },
      "image/png",
      png,
      1024,
    );
    let imageSends = 0;
    const connection = (
      f.app as unknown as { connections: Map<string, OneBotAdapter> }
    ).connections.get("fixture")!;
    vi.spyOn(connection, "send").mockImplementation(async (input) => {
      if (input.image) imageSends++;
      return { status: "confirmed", messageId: "confirmed-media-message" };
    });
    let witnessAppended = false;
    let advanceFailureObserved = false;
    const append = f.app.trace.append.bind(f.app.trace);
    vi.spyOn(f.app.trace, "append").mockImplementation(async (runId, event, provenance) => {
      if (
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "media_delivery_sent"
      ) {
        if (failurePoint === "append") throw new Error("witness_write_failed");
        const cursor = await append(runId, event, provenance);
        witnessAppended = true;
        return cursor;
      }
      return append(runId, event, provenance);
    });
    if (failurePoint === "advance") {
      const advance = f.app.store.evidence.advanceTrace.bind(f.app.store.evidence);
      vi.spyOn(f.app.store.evidence, "advanceTrace").mockImplementation(async (caller, cursor) => {
        if (witnessAppended) {
          advanceFailureObserved = true;
          throw new Error("witness_advance_failed");
        }
        return advance(caller, cursor);
      });
    }

    complete({ status: "succeeded", text: `图片已完成。[asset:${asset.id}]` });
    await f.app.runs.waitForRun(started.caller, started.run.id);
    await f.app.runs.drain();

    const deliveries = (await f.app.store.lifecycle.listDeliveries(started.caller, started.run.id))
      .items;
    const delivery = deliveries.find((item) => item.payloadKind === "media_artifact")!;
    expect(delivery.status).toBe("unknown");
    const trace = await f.app.trace.readPage(started.run.id);
    expect(trace.records.map((record) => record.event)).toContainEqual(
      expect.objectContaining({
        type: "delivery_changed",
        deliveryId: delivery.id,
        status: "unknown",
        reason: "unclassified",
      }),
    );
    const witnesses = trace.records.filter(
      (record) =>
        (record.event as { type?: unknown }).type === "media_delivery_sent" &&
        (record.event as { assetId?: unknown }).assetId === asset.id,
    );
    expect(witnesses).toHaveLength(failurePoint === "append" ? 0 : 1);
    expect(advanceFailureObserved).toBe(failurePoint === "advance");
    await expect(
      f.app.runs.retryDelivery(started.caller, started.run.id, delivery.id),
    ).rejects.toThrow();
    await f.app.runs.drain();
    expect(imageSends).toBe(1);
  },
);
