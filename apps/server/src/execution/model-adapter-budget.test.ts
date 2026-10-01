import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vite-plus/test";
import { ModelProfileStore } from "../config/model-profiles.js";
import { textResponse } from "../model/testing/streams.js";
import { configuredModelAdapter } from "./model-adapter.js";
import type { ModelAgentEvent } from "./model-agent/index.js";
import type { ExecutionInput } from "./run-service/types.js";

it("fails closed before model construction when configured capacity is unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-model-unknown-capacity-"));
  try {
    const profiles = await ModelProfileStore.open(directory);
    await profiles.save({
      id: "unknown",
      label: "Unknown capacity",
      protocol: "openai-completions",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
    });
    const events: ModelAgentEvent[] = [];
    const result = await configuredModelAdapter({
      profiles,
      profileId: "unknown",
      onEvent: (_runId, event) => {
        events.push(event);
      },
    }).execute({
      text: "do not send",
      history: [],
      run: { id: "run-unknown-capacity" },
      signal: new AbortController().signal,
    } as unknown as ExecutionInput);

    expect(result).toEqual({
      status: "failed",
      failureCode: "model_capacity_unknown",
      runtimeAttempted: false,
    });
    expect(events).toEqual([
      { type: "model_capacity", state: "unknown", reasonCode: "capacity_unknown" },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails before a provider call when the authorized current message exceeds model capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-model-budget-"));
  try {
    const profiles = await ModelProfileStore.open(directory);
    await profiles.save({
      id: "bounded",
      label: "Bounded",
      protocol: "openai-completions",
      model: "fixture",
      baseUrl: "http://127.0.0.1:1/v1",
      contextWindowTokens: 8192,
      maxOutputTokens: 4096,
    });
    const events: ModelAgentEvent[] = [];
    const adapter = configuredModelAdapter({
      profiles,
      profileId: "bounded",
      onEvent: (_runId, event) => {
        events.push(event);
      },
    });
    const result = await adapter.execute({
      text: "中".repeat(5000),
      history: [],
      run: { id: "run-budget" },
      signal: new AbortController().signal,
    } as unknown as ExecutionInput);
    expect(result.status).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "context_budget",
        overflow: "fixed_floor_exceeds_capacity",
        omittedExchanges: 0,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("sends image content only to a profile that explicitly supports vision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-model-images-"));
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(typeof init?.body === "string" ? init.body : "");
      return textResponse("openai-completions");
    }),
  );
  try {
    const profiles = await ModelProfileStore.open(directory);
    await profiles.save({
      id: "vision",
      label: "Vision",
      protocol: "openai-completions",
      model: "fixture",
      baseUrl: "http://127.0.0.1:9898/v1",
      supportsVision: true,
      contextWindowTokens: 8192,
      maxOutputTokens: 1024,
    });
    const result = await configuredModelAdapter({ profiles, profileId: "vision" }).execute({
      text: "这张图里有什么？",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      history: [],
      run: { id: "run-image" },
      signal: new AbortController().signal,
    } as unknown as ExecutionInput);

    expect(result).toMatchObject({ status: "succeeded", text: "Hello 群" });
    expect(JSON.stringify(requests)).toContain("data:image/png;base64,aGVsbG8=");
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

it("explains that a text-only model cannot inspect images without making a request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "glassbox-model-no-vision-"));
  const fetch = vi.fn(async () => textResponse("openai-completions"));
  vi.stubGlobal("fetch", fetch);
  try {
    const profiles = await ModelProfileStore.open(directory);
    await profiles.save({
      id: "text-only",
      label: "Text only",
      protocol: "openai-completions",
      model: "fixture",
      baseUrl: "http://127.0.0.1:9898/v1",
      supportsVision: false,
      contextWindowTokens: 8192,
      maxOutputTokens: 1024,
    });
    const result = await configuredModelAdapter({ profiles, profileId: "text-only" }).execute({
      text: "这张图里有什么？",
      images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      history: [],
      run: { id: "run-image-text-only" },
      signal: new AbortController().signal,
    } as unknown as ExecutionInput);

    expect(result).toMatchObject({
      status: "failed",
      failureCode: "model_capability_missing",
      runtimeAttempted: false,
      text: expect.stringContaining("不支持识别图片"),
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports an image read failure before resolving a model profile", async () => {
  const resolve = vi.fn(() => {
    throw new Error("model resolution must not run");
  });
  const result = await configuredModelAdapter({
    profiles: { resolve } as unknown as ModelProfileStore,
    profileId: "unavailable",
  }).execute({
    text: "这张图里有什么？",
    imageFailureCode: "image_unavailable",
  } as unknown as ExecutionInput);

  expect(result).toEqual({
    status: "succeeded",
    runtimeAttempted: false,
    text: "图片读取失败，暂时无法识别，请重新发送图片。",
  });
  expect(resolve).not.toHaveBeenCalled();
});
