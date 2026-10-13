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
import { boundMediaMessage } from "../lib/message-binding.mjs";
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
import { validateSpecs, Recorder, replyCase } from "../lib/runner.mjs";
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
test("development source identity accepts only an explicit SHA256", () => {
  const config = { ...baseConfig(), runtime: { expectedSourceTreeSha256: "a".repeat(64) } };
  assert.equal(validateConfig(config).runtime.expectedSourceTreeSha256, "a".repeat(64));
  for (const expectedSourceTreeSha256 of ["", "z".repeat(64), 17])
    throwsCode(
      () => validateConfig({ ...config, runtime: { expectedSourceTreeSha256 } }),
      "CONFIG_RUNTIME",
    );
});
test("media fixture timeout is bounded separately from ordinary reads", () => {
  const c = baseConfig();
  c.mediaFixtures = { enabled: true, retainAssetsConfirmed: true, timeoutMs: 600000 };
  const valid = validateConfig(c);
  assert.equal(valid.mediaFixtures.timeoutMs, 600000);
  assert.equal(valid.timeoutMs, c.timeoutMs);
  for (const timeoutMs of [0, 900001, 1.5])
    throwsCode(
      () => validateConfig({ ...c, mediaFixtures: { ...c.mediaFixtures, timeoutMs } }),
      "CONFIG_LIMIT",
    );
  for (const mediaFixtures of [
    null,
    [],
    { enabled: true },
    { ...c.mediaFixtures, extra: true },
    { ...c.mediaFixtures, enabled: "true" },
  ])
    throwsCode(() => validateConfig({ ...c, mediaFixtures }), "CONFIG_MEDIA_FIXTURE");
});
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
test("moderation consent must be recorded during the current 15 minute window", () => {
  const c = baseConfig();
  c.moderation.consentConfirmedAt = new Date(Date.now() - 16 * 60_000).toISOString();
  throwsCode(() => validateModeration(c), "CONSENT_REQUIRED");
});
test("moderation target is limited to group B", () => {
  const c = baseConfig();
  c.moderation.group = "A";
  throwsCode(() => validateModeration(c), "MODERATION_TARGET");
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
test("internal diagnostics retain only known local frames without error payloads", () => {
  const error = new TypeError("secret-token private-message");
  const local = new URL("../lib/product-evidence.mjs", import.meta.url).href;
  error.stack = `TypeError: secret-token private-message\n    at verify (${local}:42:7)\n    at remote (https://secret-token.example/private.mjs:8:2)\n    at external (/tmp/private-message.mjs:3:1)`;
  const result = safeError(error);
  assert.deepEqual(result.diagnostic, {
    type: "TypeError",
    frames: [{ path: "tools/qq-live/lib/product-evidence.mjs", line: 42, column: 7 }],
  });
  assert.ok(!JSON.stringify(result).includes("secret-token"));
  assert.ok(!JSON.stringify(result).includes("private-message"));
});
test("diagnostics ignore stack getters and arbitrary thrown objects", () => {
  const error = new Error("secret");
  Object.defineProperty(error, "stack", {
    get() {
      throw new Error("secret getter");
    },
  });
  assert.deepEqual(safeError(error).diagnostic, { type: "Error", frames: [] });
  assert.equal(safeError({ name: "TypeError", stack: "secret" }).diagnostic, undefined);
});
test("CQ metadata is not parsed as text", () => assert.equal(textOf("[CQ:at,qq=10002]hi"), "hi"));
test("SQLite diagnostics retain only a bounded numeric result code", () => {
  const error = Object.assign(new Error("secret SQLite payload"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "secret SQLite payload",
  });
  assert.equal(safeError(error).diagnostic.sqliteCode, 5);
  assert.ok(!JSON.stringify(safeError(error)).includes("secret SQLite payload"));
  for (const errcode of ["5", -1, 65536, Infinity]) {
    error.errcode = errcode;
    assert.equal(safeError(error).diagnostic.sqliteCode, undefined);
  }
  error.errcode = 5;
  error.code = "untrusted provider code";
  assert.equal(safeError(error).diagnostic.sqliteCode, undefined);
});
test("SQLite diagnostics do not invoke property getters", () => {
  const error = new Error("secret");
  Object.defineProperty(error, "code", {
    get() {
      throw new Error("secret getter");
    },
  });
  Object.defineProperty(error, "errcode", {
    get() {
      throw new Error("secret getter");
    },
  });
  assert.equal(safeError(error).diagnostic.sqliteCode, undefined);
});
test("SQLite diagnostics retain only a bounded numeric result code", () => {
  const error = Object.assign(new Error("secret SQLite payload"), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
    errstr: "secret SQLite payload",
  });
  assert.equal(safeError(error).diagnostic.sqliteCode, 5);
  assert.ok(!JSON.stringify(safeError(error)).includes("secret SQLite payload"));
  for (const errcode of ["5", -1, 65536, Infinity]) {
    error.errcode = errcode;
    assert.equal(safeError(error).diagnostic.sqliteCode, undefined);
  }
  error.errcode = 5;
  error.code = "untrusted provider code";
  assert.equal(safeError(error).diagnostic.sqliteCode, undefined);
});
test("SQLite diagnostics do not invoke property getters", () => {
  const error = new Error("secret");
  Object.defineProperty(error, "code", {
    get() {
      throw new Error("secret getter");
    },
  });
  Object.defineProperty(error, "errcode", {
    get() {
      throw new Error("secret getter");
    },
  });
  assert.equal(safeError(error).diagnostic.sqliteCode, undefined);
});
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
    driverTime: result.time,
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

test("fresh same-route reply without the nonce is recorded as a failed assertion", () => {
  const r = new Recorder(baseConfig());
  const c = r.begin("account-status", "private", "check status {{nonce}}", ["{{nonce}"]);
  const text = "The account is online.";
  r.ingest("driver", {
    self_id: 10001,
    post_type: "message",
    message_type: "private",
    user_id: 10002,
    message_id: 501,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text } }],
  });

  assert.equal(c.replies.length, 1);
  assert.equal(c.replies[0].matches, false);
  assert.equal(c.replies[0].textBytes, Buffer.byteLength(text));
  assert.equal(c.replies[0].textSha256, digest(text));
  assert.equal(JSON.stringify(c).includes(text), false);
  assert.equal(JSON.stringify(r.events).includes(text), false);
});

