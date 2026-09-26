import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserArtifactStore } from "./browser-artifact-store.js";
import type { BrowserSessionBinding } from "./browser-session.js";

const binding: BrowserSessionBinding = {
  runId: "run-1",
  principalId: "principal-1",
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  policyVersion: "policy-1",
};
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([pngSignature, Buffer.from("test-png-data")]);

describe("BrowserArtifactStore", () => {
  let dataDirectory: string;
  let store: BrowserArtifactStore;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "glassbox-browser-artifact-"));
    store = await BrowserArtifactStore.open(dataDirectory);
  });

  afterEach(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it.each([
    ["principalId", { ...binding, principalId: "principal-2" }],
    ["runId", { ...binding, runId: "run-2" }],
  ] as const)("denies read when %s does not match", async (_field, otherBinding) => {
    const artifact = await store.write(binding, png.toString("base64"), 1024);
    await expect(store.read(artifact.id, otherBinding)).rejects.toThrow("browser_artifact_denied");
  });

  it("rejects malformed base64, non-PNG bytes, and data over the byte limit", async () => {
    await expect(store.write(binding, "not base64!", 1024)).rejects.toThrow(
      "browser_artifact_invalid_base64",
    );
    await expect(
      store.write(binding, Buffer.from("not png").toString("base64"), 1024),
    ).rejects.toThrow("browser_artifact_invalid_png");
    await expect(store.write(binding, png.toString("base64"), png.length - 1)).rejects.toThrow(
      "browser_artifact_too_large",
    );
  });

  it("persists the PNG and complete binding metadata across store reopen", async () => {
    const artifact = await store.write(binding, png.toString("base64"), 1024);
    const reopened = await BrowserArtifactStore.open(dataDirectory);
    const result = await reopened.read(artifact.id, binding);
    expect(result).toEqual({ data: png, mimeType: "image/png", sizeBytes: png.length });

    const metadata = JSON.parse(
      await readFile(
        join(dataDirectory, "browser-artifacts", artifact.id, `${artifact.id}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      principalId: binding.principalId,
      runId: binding.runId,
      conversationId: binding.conversationId,
      workspaceId: binding.workspaceId,
      policyVersion: binding.policyVersion,
    });
  });

  it("uses Windows ACL tools even when PATH cannot find them", async () => {
    if (process.platform !== "win32") return;
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "";
      const reopened = await BrowserArtifactStore.open(dataDirectory);
      const artifact = await reopened.write(binding, png.toString("base64"), 1024);
      expect((await reopened.read(artifact.id, binding)).data).toEqual(png);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("uses generated UUID paths and never exposes the storage path", async () => {
    const artifact = await store.write(binding, png.toString("base64"), 1024);
    const directory = join(dataDirectory, "browser-artifacts", artifact.id);
    const names = (await readdir(directory)).sort();
    expect(artifact.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(names).toEqual([`${artifact.id}.json`, `${artifact.id}.png`]);
    expect(JSON.stringify(artifact)).not.toContain(dataDirectory);
    await expect(store.read("../outside", binding)).rejects.toThrow("browser_artifact_not_found");

    if (process.platform !== "win32") {
      const rootMode = (await stat(join(dataDirectory, "browser-artifacts"))).mode & 0o777;
      const artifactMode = (await stat(directory)).mode & 0o777;
      const pngMode = (await stat(join(directory, `${artifact.id}.png`))).mode & 0o777;
      const metadataMode = (await stat(join(directory, `${artifact.id}.json`))).mode & 0o777;
      expect(rootMode).toBe(0o700);
      expect(artifactMode).toBe(0o700);
      expect(pngMode).toBe(0o600);
      expect(metadataMode).toBe(0o600);
    }
  });
});
