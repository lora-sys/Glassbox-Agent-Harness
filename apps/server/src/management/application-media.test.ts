import { afterEach, expect, it, vi } from "vite-plus/test";
import type { MediaGenerationProvider } from "../media/provider.js";
import { admin, createApplicationFixtureScope } from "./application-test-helpers.js";
import type { OwnerContext } from "./application-test-helpers.js";

vi.mock("../media/download-public-output.js", () => ({
  downloadPublicMediaOutput: vi.fn(async () =>
    Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
  ),
}));

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(afterEachCleanup);

it("runs the Owner media Tool through the selected provider and stores a Run-bound private Asset", async () => {
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const generateImage = vi.fn(async () => ({
    status: "ready" as const,
    images: [{ base64: pngBase64 }],
  }));
  const provider: MediaGenerationProvider = {
    id: "fixture-media",
    capabilities: ["image"],
    generateImage,
  };
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
    mediaProvider: provider,
  });
  f.send(775, "生成一张小树的图片", true);
  const started = await f.started.take();
  await f.reply("生成一张小树的图片");

  const context: OwnerContext = {
    caller: started.caller,
    conversationId: started.conversation.id,
    runId: started.run.id,
    requiredToolName: "media_generate",
    requiredToolInput: { action: "image" },
  };
  const tool = admin(f.app)
    .createRuntimeTools(() => context)
    .find((candidate) => candidate.name === "media_generate");
  if (!tool) throw new Error("missing media_generate");
  const result = await tool.execute("generate", {
    action: "image",
    mode: "text2image",
    prompt: "a small tree",
    size: "1K",
  });
  const details = result.details as { status: string; assets: readonly string[] };
  expect(details.status).toBe("completed");
  expect(details.assets).toHaveLength(1);
  expect(generateImage.mock.calls).toHaveLength(1);

  const mediaAssets = (
    f.app as unknown as {
      mediaAssets: {
        binding(id: string): Promise<Record<string, string>>;
        read(id: string, binding: Record<string, string>): Promise<{ data: Buffer }>;
      };
    }
  ).mediaAssets;
  const binding = await mediaAssets.binding(details.assets[0]!);
  expect(binding).toMatchObject({
    principalId: started.caller.principalId,
    conversationId: started.conversation.id,
    runId: started.run.id,
  });
  await expect(mediaAssets.read(details.assets[0]!, binding)).resolves.toMatchObject({
    data: Buffer.from(pngBase64, "base64"),
  });
});

it("allows one corrected media call after an input rejected before provider execution", async () => {
  const generateImage = vi.fn(async () => ({
    status: "ready" as const,
    images: [
      {
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      },
    ],
  }));
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
    mediaProvider: { id: "fixture-media", capabilities: ["image"], generateImage },
  });
  f.send(775, "生成图片", true);
  const started = await f.started.take();
  await f.reply("生成图片");
  const context: OwnerContext = {
    caller: started.caller,
    conversationId: started.conversation.id,
    runId: started.run.id,
    requiredToolName: "media_generate",
    requiredToolInput: { action: "image" },
  };
  const tool = admin(f.app)
    .createRuntimeTools(() => context)
    .find((candidate) => candidate.name === "media_generate");
  if (!tool) throw new Error("missing media_generate");

  await expect(
    tool.execute("generate", { action: "image", mode: "text", prompt: "a tree" }),
  ).rejects.toThrow("protected_tool_failed");
  expect(generateImage).not.toHaveBeenCalled();
  const corrected = await tool.execute("generate", {
    action: "image",
    mode: "text2image",
    prompt: "a tree",
  });
  expect(corrected.details).toMatchObject({ status: "completed" });
  expect(generateImage).toHaveBeenCalledOnce();
});

