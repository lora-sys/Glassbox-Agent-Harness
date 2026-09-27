import { describe, expect, it, vi } from "vitest";
import { downloadPublicMediaOutput } from "./download-public-output.js";

const publicResolver = vi.fn(async () => ["93.184.216.34"]);
const sample = Buffer.from("bounded provider output");

describe("downloadPublicMediaOutput", () => {
  it("downloads a public HTTPS output with redirects disabled", async () => {
    const fetcher = vi.fn(async () => new Response(sample));
    expect(
      await downloadPublicMediaOutput("https://cdn.example/output", {
        fetcher,
        resolveHost: publicResolver,
      }),
    ).toEqual(sample);
    const [, init] = fetcher.mock.calls[0] as unknown as [unknown, RequestInit?];
    expect(init?.redirect).toBe("manual");
  });

  it("revalidates redirect targets before following them", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://localhost/private" } }),
      )
      .mockResolvedValueOnce(new Response(sample));
    await expect(
      downloadPublicMediaOutput("https://cdn.example/output", {
        fetcher,
        resolveHost: publicResolver,
      }),
    ).rejects.toThrow("web_target_local_host");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized outputs and non-HTTPS URLs", async () => {
    const fetcher = vi.fn(async () => new Response(sample));
    await expect(
      downloadPublicMediaOutput("https://cdn.example/output", {
        fetcher,
        resolveHost: publicResolver,
        maxBytes: 4,
      }),
    ).rejects.toThrow("media_output_too_large");
    await expect(
      downloadPublicMediaOutput("http://cdn.example/output", {
        fetcher,
        resolveHost: publicResolver,
      }),
    ).rejects.toThrow("media_output_invalid_url");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
