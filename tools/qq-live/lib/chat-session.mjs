import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { openReadOnlyDatabase } from "./read-only-database.mjs";
import { OneBot } from "./onebot.mjs";
import { validateConfig, textOf, id, messageId } from "./core.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const defaultChatConfig = () => join(homedir(), ".config/glassbox/qq-chat.json");
function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
export function chatConfig(raw) {
  const c = validateConfig({ ...raw, maxMessages: 30 }, { live: false });
  requireValue(
    isAbsolute(c.runtime?.checkout ?? "") &&
      isAbsolute(c.runtime?.dataDirectory ?? "") &&
      typeof c.runtime?.connectionId === "string",
    "Configure the existing Glassbox checkout, dataDirectory and connectionId.",
  );
  c.stateDirectory = resolve(c.stateDirectory ?? join(homedir(), ".glassbox/qq-chat"));
  c.socketPath = join(c.stateDirectory, "chat.sock");
  requireValue(
    Buffer.byteLength(c.socketPath) < 100,
    "Use a shorter stateDirectory for the local socket.",
  );
  return c;
}
export function routeFor(config, chat) {
  if (chat === "private") return "private";
  const group = config.groups.find((g) => g.alias === chat || g.id === chat);
  requireValue(group, "Chat must be private or a configured test group.");
  return group.id;
}
export function projectChatEvent(config, role, event) {
  if (
    !["message", "message_sent"].includes(event.post_type) ||
    id(event.self_id) !== config[role].qq
  )
    return;
  const sender = id(event.sender?.user_id ?? event.user_id);
  if (![config.bot.qq, config.driver.qq].includes(sender)) return;
  let route;
  if (event.message_type === "group" && config.groups.some((g) => g.id === id(event.group_id)))
    route = id(event.group_id);
  else if (
    event.message_type === "private" &&
    [config.bot.qq, config.driver.qq].includes(id(event.user_id))
  )
    route = "private";
  if (!route || !messageId(event.message_id)) return;
  // Persist only the two test accounts in the configured chats, never other group members.
  return {
    kind: "message",
    account: role,
    route,
    senderId: sender,
    messageId: messageId(event.message_id),
    time: event.time,
    text: textOf(event.message),
    segments: event.message,
    direction: sender === config.driver.qq ? "input" : "reply",
  };
}
export class ChatJournal extends EventEmitter {
  constructor(directory) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, "events.jsonl");
    this.rows = existsSync(this.path)
      ? readFileSync(this.path, "utf8").split("\n").filter(Boolean).map(JSON.parse)
      : [];
    this.cursor = this.rows.at(-1)?.cursor ?? 0;
    requireValue(
      this.rows.every((r, i) => Number.isSafeInteger(r.cursor) && r.cursor === i + 1),
      "Chat journal has an invalid cursor; preserve it for inspection.",
    );
  }
  append(event) {
    const row = { ...event, cursor: this.cursor + 1, observedAt: new Date().toISOString() };
    const fd = openSync(this.path, "a", 0o600);
    try {
      appendFileSync(fd, JSON.stringify(row) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.cursor = row.cursor;
    this.rows.push(row);
    this.emit("append", row);
    return row;
  }
  read(after = 0, limit = 100, route) {
    requireValue(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 500,
      "Invalid cursor or limit.",
    );
    const eligible = this.rows.filter((r) => r.cursor > after && (!route || r.route === route));
    const events = eligible.slice(0, limit);
    return {
      events,
      cursor: eligible.length > limit ? events.at(-1).cursor : Math.max(after, this.cursor),
      more: eligible.length > limit,
    };
  }
}
function credentials(config, role) {
  const a = config[role];
  if (process.env[a.tokenEnv]) return process.env;
  requireValue(
    isAbsolute(a.onebotConfigPath ?? ""),
    `Set ${a.tokenEnv} or ${role}.onebotConfigPath locally.`,
  );
  const native = JSON.parse(readFileSync(a.onebotConfigPath, "utf8"));
  const port = Number(new URL(a.wsUrl).port);
  const matches =
    native.network?.websocketServers?.filter((s) => s.enable && Number(s.port) === port) ?? [];
  requireValue(
    matches.length === 1 && typeof matches[0].token === "string",
    "Cannot resolve the configured OneBot credential.",
  );
  return { ...process.env, [a.tokenEnv]: matches[0].token };
}
export function inspectChatRuntime(config) {
  const checkout = config.runtime.checkout;
  const status = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", join(checkout, "scripts/agent-service.mts"), "status"],
      {
        cwd: checkout,
        env: { ...process.env, GLASSBOX_DATA_DIR: config.runtime.dataDirectory },
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  const processes = status.processes?.filter((p) => p.name === "glassbox") ?? [];
  return {
    ready:
      status.glassboxReady === true &&
      status.onebotReady === true &&
      processes.length === 1 &&
      processes[0].running === true,
    dataDirectory: status.dataDirectory,
    processes: processes.map((p) => ({
      pid: p.pid,
      running: p.running,
      checkout: p.checkout,
      commit: p.launchCommit,
      sourceTreeSha256: p.launchSourceTreeSha256,
    })),
  };
}
function sameInput(a, b) {
  return (
    a.route === b.route &&
    a.realSequence &&
    a.realSequence === b.realSequence &&
    a.text === b.text &&
    Math.abs(a.time - b.time) <= 2
  );
}
function safeFailure(error) {
  const identityDiagnostic = error?.identityDiagnostic;
  const safeIdentityDiagnostic =
    error?.code === "EVENT_IDENTITY" &&
    identityDiagnostic &&
    ["driver", "bot"].includes(identityDiagnostic.expectedRole) &&
    ["missing", "invalid", "other_configured_account", "unrecognized"].includes(
      identityDiagnostic.observedIdentity,
    ) &&
    ["meta_event", "message", "message_sent", "notice", "request", "other"].includes(
      identityDiagnostic.postType,
    ) &&
    (identityDiagnostic.metaEventType === undefined ||
      ["heartbeat", "lifecycle"].includes(identityDiagnostic.metaEventType))
      ? {
          expectedRole: identityDiagnostic.expectedRole,
          observedIdentity: identityDiagnostic.observedIdentity,
          postType: identityDiagnostic.postType,
          ...(identityDiagnostic.metaEventType
            ? { metaEventType: identityDiagnostic.metaEventType }
            : {}),
        }
      : undefined;
  return {
    code: error?.code ?? "CHAT_ERROR",
    message: String(error?.message ?? error).slice(0, 1000),
    ...(safeIdentityDiagnostic ? { identityDiagnostic: safeIdentityDiagnostic } : {}),
  };
}
export class ChatSession {
  constructor(config, { makeClient, runtime = inspectChatRuntime } = {}) {
    this.config = config;
    this.journal = new ChatJournal(config.stateDirectory);
    this.clients = {};
    this.runtime = runtime;
    this.makeClient =
      makeClient ??
      ((role) =>
        new OneBot({ ...config, maxMessages: Number.MAX_SAFE_INTEGER }, role, {
          env: credentials(config, role),
        }));
    this.connecting = new Map();
    this.sends = new Map();
    this.closing = false;
  }
  async connectRole(role) {
    if (this.closing) return;
    if (this.connecting.has(role)) return this.connecting.get(role);
    const work = (async () => {
      const old = this.clients[role];
      if (old && !old.problem && !old.closed) return;
      old?.close();
      const client = this.makeClient(role);
      this.clients[role] = client;
      client.subscribe((event) => {
        void this.observe(role, event).catch((error) =>
          this.journal.append({ kind: "observer_error", account: role, error: safeFailure(error) }),
        );
      });
      await client.connect();
      const account = await client.call("get_login_info");
      requireValue(
        id(account?.user_id) === this.config[role].qq,
        `Wrong ${role} QQ account; no send performed.`,
      );
      this.journal.append({ kind: "connected", account: role, accountId: this.config[role].qq });
    })()
      .catch((error) => {
        this.clients[role]?.close();
        throw error;
      })
      .finally(() => this.connecting.delete(role));
    this.connecting.set(role, work);
    return work;
  }
  async start() {
    this.ready = true;
    this.journal.append({ kind: "observer_started", pid: process.pid });
    this.timer = setInterval(() => {
      for (const role of ["driver", "bot"])
        if (this.clients[role]?.problem || this.clients[role]?.closed)
          void this.connectRole(role).catch(() => {});
    }, 5000);
    const roles = ["driver", "bot"];
    const connected = await Promise.allSettled(roles.map((role) => this.connectRole(role)));
    for (const [index, result] of connected.entries()) {
      if (result.status === "rejected")
        this.journal.append({
          kind: "connection_unavailable",
          account: roles[index],
          error: safeFailure(result.reason),
        });
    }
  }
  async observe(role, event) {
    const row = projectChatEvent(this.config, role, event);
    if (!row) return;
    if (
      this.journal.rows.some(
        (r) =>
          r.kind === "message" &&
          r.account === role &&
          r.messageId === row.messageId &&
          r.time === row.time,
      )
    )
      return;
    try {
      const client = this.clients[role];
      client.allowMessageRead(row.messageId);
      const actual = await client.call("get_msg", { message_id: row.messageId });
      if (
        messageId(actual.message_id) === row.messageId &&
        id(actual.sender?.user_id) === row.senderId &&
        typeof actual.real_seq === "string"
      ) {
        row.realSequence = actual.real_seq;
        row.time = actual.time;
        row.text = textOf(actual.message);
        row.segments = actual.message;
      }
    } catch (error) {
      row.readbackError = safeFailure(error);
    }
    if (
      !this.journal.rows.some(
        (r) =>
          r.kind === "message" &&
          r.account === role &&
          r.messageId === row.messageId &&
          r.time === row.time,
      )
    )
      this.journal.append(row);
  }
  async status() {
    const accounts = {};
    for (const role of ["driver", "bot"]) {
      try {
        const status = await this.clients[role].call("get_status");
        accounts[role] = { qq: this.config[role].qq, online: status.online === true };
      } catch (error) {
        accounts[role] = { qq: this.config[role].qq, online: false, error: safeFailure(error) };
      }
    }
    return {
      pid: process.pid,
      observerReady: this.ready === true && !this.closing,
      cursor: this.journal.cursor,
      accounts,
      runtime: this.runtime(this.config),
      journalPath: this.journal.path,
    };
  }
  async send(input) {
    requireValue(uuid.test(input.requestId ?? ""), "send requires a UUID requestId.");
    const route = routeFor(this.config, input.chat);
    requireValue(
      typeof input.text === "string" && input.text.trim() && input.text.length <= 6000,
      "Provide 1 to 6000 characters of text.",
    );
    const previous = this.journal.rows.find(
      (r) => r.kind === "send_attempt" && r.requestId === input.requestId,
    );
    if (previous) {
      requireValue(
        previous.route === route &&
          previous.text === input.text &&
          previous.atBot === (input.atBot !== false),
        "This requestId belongs to a different message.",
      );
      if (this.sends.has(input.requestId)) await this.sends.get(input.requestId);
      return this.receipt(input.requestId);
    }
    const work = this.sendOnce(input, route);
    this.sends.set(input.requestId, work);
    try {
      return await work;
    } finally {
      this.sends.delete(input.requestId);
    }
  }
  async sendOnce(input, route) {
    const status = await this.status();
    requireValue(
      status.runtime.ready && Object.values(status.accounts).every((a) => a.online),
      "Glassbox and both QQ accounts must be online. No message sent.",
    );
    // Reserve before the external effect. Unknown outcomes are inspectable, never automatically resent.
    if (this.journal.rows.some((r) => r.kind === "send_attempt" && r.requestId === input.requestId))
      return this.receipt(input.requestId);
    this.journal.append({
      kind: "send_attempt",
      requestId: input.requestId,
      route,
      text: input.text,
      atBot: input.atBot !== false,
      runtime: status.runtime,
    });
    const message =
      route !== "private" && input.atBot !== false
        ? [
            { type: "at", data: { qq: this.config.bot.qq } },
            { type: "text", data: { text: " " + input.text } },
          ]
        : [{ type: "text", data: { text: input.text } }];
    try {
      const params =
        route === "private"
          ? { user_id: this.config.bot.qq, message }
          : { group_id: route, message };
      const result = await this.clients.driver.call(
        route === "private" ? "send_private_msg" : "send_group_msg",
        params,
      );
      requireValue(
        messageId(result?.message_id),
        "OneBot did not return a message ID; send outcome is unknown.",
      );
      this.journal.append({
        kind: "send_acknowledged",
        requestId: input.requestId,
        route,
        messageId: messageId(result.message_id),
      });
      try {
        this.clients.driver.allowMessageRead(result.message_id);
        const sent = await this.clients.driver.call("get_msg", { message_id: result.message_id });
        requireValue(
          messageId(sent.message_id) === messageId(result.message_id) &&
            id(sent.sender?.user_id) === this.config.driver.qq,
          "Sent-message identity mismatch.",
        );
        this.journal.append({
          kind: "sent_message",
          requestId: input.requestId,
          route,
          messageId: messageId(result.message_id),
          text: textOf(sent.message),
          time: sent.time,
          realSequence: sent.real_seq,
        });
      } catch (error) {
        this.journal.append({
          kind: "send_readback_error",
          requestId: input.requestId,
          error: safeFailure(error),
        });
      }
    } catch (error) {
      this.journal.append({
        kind: "send_unknown",
        requestId: input.requestId,
        route,
        error: safeFailure(error),
      });
    }
    return this.receipt(input.requestId);
  }
  receipt(requestId) {
    const events = this.journal.rows.filter((r) => r.requestId === requestId);
    requireValue(
      events.some((r) => r.kind === "send_attempt"),
      "Unknown requestId.",
    );
    const sent = events.find((r) => r.kind === "sent_message");
    const inputs = sent
      ? this.journal.rows.filter(
          (r) =>
            r.kind === "message" &&
            r.account === "bot" &&
            r.direction === "input" &&
            sameInput(r, sent),
        )
      : [];
    return {
      requestId,
      sendStatus: events.some((r) => r.kind === "send_acknowledged") ? "acknowledged" : "unknown",
      botInput: inputs.length === 1 ? inputs[0] : null,
      ambiguousInputs: inputs.length > 1,
      events,
      cursor: this.journal.cursor,
    };
  }
  async read({ after = 0, limit = 100, chat, waitMs = 0 } = {}) {
    requireValue(
      Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 60000,
      "waitMs must be between 0 and 60000.",
    );
    const route = chat === undefined ? undefined : routeFor(this.config, chat);
    const first = this.journal.read(after, limit, route);
    if (first.events.length || !waitMs) return first;
    requireValue(
      Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 60000,
      "waitMs must be between 0 and 60000.",
    );
    await new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        this.journal.off("append", changed);
        done();
      };
      const changed = () => {
        if (this.journal.read(after, limit, route).events.length) finish();
      };
      const timer = setTimeout(finish, waitMs);
      this.journal.on("append", changed);
    });
    return this.journal.read(after, limit, route);
  }
  async trace({ requestId, runId, after = 0, limit = 200 } = {}) {
    requireValue(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(limit) &&
        limit > 0 &&
        limit <= 1000,
      "Invalid trace cursor or limit.",
    );
    requireValue(Boolean(requestId) !== Boolean(runId), "Specify requestId or runId.");
    let receipt;
    if (requestId) {
      receipt = this.receipt(requestId);
      if (!receipt.botInput) return { receipt, runs: [], pending: true };
    } else requireValue(uuid.test(runId ?? ""), "Invalid Run ID.");
    const db = openReadOnlyDatabase(join(this.config.runtime.dataDirectory, "glassbox.db"));
    try {
      let runs;
      if (receipt) {
        const b = receipt.botInput;
        const scope = JSON.stringify([
          this.config.runtime.connectionId,
          this.config.bot.qq,
          b.route === "private" ? "private" : "group",
          b.route === "private" ? this.config.driver.qq : b.route,
          this.config.driver.qq,
          this.config.runtime.threadId ?? null,
        ]);
        runs = db
          .prepare(
            "SELECT r.id,r.status,r.failure_code,r.created_at,r.result_text,r.scope_json FROM runs r JOIN messages m ON m.id=r.message_id WHERE m.external_id=? AND m.scope_key=?",
          )
          .all(b.messageId, scope);
      } else
        runs = db
          .prepare(
            "SELECT id,status,failure_code,created_at,result_text,scope_json FROM runs WHERE id=?",
          )
          .all(runId);
      for (const run of runs) {
        const scope = JSON.parse(run.scope_json);
        requireValue(
          scope.connectionId === this.config.runtime.connectionId &&
            scope.botId === this.config.bot.qq &&
            scope.senderId === this.config.driver.qq &&
            ((scope.chatType === "private" && scope.chatId === this.config.driver.qq) ||
              (scope.chatType === "group" &&
                this.config.groups.some((g) => g.id === scope.chatId))),
          "Run is outside the configured Owner test chats.",
        );
        delete run.scope_json;
        const file = join(this.config.runtime.dataDirectory, "runs", run.id, "trace.jsonl");
        let rows = [];
        if (existsSync(file)) {
          const text = readFileSync(file, "utf8");
          const lines = text.split("\n");
          if (lines.at(-1)) lines.pop();
          rows = lines.filter(Boolean).map(JSON.parse);
        }
        run.tracePath = file;
        run.events = rows.filter((r) => r.seq > after).slice(0, limit);
        run.cursor = run.events.at(-1)?.seq ?? after;
        run.more = rows.some((r) => r.seq > run.cursor);
        run.deliveries = db
          .prepare("SELECT id,status,external_id,payload_kind FROM deliveries WHERE run_id=?")
          .all(run.id);
        for (const delivery of run.deliveries) {
          if (delivery.status !== "sent" || !messageId(delivery.external_id)) continue;
          try {
            const bot = this.clients.bot;
            bot.allowMessageRead(delivery.external_id);
            const message = await bot.call("get_msg", { message_id: delivery.external_id });
            const route = scope.chatType === "private" ? "private" : scope.chatId;
            const actual = this.journal.rows.filter(
              (r) =>
                r.kind === "message" &&
                r.account === "driver" &&
                r.direction === "reply" &&
                r.route === route &&
                r.realSequence === message.real_seq &&
                r.text === textOf(message.message) &&
                Math.abs(r.time - message.time) <= 2,
            );
            delivery.receivedByOwner = actual.length === 1;
            if (actual.length === 1) delivery.reply = actual[0];
          } catch (error) {
            delivery.observationError = safeFailure(error);
          }
        }
      }
      return {
        ...(receipt ? { receipt } : {}),
        runs,
        pending: runs.length === 0,
        ambiguousRuns: runs.length > 1,
      };
    } finally {
      db.close();
    }
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    clearInterval(this.timer);
    for (const client of Object.values(this.clients)) client.close();
    this.journal.append({ kind: "observer_stopped", pid: process.pid });
  }
}
