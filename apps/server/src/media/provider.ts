/** Provider-neutral media generation contract used by Glassbox Tools and adapters. */
export type MediaProviderFailure =
  | "auth_missing"
  | "quota_exhausted"
  | "rate_limited"
  | "capability_unavailable"
  | "timeout"
  | "failed";

export type ImageSize = "1K" | "2K" | "3K" | "4K";
export type ImageRatio = "1:1" | "3:4" | "4:3" | "16:9" | "9:16" | "2:3" | "3:2" | "21:9";
export type VideoRatio = "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export type ImageReference =
  | { type: "url"; url: string }
  | { type: "base64"; mimeType: string; data: string };

export interface ImageGenerationRequest {
  mode: "text2image" | "img2img" | "compose";
  prompt: string;
  size: ImageSize;
  ratio?: ImageRatio;
  images?: readonly ImageReference[];
  output: "url" | "base64";
}

export type ImageGenerationResult =
  | { status: "ready"; images: readonly ({ url: string } | { base64: string })[] }
  | { status: MediaProviderFailure };

export interface VideoGenerationRequest {
  mode: "text" | "keyframe" | "reference";
  prompt: string;
  seconds?: number;
  aspectRatio?: VideoRatio;
  firstFrame?: string;
  lastFrame?: string;
  images?: readonly string[];
}

export type VideoGenerationJob =
  | { status: "pending"; videoId: string; taskId?: string; progress?: number }
  | {
      status: "completed";
      videoId: string;
      url: string;
      progress?: number;
      requestedResolution?: string;
    }
  | { status: "failed"; videoId: string; progress?: number }
  | { status: MediaProviderFailure };

export interface MediaGenerationProvider {
  readonly id: string;
  readonly capabilities: readonly ("image" | "video")[];
  generateImage?(
    input: ImageGenerationRequest,
    signal?: AbortSignal,
  ): Promise<ImageGenerationResult>;
  createVideo?(input: VideoGenerationRequest, signal?: AbortSignal): Promise<VideoGenerationJob>;
  pollVideo?(videoId: string, signal?: AbortSignal): Promise<VideoGenerationJob>;
}
