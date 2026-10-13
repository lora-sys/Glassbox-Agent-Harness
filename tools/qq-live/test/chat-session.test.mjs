import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ChatJournal,
  ChatSession,
  chatConfig,
  projectChatEvent,
  projectChatRuntimeStatus,
  routeFor,
} from "../lib/chat-session.mjs";
import { serve, rpc } from "../chat.mjs";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "qq-chat-"));
  const cleanup = [];
  t.after(() => {
    for (const close of cleanup) close();
    rmSync(dir, { recursive: true, force: true });
  });
  const config = chatConfig({
    schemaVersion: 1,
    driver: { qq: "10001", wsUrl: "ws://127.0.0.1:6701", tokenEnv: "TEST_OWNER_TOKEN" },
    bot: { qq: "10002", wsUrl: "ws://127.0.0.1:6700", tokenEnv: "TEST_BOT_TOKEN" },
    groups: [
      { alias: "A", id: "20001" },
      { alias: "B", id: "20002" },
    ],
    stateDirectory: join(dir, "observer"),
    runtime: { checkout: dir, dataDirectory: dir, connectionId: "qq-test" },
  });
  const clients = {};
  const message = {
    message_id: "71",
    sender: { user_id: "10001" },
    real_seq: "9",
    time: 100,
    message: [{ type: "text", data: { text: "明天的新功能照样可以测" } }],
  };
  const makeClient = (role) =>
    (clients[role] = {
      closed: true,
      calls: [],
      subscribe(fn) {
        this.listener = fn;
      },
      connect() {
        this.closed = false;
      },
      close() {
        this.closed = true;
      },
      allowMessageRead() {},
      async call(action, params) {
        this.calls.push({ action, params });
        if (this.failure && action.startsWith("send_"))
          throw new Error("unknown transport outcome");
        if (action === "get_login_info") return { user_id: config[role].qq };
        if (action === "get_status") return { online: true };
        if (action.startsWith("send_")) return { message_id: "71" };
        if (action === "get_msg") return { ...message, message_id: String(params.message_id) };
        throw new Error("unexpected action");
      },
    });
  return {
    dir,
    config,
    clients,
    message,
    dependencies: { makeClient, runtime: () => ({ ready: true, processes: [{ pid: 1 }] }) },
    own(close) {
      cleanup.push(close);
    },
    session() {
      const value = new ChatSession(config, {
        makeClient,
        runtime: () => ({ ready: true, processes: [{ pid: 1 }] }),
      });
      cleanup.push(() => value.close());
      return value;
    },
  };
}
test("runtime status accepts the current OneBot listener contract and rejects an offline listener", () => {
  const status = {
    dataDirectory: "/data",
    glassboxReady: true,
    onebotListener: { host: "127.0.0.1", port: 6700, listening: true },
    processes: [
      {
        name: "glassbox",
        pid: 42,
        running: true,
        checkout: "/checkout",
        launchCommit: "abc123",
      },
    ],
  };
  const ready = projectChatRuntimeStatus(status);
  assert.equal(ready.ready, true);
  assert.equal(ready.processes[0].pid, 42);
  assert.equal(
    projectChatRuntimeStatus({
      ...status,
      onebotListener: { ...status.onebotListener, listening: false },
    }).ready,
    false,
  );
  assert.equal(
    projectChatRuntimeStatus({
      ...status,
      onebotListener: undefined,
      onebotReady: true,
    }).ready,
    true,
  );
});
test("free text routes only to configured private/group chats and excludes other members", (t) => {
  const { config } = fixture(t);
  assert.equal(routeFor(config, "B"), "20002");
  assert.throws(() => routeFor(config, "99999"));
  const event = {
    post_type: "message",
    self_id: "10002",
    message_id: "4",
    message_type: "group",
    group_id: "20002",
    sender: { user_id: "10001" },
    message: [{ type: "text", data: { text: "hello" } }],
  };
  assert.equal(projectChatEvent(config, "bot", event).text, "hello");
  assert.equal(
    projectChatEvent(config, "bot", { ...event, sender: { user_id: "30003" } }),
    undefined,
  );
  assert.equal(projectChatEvent(config, "bot", { ...event, self_id: "10001" }), undefined);
  assert.equal(projectChatEvent(config, "bot", { ...event, group_id: "99999" }), undefined);
});
test("durable cursor resumes through restart and paginates without losing events", (t) => {
  const { config } = fixture(t);
  const first = new ChatJournal(config.stateDirectory);
  first.append({ kind: "message", text: "first", route: "private" });
  first.append({ kind: "message", text: "second", route: "20002" });
  const second = new ChatJournal(config.stateDirectory);
  second.append({ kind: "message", text: "third", route: "private" });
  assert.equal(second.read(0, 1).cursor, 1);
  assert.equal(second.read(1).events.length, 2);
  assert.equal(second.read(1, 100, "private").events[0].text, "third");
});
test("send preserves ordinary user text and duplicate request IDs never send again", async (t) => {
  const f = fixture(t);
  const session = f.session();
  await session.start();
  t.after(() => session.close());
  const input = { requestId: randomUUID(), chat: "private", text: f.message.message[0].data.text };
  const first = await session.send(input);
  const duplicate = await session.send(input);
  assert.equal(first.sendStatus, "acknowledged");
  assert.equal(duplicate.sendStatus, "acknowledged");
  const sends = f.clients.driver.calls.filter((c) => c.action === "send_private_msg");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].params.message, f.message.message);
  await assert.rejects(session.send({ ...input, text: "different" }), /different message/);
});
test("unknown sends remain unknown after observer restart without retry", async (t) => {
  const f = fixture(t);
  const session = f.session();
  await session.start();
  f.clients.driver.failure = true;
  const input = { requestId: randomUUID(), chat: "private", text: "hello" };
  assert.equal((await session.send(input)).sendStatus, "unknown");
  session.close();
  const again = f.session();
  await again.start();
  t.after(() => again.close());
  assert.equal((await again.send(input)).sendStatus, "unknown");
  assert.equal(f.clients.driver.calls.filter((c) => c.action.startsWith("send_")).length, 0);
});
test("status keeps only the allow-listed OneBot identity diagnostic", async (t) => {
  const f = fixture(t);
  const session = f.session();
  await session.start();
  t.after(() => session.close());
  const error = Object.assign(new Error("OneBot event account did not match."), {
    code: "EVENT_IDENTITY",
    identityDiagnostic: {
      expectedRole: "driver",
      observedIdentity: "missing",
      postType: "meta_event",
      metaEventType: "lifecycle",
      eventBody: "must not be projected",
    },
  });
  f.clients.driver.call = async (action) => {
    if (action === "get_status") throw error;
    return { user_id: f.config.driver.qq };
  };
  const status = await session.status();
  assert.deepEqual(status.accounts.driver.error.identityDiagnostic, {
    expectedRole: "driver",
    observedIdentity: "missing",
    postType: "meta_event",
    metaEventType: "lifecycle",
  });
  assert.equal(JSON.stringify(status).includes("eventBody"), false);
});

