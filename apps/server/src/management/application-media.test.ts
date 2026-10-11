import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ExecutionResult } from "../execution/run-service/types.js";
import { downloadPublicMediaOutput } from "../media/download-public-output.js";
import type {
  ImageGenerationRequest,
  MediaGenerationProvider,
  VideoGenerationRequest,
} from "../media/provider.js";
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
  const generateImage = vi.fn(async (_input: ImageGenerationRequest) => ({
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
    prompt: "private-media-prompt-canary",
    size: "1K",
  });
  const details = result.details as {
    status: string;
    assets: readonly string[];
  };
  expect(details.status).toBe("completed");
  expect(details.assets).toHaveLength(1);
  expect(generateImage.mock.calls).toHaveLength(1);
  const providerInput = generateImage.mock.calls[0]![0];
  const admission = (await f.app.trace.readPage(started.run.id)).records
    .map((record) => record.event as Record<string, unknown>)
    .find((event) => event.type === "media_generation_request_admitted");
  const providerInputJson = JSON.stringify(providerInput);
  expect(admission).toEqual({
    type: "media_generation_request_admitted",
    schemaVersion: 1,
    runId: started.run.id,
    principalId: started.caller.principalId,
    toolCallId: "generate",
    provider: "fixture-media",
    mediaType: "image",
    providerInputSha256: createHash("sha256").update(providerInputJson).digest("hex"),
    providerInputBytes: Buffer.byteLength(providerInputJson, "utf8"),
    promptSha256: createHash("sha256").update("private-media-prompt-canary").digest("hex"),
    promptBytes: Buffer.byteLength("private-media-prompt-canary", "utf8"),
    mode: "text2image",
    size: "1K",
    referenceCount: 0,
    hasFirstFrame: false,
    hasLastFrame: false,
  });
  expect(JSON.stringify(admission)).not.toContain("private-media-prompt-canary");

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
    mediaProvider: {
      id: "fixture-media",
      capabilities: ["image"],
      generateImage,
    },
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
    tool.execute("generate", {
      action: "image",
      mode: "text",
      prompt: "a tree",
    }),
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
  const createVideo = vi.fn(async (_input: VideoGenerationRequest) => ({
    status: "completed" as const,
    videoId: "video-job",
    url: "https://media.example/video.mp4",
    requestedResolution: "720P",
  }));
  const provider: MediaGenerationProvider = {
    id: "fixture-video",
    capabilities: ["video"],
    createVideo,
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
  expect(result.details).toMatchObject({
    status: "completed",
    requestedResolution: "720P",
  });
  const text = (result as unknown as { content: Array<{ type: string; text: string }> }).content[0]
    ?.text;
  expect(text).toContain("video resolution 720P");
  expect(text).not.toContain("1K");
});

it.each(["append", "advanceTrace"] as const)(
  "does not invoke the provider when admission evidence %s cannot be persisted",
  async (failurePoint) => {
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
      mediaProvider: {
        id: "fixture-media",
        capabilities: ["image"],
        generateImage,
      },
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
    const append = vi.spyOn(f.app.trace, "append");
    const advanceTrace = vi.spyOn(f.app.store.evidence, "advanceTrace");
    if (failurePoint === "append") append.mockRejectedValue(new Error("trace unavailable"));
    else advanceTrace.mockRejectedValue(new Error("trace index unavailable"));
    try {
      await expect(
        tool.execute("admission-failure", {
          action: "image",
          mode: "text2image",
          prompt: "admission-failure-prompt",
        }),
      ).rejects.toThrow("protected_tool_failed");
      expect(
        append.mock.calls.some(
          ([, event]) =>
            (event as Record<string, unknown>).type === "media_generation_request_admitted",
        ),
      ).toBe(true);
      if (failurePoint === "advanceTrace") expect(advanceTrace).toHaveBeenCalled();
      expect(generateImage).not.toHaveBeenCalled();
    } finally {
      append.mockRestore();
      advanceTrace.mockRestore();
    }
  },
);

