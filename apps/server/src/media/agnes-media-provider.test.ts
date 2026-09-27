import { describe, expect, it, vi } from "vitest";
import { AgnesMediaProvider } from "./agnes-media-provider.js";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(
  fetcher: ReturnType<typeof vi.fn<typeof fetch>>,
  callIndex = 0,
): Record<string, unknown> {
  const body = fetcher.mock.calls[callIndex]?.[1]?.body;
  return JSON.parse(typeof body === "string" ? body : "{}") as Record<string, unknown>;
}

describe("Agnes media provider", () => {
  it("does not send a request without a supplied key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new AgnesMediaProvider({ fetcher });
    const result = await provider.generateImage({
      mode: "text2image",
      prompt: "A lighthouse",
      size: "1K",
      output: "url",
    });
    expect(result).toEqual({ status: "auth_missing" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends text-to-image to the fixed Agnes endpoint with supported output controls", async () => {
    const fetcher = vi.fn(async () =>
      response(200, { data: [{ url: "https://cdn.example/image.png" }] }),
    );
    const provider = new AgnesMediaProvider({ apiKey: "test-only-secret", fetcher });
    const result = await provider.generateImage({
      mode: "text2image",
      prompt: "A detailed field guide infographic",
      size: "4K",
      ratio: "16:9",
      output: "url",
    });

    expect(result).toEqual({ status: "ready", images: [{ url: "https://cdn.example/image.png" }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [unknown, RequestInit?];
    expect(url).toBe("https://apihub.agnes-ai.com/v1/images/generations");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only-secret");
    expect(bodyOf(fetcher)).toEqual({
      model: "agnes-image-2.1-flash",
      prompt: "A detailed field guide infographic",
      size: "4K",
      ratio: "16:9",
      extra_body: { response_format: "url" },
    });
    expect(JSON.stringify(result)).not.toContain("test-only-secret");
  });

  it("sends img2img and composition references as extra_body.image and requests Base64 output", async () => {
    const fetcher = vi.fn(async () => response(200, { data: [{ b64_json: "aGVsbG8=" }] }));
    const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
    const result = await provider.generateImage({
      mode: "compose",
      prompt: "Combine the references into one scene",
      size: "2K",
      images: [
        { type: "url", url: "https://images.example/one.png" },
        { type: "base64", mimeType: "image/png", data: "aGVsbG8=" },
      ],
      output: "base64",
    });

    expect(result).toEqual({ status: "ready", images: [{ base64: "aGVsbG8=" }] });
    expect(bodyOf(fetcher)).toMatchObject({
      model: "agnes-image-2.1-flash",
      size: "2K",
      extra_body: {
        image: ["https://images.example/one.png", "data:image/png;base64,aGVsbG8="],
        response_format: "b64_json",
      },
    });
  });

  it("uses return_base64 for text-to-image Base64 output", async () => {
    const fetcher = vi.fn(async () => response(200, { data: [{ b64_json: "aGVsbG8=" }] }));
    const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
    await provider.generateImage({
      mode: "text2image",
      prompt: "A tree",
      size: "1K",
      output: "base64",
    });
    expect(bodyOf(fetcher)).toMatchObject({ return_base64: true });
    expect(bodyOf(fetcher).extra_body).toBeUndefined();
  });

  it.each([
    [{ mode: "img2img", prompt: "Edit", size: "1K", output: "url" }, "image_input_required"],
    [
      {
        mode: "text2image",
        prompt: "Text",
        size: "1K",
        output: "url",
        images: [{ type: "url", url: "https://images.example/a.png" }],
      },
      "unexpected_images_for_text2image",
    ],
  ] as const)("rejects invalid image request shape before network I/O", async (input, expected) => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
    await expect(provider.generateImage(input as never)).rejects.toThrow(expected);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS input image URLs before network I/O", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
    await expect(
      provider.generateImage({
        mode: "img2img",
        prompt: "Edit",
        size: "1K",
        output: "url",
        images: [{ type: "url", url: "http://127.0.0.1/image.png" }],
      }),
    ).rejects.toThrow("invalid_image_input_url");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("creates a 720P video job with typed keyframe inputs", async () => {
    const fetcher = vi.fn(async () =>
      response(200, { id: "task-1", video_id: "video-1", status: "queued", progress: 0 }),
    );
    const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
    const result = await provider.createVideo({
      mode: "keyframe",
      prompt: "Move smoothly between frames",
      seconds: 8,
      firstFrame: "https://images.example/start.png",
      lastFrame: "https://images.example/end.png",
      aspectRatio: "16:9",
    });
    expect(result).toEqual({
      status: "pending",
      videoId: "video-1",
      taskId: "task-1",
      progress: 0,
    });
    expect((fetcher.mock.calls[0] as unknown as [unknown])[0]).toBe(
      "https://apihub.agnes-ai.com/v1/videos",
    );
    expect(bodyOf(fetcher)).toEqual({
      model: "agnes-video-2.5-flash",
      prompt: "Move smoothly between frames",
      mode: "keyframe",
      seconds: "8",
      size: "720P",
      n: 1,
      aspect_ratio: "16:9",
      first_frame: "https://images.example/start.png",
      last_frame: "https://images.example/end.png",
    });
  });

  it("creates text and reference jobs with the Flash reference cap", async () => {
    const fetcher = vi.fn(async () => response(200, { video_id: "video-2", status: "queued" }));
    const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
    await provider.createVideo({ mode: "text", prompt: "A cloud moves over the hills" });
    expect(bodyOf(fetcher)).toMatchObject({
      model: "agnes-video-2.5-flash",
      mode: "text",
      seconds: "5",
      size: "720P",
      n: 1,
    });

    await provider.createVideo({
      mode: "reference",
      prompt: "Use the references",
      images: Array.from({ length: 5 }, (_, i) => `https://images.example/${i}.png`),
    });
    expect(bodyOf(fetcher, 1).images).toHaveLength(5);
  });

  it("polls by video_id and model_name at the fixed Agnes origin", async () => {
    const fetcher = vi.fn(async () =>
      response(200, { status: "completed", url: "https://cdn.example/video.mp4", progress: 100 }),
    );
    const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
    expect(await provider.pollVideo("video/1")).toEqual({
      status: "completed",
      videoId: "video/1",
      url: "https://cdn.example/video.mp4",
      requestedResolution: "720P",
      progress: 100,
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [unknown, RequestInit?];
    expect(String(url)).toBe(
      "https://apihub.agnes-ai.com/agnesapi?video_id=video%2F1&model_name=agnes-video-2.5-flash",
    );
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
  });

  it.each([
    [
      {
        mode: "keyframe",
        prompt: "Animate",
        seconds: 13,
        firstFrame: "https://images.example/start.png",
      },
      "invalid_video_duration",
    ],
    [
      { mode: "keyframe", prompt: "Animate", firstFrame: "http://images.example/start.png" },
      "invalid_first_frame_url",
    ],
    [{ mode: "reference", prompt: "Animate", images: [] }, "reference_image_required"],
  ] as const)(
    "rejects unsupported video capabilities before network I/O",
    async (input, expected) => {
      const fetcher = vi.fn<typeof fetch>();
      const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
      await expect(provider.createVideo(input as never)).rejects.toThrow(expected);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects more than five reference images before network I/O", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new AgnesMediaProvider({ apiKey: "test", fetcher });
    await expect(
      provider.createVideo({
        mode: "reference",
        prompt: "Animate",
        images: Array.from({ length: 6 }, (_, i) => `https://images.example/${i}.png`),
      }),
    ).rejects.toThrow("too_many_reference_images");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [401, "auth_missing"],
    [402, "quota_exhausted"],
    [429, "rate_limited"],
    [503, "rate_limited"],
    [500, "failed"],
  ] as const)(
    "maps Agnes HTTP status %i to %s without exposing response data",
    async (status, expected) => {
      const fetcher = vi.fn(async () => response(status, { error: "sensitive provider response" }));
      const result = await new AgnesMediaProvider({ apiKey: "test", fetcher }).generateImage({
        mode: "text2image",
        prompt: "A tree",
        size: "1K",
        output: "url",
      });
      expect(result).toEqual({ status: expected });
      expect(JSON.stringify(result)).not.toContain("sensitive");
    },
  );
});
