import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { digest, toolManifestDigest } from "../lib/core.mjs";
import { mediaFixtureStep, mediaObservationFor } from "../lib/media-scenario.mjs";
import { Recorder, replyCase } from "../lib/runner.mjs";
import { baseConfig } from "./fixture.mjs";

const nowSeconds = () => Math.floor(Date.now() / 1000);

function mediaEvent({ messageId = "301", mediaType = "image", caption = "图片已生成" } = {}) {
  return {
    self_id: 10001,
    post_type: "message",
    message_type: "private",
    user_id: 10002,
    message_id: messageId,
    time: nowSeconds(),
    message: [
      { type: "text", data: { text: caption } },
      { type: mediaType, data: { file: "private-media-locator-must-not-be-retained" } },
    ],
  };
}

function boundInput(messageId, selfId, senderId, text) {
  return {
    self_id: selfId,
    message_id: messageId,
    real_seq: "901",
    time: nowSeconds(),
    user_id: senderId,
    sender: { user_id: senderId },
    message_type: "private",
    message: [{ type: "text", data: { text } }],
  };
}

test("replyCase records and wakes on the fixed real media reply without retaining its locator or caption", async () => {
  const config = { ...baseConfig(), timeoutMs: 500, settleMs: 0 };
  const spec = mediaFixtureStep("image-1k");
  const expectation = mediaObservationFor("image-1k");
  const recorder = new Recorder(config);
  const controller = new AbortController();
  let observationWait;
  const driver = {
    problem: null,
    allowMessageRead() {},
    async call(action, params) {
      if (action === "send_private_msg") {
        const c = recorder.cases[0];
        observationWait = recorder.waitForMediaObservation(c.id, controller.signal);
        const time = nowSeconds();
        recorder.ingest("bot", {
          self_id: Number(config.bot.qq),
          post_type: "message",
          message_type: "private",
          user_id: Number(config.driver.qq),
          message_id: "201",
          time,
          message: [{ type: "text", data: { text: c.prompt } }],
        });
        recorder.ingest("driver", mediaEvent());
        recorder.ingest("driver", {
          self_id: Number(config.driver.qq),
          post_type: "message",
          message_type: "private",
          user_id: Number(config.bot.qq),
          message_id: "302",
          time,
          message: [{ type: "text", data: { text: `已完成测试 ${c.token}` } }],
        });
        return { message_id: "101" };
      }
      if (action === "get_msg")
        return boundInput(
          params.message_id,
          Number(config.driver.qq),
          Number(config.driver.qq),
          recorder.cases[0].prompt,
        );
      throw new Error("unexpected API call");
    },
  };
  const bot = {
    problem: null,
    allowMessageRead() {},
    async call(action, params) {
      if (action === "get_msg")
        return boundInput(
          params.message_id,
          Number(config.bot.qq),
          Number(config.driver.qq),
          recorder.cases[0].prompt,
        );
      throw new Error("unexpected API call");
    },
  };
  const clients = { driver, bot };
  const acceptance = {
    async register(_config, _case, tools) {
      return {
        leaseId: randomUUID(),
        expiresAt: Date.now() + 60_000,
        toolsSha256: toolManifestDigest(tools),
      };
    },
    async revoke() {},
  };

  const c = await replyCase(
    config,
    clients,
    recorder,
    spec,
    controller.signal,
    acceptance,
    expectation,
  );
  assert.equal(c.status, "PASS");
  await observationWait;
  assert.deepEqual(recorder.mediaObservationSnapshot(c.id), {
    candidates: [
      {
        messageId: "301",
        mediaType: "image",
        captionSha256: digest("图片已生成"),
        segmentCount: 2,
        receivedAt: c.mediaObservations[0].receivedAt,
      },
    ],
    overflow: false,
  });
  assert.equal(c.mediaObservationExpectedType, "image");
  assert.equal(c.mediaObservationExpectedCaptionSha256, digest("图片已生成"));
  assert.equal(JSON.stringify(c).includes("private-media-locator-must-not-be-retained"), false);
  assert.equal(JSON.stringify(c).includes("图片已生成"), false);
  recorder.closeMediaObservation(c.id);
  assert.equal(c.mediaObservationClosed, true);
});

test("media observer ignores unrelated captions, deduplicates event IDs, bounds duplicates, and wakes waiters", async () => {
  const recorder = new Recorder(baseConfig());
  const c = recorder.begin("media-image-1k", "private", "fixed request", ["marker"]);
  recorder.expectMediaObservation(c, mediaObservationFor("image-1k"));
  const controller = new AbortController();
  const waiting = recorder.waitForMediaObservation(c.id, controller.signal);
  recorder.ingest("driver", mediaEvent({ messageId: "401", caption: "无关图片" }));
  assert.deepEqual(recorder.mediaObservationSnapshot(c.id), { candidates: [], overflow: false });
  const event = mediaEvent({ messageId: "402" });
  recorder.ingest("driver", event);
  await waiting;
  recorder.ingest("driver", event);
  recorder.ingest("driver", mediaEvent({ messageId: "403" }));
  recorder.ingest("driver", mediaEvent({ messageId: "404" }));
  assert.equal(recorder.mediaObservationSnapshot(c.id).candidates.length, 2);
  assert.equal(recorder.mediaObservationSnapshot(c.id).overflow, true);
  recorder.closeMediaObservation(c.id);
});

test("media observation wait is cancelled without a timer", async () => {
  const recorder = new Recorder(baseConfig());
  const c = recorder.begin("media-image-1k", "private", "fixed request", ["marker"]);
  recorder.expectMediaObservation(c, mediaObservationFor("image-1k"));
  const controller = new AbortController();
  const waiting = recorder.waitForMediaObservation(c.id, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { code: "CANCELLED", status: "INCONCLUSIVE" });
  recorder.closeMediaObservation(c.id);
});

test("media observation remains open after text transport finishes and closes explicitly", async () => {
  const recorder = new Recorder(baseConfig());
  const c = recorder.begin("media-image-1k", "private", "fixed request", ["marker"]);
  recorder.expectMediaObservation(c, mediaObservationFor("image-1k"));
  recorder.finish(c, "PASS", "REPLY_CONFIRMED", "text received");
  assert.equal(c.startedMs, undefined);
  const controller = new AbortController();
  const waiting = recorder.waitForMediaObservation(c.id, controller.signal);
  recorder.ingest("driver", mediaEvent({ messageId: "501" }));
  await waiting;
  assert.equal(recorder.mediaObservationSnapshot(c.id).candidates[0]?.messageId, "501");
  recorder.closeMediaObservation(c.id);
  recorder.ingest("driver", mediaEvent({ messageId: "502" }));
  assert.equal(recorder.mediaObservationSnapshot(c.id).candidates.length, 1);
});

test("finished text transport does not admit old or wrong-account media", () => {
  const recorder = new Recorder(baseConfig());
  const c = recorder.begin("media-image-1k", "private", "fixed request", ["marker"]);
  recorder.expectMediaObservation(c, mediaObservationFor("image-1k"));
  recorder.finish(c, "PASS", "REPLY_CONFIRMED", "text received");
  for (const patch of [
    { self_id: 10002 },
    { user_id: 10003 },
    { time: nowSeconds() - 60 },
    { message_type: "group", group_id: 20001 },
  ])
    recorder.ingest("driver", { ...mediaEvent(), ...patch });
  assert.deepEqual(recorder.mediaObservationSnapshot(c.id), { candidates: [], overflow: false });
  recorder.closeMediaObservation(c.id);
});
