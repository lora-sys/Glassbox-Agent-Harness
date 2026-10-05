import test from "node:test";
import assert from "node:assert/strict";
import { OneBot } from "../lib/onebot.mjs";
import { Recorder, doctor, replyCase } from "../lib/runner.mjs";
import { moderationCase } from "../lib/moderation.mjs";
import { world } from "./fixture.mjs";
const env = { DRIVER_TOKEN: "fixture-token-only", BOT_TOKEN: "fixture-token-only" };
async function setup(t, opts = {}) {
  const w = await world(opts);
  const clients = {
    driver: new OneBot(w.config, "driver", { env }),
    bot: new OneBot(w.config, "bot", { env }),
  };
  t.after(async () => {
    clients.driver.close();
    clients.bot.close();
    await w.close();
  });
  await clients.driver.connect();
  await clients.bot.connect();
  const recorder = new Recorder(w.config, Object.values(env));
  for (const role of ["driver", "bot"]) clients[role].subscribe((e) => recorder.ingest(role, e));
  return { ...w, clients, recorder };
}
const spec = {
  id: "private",
  chat: "private",
  prompt: "请回复 {{nonce}} 和 result: 42",
  expectContains: ["{{nonce}}", "result: 42"],
};
const featureSpec = {
  ...spec,
  leaseTools: [],
  featureAssertions: [
    { kind: "trace", type: "tool_result", where: { name: "fixture", isError: false }, count: 1 },
  ],
};
test("feature request registers before sending and revokes its exact lease", async (t) => {
  const w = await setup(t);
  const leaseId = "12345678-1234-1234-1234-123456789abc";
  let registered = false,
    revoked = false;
  const c = await replyCase(w.config, w.clients, w.recorder, featureSpec, undefined, {
    register: async (config, c, tools) => {
      assert.equal(w.actions.filter((a) => a.action.startsWith("send_")).length, 0);
      assert.match(c.prompt, /^GLASSBOX_ACCEPTANCE_V1 [a-f0-9]{32}\n/);
      assert.deepEqual(tools, []);
      registered = true;
      return { leaseId, expiresAt: Date.now() + 10000 };
    },
    revoke: async (id) => {
      assert.equal(id, leaseId);
      revoked = true;
    },
  });
  assert.equal(c.status, "PASS");
  assert.equal(registered, true);
  assert.equal(revoked, true);
  assert.equal(c.leaseRevoked, true);
  assert.deepEqual(c.featureAssertions, featureSpec.featureAssertions);
});
test("missing or rejected feature lease prevents all sends", async (t) => {
  const w = await setup(t);
  const c = await replyCase(w.config, w.clients, w.recorder, featureSpec);
  assert.equal(c.status, "BLOCKED");
  const denied = await replyCase(w.config, w.clients, w.recorder, featureSpec, undefined, {
    register: async () => {
      throw Error("refused");
    },
  });
  assert.notEqual(denied.status, "PASS");
  assert.equal(w.actions.filter((a) => a.action.startsWith("send_")).length, 0);
});
test("feature evidence query is expanded to the exact sent marker", async (t) => {
  const w = await setup(t);
  const assertions = [
    {
      kind: "trace",
      type: "history_retrieval",
      count: 1,
      where: { query: "{{nonce}}", groups: ["123"], resources: ["group:123"] },
    },
  ];
  const c = await replyCase(
    w.config,
    w.clients,
    w.recorder,
    { ...featureSpec, featureAssertions: assertions },
    undefined,
    {
      register: async () => ({ leaseId: "fixture-lease" }),
      revoke: async () => {},
    },
  );
  assert.equal(c.status, "PASS");
  assert.equal(c.featureAssertions[0].where.query, c.token);
  assert.equal(assertions[0].where.query, "{{nonce}}");
});
test("lost registration response revokes by marker without retrying or sending", async (t) => {
  const w = await setup(t);
  let attempts = 0,
    marker;
  const c = await replyCase(w.config, w.clients, w.recorder, featureSpec, undefined, {
    register: async () => {
      attempts++;
      throw Error("response lost");
    },
    revokeMarker: async (value) => {
      marker = value;
    },
  });
  assert.equal(attempts, 1);
  assert.equal(marker, c.token);
  assert.equal(c.leaseRevoked, true);
  assert.notEqual(c.status, "PASS");
  assert.equal(w.actions.filter((a) => a.action.startsWith("send_")).length, 0);
});
test("unconfirmed lease revocation makes a received reply inconclusive", async (t) => {
  const w = await setup(t);
  const c = await replyCase(w.config, w.clients, w.recorder, featureSpec, undefined, {
    register: async () => ({ leaseId: "fixture-lease" }),
    revoke: async () => {
      throw Error("offline");
    },
  });
  assert.equal(c.status, "INCONCLUSIVE");
  assert.equal(c.code, "LEASE_REVOKE_UNCONFIRMED");
  assert.deepEqual(c.cleanup, { required: true, restored: false });
});
test("real localhost WebSocket handshake uses Bearer header", async (t) => {
  const w = await setup(t);
  await doctor(w.config, w.clients);
  assert.equal(w.driver.authCount, 1);
  assert.equal(w.bot.authCount, 1);
});

