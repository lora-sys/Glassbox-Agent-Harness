import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectRetainedMediaAsset } from "../lib/media-asset-evidence.mjs";

const assetId = "e6ef0e17-758a-4c50-a3c0-e8036ae9842d";
const binding = { principalId: "owner-1", conversationId: "conversation-1", runId: "run-1" };
const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
png.write("IHDR", 12);
const mp4 = Buffer.alloc(12);
mp4.writeUInt32BE(12);
mp4.write("ftyp", 4);

async function fixture(t, stage = "image-1k") {
  const dataDirectory = await mkdtemp(join(tmpdir(), "qq-media-asset-test-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const directory = join(dataDirectory, "media-assets", assetId);
  await mkdir(directory, { recursive: true });
  const video = stage === "video-4s";
  const data = video ? mp4 : png;
  const metadata = {
    schemaVersion: 1,
    id: assetId,
    ...binding,
    mimeType: video ? "video/mp4" : "image/png",
    sizeBytes: data.length,
  };
  const metadataPath = join(directory, `${assetId}.json`);
  const assetPath = join(directory, `${assetId}.${video ? "mp4" : "png"}`);
  await writeFile(metadataPath, JSON.stringify(metadata));
  await writeFile(assetPath, data);
  return {
    input: { dataDirectory, assetId, binding, stage },
    metadata,
    metadataPath,
    assetPath,
    data,
  };
}

function captureFor(stage, changes = {}) {
  const calls = [];
  return {
    calls,
    capture(command, args, options) {
      calls.push({ command, args, options });
      assert.equal(args.includes("/proc/self/fd/0"), true);
      assert.equal(args.includes("file,pipe"), true);
      assert.equal(typeof options.stdio[0], "number");
      if (command.endsWith("ffprobe"))
        return JSON.stringify({
          streams: [
            {
              codec_type: "video",
              width: stage === "image-1k" ? 1024 : 1280,
              height: stage === "image-1k" ? 1024 : 720,
              duration: "4",
              avg_frame_rate: "24/1",
              ...changes,
            },
          ],
          format: { duration: "4" },
        });
      return "";
    },
  };
}

test("retained media reads bind metadata, actual bytes and decoded dimensions without writes", async (t) => {
  for (const stage of ["image-1k", "video-4s"]) {
    const f = await fixture(t, stage);
    const before = await readFile(f.metadataPath);
    const probe = captureFor(stage);
    const facts = await inspectRetainedMediaAsset(f.input, probe);
    assert.equal(facts.sha256, createHash("sha256").update(f.data).digest("hex"));
    assert.equal(facts.sizeBytes, f.data.length);
    assert.equal(facts.fullDecodeVerified, true);
    assert.equal(facts.retained, true);
    assert.equal(probe.calls.length, 2);
    assert.deepEqual(await readFile(f.metadataPath), before);
    assert.deepEqual(await readFile(f.assetPath), f.data);
    assert.equal(JSON.stringify(facts).includes(f.input.dataDirectory), false);
  }
});

test("media metadata identity, MIME signature and byte-count mismatches are refused", async (t) => {
  for (const change of [
    { runId: "another-run" },
    { principalId: "visitor" },
    { conversationId: "another-chat" },
    { sizeBytes: 100 },
    { mimeType: "image/jpeg" },
    { extra: "forged" },
  ]) {
    const f = await fixture(t);
    await writeFile(f.metadataPath, JSON.stringify({ ...f.metadata, ...change }));
    await assert.rejects(inspectRetainedMediaAsset(f.input, captureFor("image-1k")), {
      code: "MEDIA_ASSET_EVIDENCE",
    });
  }
});

test("symlinked media files are refused before invoking the decoder", async (t) => {
  const f = await fixture(t);
  const target = join(f.input.dataDirectory, "outside.png");
  await writeFile(target, f.data);
  await rm(f.assetPath);
  await symlink(target, f.assetPath);
  const probe = captureFor("image-1k");
  await assert.rejects(inspectRetainedMediaAsset(f.input, probe), { code: "MEDIA_ASSET_EVIDENCE" });
  assert.equal(probe.calls.length, 0);
});

test("wrong dimensions, wrong duration and decoder failure cannot claim media output success", async (t) => {
  for (const [stage, change] of [
    ["image-1k", { width: 512 }],
    ["video-4s", { duration: "5" }],
    ["video-4s", { avg_frame_rate: "0/0" }],
  ]) {
    const f = await fixture(t, stage);
    await assert.rejects(inspectRetainedMediaAsset(f.input, captureFor(stage, change)), {
      code: "MEDIA_ASSET_EVIDENCE",
    });
  }
  const f = await fixture(t);
  const capture = () => {
    throw new Error("secret file and URL must not escape");
  };
  await assert.rejects(
    inspectRetainedMediaAsset(f.input, { capture }),
    (error) => error.code === "MEDIA_ASSET_EVIDENCE" && !error.message.includes("secret"),
  );
});