test("old unmarked same-route reply is not associated with an active case", () => {
  const r = new Recorder(baseConfig());
  const c = r.begin("account-status", "private", "check status {{nonce}}", ["{{nonce}"]);
  r.ingest("driver", {
    self_id: 10001,
    post_type: "message",
    message_type: "private",
    user_id: 10002,
    message_id: 502,
    time: Math.floor(c.startedMs / 1000) - 10,
    message: "The account is online.",
  });
  assert.equal(c.replies.length, 0);
});

test("replyCase classifies a captured fresh reply without the nonce as an assertion failure", async () => {
  const config = { ...baseConfig(), timeoutMs: 20, settleMs: 0 };
  const recorder = new Recorder(config);
  const currentTime = Math.floor(Date.now() / 1000);
  const promptText = (messageId) => ({
    self_id: messageId === 101 ? 10001 : 10002,
    message_id: messageId,
    message_type: "private",
    user_id: 10001,
    real_seq: "901",
    time: currentTime,
    sender: { user_id: 10001 },
    message: [{ type: "text", data: { text: recorder.cases[0].prompt } }],
  });
  const clients = {
    driver: {
      problem: null,
      async call(action) {
        if (action === "send_private_msg") {
          recorder.ingest("bot", {
            self_id: 10002,
            post_type: "message",
            message_type: "private",
            user_id: 10001,
            message_id: 201,
            time: currentTime,
            message: [{ type: "text", data: { text: recorder.cases[0].prompt } }],
          });
          recorder.ingest("driver", {
            self_id: 10001,
            post_type: "message",
            message_type: "private",
            user_id: 10002,
            message_id: 301,
            time: currentTime,
            message: [{ type: "text", data: { text: "The account is online." } }],
          });
          return { message_id: 101 };
        }
        if (action === "get_msg") return promptText(101);
        throw new Error("unexpected driver API call");
      },
    },
    bot: {
      problem: null,
      allowMessageRead() {},
      async call(action) {
        if (action === "get_msg") return promptText(201);
        throw new Error("unexpected bot API call");
      },
    },
  };

  const result = await replyCase(
    config,
    clients,
    recorder,
    {
      id: "account-status",
      chat: "private",
      prompt: "check status {{nonce}}",
      expectContains: ["{{nonce}"],
    },
    undefined,
  );
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "REPLY_ASSERTION_FAILED");
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].matches, false);
  assert.equal(JSON.stringify(result).includes("The account is online."), false);
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

test("media binding checks the received caption, media type, accounts and fresh message identity", async () => {
  const expected = {
    selfId: "10002",
    senderId: "10001",
    messageType: "private",
    mediaType: "image",
    caption: "fixed image caption",
    afterTime: new Date(Date.now() - 1000).toISOString(),
  };
  const result = {
    message_id: "123456",
    real_seq: "456789",
    time: Math.floor(Date.now() / 1000),
    self_id: "10002",
    user_id: "10001",
    message_type: "private",
    message: [
      { type: "text", data: { text: expected.caption } },
      { type: "image", data: { file: "private-local-media-handle" } },
    ],
  };
  const client = {
    call: async (method, input) => {
      assert.equal(method, "get_msg");
      assert.deepEqual(input, { message_id: "123456" });
      return result;
    },
  };
  const binding = await boundMediaMessage(client, "123456", expected);
  assert.equal(binding.mediaType, "image");
  assert.equal(binding.captionSha256, digest(expected.caption));
  assert.equal(binding.segmentCount, 2);
  assert.equal(Object.hasOwn(binding, "file"), false);
  for (const change of [
    (message) => {
      message.message[1].type = "video";
    },
    (message) => {
      message.message[0].data.text = "different caption";
    },
    (message) => {
      message.message.push({ type: "text", data: { text: "extra" } });
    },
    (message) => {
      message.user_id = "10003";
    },
    (message) => {
      message.real_seq = "not-decimal";
    },
  ]) {
    const altered = structuredClone(result);
    change(altered);
    await assert.rejects(boundMediaMessage({ call: async () => altered }, "123456", expected), {
      code: "MESSAGE_BINDING_MISMATCH",
    });
  }
});
