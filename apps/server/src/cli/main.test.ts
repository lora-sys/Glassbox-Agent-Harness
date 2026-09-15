import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { readJsonFromStdin, readSecretFromStdin } from "./main.ts";

describe("bounded private stdin", () => {
  it("accepts multiline JSON without applying the single-line key rule", async () => {
    const json = '{\n  "token": "private-input"\n}';
    expect(await readJsonFromStdin(Readable.from([json]))).toBe(json);
  });

  it("rejects interactive and oversized channel input", async () => {
    await expect(
      readJsonFromStdin(Object.assign(new PassThrough(), { isTTY: true })),
    ).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
    await expect(readJsonFromStdin(Readable.from(["x".repeat(65537)]))).rejects.toMatchObject({
      code: "INPUT_TOO_LARGE",
    });
  });

  it("rejects invalid UTF-8 channel input", async () => {
    await expect(readJsonFromStdin(Readable.from([Buffer.from([255])]))).rejects.toMatchObject({
      code: "INPUT_REQUIRED",
    });
  });

  it("bounds the channel input deadline and removes listeners", async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const assertion = expect(readJsonFromStdin(stream, 20)).rejects.toMatchObject({
        code: "INPUT_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(stream.listenerCount("data")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("reads one piped key and removes trailing newlines", async () => {
    expect(await readSecretFromStdin(Readable.from(["test-key\r\n"]))).toBe("test-key");
  });

  it("refuses an interactive terminal without echoing input", async () => {
    const stream = Object.assign(new PassThrough(), { isTTY: true });
    await expect(readSecretFromStdin(stream)).rejects.toMatchObject({ code: "SECRET_REQUIRED" });
    expect(stream.listenerCount("data")).toBe(0);
  });

  it.each(["", "\n", "first\nsecond"])("rejects empty or multiline keys", async (input) => {
    await expect(readSecretFromStdin(Readable.from([input]))).rejects.toMatchObject({
      code: "SECRET_REQUIRED",
    });
  });

  it("rejects oversized input and removes listeners", async () => {
    const stream = Readable.from(["a".repeat(17000)]);
    await expect(readSecretFromStdin(stream)).rejects.toMatchObject({ code: "SECRET_TOO_LARGE" });
    expect(stream.listenerCount("data")).toBe(0);
  });

  it("rejects invalid UTF-8", async () => {
    await expect(readSecretFromStdin(Readable.from([Buffer.from([255])]))).rejects.toMatchObject({
      code: "SECRET_REQUIRED",
    });
  });

  it("times out stalled stdin and removes listeners", async () => {
    vi.useFakeTimers();
    try {
      const stream = new PassThrough();
      const result = readSecretFromStdin(stream, 20);
      const assertion = expect(result).rejects.toMatchObject({ code: "SECRET_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(20);
      await assertion;
      expect(stream.listenerCount("data")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
