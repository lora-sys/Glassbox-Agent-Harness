import { describe, expect, it, vi } from "vite-plus/test";
import { MediaProviderRegistry } from "./provider-registry.js";
import type { MediaGenerationProvider } from "./provider.js";

function provider(
  id: string,
  capabilities: readonly ("image" | "video")[],
): MediaGenerationProvider {
  return {
    id,
    capabilities,
    generateImage: vi.fn(async () => ({
      status: "ready" as const,
      images: [{ base64: "aGVsbG8=" }],
    })),
    createVideo: vi.fn(async () => ({ status: "pending" as const, videoId: `${id}-job` })),
    pollVideo: vi.fn(async (videoId: string) => ({
      status: "completed" as const,
      videoId,
      url: "https://media.example/video.mp4",
    })),
  };
}

describe("MediaProviderRegistry", () => {
  it("routes image and video requests to their independently selected providers", async () => {
    const images = provider("image-provider", ["image"]);
    const videos = provider("video-provider", ["video"]);
    const registry = new MediaProviderRegistry([images, videos], {
      imageProviderId: images.id,
      videoProviderId: videos.id,
    });

    await expect(
      registry.generateImage({
        mode: "text2image",
        prompt: "a tree",
        size: "1K",
        output: "base64",
      }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(registry.createVideo({ mode: "text", prompt: "a tree" })).resolves.toMatchObject({
      status: "pending",
      videoId: "video-provider-job",
    });
    expect(registry.providerIdFor("image")).toBe("image-provider");
    expect(registry.providerIdFor("video")).toBe("video-provider");
  });

  it("returns a fixed capability failure when the selected provider is unavailable", async () => {
    const onlyImages = provider("image-provider", ["image"]);
    const registry = new MediaProviderRegistry([onlyImages], {
      imageProviderId: onlyImages.id,
      videoProviderId: "not-configured",
    });
    await expect(registry.createVideo({ mode: "text", prompt: "a tree" })).resolves.toEqual({
      status: "capability_unavailable",
    });
    expect(registry.providerIdFor("video")).toBeUndefined();
  });

  it("rejects duplicate provider IDs", () => {
    const first = provider("duplicate", ["image"]);
    const second = provider("duplicate", ["video"]);
    expect(
      () =>
        new MediaProviderRegistry([first, second], {
          imageProviderId: first.id,
          videoProviderId: second.id,
        }),
    ).toThrow("media_provider_duplicate_id");
  });
});
