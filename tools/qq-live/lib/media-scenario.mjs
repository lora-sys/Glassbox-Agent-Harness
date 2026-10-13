import { fail } from "./core.mjs";

export const MEDIA_FAMILY_ID = "media-private-delivery";
export const MEDIA_FAMILY = Object.freeze({
  id: MEDIA_FAMILY_ID,
  kind: "media-private-delivery",
  chat: "private",
});

const STAGES = Object.freeze({
  "image-1k": {
    mediaType: "image",
    caption: "图片已生成",
    input: {
      action: "image",
      size: "1K",
      ratio: "1:1",
      prompt: "一只橙色小猫坐在蓝色杯子旁边，白色背景。",
    },
    prompt:
      '给我生成一张 1K 分辨率的正方形图片。画面描述直接使用"一只橙色小猫坐在蓝色杯子旁边，白色背景。"，不要改写。只生成一张，不使用参考图片。把图片发到这个私聊，并在文字回复里带上测试编号 {{nonce}}。如果失败，不要再生成。',
  },
  "video-4s": {
    mediaType: "video",
    caption: "视频已生成",
    input: { action: "video", seconds: 4, prompt: "一片绿色叶子缓慢落在白色桌面上。" },
    prompt:
      '给我生成一段 4 秒的视频。画面描述直接使用"一片绿色叶子缓慢落在白色桌面上。"，不要改写。只生成一段，不使用参考图片。把视频发到这个私聊，并在文字回复里带上测试编号 {{nonce}}。如果失败，不要再生成。',
  },
});

export function validateMediaFamily(value) {
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "chat,id,kind" ||
    Object.entries(MEDIA_FAMILY).some(([key, expected]) => value[key] !== expected)
  )
    fail("MEDIA_FAMILY", "媒体测试只支持固定 Owner 私聊流程。", "BLOCKED");
  return value;
}

export function mediaFixtureStep(stage) {
  const fixed = STAGES[stage];
  if (!fixed) fail("MEDIA_STAGE", "媒体测试阶段未实现。", "BLOCKED");
  return {
    id: `media-${stage}`,
    chat: "private",
    prompt: fixed.prompt,
    expectContains: ["{{nonce}}"],
    sideEffect: "acceptance_fixture",
    leaseTools: [
      {
        name: "media_generate",
        operations: [
          {
            action: "media:generate",
            resourceId: "media-generation",
            inputConstraint: { ...fixed.input },
          },
        ],
      },
    ],
    featureAssertions: [
      { kind: "trace", type: "tool_call", where: { name: "media_generate" }, count: 1 },
      {
        kind: "trace",
        type: "tool_result",
        where: { name: "media_generate", isError: false },
        count: 1,
      },
    ],
  };
}

export function mediaObservationFor(stage) {
  const fixed = STAGES[stage];
  if (!fixed) fail("MEDIA_STAGE", "媒体测试阶段未实现。", "BLOCKED");
  return { expectedType: fixed.mediaType, expectedCaption: fixed.caption };
}

export function mediaFamilyPlan() {
  return {
    familyId: MEDIA_FAMILY_ID,
    stages: Object.keys(STAGES).map((stage) => ({
      stage,
      spec: mediaFixtureStep(stage),
      observation: mediaObservationFor(stage),
    })),
    retainedArtifacts: "Keep the two test Assets and append-only audit evidence.",
    cleanup: "Verify each exact temporary lease is revoked. Never regenerate or resend on failure.",
    limitation:
      "Sender SHA256 binds the Asset Buffer handed to OneBot. Received QQ segments do not prove unchanged or untranscoded media bytes.",
  };
}
