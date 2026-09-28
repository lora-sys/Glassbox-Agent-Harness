import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  fitsIncomingImageBudget,
  readOneBotImageFile,
  validateIncomingImage,
} from "./image-input.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("OneBot image input validation", () => {
  it("enforces the aggregate attachment budget before persistence", () => {
    expect(fitsIncomingImageBudget(10 * 1024 * 1024, 6 * 1024 * 1024)).toBe(true);
    expect(fitsIncomingImageBudget(12 * 1024 * 1024, 5 * 1024 * 1024)).toBe(false);
  });

  it("accepts a bounded PNG and identifies its actual format", () => {
    expect(validateIncomingImage(png)).toMatchObject({
      status: "ready",
      image: { mimeType: "image/png", data: png },
    });
  });

  it("rejects non-images and dimensions above configured limits", () => {
    expect(validateIncomingImage(Buffer.from("not an image"))).toEqual({
      status: "failed",
      code: "image_invalid",
    });
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(10_000, 16);
    expect(validateIncomingImage(oversized)).toEqual({
      status: "failed",
      code: "image_too_large",
    });
  });

  it("reads only absolute regular image files under the byte cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-onebot-image-"));
    directories.push(directory);
    const path = join(directory, "incoming.png");
    await writeFile(path, png);
    expect(await readOneBotImageFile(path)).toMatchObject({
      status: "ready",
      image: { mimeType: "image/png" },
    });
    expect(await readOneBotImageFile("relative.png")).toEqual({
      status: "failed",
      code: "image_invalid",
    });
    expect(await readOneBotImageFile(join(directory, "missing.png"))).toEqual({
      status: "failed",
      code: "image_unavailable",
    });
    expect(await readOneBotImageFile(path, AbortSignal.abort())).toEqual({
      status: "failed",
      code: "image_timeout",
    });
  });
});
