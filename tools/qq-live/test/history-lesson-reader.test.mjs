import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createHistoryLessonReader } from "../lib/history-lesson-reader.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");

function fixture({ failRole } = {}) {
  const time = Math.floor(Date.now() / 1000);
  const token = "a".repeat(32);
  const prompt = `GLASSBOX_ACCEPTANCE_V1 ${token}\nRead the fixed history fixture.`;
  const reply = `${token} verified`;
  const config = {
    bot: { qq: "20002" },
    driver: { qq: "20001" },
    groups: [
      { alias: "A", id: "30001" },
      { alias: "B", id: "30002" },
    ],
    runtime: {
      checkout: resolve("fixture-checkout"),
      dataDirectory: resolve("fixture-data"),
      expectedCommit: "b".repeat(40),
      connectionId: "fixture-connection",
      threadId: null,
    },
  };
  const caseRecord = {
    prompt,
    route: "private",
    expected: token,
    startedAt: new Date(time * 1000).toISOString(),
    inputBinding: {
      botMessageId: "101",
      driverMessageId: "201",
      realSequence: "11",
      time,
      textSha256: hash(prompt),
    },
    replies: [{ route: "private", matches: true, messageId: "401", textSha256: hash(reply) }],
  };
  const delivery = { external_id: "301" };
  const records = new Map();
  for (const [role, messageId, text, realSequence, sender] of [
    ["bot", "101", prompt, "11", config.driver.qq],
    ["driver", "201", prompt, "11", config.driver.qq],
    ["bot", "301", reply, "12", config.bot.qq],
    ["driver", "401", reply, "12", config.bot.qq],
  ]) {
    records.set(`${role}:${messageId}`, {
      message_id: messageId,
      self_id: config[role].qq,
      sender: { user_id: sender },
      message_type: "private",
      real_seq: realSequence,
      time,
      message: [{ type: "text", data: { text } }],
    });
  }
  const connections = [],
    calls = [],
    closed = [];
  class FakeOneBot {
    constructor(_config, role) {
      this.role = role;
      this.allowed = new Set();
    }
    async connect() {
      connections.push(this.role);
      if (this.role === failRole) throw new Error("private transport detail");
    }
    close() {
      closed.push(this.role);
    }
    allowMessageRead(id) {
      this.allowed.add(id);
    }
    async call(action, parameters) {
      assert.equal(action, "get_msg");
      assert.deepEqual(Object.keys(parameters), ["message_id"]);
      assert.ok(this.allowed.has(parameters.message_id));
      calls.push(`${this.role}:${parameters.message_id}`);
      return structuredClone(records.get(`${this.role}:${parameters.message_id}`));
    }
  }
  return {
    config,
    caseRecord,
    delivery,
    records,
    connections,
    calls,
    closed,
    reader: createHistoryLessonReader(config, { OneBotClass: FakeOneBot }),
  };
}

test("history lesson reader independently re-reads both accounts without sending", async () => {
  const f = fixture();
  const result = await f.reader.readBindings(f.caseRecord, structuredClone(f.config), f.delivery);
  assert.equal(result.input.realSequence, "11");
  assert.equal(result.reply.realSequence, "12");
  assert.equal(result.reply.botMessageId, "301");
  assert.equal(result.reply.driverMessageId, "401");
  assert.deepEqual(f.calls, ["bot:101", "driver:201", "bot:301", "driver:401"]);
  await f.reader.readBindings(f.caseRecord, structuredClone(f.config), f.delivery);
  assert.equal(f.connections.length, 2);
  assert.equal(f.calls.length, 8);
  f.reader.close();
  assert.deepEqual(
    f.closed.sort((a, b) => a.localeCompare(b)),
    ["bot", "driver"],
  );
  await assert.rejects(f.reader.readBindings(f.caseRecord, f.config, f.delivery), {
    code: "HISTORY_LESSON_MESSAGE_EVIDENCE",
  });
});

test("report reply digests and account-local IDs cannot replace actual message proof", async (t) => {
  for (const mutate of [
    (f) => {
      f.caseRecord.replies[0].textSha256 = hash("forged report reply");
    },
    (f) => {
      f.records.get("driver:401").real_seq = "13";
    },
    (f) => {
      f.records.get("driver:401").sender.user_id = f.config.driver.qq;
    },
    (f) => {
      f.records.get("bot:101").message[0].data.text = "another input";
    },
    (f) => {
      f.records.delete("driver:401");
    },
  ]) {
    await t.test("rejects inconsistent independent account data", async () => {
      const f = fixture();
      mutate(f);
      await assert.rejects(f.reader.readBindings(f.caseRecord, f.config, f.delivery), {
        code: "HISTORY_LESSON_MESSAGE_EVIDENCE",
      });
      assert.deepEqual(
        f.closed.sort((a, b) => a.localeCompare(b)),
        ["bot", "driver"],
      );
      assert.ok(f.calls.length <= 4);
    });
  }
});

test("history lesson reader rejects unrelated local configuration before connecting", async (t) => {
  for (const mutate of [
    (c) => {
      c.bot.qq = "90002";
    },
    (c) => {
      c.driver.qq = "90001";
    },
    (c) => {
      c.runtime.expectedCommit = "c".repeat(40);
    },
    (c) => {
      c.runtime.checkout = resolve("another-checkout");
    },
    (c) => {
      c.runtime.dataDirectory = resolve("another-data");
    },
    (c) => {
      c.runtime.connectionId = "another-connection";
    },
    (c) => {
      c.runtime.threadId = "another-thread";
    },
    (c) => {
      c.groups[0].id = "90003";
    },
    (c) => {
      c.groups.push({ alias: "A", id: "30001" });
    },
  ]) {
    await t.test("rejects configuration mismatch", async () => {
      const f = fixture();
      const derived = structuredClone(f.config);
      mutate(derived);
      await assert.rejects(f.reader.readBindings(f.caseRecord, derived, f.delivery), {
        code: "HISTORY_LESSON_MESSAGE_EVIDENCE",
      });
      assert.deepEqual(f.connections, []);
      assert.deepEqual(f.calls, []);
    });
  }
});

test("a failed account connection closes both readers and is never retried", async () => {
  const f = fixture({ failRole: "driver" });
  await assert.rejects(f.reader.readBindings(f.caseRecord, f.config, f.delivery), (error) => {
    assert.equal(error.code, "HISTORY_LESSON_MESSAGE_EVIDENCE");
    assert.ok(!error.message.includes("private transport detail"));
    return true;
  });
  assert.deepEqual(
    f.connections.sort((a, b) => a.localeCompare(b)),
    ["bot", "driver"],
  );
  assert.deepEqual(
    f.closed.sort((a, b) => a.localeCompare(b)),
    ["bot", "driver"],
  );
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.reader.readBindings(f.caseRecord, f.config, f.delivery));
  assert.equal(f.connections.length, 2);
});