test("status reports a connected instance as offline when its QQ identity changes", async (t) => {
  const f = fixture(t);
  const session = f.session();
  await session.start();
  t.after(() => session.close());
  const driver = f.clients.driver;
  const callsBefore = driver.calls.length;
  driver.call = async (action, params) => {
    driver.calls.push({ action, params });
    if (action === "get_login_info") return { user_id: f.config.bot.qq };
    if (action === "get_status") return { online: true };
    if (action.startsWith("send_")) return { message_id: "71" };
    throw new Error("unexpected action");
  };

  const status = await session.status();
  assert.equal(status.accounts.driver.qq, f.config.driver.qq);
  assert.equal(status.accounts.driver.observedQQ, f.config.bot.qq);
  assert.equal(status.accounts.driver.identityMatches, false);
  assert.equal(status.accounts.driver.online, false);
  assert.equal(status.accounts.driver.error.code, "ACCOUNT_IDENTITY_MISMATCH");
  assert.equal(
    status.accounts.driver.error.identityDiagnostic.observedIdentity,
    "other_configured_account",
  );
  assert.deepEqual(
    driver.calls.slice(callsBefore).map((call) => call.action),
    ["get_login_info"],
  );

  await assert.rejects(
    session.send({ requestId: randomUUID(), chat: "private", text: "check account identity only" }),
    /both QQ accounts must be online/,
  );
  assert.equal(
    driver.calls.slice(callsBefore).some((call) => call.action.startsWith("send_")),
    false,
  );
});

