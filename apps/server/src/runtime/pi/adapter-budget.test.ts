import { describe, expect, it } from "vite-plus/test";
import { estimateStructuredTokens } from "./adapter.js";

describe("Pi provider payload estimates", () => {
  it("budgets Pi image content and provider data URLs by decoded bytes", () => {
    const dataUrl = `data:image/jpeg;base64,${Buffer.alloc(1024 * 1024).toString("base64")}`;
    const payloads = [
      { type: "image", mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1) },
      { type: "image_url", image_url: { url: dataUrl } },
      { type: "input_image", image_url: dataUrl },
      { type: "image_url", imageUrl: dataUrl },
    ];

    for (const payload of payloads) {
      const estimate = estimateStructuredTokens(payload);
      expect(estimate).toBeGreaterThan(4_000);
      expect(estimate).toBeLessThan(5_000);
    }
  });

  it("bounds binary image payloads using their byte length", () => {
    const estimate = estimateStructuredTokens({
      type: "image",
      data: new Uint8Array(1024 * 1024),
    });
    expect(estimate).toBeGreaterThan(4_000);
    expect(estimate).toBeLessThan(5_000);
  });
});
