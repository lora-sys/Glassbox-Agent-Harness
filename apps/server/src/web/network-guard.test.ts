import { describe, expect, it } from "vitest";
import { assertPublicWebRedirect, assertPublicWebUrl, WebTargetError } from "./network-guard.js";

const publicResolver = async () => ["93.184.215.14"];

describe("public web target guard", () => {
  it.each([
    "http://localhost/",
    "http://localhost.localdomain/",
    "http://metadata.google.internal/",
    "http://service.internal/",
    "http://printer/",
    "http://127.0.0.1/",
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:password@example.com/",
  ])("rejects %s", async (url) => {
    await expect(assertPublicWebUrl(url, publicResolver)).rejects.toBeInstanceOf(WebTargetError);
  });

  it("rejects a hostname if any DNS answer is private", async () => {
    await expect(
      assertPublicWebUrl("https://example.com/", async () => ["93.184.215.14", "10.0.0.2"]),
    ).rejects.toThrow("web_target_non_public");
  });

  it("permits an explicitly configured synthetic DNS range only for a hostname answer", async () => {
    const resolver = async () => ["198.18.1.103"];
    await expect(assertPublicWebUrl("https://example.com/", resolver)).rejects.toThrow(
      "web_target_non_public",
    );
    await expect(
      assertPublicWebUrl("https://example.com/", resolver, ["198.18.0.0/15"]),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertPublicWebUrl("http://198.18.1.103/", resolver, ["198.18.0.0/15"]),
    ).rejects.toThrow("web_target_non_public");
    await expect(
      assertPublicWebUrl("https://example.com/", async () => ["198.18.1.103", "10.0.0.1"], [
        "198.18.0.0/15",
      ]),
    ).rejects.toThrow("web_target_non_public");
  });

  it("rejects a public to private redirect hop", async () => {
    await expect(
      assertPublicWebRedirect("https://example.com/a", "http://127.0.0.1/admin", publicResolver),
    ).rejects.toThrow("web_target_non_public");
  });

  it("accepts a resolved public target and a relative redirect", async () => {
    const first = await assertPublicWebUrl("https://example.com/a", publicResolver);
    const next = await assertPublicWebRedirect(first.href, "/b", publicResolver);
    expect(next.href).toBe("https://example.com/b");
  });
});