test("doctor verifies driver membership through the Bot despite an empty driver cache", async (t) => {
  const w = await setup(t);
  const original = w.clients.driver.call.bind(w.clients.driver);
  w.clients.driver.call = async (action, ...args) => {
    if (action === "get_group_member_info") throw new Error("driver member cache unavailable");
    return original(action, ...args);
  };
  const result = await doctor(w.config, w.clients);
  assert.equal(result.driver.identityVerified, true);
  assert.equal(result.driver.groups.length, w.config.groups.length);
  assert.ok(
    w.actions.filter((a) => a.action === "get_group_member_info").every((a) => a.role === "bot"),
  );
});

test("doctor refuses a mismatched driver membership returned by the Bot", async (t) => {
  const w = await setup(t);
  const original = w.clients.bot.call.bind(w.clients.bot);
  w.clients.bot.call = async (action, params, ...args) => {
    const result = await original(action, params, ...args);
    if (action === "get_group_member_info" && String(params.user_id) === w.config.driver.qq)
      return { ...result, user_id: Number(w.config.bot.qq) };
    return result;
  };
  await assert.rejects(doctor(w.config, w.clients), (e) => e.code === "GROUP_MEMBERSHIP");
});
test("private round trip binds different account-local IDs to the same input", async (t) => {
  const w = await setup(t);
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(c.status, "PASS");
  assert.equal(c.inputObserved, true);
  assert.notEqual(c.botInputMessageId, c.sentMessageId);
  assert.equal(c.inputBinding.driverMessageId, c.sentMessageId);
  assert.equal(c.inputBinding.botMessageId, c.botInputMessageId);
  assert.equal(c.inputBinding.realSequence, "501");
  assert.ok(Number.isSafeInteger(c.inputBinding.time));
  assert.match(c.inputBinding.textSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    w.actions
      .filter((a) => a.action === "get_msg")
      .map((a) => a.role)
      .sort((a, b) => a.localeCompare(b)),
    ["bot", "driver"],
  );
});
test("get_msg must return the requested account-local receipt ID", async (t) => {
  const w = await setup(t, { mode: "wrong-read-id" });
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(c.status, "INCONCLUSIVE");
  assert.equal(c.code, "MESSAGE_BINDING_MISMATCH");
  assert.notEqual(c.botInputMessageId, c.sentMessageId);
});
test("cross-account real sequence mismatch cannot pass", async (t) => {
  const w = await setup(t, { mode: "binding-sequence-mismatch" });
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(c.status, "INCONCLUSIVE");
  assert.equal(c.code, "MESSAGE_BINDING_MISMATCH");
});
test("multiple Bot-side input candidates cannot pass", async (t) => {
  const w = await setup(t, { mode: "duplicate-input" });
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(c.status, "INCONCLUSIVE");
  assert.equal(c.code, "MESSAGE_BINDING_MISMATCH");
  assert.equal(w.actions.filter((a) => a.action === "get_msg").length, 0);
});
test("get_msg text mismatch cannot pass despite a nonce reply", async (t) => {
  const w = await setup(t, { mode: "binding-text-mismatch" });
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(c.status, "INCONCLUSIVE");
  assert.equal(c.code, "MESSAGE_BINDING_MISMATCH");
});
test("get_msg requires an explicitly registered message ID", async (t) => {
  const w = await setup(t);
  await assert.rejects(
    w.clients.bot.call("get_msg", { message_id: "12345" }),
    (e) => e.code === "ACTION_DENIED",
  );
});
test("group round trip validates receiving account and route", async (t) => {
  const w = await setup(t);
  const c = await replyCase(w.config, w.clients, w.recorder, { ...spec, id: "group-A", chat: "A" });
  assert.equal(c.status, "PASS");
});
test("wrong-group reply fails", async (t) => {
  const w = await setup(t, { mode: "wrong" });
  await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(w.recorder.finalize(), "FAIL");
});
test("replayed same message does not become a duplicate reply", async (t) => {
  const w = await setup(t, { mode: "replay" });
  await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(w.recorder.finalize(), "PASS");
});
test("distinct duplicate replies fail", async (t) => {
  const w = await setup(t, { mode: "duplicate" });
  await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(w.recorder.finalize(), "FAIL");
});
test("API rejection with message_id never passes", async (t) => {
  const w = await setup(t, { ack: "reject" });
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.notEqual(c.status, "PASS");
  assert.equal(c.code, "API_REJECTED");
});
test("send timeout is not retried", async (t) => {
  const w = await setup(t, { ack: "timeout" });
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(c.status, "INCONCLUSIVE");
  assert.equal(w.actions.filter((a) => a.action.startsWith("send_")).length, 1);
});
test("Bot input without reply is inconclusive", async (t) => {
  const w = await setup(t, { mode: "silent" });
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(c.code, "REPLY_TIMEOUT");
  assert.equal(c.status, "INCONCLUSIVE");
});
test("reply assertion mismatch fails", async (t) => {
  const w = await setup(t, { mode: "mismatch" });
  const begin = w.recorder.begin.bind(w.recorder);
  w.recorder.begin = (...args) => begin(...args, "QQLIVE_fixture42");
  const c = await replyCase(w.config, w.clients, w.recorder, spec);
  assert.equal(c.code, "REPLY_ASSERTION_FAILED");
});
test("offline account blocks doctor", async (t) => {
  const w = await setup(t, { online: false });
  await assert.rejects(doctor(w.config, w.clients), (e) => e.code === "ACCOUNT_OFFLINE");
});
test("unapproved targets and direct Bot mutations are blocked", async (t) => {
  const w = await setup(t);
  await assert.rejects(
    w.clients.driver.call("send_private_msg", { user_id: "99999", message: [] }),
    (e) => e.code === "TARGET_DENIED",
  );
  await assert.rejects(
    w.clients.bot.call("set_group_ban", { group_id: "20001", user_id: "10003", duration: 60 }),
    (e) => e.code === "ACTION_DENIED",
  );
});
test("direct driver mute forbidden even when emergency cleanup allowed", async (t) => {
  const w = await setup(t);
  w.config.moderation.emergencyCleanupViaDriver = true;
  await assert.rejects(
    w.clients.driver.call(
      "set_group_ban",
      { group_id: "20001", user_id: "10003", duration: 60 },
      { cleanup: true },
    ),
    (e) => e.code === "ACTION_DENIED",
  );
});
test("moderation proves independent notice and state then chat unmute", async (t) => {
  const w = await setup(t);
  stageNoticeTimes(w, w.recorder);
  const c = await moderationCase(w.config, w.clients, w.recorder);
  assert.equal(c.status, "PASS", JSON.stringify(c));
  assert.equal(c.effectVerified, true);
  assert.equal(c.cleanup.normalChatVerified, true);
  assert.equal(w.actions.filter((a) => a.action === "set_group_ban").length, 0);
});
test("missing mute state prevents any moderation message", async (t) => {
  const w = await setup(t, { stateField: false });
  const c = await moderationCase(w.config, w.clients, w.recorder);
  assert.equal(c.code, "MUTE_STATE_UNSUPPORTED");
  assert.equal(w.actions.filter((a) => a.action.startsWith("send_")).length, 0);
});
test("already muted member is left untouched", async (t) => {
  const w = await setup(t, { initialMute: Math.floor(Date.now() / 1000) + 60 });
  const c = await moderationCase(w.config, w.clients, w.recorder);
  assert.equal(c.code, "TARGET_ALREADY_MUTED");
  assert.equal(w.actions.filter((a) => a.action.startsWith("send_")).length, 0);
});
test("claimed reply without moderation effect cannot pass", async (t) => {
  const w = await setup(t, { mode: "pretend" });
  const c = await moderationCase(w.config, w.clients, w.recorder);
  assert.notEqual(c.status, "PASS");
  assert.equal(c.cleanup.pendingActionUnknown, true);
});
test("cancel prevents outgoing messages", async (t) => {
  const w = await setup(t);
  const signal = AbortSignal.abort();
  const c = await replyCase(w.config, w.clients, w.recorder, spec, signal);
  assert.equal(c.code, "CANCELLED");
  assert.equal(w.actions.filter((a) => a.action.startsWith("send_")).length, 0);
});