it("refuses media generation without a Tool call identity", async () => {
  const generateImage = vi.fn(async () => ({ status: "failed" as const }));
  const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
    mediaProvider: {
      id: "fixture-media",
      capabilities: ["image"],
      generateImage,
    },
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
    tool.execute("", {
      action: "image",
      mode: "text2image",
      prompt: "identity-required",
    }),
  ).rejects.toThrow("protected_tool_failed");
  expect(generateImage).not.toHaveBeenCalled();
});

it("rejects image-only ratio validation for video before calling the media provider", async () => {
  const createVideo = vi.fn(async () => ({
    status: "pending" as const,
    videoId: "job",
  }));
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
    tool.execute("generate", {
      action: "video",
      prompt: "A river",
      ratio: "2:3",
    }),
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
  await expect(
    tool.execute("generate", {
      action: "image",
      prompt: "A tree",
    }),
  ).rejects.toMatchObject({
    name: "ProviderCallError",
    outcome: "provider_failed",
    message: "media_output_too_large",
  });
});

it.each(["image", "video"] as const)(
  "marks a rejected %s generation as a failed Tool call and prevents same-Run retries",
  async (action) => {
    const rejected = vi.fn(async () => ({ status: "rate_limited" as const }));
    const provider: MediaGenerationProvider = {
      id: "fixture-media",
      capabilities: ["image", "video"],
      generateImage: rejected,
      createVideo: rejected,
      pollVideo: vi.fn(),
    };
    const f = await fixture(async (input) => ({ status: "succeeded", text: input.text }), {
      mediaProvider: provider,
    });
    f.send(775, "生成媒体", true);
    const started = await f.started.take();
    await f.reply("生成媒体");
    const context: OwnerContext = {
      caller: started.caller,
      conversationId: started.conversation.id,
      runId: started.run.id,
      requiredToolName: "media_generate",
      requiredToolInput: { action },
    };
    const tool = admin(f.app)
      .createRuntimeTools(() => context)
      .find((item) => item.name === "media_generate")!;
    await expect(
      tool.execute("generate", { action, prompt: "private-canary" }),
    ).rejects.toMatchObject({
      name: "ProviderCallError",
      outcome: "provider_unavailable",
      message: "media_rate_limited",
    });
    await expect(tool.execute("retry", { action, prompt: "private-canary" })).rejects.toThrow(
      "mutation_already_attempted",
    );
    expect(rejected).toHaveBeenCalledOnce();
    const events = (await f.app.trace.readPage(started.run.id)).records.map(
      (row) => row.event as Record<string, unknown>,
    );
    expect(
      events.filter((event) => event.type === "media_generation_request_admitted"),
    ).toHaveLength(1);
    expect(events.some((event) => event.type === "media_generation_completed")).toBe(false);
  },
);

it.each(["image", "video"] as const)(
  "delivers completed %s from trusted generation evidence when the model omits its asset marker",
  async (action) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    let complete!: (value: { status: "succeeded"; text: string }) => void;
    const pending = new Promise<{ status: "succeeded"; text: string }>((resolve) => {
      complete = resolve;
    });
    const f = await fixture(async () => pending, {
      mediaProvider: {
        id: "fixture-media",
        capabilities: ["image", "video"],
        generateImage: vi.fn(async () => ({ status: "ready" as const, images: [{ base64: png }] })),
        createVideo: vi.fn(async () => ({
          status: "completed" as const,
          videoId: "fixture-video",
          url: "https://media.example/video.mp4",
        })),
        pollVideo: vi.fn(),
      },
    });
    f.send(776, action === "image" ? "帮我做一张图片" : "帮我做一段视频", true);
    const started = await f.started.take();
    const context: OwnerContext = {
      caller: started.caller,
      conversationId: started.conversation.id,
      runId: started.run.id,
      requiredToolName: "media_generate",
      requiredToolInput: { action },
    };
    const tool = admin(f.app)
      .createRuntimeTools(() => context)
      .find((entry) => entry.name === "media_generate")!;
    if (action === "video")
      vi.mocked(downloadPublicMediaOutput).mockResolvedValueOnce(
        Buffer.from("000000186674797069736F6D0000020069736F6D69736F32", "hex"),
      );
    const result = await tool.execute("generate", { action, prompt: "a cat" });
    const assetId = (result.details as { assets: string[] }).assets[0]!;
    complete({ status: "succeeded", text: "已完成，请查看附件。" });
    await f.app.runs.waitForRun(started.caller, started.run.id);
    await f.app.runs.drain();
    const deliveries = (await f.app.store.lifecycle.listDeliveries(started.caller, started.run.id))
      .items;
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ payloadKind: "result", status: "sent" }),
        expect.objectContaining({
          payloadKind: "media_artifact",
          payloadText: assetId,
          status: "sent",
        }),
      ]),
    );
    expect(deliveries.filter((entry) => entry.payloadKind === "media_artifact")).toHaveLength(1);
    const actual = f.actionLog.filter((entry) => entry.action === "send_private_msg");
    expect(
      actual.some((entry) =>
        (entry.params.message as Array<{ type: string }>).some((part) => part.type === action),
      ),
    ).toBe(true);
  },
);

