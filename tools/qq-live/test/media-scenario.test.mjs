import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_FAMILY,
  mediaFamilyPlan,
  mediaFixtureStep,
  mediaObservationFor,
  validateMediaFamily,
} from "../lib/media-scenario.mjs";

test("fixed media family pins one private image and one four-second video", () => {
  const plan = mediaFamilyPlan();
  assert.equal(plan.stages.length, 2);
  assert.deepEqual(
    plan.stages.map(({ stage }) => stage),
    ["image-1k", "video-4s"],
  );
  for (const { stage, spec, observation } of plan.stages) {
    assert.equal(spec.chat, "private");
    assert.equal(spec.leaseTools.length, 1);
    assert.equal(spec.leaseTools[0].name, "media_generate");
    assert.equal(spec.leaseTools[0].operations.length, 1);
    assert.equal(spec.leaseTools[0].operations[0].action, "media:generate");
    assert.equal(spec.leaseTools[0].operations[0].resourceId, "media-generation");
    assert.ok(spec.prompt.includes("{{nonce}}"));
    assert.ok(!spec.prompt.includes("media_generate"));
    assert.ok(spec.prompt.includes("如果失败，不要再生成"));
    assert.deepEqual(mediaFixtureStep(stage), spec);
    assert.deepEqual(mediaObservationFor(stage), observation);
  }
  assert.deepEqual(plan.stages[0].spec.leaseTools[0].operations[0].inputConstraint, {
    action: "image",
    size: "1K",
    ratio: "1:1",
    prompt: "一只橙色小猫坐在蓝色杯子旁边，白色背景。",
  });
  assert.deepEqual(plan.stages[1].spec.leaseTools[0].operations[0].inputConstraint, {
    action: "video",
    seconds: 4,
    prompt: "一片绿色叶子缓慢落在白色桌面上。",
  });
});

test("media family rejects extra fields and altered scope, stage, or identity", () => {
  assert.equal(validateMediaFamily(MEDIA_FAMILY), MEDIA_FAMILY);
  for (const changed of [
    { ...MEDIA_FAMILY, chat: "B" },
    { ...MEDIA_FAMILY, id: "other" },
    { ...MEDIA_FAMILY, kind: "read" },
    { ...MEDIA_FAMILY, stages: ["video-12s"] },
  ])
    assert.throws(() => validateMediaFamily(changed), { code: "MEDIA_FAMILY" });
  assert.throws(() => mediaFixtureStep("video-12s"), { code: "MEDIA_STAGE" });
  assert.throws(() => mediaObservationFor("image-edit"), { code: "MEDIA_STAGE" });
});