function stageNoticeTimes(w, recorder, staleSubtype = null) {
  w.config.timeoutMs = 3000;
  const broadcast = w.driver.broadcast.bind(w.driver);
  w.driver.broadcast = (event) => {
    if (event.post_type !== "notice" || event.notice_type !== "group_ban") return broadcast(event);
    const c = recorder.cases.find((item) => item.moderation);
    const stageAt = event.sub_type === "ban" ? c?.muteSentAt : c?.liftSentAt;
    if (!c || !Number.isFinite(stageAt)) return broadcast(event);
    const serverTime =
      event.sub_type === staleSubtype
        ? Math.floor(c.startedMs / 1000) - 1
        : Math.ceil(stageAt / 1000);
    void (async () => {
      while (Math.floor(Date.now() / 1000) < serverTime)
        await new Promise((resolve) => setTimeout(resolve, 5));
      broadcast({ ...event, time: serverTime });
    })();
  };
}

test("delayed pre-request ban notice cannot verify moderation", async (t) => {
  const w = await setup(t);
  stageNoticeTimes(w, w.recorder, "ban");
  const c = await moderationCase(w.config, w.clients, w.recorder);
  assert.notEqual(c.status, "PASS");
  assert.equal(c.effectVerified, false);
});
test("delayed pre-request lift notice cannot verify cleanup", async (t) => {
  const w = await setup(t);
  stageNoticeTimes(w, w.recorder, "lift_ban");
  const c = await moderationCase(w.config, w.clients, w.recorder);
  assert.notEqual(c.status, "PASS");
  assert.equal(c.cleanup.normalChatVerified, false);
});