it.each(["wrong_provenance", "foreign_run", "failed_run"] as const)(
  "does not infer an attachment from %s evidence",
  async (scenario) => {
    let finish!: (value: ExecutionResult) => void;
    const pending = new Promise<ExecutionResult>((resolve) => {
      finish = resolve;
    });
    const f = await fixture(async () => pending, {
      mediaProvider: {
        id: "fixture-media",
        capabilities: ["image"],
        generateImage: vi.fn(async () => ({
          status: "ready" as const,
          images: [
            {
              base64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
            },
          ],
        })),
      },
    });
    f.send(779, "帮我做一张图片", true);
    const started = await f.started.take();
    const context: OwnerContext = {
      caller: started.caller,
      conversationId: started.conversation.id,
      runId: started.run.id,
      requiredToolName: "media_generate",
      requiredToolInput: { action: "image" },
    };
    const tool = admin(f.app)
      .createRuntimeTools(() => context)
      .find((entry) => entry.name === "media_generate")!;
    await tool.execute("generate", { action: "image", prompt: "a tree" });
    const readPage = f.app.trace.readPage.bind(f.app.trace);
    const pageSpy =
      scenario === "wrong_provenance"
        ? vi.spyOn(f.app.trace, "readPage").mockImplementation(async (...args) => {
            const page = await readPage(...args);
            return {
              ...page,
              records: page.records.map((record) => ({ ...record, provenance: "pi" })),
            };
          })
        : undefined;
    const assets = (
      f.app as unknown as {
        mediaAssets: {
          binding(
            id: string,
          ): Promise<{ runId: string; conversationId: string; principalId: string }>;
        };
      }
    ).mediaAssets;
    const binding = assets.binding.bind(assets);
    const bindingSpy =
      scenario === "foreign_run"
        ? vi
            .spyOn(assets, "binding")
            .mockImplementation(async (id) => ({ ...(await binding(id)), runId: "another-run" }))
        : undefined;
    try {
      finish(
        scenario === "failed_run"
          ? { status: "failed", failureCode: "runtime_run_errored", text: "已结束。" }
          : { status: "succeeded", text: "已结束。" },
      );
      await f.app.runs.waitForRun(started.caller, started.run.id);
      await f.app.runs.drain();
      const deliveries = (
        await f.app.store.lifecycle.listDeliveries(started.caller, started.run.id)
      ).items;
      expect(deliveries.some((entry) => entry.payloadKind === "media_artifact")).toBe(false);
      expect(
        f.actionLog
          .filter((entry) => entry.action === "send_private_msg")
          .some((entry) =>
            (entry.params.message as Array<{ type: string }>).some((part) => part.type === "image"),
          ),
      ).toBe(false);
    } finally {
      pageSpy?.mockRestore();
      bindingSpy?.mockRestore();
    }
  },
);
