import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  MediaGenerationProvider,
  VideoGenerationJob,
  VideoGenerationRequest,
} from "./provider.js";

export interface MediaProviderSelection {
  imageProviderId: string;
  videoProviderId: string;
}

/** Routes each media capability through a configured provider without exposing vendor details to Tools. */
export class MediaProviderRegistry implements MediaGenerationProvider {
  readonly id = "media-provider-registry";
  readonly capabilities: readonly ("image" | "video")[];
  private readonly providers: ReadonlyMap<string, MediaGenerationProvider>;

  constructor(
    providers: readonly MediaGenerationProvider[],
    private readonly selection: MediaProviderSelection,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    if (this.providers.size !== providers.length) throw new Error("media_provider_duplicate_id");
    this.capabilities = Object.freeze([
      ...(this.selected("image")?.generateImage ? (["image"] as const) : []),
      ...(this.selected("video")?.createVideo && this.selected("video")?.pollVideo
        ? (["video"] as const)
        : []),
    ]);
  }

  providerIdFor(type: "image" | "video"): string | undefined {
    const provider = this.selected(type);
    const supported =
      type === "image"
        ? Boolean(provider?.generateImage && provider.capabilities.includes("image"))
        : Boolean(
            provider?.createVideo && provider.pollVideo && provider.capabilities.includes("video"),
          );
    return supported ? provider?.id : undefined;
  }

  async generateImage(
    input: ImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ImageGenerationResult> {
    const provider = this.selected("image");
    if (!provider?.generateImage || !provider.capabilities.includes("image"))
      return { status: "capability_unavailable" };
    return provider.generateImage(input, signal);
  }

  async createVideo(
    input: VideoGenerationRequest,
    signal?: AbortSignal,
  ): Promise<VideoGenerationJob> {
    const provider = this.selected("video");
    if (!provider?.createVideo || !provider.capabilities.includes("video"))
      return { status: "capability_unavailable" };
    return provider.createVideo(input, signal);
  }

  async pollVideo(videoId: string, signal?: AbortSignal): Promise<VideoGenerationJob> {
    const provider = this.selected("video");
    if (!provider?.pollVideo || !provider.capabilities.includes("video"))
      return { status: "capability_unavailable" };
    return provider.pollVideo(videoId, signal);
  }

  private selected(type: "image" | "video"): MediaGenerationProvider | undefined {
    return this.providers.get(
      type === "image" ? this.selection.imageProviderId : this.selection.videoProviderId,
    );
  }
}
