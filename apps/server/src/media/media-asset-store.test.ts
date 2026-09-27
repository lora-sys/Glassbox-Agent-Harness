import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MediaAssetStore,
  type MediaAssetBinding,
  type MediaAssetMimeType,
} from "./media-asset-store.js";

const binding: MediaAssetBinding = {
  principalId: "principal-1",
  conversationId: "conversation-1",
  runId: "run-1",
};

const samples: Array<[MediaAssetMimeType, Buffer]> = [
  [
    "image/png",
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0,
      1, 0, 0, 0, 1,
    ]),
  ],
  ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
  ["image/webp", Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP", "binary")],
  ["video/mp4", Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])],
];

describe("MediaAssetStore", () => {
  let dataDirectory: string;
  let store: MediaAssetStore;

  beforeEach(async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "glassbox-media-asset-"));
    store = await MediaAssetStore.open(dataDirectory);
  });

  afterEach(async () => {
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it.each(samples)("stores and reads %s with the same binding", async (mimeType, data) => {
    const asset = await store.write(binding, mimeType, data.toString("base64"), 1024);
    const reopened = await MediaAssetStore.open(dataDirectory);
    expect(await reopened.read(asset.id, binding)).toEqual({
      data,
      mimeType,
      sizeBytes: data.length,
    });
  });

  it.each([
    ["principalId", { ...binding, principalId: "principal-2" }],
    ["conversationId", { ...binding, conversationId: "conversation-2" }],
    ["runId", { ...binding, runId: "run-2" }],
  ] as const)("denies reads when %s does not match", async (_field, otherBinding) => {
    const [mimeType, data] = samples[0]!;
    const asset = await store.write(binding, mimeType, data.toString("base64"), 1024);
    await expect(store.read(asset.id, otherBinding)).rejects.toThrow("media_asset_denied");
  });

  it("rejects malformed base64, signature mismatches, and oversized data", async () => {
    await expect(store.write(binding, "image/png", "not base64!", 1024)).rejects.toThrow(
      "media_asset_invalid_base64",
    );
    await expect(
      store.write(binding, "image/png", Buffer.from("not a png").toString("base64"), 1024),
    ).rejects.toThrow("media_asset_invalid_signature");

    const [mimeType, data] = samples[0]!;
    await expect(
      store.write(binding, mimeType, data.toString("base64"), data.length - 1),
    ).rejects.toThrow("media_asset_too_large");
    await expect(
      store.write(binding, "application/json" as MediaAssetMimeType, data.toString("base64"), 1024),
    ).rejects.toThrow("media_asset_unsupported_mime_type");
  });

  it("writes opaque IDs and private files", async () => {
    const [mimeType, data] = samples[0]!;
    const asset = await store.write(binding, mimeType, data.toString("base64"), 1024);
    const directory = join(dataDirectory, "media-assets", asset.id);
    const names = (await readdir(directory)).sort();
    expect(asset.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(names).toEqual([`${asset.id}.json`, `${asset.id}.png`]);
    expect(JSON.stringify(asset)).not.toContain(dataDirectory);
    await expect(store.read("../outside", binding)).rejects.toThrow("media_asset_not_found");

    if (process.platform !== "win32") {
      expect((await stat(join(dataDirectory, "media-assets"))).mode & 0o777).toBe(0o700);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, `${asset.id}.png`))).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, `${asset.id}.json`))).mode & 0o777).toBe(0o600);
    }
  });
});
