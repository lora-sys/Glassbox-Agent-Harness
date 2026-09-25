import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserArtifactStore } from "../apps/server/src/web/browser-artifact-store.js";
import { BrowserBridge } from "../apps/server/src/web/browser-bridge.js";
import { createKitBrowserExecutor } from "../apps/server/src/web/kit-browser-executor.js";
import { loadKitSandbox } from "../apps/server/src/runtime/pi/sandbox-kit.js";
import { dohResolveWebHost } from "../apps/server/src/web/network-guard.js";
import type { IsolatedPiSession } from "../apps/server/src/runtime/pi/sandbox-pi-tools.js";

const kitPath = process.env.LORA_PI_KIT_PATH;
const image = process.env.GLASSBOX_SANDBOX_IMAGE;
const publicUrl = process.env.GLASSBOX_SMOKE_PUBLIC_URL ?? "https://example.com/";
assert(kitPath, "Set LORA_PI_KIT_PATH to the final Lora PI Kit checkout");
assert(image, "Set GLASSBOX_SANDBOX_IMAGE to the immutable sandbox image digest");

const temporaryRoot = await mkdtemp(join(tmpdir(), "glassbox-browser-smoke-"));
const workspacePath = join(temporaryRoot, "workspace");
const principalId = `smoke-owner-${randomUUID()}`;
const binding = {
  runId: `smoke-run-${randomUUID()}`,
  principalId,
  conversationId: `smoke-conversation-${randomUUID()}`,
  workspaceId: `smoke-workspace-${randomUUID()}`,
  policyVersion: "browser-sandbox-smoke-v1",
} as const;

let runtime: Awaited<ReturnType<typeof loadKitSandbox>> = null;
let sandbox: IsolatedPiSession | undefined;
let bridge: BrowserBridge | undefined;
let artifacts: BrowserArtifactStore | undefined;
let authorized = true;
let primaryError: unknown;

try {
  runtime = await loadKitSandbox(await realpath(kitPath));
  assert(runtime, "Sandbox image is not configured");
  assert(runtime.cliAvailable, "Pinned Kit image does not contain agent-browser");

  artifacts = await BrowserArtifactStore.open(temporaryRoot);
  await mkdir(workspacePath, { recursive: true });
  sandbox = await runtime.executor.openSession({
    sessionId: binding.runId,
    workspacePath,
    writable: false,
    policyVersion: binding.policyVersion,
    network: "public_web",
  });
  assert.equal(typeof sandbox.executeCli, "function", "Kit session lacks agent-browser support");
  assert.equal(typeof sandbox.cancel, "function", "Kit session lacks per-call cancellation");

  const executor = createKitBrowserExecutor(
    async (candidate) =>
      candidate.runId === binding.runId &&
      candidate.principalId === binding.principalId &&
      candidate.conversationId === binding.conversationId &&
      candidate.workspaceId === binding.workspaceId &&
      candidate.policyVersion === binding.policyVersion &&
      authorized &&
      sandbox?.executeCli &&
      sandbox.cancel
        ? {
            executeCli: sandbox.executeCli.bind(sandbox),
            cancel: sandbox.cancel.bind(sandbox),
            closeRun: () => sandbox!.close(),
          }
        : undefined,
    artifacts,
  );
  bridge = new BrowserBridge({
    resolveHost: dohResolveWebHost,
    authorize: async (candidate) =>
      authorized &&
      candidate.principalId === principalId &&
      candidate.runId === binding.runId &&
      candidate.workspaceId === binding.workspaceId,
    executor,
  });

  await bridge.execute(binding, { type: "open", url: publicUrl });
  const snapshot = await bridge.execute(binding, { type: "snapshot", compact: true });
  assert(snapshot.output.trim(), `Browser returned no snapshot from ${publicUrl}`);

  await assert.rejects(
    bridge.execute(binding, { type: "goto", url: "http://127.0.0.1/" }),
    (error: unknown) =>
      error instanceof Error &&
      ["web_target_non_public", "browser_result_target_denied"].includes(error.message),
    "Browser accepted a private-network target",
  );

  const screenshot = await bridge.execute(binding, { type: "screenshot" });
  assert(screenshot.artifact?.id, "Screenshot was not persisted as a browser artifact");
  const stored = await artifacts.read(screenshot.artifact.id, binding);
  assert.equal(stored.mimeType, "image/png");
  assert.equal(stored.sizeBytes, screenshot.artifact.sizeBytes);
  assert.equal(stored.data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  await assert.rejects(
    artifacts.read(screenshot.artifact.id, { ...binding, principalId: `${principalId}-other` }),
    /browser_artifact_denied/u,
    "Screenshot was readable under a different Principal",
  );

  authorized = false;
  await assert.rejects(
    bridge.execute(binding, { type: "snapshot" }),
    /browser_denied/u,
    "Revoked browser access remained usable",
  );
  console.log(`PASS: Docker browser opened ${new URL(publicUrl).origin} and returned a snapshot`);
  console.log("PASS: private target was denied before browser navigation");
  console.log("PASS: screenshot artifact was persisted and binding-scoped");
  console.log("PASS: revoked browser authorization denied the next action");
} catch (error) {
  primaryError = error;
} finally {
  const cleanupErrors: unknown[] = [];
  if (bridge) await bridge.cleanup(binding).catch((error: unknown) => cleanupErrors.push(error));
  if (sandbox) {
    await sandbox.close().catch((error: unknown) => cleanupErrors.push(error));
    await runtime?.executor
      .ensureSessionStopped(binding.runId)
      .catch((error: unknown) => cleanupErrors.push(error));
  }
  if (runtime) await runtime.executor.close().catch((error: unknown) => cleanupErrors.push(error));
  await rm(temporaryRoot, { recursive: true, force: true }).catch((error: unknown) =>
    cleanupErrors.push(error),
  );

  if (primaryError || cleanupErrors.length > 0) {
    if (primaryError) console.error(primaryError);
    for (const error of cleanupErrors) console.error("Cleanup failed:", error);
    process.exitCode = 1;
  }
}