it("reports the video provider's requested resolution without using image sizes", async () => {
  const provider: MediaGenerationProvider = {
    id: "fixture-video",
    capabilities: ["video"],
    createVideo: vi.fn(async () => ({
      status: "completed" as const,
      videoId: "video-job",
      url: "https://media.example/video.mp4",
      requestedResolution: "720P",
    })),
    pollVideo: vi.fn(),
  };
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
    mediaProvider: provider,
  });
  f.send(775, "生成 720P 视频", true);
  const started = await f.started.take();
  await f.reply("生成 720P 视频");
  const context: OwnerContext = {
    caller: started.caller,
    conversationId: started.conversation.id,
    runId: started.run.id,
    requiredToolName: "media_generate",
    requiredToolInput: { action: "video" },
  };
  const tool = admin(f.app)
    .createRuntimeTools(() => context)
    .find((candidate) => candidate.name === "media_generate");
  if (!tool) throw new Error("missing media_generate");
  const result = await tool.execute("generate", {
    action: "video",
    mode: "text",
    prompt: "A bubbling drink",
    ratio: "16:9",
    seconds: 5,
  });
  expect(result.details).toMatchObject({ status: "completed", requestedResolution: "720P" });
  const text = (result as unknown as { content: Array<{ type: string; text: string }> }).content[0]
    ?.text;
  expect(text).toContain("video resolution 720P");
  expect(text).not.toContain("1K");
});

it("rejects image-only ratio validation for video before calling the media provider", async () => {
  const createVideo = vi.fn(async () => ({ status: "pending" as const, videoId: "job" }));
  const provider: MediaGenerationProvider = {
    id: "fixture-media",
    capabilities: ["video"],
    createVideo,
    pollVideo: vi.fn(),
  };
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
    mediaProvider: provider,
  });
  f.send(775, "生成图片", true);
  const started = await f.started.take();
  await f.reply("生成图片");
  const context: OwnerContext = {
    caller: started.caller,
    conversationId: started.conversation.id,
    runId: started.run.id,
    requiredToolName: "media_generate",
    requiredToolInput: { action: "video" },
  };
  const tool = admin(f.app)
    .createRuntimeTools(() => context)
    .find((item) => item.name === "media_generate");
  if (!tool) throw new Error("missing media_generate");
  await expect(
    tool.execute("generate", { action: "video", prompt: "A river", ratio: "2:3" }),
  ).rejects.toThrow();
  expect(createVideo).not.toHaveBeenCalled();
});

it("passes Run cancellation to the media provider and does not write an Asset", async () => {
  const generateImage = vi.fn(
    (_input, signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Operation cancelled")), {
          once: true,
        });
      }),
  );
  const provider: MediaGenerationProvider = {
    id: "fixture-media",
    capabilities: ["image"],
    generateImage,
  };
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
    mediaProvider: provider,
  });
  f.send(775, "生成图片", true);
  const started = await f.started.take();
  await f.reply("生成图片");
  const context: OwnerContext = {
    caller: started.caller,
    conversationId: started.conversation.id,
    runId: started.run.id,
    requiredToolName: "media_generate",
    requiredToolInput: { action: "image" },
  };
  const tool = admin(f.app)
    .createRuntimeTools(() => context)
    .find((item) => item.name === "media_generate");
  if (!tool) throw new Error("missing media_generate");
  const controller = new AbortController();
  const pending = tool.execute(
    "generate",
    { action: "image", prompt: "A tree" },
    controller.signal,
  );
  await vi.waitFor(() => expect(generateImage).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toThrow("Operation cancelled");
});

it("returns a clear status when generated media exceeds the OneBot delivery limit", async () => {
  const image = Buffer.alloc(8 * 1024 * 1024 + 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  const provider: MediaGenerationProvider = {
    id: "fixture-media",
    capabilities: ["image"],
    generateImage: vi.fn(async () => ({
      status: "ready" as const,
      images: [{ base64: image.toString("base64") }],
    })),
  };
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
    mediaProvider: provider,
  });
  f.send(775, "生成图片", true);
  const started = await f.started.take();
  await f.reply("生成图片");
  const context: OwnerContext = {
    caller: started.caller,
    conversationId: started.conversation.id,
    runId: started.run.id,
    requiredToolName: "media_generate",
    requiredToolInput: { action: "image" },
  };
  const tool = admin(f.app)
    .createRuntimeTools(() => context)
    .find((item) => item.name === "media_generate");
  if (!tool) throw new Error("missing media_generate");
  const result = await tool.execute("generate", { action: "image", prompt: "A tree" });
  expect(result.details).toMatchObject({ status: "media_output_too_large" });
});
