import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageReference,
  MediaGenerationProvider,
  MediaProviderFailure,
  VideoGenerationJob,
  VideoGenerationRequest,
} from "./provider.js";

const AGNES_ORIGIN = "https://apihub.agnes-ai.com";
const IMAGE_MODEL = "agnes-image-2.1-flash";
const VIDEO_MODEL = "agnes-video-2.5-flash";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_IMAGE_TIMEOUT_MS = 240_000;
const DEFAULT_VIDEO_TIMEOUT_MS = 30_000;

export type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageReference,
  MediaProviderFailure,
  VideoGenerationJob,
  VideoGenerationRequest,
} from "./provider.js";

export interface AgnesMediaProviderOptions {
  /** Supplied by the caller. This client never reads credentials from process.env or files. */
  apiKey?: string;
  fetcher?: typeof fetch;
  imageTimeoutMs?: number;
  videoTimeoutMs?: number;
}

export type AgnesMediaFailure = MediaProviderFailure;
export type AgnesImageResult = ImageGenerationResult;
export type AgnesVideoJob = VideoGenerationJob;
export type AgnesImageRequest = ImageGenerationRequest;
export type AgnesVideoRequest = VideoGenerationRequest;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mediaInputValue(input: ImageReference): string {
  if (input.type === "base64") {
    if (
      !/^image\/(?:png|jpeg|webp|gif)$/.test(input.mimeType) ||
      !input.data ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)
    ) {
      throw new Error("invalid_image_input");
    }
    return `data:${input.mimeType};base64,${input.data}`;
  }
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("invalid_image_input_url");
  return url.href;
}

function publicHttpsUrl(value: string, errorCode: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(errorCode);
  return url.href;
}

function mapHttpFailure(status: number): AgnesMediaFailure {
  if (status === 401 || status === 403) return "auth_missing";
  if (status === 402) return "quota_exhausted";
  if (status === 429 || status === 503) return "rate_limited";
  return "failed";
}

async function readJsonBounded(response: Response): Promise<Record<string, unknown> | undefined> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) return undefined;
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return asRecord(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return undefined;
  }
}

function imageRequestBody(input: AgnesImageRequest): Record<string, unknown> {
  if (!input.prompt.trim()) throw new Error("empty_prompt");
  const body: Record<string, unknown> = {
    model: IMAGE_MODEL,
    prompt: input.prompt,
    size: input.size,
    ...(input.ratio ? { ratio: input.ratio } : {}),
  };

  if (input.mode === "text2image") {
    if (input.images?.length) throw new Error("unexpected_images_for_text2image");
    if (input.output === "base64") body.return_base64 = true;
  } else {
    if (!input.images?.length) throw new Error("image_input_required");
    const images = input.images.map(mediaInputValue);
    body.extra_body = {
      image: images,
      ...(input.output === "url" ? { response_format: "url" } : { response_format: "b64_json" }),
    };
  }

  if (input.mode === "text2image" && input.output === "url") {
    body.extra_body = { response_format: "url" };
  }
  return body;
}

function readImages(payload: Record<string, unknown>): AgnesImageResult {
  if (!Array.isArray(payload.data)) return { status: "failed" };
  const images: ({ url: string } | { base64: string })[] = [];
  for (const item of payload.data) {
    const row = asRecord(item);
    if (typeof row?.url === "string" && row.url) images.push({ url: row.url });
    else if (typeof row?.b64_json === "string" && row.b64_json)
      images.push({ base64: row.b64_json });
  }
  return images.length ? { status: "ready", images } : { status: "failed" };
}

function videoRequestBody(input: AgnesVideoRequest): Record<string, unknown> {
  if (!input.prompt.trim()) throw new Error("empty_prompt");
  const seconds = input.seconds ?? 5;
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 12)
    throw new Error("invalid_video_duration");

  const body: Record<string, unknown> = {
    model: VIDEO_MODEL,
    prompt: input.prompt,
    mode: input.mode,
    seconds: String(seconds),
    size: "720P",
    n: 1,
    ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
  };

  if (input.mode === "text") {
    if (input.firstFrame || input.lastFrame || input.images?.length)
      throw new Error("unexpected_media_for_text_video");
  } else if (input.mode === "keyframe") {
    if (!input.firstFrame && !input.lastFrame) throw new Error("keyframe_required");
    if (input.images?.length) throw new Error("unexpected_images_for_keyframe");
    if (input.firstFrame)
      body.first_frame = publicHttpsUrl(input.firstFrame, "invalid_first_frame_url");
    if (input.lastFrame)
      body.last_frame = publicHttpsUrl(input.lastFrame, "invalid_last_frame_url");
  } else {
    if (input.firstFrame || input.lastFrame) throw new Error("unexpected_keyframe_for_reference");
    if (!input.images?.length) throw new Error("reference_image_required");
    if (input.images.length > 5) throw new Error("too_many_reference_images");
    body.images = input.images.map((image) => publicHttpsUrl(image, "invalid_reference_image_url"));
  }

  return body;
}

