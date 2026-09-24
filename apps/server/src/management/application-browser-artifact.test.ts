import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { BrowserArtifactStore } from "../web/browser-artifact-store.js";
import { ManagementError } from "./access.js";
import { createApplicationFixtureScope } from "./application-test-helpers.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
const directories: string[] = [];
afterEach(async () => {
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
