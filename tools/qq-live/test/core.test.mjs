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
  toolManifestDigest,
  digest,
} from "../lib/core.mjs";
test("Tool specification hashing matches the server canonical JSON contract", () => {
  const tools = [
    {
      name: "ops_status",
      operations: [
        {
          resourceId: "agent-operations",
          inputConstraint: { z: 1, a: [2, 3] },
          action: "ops:status",
        },
      ],
    },
  ];
  assert.equal(
    toolManifestDigest(tools),
    "4d93a3f0fd2449068b6579b750e7394ca8dc090283f0f3ac4027c934c35a38e1",
  );
  assert.equal(
    toolManifestDigest([
      {
        operations: [
          {
            action: "ops:status",
            inputConstraint: { a: [2, 3], z: 1 },
            resourceId: "agent-operations",
          },
        ],
        name: "ops_status",
      },
    ]),
    toolManifestDigest(tools),
  );
  assert.notEqual(
    toolManifestDigest([
      { ...tools[0], operations: [{ ...tools[0].operations[0], resourceId: "another-resource" }] },
    ]),
    toolManifestDigest(tools),
  );
});
import { muteUntil } from "../lib/moderation.mjs";
import { validateSpecs, Recorder } from "../lib/runner.mjs";
import { boundMessage, compareSameMessage } from "../lib/message-binding.mjs";
import { baseConfig } from "./fixture.mjs";
const throwsCode = (f, code) => assert.throws(f, (e) => e.code === code);
const boundFixture = (overrides = {}) => ({
  self_id: "10002",
  message_id: "123456",
  real_seq: "554",
  time: Math.floor(Date.now() / 1000),
  user_id: "10001",
  sender: { user_id: "10001" },
  message_type: "private",
  message: [{ type: "text", data: { text: "QQLIVE_TEST prompt" } }],
  ...overrides,
});
const boundExpected = () => ({
  selfId: "10002",
  senderId: "10001",
  messageType: "private",
  text: "QQLIVE_TEST prompt",
  contains: "QQLIVE_TEST",
  afterTime: new Date(Date.now() - 1000).toISOString(),
});
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
test("bound message returns identity metadata without its body", async () => {
  const client = { call: async () => boundFixture() };
  const result = await boundMessage(client, "123456", boundExpected());
  assert.deepEqual(Object.keys(result).sort(), ["messageId", "realSequence", "textSha256", "time"]);
  assert.equal(result.realSequence, "554");
  assert.deepEqual(compareSameMessage(result, result), {
    realSequence: "554",
    time: result.time,
    textSha256: result.textSha256,
  });
});
test("bound message rejects conflicting sender fields", async () => {
  const client = { call: async () => boundFixture({ user_id: "10003" }) };
  await assert.rejects(boundMessage(client, "123456", boundExpected()), (e) =>
    ["MESSAGE_BINDING_MISMATCH"].includes(e.code),
  );
});
test("bound message requires a bounded decimal real sequence", async () => {
  for (const real_seq of [554, "1".repeat(31)]) {
    const client = { call: async () => boundFixture({ real_seq }) };
    await assert.rejects(
      boundMessage(client, "123456", boundExpected()),
      (e) => e.code === "MESSAGE_BINDING_MISMATCH",
    );
  }
});
test("bound message rejects a timestamp far in the future", async () => {
  const client = {
    call: async () => boundFixture({ time: Math.floor(Date.now() / 1000) + 6 }),
  };
  await assert.rejects(
    boundMessage(client, "123456", boundExpected()),
    (e) => e.code === "MESSAGE_BINDING_MISMATCH",
  );
});
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

test("bound reply excludes fixture content using the actual fetched body", async () => {
  const client = { call: async () => boundFixture() };
  const expected = { ...boundExpected(), forbiddenContains: ["isolated-fixture-sentinel"] };
  const result = await boundMessage(client, "123456", expected);
  assert.deepEqual(Object.keys(result).sort(), ["messageId", "realSequence", "textSha256", "time"]);
  const actual = boundFixture();
  const leaked = {
    ...actual,
    message: [
      { type: "text", data: { text: `${textOf(actual.message)} isolated-fixture-sentinel` } },
    ],
  };
  await assert.rejects(
    boundMessage({ call: async () => leaked }, "123456", {
      ...expected,
      text: undefined,
      textSha256: undefined,
    }),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );
});

test("bound reply rejects malformed or unbounded exclusion constraints", async () => {
  for (const forbiddenContains of [
    null,
    "sentinel",
    [""],
    [5],
    ["x".repeat(257)],
    Array(9).fill("x"),
  ]) {
    await assert.rejects(
      boundMessage({ call: async () => boundFixture() }, "123456", {
        ...boundExpected(),
        forbiddenContains,
      }),
      { code: "MESSAGE_BINDING_MISMATCH" },
    );
  }
});

test("bound reply checks a fixed isolation fixture digest without retaining its content", async () => {
  const sentinel = `qq-isolation-secret-${"b".repeat(32)}`;
  const forbiddenFixtureSha256 = digest(sentinel);
  const expected = { ...boundExpected(), forbiddenFixtureSha256 };
  const actual = boundFixture();
  await boundMessage({ call: async () => actual }, "123456", expected);
  const leaked = {
    ...actual,
    message: [{ type: "text", data: { text: `${textOf(actual.message)} ${sentinel}` } }],
  };
  await assert.rejects(
    boundMessage({ call: async () => leaked }, "123456", {
      ...expected,
      text: undefined,
      textSha256: undefined,
    }),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );
  await assert.rejects(
    boundMessage({ call: async () => actual }, "123456", {
      ...expected,
      forbiddenFixtureSha256: [forbiddenFixtureSha256],
    }),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );
});

test("isolation fixture content in non-text QQ segments cannot evade reply checking", async () => {
  const sentinel = `qq-isolation-secret-${"c".repeat(32)}`;
  const actual = boundFixture();
  const message = Array.isArray(actual.message)
    ? actual.message
    : [{ type: "text", data: { text: textOf(actual.message) } }];
  const leaked = {
    ...actual,
    message: [...message, { type: "image", data: { url: `https://example.invalid/${sentinel}` } }],
  };
  assert.equal(textOf(leaked.message), textOf(actual.message));
  await assert.rejects(
    boundMessage({ call: async () => leaked }, "123456", {
      ...boundExpected(),
      forbiddenFixtureSha256: digest(sentinel),
    }),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );
});

test("reply cannot bypass the isolation fixture check by changing its letter case", async () => {
  const sentinel = `qq-isolation-secret-${"d".repeat(32)}`;
  const actual = boundFixture();
  const leaked = {
    ...actual,
    message: [
      { type: "text", data: { text: `${textOf(actual.message)} ${sentinel.toUpperCase()}` } },
    ],
  };
  await assert.rejects(
    boundMessage({ call: async () => leaked }, "123456", {
      ...boundExpected(),
      text: undefined,
      textSha256: undefined,
      forbiddenFixtureSha256: digest(sentinel),
    }),
    { code: "MESSAGE_BINDING_MISMATCH" },
  );
});
