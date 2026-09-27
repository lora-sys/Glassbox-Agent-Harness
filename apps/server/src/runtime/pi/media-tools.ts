import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import { MediaAssetStore } from "../../media/media-asset-store.js";
import { downloadPublicMediaOutput } from "../../media/download-public-output.js";
import type {
  ImageRatio,
  MediaGenerationProvider,
  MediaProviderFailure,
  VideoRatio,
  VideoGenerationJob,
} from "../../media/provider.js";
import { assertPublicWebUrl, dohResolveWebHost } from "../../web/network-guard.js";
import {
  consumeMutationIntent,
  createProtectedTool,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

export const MEDIA_GENERATION_TOOL = "media_generate";
export const MEDIA_GENERATION_RESOURCE = "media-generation";
export const MEDIA_GENERATE_ACTION = "media:generate";
const MAX_VIDEO_WAIT_MS = 9 * 60_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 16 * 1024 * 1024;
const IMAGE_RATIOS: readonly ImageRatio[] = [
  "1:1",
  "3:4",
  "4:3",
  "16:9",
  "9:16",
  "2:3",
  "3:2",
  "21:9",
];
const VIDEO_RATIOS: readonly VideoRatio[] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

type MediaToolInput = Record<string, unknown> & {
  action: "image" | "video";
  prompt: string;
  mode?: string;
  size?: string;
  ratio?: string;
  seconds?: number;
  images?: Array<{ url: string }>;
  firstFrame?: string;
  lastFrame?: string;
};

function protectedContext(value: PiRunContext | undefined): ProtectedToolContext | undefined {
  return value?.caller && value.conversationId && value.runId
    ? {
        caller: value.caller,
        conversationId: value.conversationId,
        runId: value.runId,
        ...(value.requiredToolName === undefined
          ? {}
          : { requiredToolName: value.requiredToolName }),
        ...(value.requiredToolInput === undefined
          ? {}
          : { requiredToolInput: value.requiredToolInput }),
      }
    : undefined;
}

function inputString(input: MediaToolInput, key: string, fallback?: string): string | undefined {
  const value = input[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("invalid_media_input");
  return value;
}

function imageMime(data: Buffer): "image/png" | "image/jpeg" | "image/webp" {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    data.length >= 4 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data.at(-2) === 0xff &&
    data.at(-1) === 0xd9
  )
    return "image/jpeg";
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  throw new Error("media_output_invalid_image");
}

function fixedFailure(status: MediaProviderFailure): string {
  return `media_${status}`;
}

async function validateReferenceUrls(input: MediaToolInput): Promise<void> {
  const urls = [
    ...(input.images ?? []).map(({ url }) => url),
    ...(input.firstFrame ? [input.firstFrame] : []),
    ...(input.lastFrame ? [input.lastFrame] : []),
  ];
  for (const value of urls) {
    const url = await assertPublicWebUrl(value, dohResolveWebHost);
    if (url.protocol !== "https:") throw new Error("media_invalid_reference_url");
  }
}

export function createMediaGenerationTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  assets: MediaAssetStore;
  provider: MediaGenerationProvider;
  recordEvidence: (record: Record<string, unknown>, context: ProtectedToolContext) => Promise<void>;
}): ToolDefinition[] {
  const getContext = () => protectedContext(options.getContext());
  return [
    createProtectedTool<
      MediaToolInput,
      { assets?: readonly string[]; status: string; requestedResolution?: string }
    >({
      name: MEDIA_GENERATION_TOOL,
      label: "生成图片或视频",
      description:
        "Generate an image or video through the configured media provider. Image mode supports text-to-image, image edits, and multi-image composition at supported resolutions. Video generation supports text, keyframe, and reference modes at the provider's available size. Generated media is delivered to this private QQ conversation through Glassbox delivery authorization.",
      parameters: Type.Object(
        {
          action: Type.Unsafe<MediaToolInput["action"]>({
            type: "string",
            enum: ["image", "video"],
          }),
          prompt: Type.String({ minLength: 1, maxLength: 8_000 }),
          mode: Type.Optional(
            Type.String({
              enum: ["text2image", "img2img", "compose", "text", "keyframe", "reference"],
            }),
          ),
          size: Type.Optional(
            Type.String({
              enum: ["1K", "2K", "3K", "4K"],
              description: "Image size only. Do not use for video.",
            }),
          ),
          ratio: Type.Optional(
            Type.String({ enum: ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"] }),
          ),
          seconds: Type.Optional(Type.Integer({ minimum: 4, maximum: 12 })),
          images: Type.Optional(
            Type.Array(
              Type.Object(
                { url: Type.String({ minLength: 1, maxLength: 2048 }) },
                { additionalProperties: false },
              ),
              { maxItems: 14 },
            ),
          ),
          firstFrame: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
          lastFrame: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
        },
        { additionalProperties: false },
      ),
      action: MEDIA_GENERATE_ACTION,
      resourceId: MEDIA_GENERATION_RESOURCE,
      authService: options.store.authorization,
      getContext,
      execute: async (input, context, signal) => {
        consumeMutationIntent(context, MEDIA_GENERATION_TOOL, { action: input.action });
        if (input.action === "image") {
          if (!options.provider.capabilities.includes("image") || !options.provider.generateImage)
            return { status: "media_capability_unavailable" };
          const mode = inputString(input, "mode", "text2image");
          if (mode !== "text2image" && mode !== "img2img" && mode !== "compose")
            throw new Error("invalid_media_input");
          const size = inputString(input, "size", "1K");
          if (size !== "1K" && size !== "2K" && size !== "3K" && size !== "4K")
            throw new Error("invalid_media_input");
          await validateReferenceUrls(input);
          if (input.ratio && !IMAGE_RATIOS.includes(input.ratio as ImageRatio))
            throw new Error("invalid_media_input");
          const result = await options.provider.generateImage(
            {
              mode,
              prompt: input.prompt,
              size,
              ...(input.ratio ? { ratio: input.ratio as ImageRatio } : {}),
              ...(input.images
                ? { images: input.images.map(({ url }) => ({ type: "url" as const, url })) }
                : {}),
              output: "base64",
            },
            signal,
          );
          if (result.status !== "ready") return { status: fixedFailure(result.status) };
          if (result.images.length === 0 || result.images.length > 3)
            return { status: fixedFailure("failed") };
          const images: Array<{
            mimeType: "image/png" | "image/jpeg" | "image/webp";
            data: Buffer;
          }> = [];
          for (const output of result.images) {
            if (signal?.aborted) throw new Error("Operation cancelled");
            const data =
              "base64" in output
                ? Buffer.from(output.base64, "base64")
                : await downloadPublicMediaOutput(output.url, {
                    maxBytes: MAX_IMAGE_BYTES,
                    signal,
                  });
            if (data.length > MAX_IMAGE_BYTES) return { status: "media_output_too_large" };
            if ("base64" in output && data.toString("base64") !== output.base64)
              throw new Error("media_output_invalid_image");
            const mimeType = imageMime(data);
            images.push({ mimeType, data });
          }
          const ids: string[] = [];
          for (const { mimeType, data } of images) {
            if (signal?.aborted) throw new Error("Operation cancelled");
            const asset = await options.assets.write(
              {
                principalId: context.caller.principalId,
                conversationId: context.conversationId,
                runId: context.runId,
              },
              mimeType,
              data,
              MAX_IMAGE_BYTES,
            );
            ids.push(asset.id);
          }
          await options.recordEvidence(
            {
              type: "media_generation_completed",
              provider: providerId("image"),
              mediaType: "image",
              assetIds: ids,
            },
            context,
          );
          return { status: "completed", assets: ids };
        }

        const mode = inputString(input, "mode", "text");
        if (mode !== "text" && mode !== "keyframe" && mode !== "reference")
          throw new Error("invalid_media_input");
        if (
          !options.provider.capabilities.includes("video") ||
          !options.provider.createVideo ||
          !options.provider.pollVideo
        )
          return { status: "media_capability_unavailable" };
        if (input.ratio && !VIDEO_RATIOS.includes(input.ratio as VideoRatio))
          throw new Error("invalid_media_input");
        await validateReferenceUrls(input);
        const job = await options.provider.createVideo(
          {
            mode,
            prompt: input.prompt,
            ...(input.seconds === undefined ? {} : { seconds: input.seconds }),
            ...(input.ratio ? { aspectRatio: input.ratio as VideoRatio } : {}),
            ...(input.firstFrame ? { firstFrame: input.firstFrame } : {}),
            ...(input.lastFrame ? { lastFrame: input.lastFrame } : {}),
            ...(input.images ? { images: input.images.map(({ url }) => url) } : {}),
          },
          signal,
        );
        if (job.status !== "pending" && job.status !== "completed")
          return { status: fixedFailure(job.status) };
        const startedAt = Date.now();
        let completed: VideoGenerationJob = job;
        let waitMs = 5_000;
        while (completed.status === "pending" && Date.now() - startedAt < MAX_VIDEO_WAIT_MS) {
          if (signal?.aborted) throw new Error("Operation cancelled");
          await delay(waitMs, undefined, { signal });
          completed = await options.provider.pollVideo(job.videoId, signal);
          waitMs = Math.min(Math.round(waitMs * 1.4), 20_000);
        }
        if (completed.status !== "completed")
          return {
            status:
              completed.status === "pending" ? "media_timeout" : fixedFailure(completed.status),
          };
        if (signal?.aborted) throw new Error("Operation cancelled");
        const data = await downloadPublicMediaOutput(completed.url, {
          maxBytes: MAX_VIDEO_BYTES,
          signal,
        });
        if (signal?.aborted) throw new Error("Operation cancelled");
        if (data.length > MAX_VIDEO_BYTES) return { status: "media_output_too_large" };
        const asset = await options.assets.write(
          {
            principalId: context.caller.principalId,
            conversationId: context.conversationId,
            runId: context.runId,
          },
          "video/mp4",
          data,
          MAX_VIDEO_BYTES,
        );
        await options.recordEvidence(
          {
            type: "media_generation_completed",
            provider: providerId("video"),
            mediaType: "video",
            assetIds: [asset.id],
          },
          context,
        );
        return {
          status: "completed",
          assets: [asset.id],
          ...(completed.requestedResolution
            ? { requestedResolution: completed.requestedResolution }
            : {}),
        };
      },
      projectResult: (result) =>
        result.assets?.length
          ? `Media generation ${result.status}.${result.requestedResolution ? ` Provider requested video resolution ${result.requestedResolution}; image size options do not apply to video.` : ""} Include each delivery marker exactly once in the final response: ${result.assets.map((id) => `[asset:${id}]`).join(" ")}`
          : `Media generation ${result.status}.`,
    }),
  ];

  function providerId(type: "image" | "video"): string {
    const routed = options.provider as MediaGenerationProvider & {
      providerIdFor?: (mediaType: "image" | "video") => string | undefined;
    };
    return routed.providerIdFor?.(type) ?? options.provider.id;
  }
}
