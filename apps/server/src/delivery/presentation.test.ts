import { describe, expect, it } from "vite-plus/test";
import { createQqDeliveryPolicy } from "./content-policy.js";
import { renderQqPlainText } from "./presentation.js";

describe("QQ delivery presentation", () => {
  it("renders common Markdown as readable plain text", () => {
    expect(
      renderQqPlainText(
        "# 标题\n\n**重点**和`代码`\n\n- 第一项\n- 第二项\n\n[官网](https://example.com)",
      ),
    ).toBe("标题\n\n重点和代码\n\n• 第一项\n• 第二项\n\n官网 https://example.com");
  });

  it.each([
    ["Windows path", "目录是 C:\\Users\\owner\\private"],
    ["forward slash Windows path", "目录是 C:/Users/owner/private"],
    ["Windows UNC path", "目录是 \\\\server\\share\\private"],
    ["POSIX path", "目录是 /home/owner/private"],
    ["loopback URL", "服务在 http://127.0.0.1:3030/manage"],
    ["internal domain", "服务在 https://api.service.internal/manage"],
    ["internal UUID", "run 83a4513a-742f-4d87-b047-ec67cc775c98"],
    ["configured value", "profile p3-internal-model"],
  ])("blocks %s before QQ delivery", (_name, candidate) => {
    const policy = createQqDeliveryPolicy({ forbiddenValues: ["p3-internal-model"] });
    const result = policy.prepare(candidate);
    expect(result.allowed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.candidateSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("allows ordinary Chinese text and public links", () => {
    const result = createQqDeliveryPolicy().prepare(
      "## 结果\n\n测试已通过。查看 [文档](https://example.com/docs)。",
    );
    expect(result).toEqual(
      expect.objectContaining({
        allowed: true,
        text: "结果\n\n测试已通过。查看 文档 https://example.com/docs。",
        reasons: [],
      }),
    );
  });

  it("reads configured forbidden values for every candidate without exposing the value", () => {
    let credential = "first-runtime-credential";
    const policy = createQqDeliveryPolicy({ forbiddenValues: () => [credential] });
    expect(policy.prepare("first-runtime-credential").allowed).toBe(false);
    credential = "rotated-runtime-credential";
    const result = policy.prepare("rotated-runtime-credential");
    expect(result.allowed).toBe(false);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("blocks a configured credential even when it is shorter than metadata screening values", () => {
    const result = createQqDeliveryPolicy({ protectedValues: ["k"] }).prepare("key k");
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/^protected:[0-9a-f]{12}$/u);
    expect(JSON.stringify(result)).not.toContain('"k"');
  });
});