function readVideoJob(payload: Record<string, unknown>, requestedVideoId?: string): AgnesVideoJob {
  const videoId = typeof payload.video_id === "string" ? payload.video_id : requestedVideoId;
  if (!videoId) return { status: "failed" };
  const progress =
    typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.max(0, Math.min(100, payload.progress))
      : undefined;
  if (payload.status === "completed") {
    if (typeof payload.url !== "string" || !payload.url)
      return { status: "failed", videoId, ...(progress !== undefined ? { progress } : {}) };
    return {
      status: "completed",
      videoId,
      url: payload.url,
      requestedResolution: "720P",
      ...(progress !== undefined ? { progress } : {}),
    };
  }
  if (payload.status === "failed")
    return { status: "failed", videoId, ...(progress !== undefined ? { progress } : {}) };
  if (typeof payload.status === "string") {
    return {
      status: "pending",
      videoId,
      ...(typeof payload.id === "string" ? { taskId: payload.id } : {}),
      ...(progress !== undefined ? { progress } : {}),
    };
  }
  return { status: "failed" };
}

export class AgnesMediaProvider implements MediaGenerationProvider {
  readonly id = "agnes";
  readonly capabilities = ["image", "video"] as const;
  private readonly fetcher: typeof fetch;
  private readonly imageTimeoutMs: number;
  private readonly videoTimeoutMs: number;

  constructor(private readonly options: AgnesMediaProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.imageTimeoutMs = Math.min(
      Math.max(options.imageTimeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS, 1),
      360_000,
    );
    this.videoTimeoutMs = Math.min(
      Math.max(options.videoTimeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS, 1),
      120_000,
    );
  }

  async generateImage(input: AgnesImageRequest, signal?: AbortSignal): Promise<AgnesImageResult> {
    const apiKey = this.options.apiKey;
    if (!apiKey?.trim()) return { status: "auth_missing" };
    const body = imageRequestBody(input);
    return this.request("/v1/images/generations", body, this.imageTimeoutMs, readImages, signal);
  }

  async createVideo(input: AgnesVideoRequest, signal?: AbortSignal): Promise<AgnesVideoJob> {
    const apiKey = this.options.apiKey;
    if (!apiKey?.trim()) return { status: "auth_missing" };
    const body = videoRequestBody(input);
    return this.request(
      "/v1/videos",
      body,
      this.videoTimeoutMs,
      (payload) => readVideoJob(payload),
      signal,
    );
  }

  async pollVideo(videoId: string, signal?: AbortSignal): Promise<AgnesVideoJob> {
    const apiKey = this.options.apiKey;
    if (!apiKey?.trim()) return { status: "auth_missing" };
    if (!videoId.trim()) throw new Error("video_id_required");
    const url = new URL("/agnesapi", AGNES_ORIGIN);
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("model_name", VIDEO_MODEL);
    return this.requestUrl(
      url.href,
      undefined,
      this.videoTimeoutMs,
      (payload) => readVideoJob(payload, videoId),
      signal,
    );
  }

  private async request<
    T extends { status: AgnesMediaFailure } | { status: "ready" } | AgnesVideoJob,
  >(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    parse: (payload: Record<string, unknown>) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requestUrl(`${AGNES_ORIGIN}${path}`, body, timeoutMs, parse, signal);
  }

  private async requestUrl<
    T extends { status: AgnesMediaFailure } | { status: "ready" } | AgnesVideoJob,
  >(
    url: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number,
    parse: (payload: Record<string, unknown>) => T,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const apiKey = this.options.apiKey;
    if (!apiKey?.trim()) return { status: "auth_missing" } as T;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([controller.signal, callerSignal])
      : controller.signal;
    try {
      const response = await this.fetcher(url, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: "error",
      });
      if (!response.ok) return { status: mapHttpFailure(response.status) } as T;
      const payload = await readJsonBounded(response);
      return payload ? parse(payload) : ({ status: "failed" } as T);
    } catch {
      if (callerSignal?.aborted) throw new Error("Operation cancelled");
      return { status: controller.signal.aborted ? "timeout" : "failed" } as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
