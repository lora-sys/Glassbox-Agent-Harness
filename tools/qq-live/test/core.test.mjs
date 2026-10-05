import test from "node:test";
import assert from "node:assert/strict";
import {
  validateConfig,
  validateModeration,
  safeText,
  safeError,
  statusOf,
  endpoint,
  textOf,
  id,
  messageId,
} from "../lib/core.mjs";
import { muteUntil } from "../lib/moderation.mjs";
import { validateSpecs, Recorder } from "../lib/runner.mjs";
import { baseConfig } from "./fixture.mjs";
const throwsCode = (f, code) => assert.throws(f, (e) => e.code === code);
test("configuration accepts isolated armed fixture", () =>
  assert.equal(validateConfig(baseConfig(), { live: true }).groups.length, 2));
test("same identities are rejected", () => {
  const c = baseConfig();
  c.bot.qq = c.driver.qq;
  throwsCode(() => validateConfig(c), "CONFIG_IDENTITIES");
});
test("same endpoints are rejected", () => {
  const c = baseConfig();
  c.bot.wsUrl = c.driver.wsUrl;
  throwsCode(() => validateConfig(c), "CONFIG_IDENTITIES");
});
test("remote plain WS rejected", () =>
  throwsCode(() => endpoint("ws://example.com:6700", true), "CONFIG_REMOTE"));
test("credentials in URL rejected", () =>
  throwsCode(() => endpoint("ws://127.0.0.1:6700/?access_token=secret"), "CONFIG_URL"));
test("expired window rejected", () => {
  const c = baseConfig();
  c.safety.armedUntil = new Date(0).toISOString();
  throwsCode(() => validateConfig(c, { live: true }), "NOT_ARMED");
});
test("live state confirmation required", () => {
  const c = baseConfig();
  c.safety.acceptanceServiceConfirmed = false;
  throwsCode(() => validateConfig(c, { live: true }), "ACCEPTANCE_SERVICE_REQUIRED");
});
test("unbounded timeouts rejected", () => {
  const c = baseConfig();
  c.timeoutMs = Infinity;
  throwsCode(() => validateConfig(c), "CONFIG_LIMIT");
});
test("duplicate group rejected", () => {
  const c = baseConfig();
  c.groups[1].id = c.groups[0].id;
  throwsCode(() => validateConfig(c), "CONFIG_GROUPS");
});
test("moderation target cannot be driver", () => {
  const c = baseConfig();
  c.moderation.target = c.driver.qq;
  throwsCode(() => validateModeration(c), "MODERATION_TARGET");
});
test("consent required", () => {
  const c = baseConfig();
  c.moderation.consentConfirmed = false;
  throwsCode(() => validateModeration(c), "CONSENT_REQUIRED");
});
test("long mute forbidden", () => {
  const c = baseConfig();
  c.moderation.durationSeconds = 3600;
  throwsCode(() => validateModeration(c), "CONFIG_LIMIT");
});
test("unknown mute state is not treated as zero", () =>
  throwsCode(() => muteUntil({}), "MUTE_STATE_UNSUPPORTED"));
test("millisecond mute timestamp rejected", () =>
  throwsCode(() => muteUntil({ shut_up_timestamp: Date.now() }), "MUTE_STATE_UNSUPPORTED"));
test("no cases is not PASS", () => assert.equal(statusOf([]), "BLOCKED"));
test("mixed failure cannot pass", () =>
  assert.equal(statusOf([{ status: "PASS" }, { status: "INCONCLUSIVE" }]), "INCONCLUSIVE"));
test("tokens and terminal escapes redacted", () =>
  assert.equal(
    safeText("secretABC \x1bBearer abcdefgh", ["secretABC"]),
    "[REDACTED] Bearer [REDACTED]",
  ));
test("arbitrary exception is not leaked", () =>
  assert.ok(!safeError(new Error("my token")).message.includes("my token")));
test("CQ metadata is not parsed as text", () => assert.equal(textOf("[CQ:at,qq=10002]hi"), "hi"));
test("unsafe numeric identifiers rejected", () => assert.equal(id(2 ** 60), ""));
test("negative message ID supported", () => assert.equal(messageId(-7), "-7"));
test("custom suite must retain nonce", () => {
  const raw = {
    schemaVersion: 1,
    cases: [
      {
        id: "a",
        chat: "private",
        prompt: "hi",
        assertion: "reply",
        sideEffect: "none",
        expectContains: ["x"],
      },
    ],
  };
  throwsCode(() => validateSpecs(raw, baseConfig()), "SUITE_PROMPT");
});
test("custom suite reply assertion must contain nonce", () => {
  const raw = {
    schemaVersion: 1,
    cases: [
      {
        id: "a",
        chat: "private",
        prompt: "hi {{nonce}}",
        assertion: "reply",
        sideEffect: "none",
        expectContains: ["x"],
      },
    ],
  };
  throwsCode(() => validateSpecs(raw, baseConfig()), "SUITE_ASSERTION");
});
test("custom suite cannot claim side effects", () => {
  const raw = {
    schemaVersion: 1,
    cases: [
      {
        id: "a",
        chat: "private",
        prompt: "hi {{nonce}}",
        assertion: "reply",
        sideEffect: "mute",
        expectContains: ["{{nonce}}"],
      },
    ],
  };
  throwsCode(() => validateSpecs(raw, baseConfig()), "SUITE_SIDE_EFFECT");
});
test("unrelated private messages are not retained", () => {
  const r = new Recorder(baseConfig());
  r.begin("a", "private", "{{nonce}}", []);
  r.ingest("driver", {
    self_id: 10001,
    post_type: "message",
    message_type: "private",
    user_id: 99999,
    message_id: 1,
    message: "secret",
  });
  assert.equal(r.events.length, 0);
});
test("old run marker cannot satisfy a new run", () => {
  const r = new Recorder(baseConfig());
  r.begin("a", "private", "{{nonce}}", []);
  r.ingest("driver", {
    self_id: 10001,
    post_type: "message",
    message_type: "private",
    user_id: 10002,
    message_id: 1,
    message: "QQLIVE_OLD",
  });
  assert.equal(r.cases[0].replies.length, 0);
});