test("observer retains late images and videos after text without a scenario schema", async (t) => {
  const f = fixture(t);
  const session = f.session();
  await session.start();
  t.after(() => session.close());
  f.clients.driver.call = async () => {
    throw new Error("readback unavailable");
  };
  for (const [index, type] of ["text", "image", "video"].entries())
    await session.observe("driver", {
      post_type: "message",
      self_id: "10001",
      message_type: "private",
      user_id: "10002",
      sender: { user_id: "10002" },
      message_id: String(index),
      time: 200 + index,
      message: [{ type, data: type === "text" ? { text: "done" } : { file: "fixture" } }],
    });
  const messages = session.journal.rows.filter((r) => r.kind === "message");
  assert.deepEqual(
    messages.map((r) => r.segments[0].type),
    ["text", "image", "video"],
  );
});
test("same native sequence binds account-local message IDs to the actual failed Run", async (t) => {
  const f = fixture(t);
  const session = f.session();
  await session.start();
  t.after(() => session.close());
  const requestId = randomUUID();
  await session.send({ requestId, chat: "private", text: f.message.message[0].data.text });
  await session.observe("bot", {
    post_type: "message",
    self_id: "10002",
    message_type: "private",
    user_id: "10001",
    sender: { user_id: "10001" },
    message_id: "88",
    time: 100,
    message: f.message.message,
  });
  assert.equal(session.receipt(requestId).botInput.messageId, "88");
  const runId = randomUUID();
  const db = new DatabaseSync(join(f.dir, "glassbox.db"));
  db.exec(
    "CREATE TABLE runs(id TEXT,status TEXT,failure_code TEXT,created_at TEXT,result_text TEXT,scope_json TEXT,message_id TEXT);CREATE TABLE messages(id TEXT,external_id TEXT,scope_key TEXT);CREATE TABLE deliveries(id TEXT,status TEXT,external_id TEXT,payload_kind TEXT,run_id TEXT)",
  );
  const scope = {
    connectionId: "qq-test",
    botId: "10002",
    senderId: "10001",
    chatType: "private",
    chatId: "10001",
  };
  db.prepare("INSERT INTO messages VALUES(?,?,?)").run(
    "m1",
    "88",
    JSON.stringify(["qq-test", "10002", "private", "10001", "10001", null]),
  );
  db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?)").run(
    runId,
    "failed",
    "provider_failed",
    "2026-10-08",
    "",
    JSON.stringify(scope),
    "m1",
  );
  db.close();
  const rd = join(f.dir, "runs", runId);
  mkdirSync(rd, { recursive: true });
  writeFileSync(
    join(rd, "trace.jsonl"),
    JSON.stringify({ seq: 1, event: { type: "tool_call", data: { name: "future_tool" } } }) + "\n",
  );
  const trace = await session.trace({ requestId });
  assert.equal(trace.runs[0].failure_code, "provider_failed");
  assert.equal(trace.runs[0].events[0].event.data.name, "future_tool");
});
test("local RPC exposes chat operations only and never arbitrary OneBot actions", async (t) => {
  const f = fixture(t);
  const app = await serve(f.config, f.dependencies);
  f.own(app.close);
  t.after(() => app.close());
  assert.equal((await rpc(f.config.socketPath, "status")).accounts.driver.online, true);
  await assert.rejects(
    rpc(f.config.socketPath, "set_group_ban", { duration: 30 }),
    /Unknown chat operation/,
  );
  const sent = await rpc(f.config.socketPath, "send", {
    requestId: randomUUID(),
    chat: "B",
    text: "新功能测试",
  });
  assert.equal(sent.sendStatus, "acknowledged");
  assert.equal(
    f.clients.driver.calls.find((c) => c.action === "send_group_msg").params.message[0].type,
    "at",
  );
});

test("concurrent identical requests cannot cause duplicate QQ sends", async (t) => {
  const f = fixture(t);
  const session = f.session();
  await session.start();
  t.after(() => session.close());
  const input = { requestId: randomUUID(), chat: "private", text: "同一条消息" };
  await Promise.all([session.send(input), session.send(input)]);
  assert.equal(f.clients.driver.calls.filter((c) => c.action === "send_private_msg").length, 1);
});

test("offline startup preserves local observation and reconnects without resending", async (t) => {
  const f = fixture(t);
  let offline = true;
  const ordinary = f.dependencies.makeClient;
  const deps = {
    ...f.dependencies,
    makeClient(role) {
      if (!offline) return ordinary(role);
      return {
        closed: true,
        subscribe() {},
        async connect() {
          throw new Error("QQ offline");
        },
        close() {
          this.closed = true;
        },
        async call() {
          throw new Error("QQ offline");
        },
      };
    },
  };
  const session = new ChatSession(f.config, deps);
  f.own(() => session.close());
  await session.start();
  const status = await session.status();
  assert.equal(status.observerReady, true);
  assert.equal(status.accounts.bot.online, false);
  assert.ok((await session.read()).events.some((r) => r.kind === "connection_unavailable"));
  await assert.rejects(
    session.send({ requestId: randomUUID(), chat: "private", text: "不应发送" }),
    /No message sent/,
  );
  offline = false;
  await Promise.all([session.connectRole("driver"), session.connectRole("bot")]);
  assert.equal((await session.status()).accounts.bot.online, true);
  assert.equal(f.clients.driver.calls.filter((c) => c.action.startsWith("send_")).length, 0);
});
