import { randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { TrustedChannelScope } from "../../identity/scope.js";
import {
  messageId,
  object,
  parseOneBotConfig,
  qqId,
  type OneBotConnectionConfig,
} from "./config.ts";
import { normalizeOneBotMessage, type OneBotIncomingMessage } from "./normalize.ts";

export interface OneBotState {
  status: "stopped" | "connecting" | "verifying" | "ready" | "reconnecting" | "faulted";
  reason?:
    | "connection_failed"
    | "disconnected"
    | "authentication_failed"
    | "identity_mismatch"
    | "identity_check_failed"
    | "invalid_frame"
    | "ingress_overflow";
}

export type OneBotDeliveryResult =
  | { status: "confirmed"; messageId: string }
  | {
      status: "failed";
      code:
        | "invalid_target"
        | "invalid_message"
        | "not_connected"
        | "request_limit"
        | "api_rejected";
      retcode?: number;
    }
  | {
      status: "unknown";
      code: "timeout" | "disconnected" | "send_error" | "invalid_response" | "async_response";
    };

type RpcResult =
  | { status: "ok"; data: unknown }
  | Exclude<OneBotDeliveryResult, { status: "confirmed" }>;

interface PendingRequest {
  resolve: (result: RpcResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  socket: WebSocket;
}

const QQ_DIRECT_TEXT_LIMIT = 3_500;
const QQ_FORWARD_NODE_LIMIT = 1_800;

function splitForwardText(text: string): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += QQ_FORWARD_NODE_LIMIT)
    chunks.push(characters.slice(offset, offset + QQ_FORWARD_NODE_LIMIT).join(""));
  return chunks;
}

export class OneBotConnectionError extends Error {
  constructor(readonly code: NonNullable<OneBotState["reason"]> | "stopped") {
    super(`OneBot connection ${code}`);
    this.name = "OneBotConnectionError";
  }
}

export interface OneBotAdapterOptions {
  config: OneBotConnectionConfig;
  token: string;
  /** Persist acceptance and enqueue intent here. Do not wait for model execution. */
  onIncoming: (message: OneBotIncomingMessage, signal: AbortSignal) => void | Promise<unknown>;
  onState?: (state: OneBotState) => void;
  onIngressError?: (error: {
    code: "invalid_message" | "unsupported_message" | "acceptance_failed" | "ingress_overflow";
    messageId?: string;
  }) => void;
  requestTimeoutMs?: number;
  reconnectDelayMs?: number;
  maxPendingIncoming?: number;
}

/** One authenticated combined forward WebSocket. Persistence and execution live above this adapter. */
export class OneBotAdapter {
  config: OneBotConnectionConfig;
  readonly capabilities = Object.freeze({
    groupMention: true,
    ownerPrivateChat: true,
    text: true,
    reply: true,
    attachments: false,
    proactive: true,
  });
  readonly #token: string;
  readonly #options: OneBotAdapterOptions;
  readonly #timeout: number;
  readonly #reconnectDelay: number;
  readonly #incomingLimit: number;
  #state: OneBotState = { status: "stopped" };
  #socket: WebSocket | undefined;
  #active = false;
  #generation = 0;
  #attempt: Promise<void> | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #retryCount = 0;
  #pending = new Map<string, PendingRequest>();
  #incomingQueue: Promise<void> = Promise.resolve();
  #beforeVerification: OneBotIncomingMessage[] = [];
  #incomingCount = 0;
  #incomingAbort = new AbortController();

  constructor(options: OneBotAdapterOptions) {
    this.config = parseOneBotConfig(options.config);
    if (typeof options.token !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(options.token))
      throw new Error("Configure an explicit OneBot access token");
    this.#token = options.token;
    this.#options = options;
    this.#timeout = options.requestTimeoutMs ?? 10_000;
    this.#reconnectDelay = options.reconnectDelayMs ?? 1_000;
    this.#incomingLimit = options.maxPendingIncoming ?? 64;
    if (
      !Number.isSafeInteger(this.#timeout) ||
      this.#timeout < 10 ||
      this.#timeout > 120_000 ||
      !Number.isSafeInteger(this.#reconnectDelay) ||
      this.#reconnectDelay < 10 ||
      this.#reconnectDelay > 30_000 ||
      !Number.isSafeInteger(this.#incomingLimit) ||
      this.#incomingLimit < 1 ||
      this.#incomingLimit > 256
    )
      throw new Error("Invalid OneBot connection limits");
  }

  get state(): OneBotState {
    return { ...this.#state };
  }

  setAllowedGroups(groupIds: readonly string[]): void {
    this.config = parseOneBotConfig({ ...this.config, groupIds: [...groupIds] });
  }

  async hasGroup(groupId: string): Promise<boolean> {
    const parsed = parseOneBotConfig({ ...this.config, groupIds: [groupId] });
    const socket = this.#socket;
    if (this.#state.status !== "ready" || !socket) throw new OneBotConnectionError("disconnected");
    const result = await this.#request(socket, "get_group_info", {
      group_id: Number(parsed.groupIds[0]),
      no_cache: true,
    });
    return result.status === "ok" && qqId(object(result.data)?.group_id) === groupId;
  }

  async start(): Promise<void> {
    if (this.#state.status === "ready") return;
    if (this.#attempt) return this.#attempt;
    this.#active = true;
    if (this.#incomingAbort.signal.aborted) this.#incomingAbort = new AbortController();
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    this.#attempt = this.#connect();
    try {
      await this.#attempt;
    } finally {
      this.#attempt = undefined;
    }
  }

  async stop(): Promise<void> {
    this.#active = false;
    this.#generation++;
    this.#incomingAbort.abort();
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
    const socket = this.#socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        socket.once("close", resolve);
        socket.terminate();
      });
    }
    this.#setState({ status: "stopped" });
  }

  async send(input: {
    deliveryId: string;
    target: TrustedChannelScope;
    text: string;
    replyTo?: string;
  }): Promise<OneBotDeliveryResult> {
    const target = input.target;
    if (
      !target ||
      target.connectionId !== this.config.connectionId ||
      target.botId !== this.config.botId ||
      (target.senderId !== this.config.ownerId &&
        !this.config.visitorIds.includes(target.senderId)) ||
      target.threadId !== undefined ||
      (target.chatType === "private"
        ? target.chatId !== target.senderId
        : target.chatType !== "group" || !this.config.groupIds.includes(target.chatId))
    )
      return { status: "failed", code: "invalid_target" };
    const replyTo = input.replyTo === undefined ? undefined : messageId(input.replyTo);
    if (
      typeof input.deliveryId !== "string" ||
      !input.deliveryId ||
      input.deliveryId.length > 128 ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 64_000 ||
      (input.replyTo !== undefined && replyTo === undefined)
    )
      return { status: "failed", code: "invalid_message" };
    const socket = this.#socket;
    if (this.#state.status !== "ready" || !socket)
      return { status: "failed", code: "not_connected" };
    if (Array.from(input.text).length > QQ_DIRECT_TEXT_LIMIT) {
      const messages = splitForwardText(input.text).map((text) => ({
        type: "node",
        data: {
          user_id: Number(this.config.botId),
          nickname: this.config.label.slice(0, 64),
          content: [{ type: "text", data: { text } }],
        },
      }));
      const result = await this.#request(
        socket,
        target.chatType === "private" ? "send_private_forward_msg" : "send_group_forward_msg",
        {
          ...(target.chatType === "private"
            ? { user_id: Number(target.chatId) }
            : { group_id: Number(target.chatId) }),
          messages,
        },
      );
      if (result.status !== "ok") return result;
      const sentId = messageId(object(result.data)?.message_id);
      const resourceId = object(result.data)?.res_id;
      if (sentId !== undefined) return { status: "confirmed", messageId: `forward:${sentId}` };
      return typeof resourceId === "string" && resourceId.length > 0 && resourceId.length <= 384
        ? { status: "confirmed", messageId: `forward-res:${resourceId}` }
        : { status: "unknown", code: "invalid_response" };
    }
    const message = [
      ...(replyTo === undefined ? [] : [{ type: "reply", data: { id: replyTo } }]),
      { type: "text", data: { text: input.text } },
    ];
    const result = await this.#request(
      socket,
      target.chatType === "private" ? "send_private_msg" : "send_group_msg",
      {
        ...(target.chatType === "private"
          ? { user_id: Number(target.chatId) }
          : { group_id: Number(target.chatId) }),
        message,
      },
    );
    if (result.status !== "ok") return result;
    const sentId = messageId(object(result.data)?.message_id);
    return sentId === undefined
      ? { status: "unknown", code: "invalid_response" }
      : { status: "confirmed", messageId: sentId };
  }

  #setState(state: OneBotState): void {
    this.#state = state;
    try {
      this.#options.onState?.({ ...state });
    } catch {
      /* Observers cannot change connection ownership. */
    }
  }

  #ingressError(error: Parameters<NonNullable<OneBotAdapterOptions["onIngressError"]>>[0]): void {
    try {
      this.#options.onIngressError?.(error);
    } catch {
      /* No message payload is included in diagnostics. */
    }
  }

  #connect(): Promise<void> {
    const generation = ++this.#generation;
    this.#beforeVerification = [];
    this.#setState({ status: "connecting" });
    const socket = new WebSocket(this.config.endpoint, {
      headers: { Authorization: `Bearer ${this.#token}` },
      followRedirects: false,
      handshakeTimeout: this.#timeout,
      maxPayload: 512 * 1024,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let reason: NonNullable<OneBotState["reason"]> = "disconnected";
      const rejectAttempt = (code: NonNullable<OneBotState["reason"]> | "stopped") => {
        if (!settled) {
          settled = true;
          reject(new OneBotConnectionError(code));
        }
      };
      const fault = (code: "authentication_failed" | "identity_mismatch") => {
        reason = code;
        this.#active = false;
        this.#setState({ status: "faulted", reason: code });
        rejectAttempt(code);
        socket.terminate();
      };
      socket.on("unexpected-response", (_request, response) => {
        const denied = response.statusCode === 401 || response.statusCode === 403;
        response.destroy();
        if (denied) fault("authentication_failed");
        else {
          reason = "connection_failed";
          rejectAttempt(reason);
          socket.terminate();
        }
      });
      socket.on("error", () => {
        reason = reason === "disconnected" ? "connection_failed" : reason;
      });
      socket.on("message", (data, isBinary) => {
        if (socket !== this.#socket) return;
        if (isBinary) {
          reason = "invalid_frame";
          socket.terminate();
          return;
        }
        this.#receive(socket, data, generation);
      });
      socket.on("close", () => {
        for (const [echo, pending] of this.#pending)
          if (pending.socket === socket)
            this.#settle(echo, { status: "unknown", code: "disconnected" });
        if (socket !== this.#socket) return;
        this.#socket = undefined;
        this.#beforeVerification = [];
        if (this.#heartbeat) {
          clearInterval(this.#heartbeat);
          this.#heartbeat = undefined;
        }
        rejectAttempt(this.#active ? reason : "stopped");
        if (this.#active) {
          this.#setState({ status: "reconnecting", reason });
          const delay = Math.min(
            30_000,
            this.#reconnectDelay * 2 ** Math.min(this.#retryCount++, 6),
          );
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            if (this.#active) void this.start().catch(() => {});
          }, delay);
        }
      });
      socket.once("open", () => {
        if (!this.#active || this.#generation !== generation) {
          socket.terminate();
          return;
        }
        this.#setState({ status: "verifying" });
        void this.#request(socket, "get_login_info", {}).then((result) => {
          if (!this.#active || socket !== this.#socket) return;
          if (result.status !== "ok") {
            reason = "identity_check_failed";
            rejectAttempt(reason);
            socket.terminate();
            return;
          }
          if (qqId(object(result.data)?.user_id) !== this.config.botId) {
            fault("identity_mismatch");
            return;
          }
          this.#retryCount = 0;
          this.#setState({ status: "ready" });
          for (const message of this.#beforeVerification)
            this.#enqueue(message, socket, generation);
          this.#beforeVerification = [];
          let alive = true;
          socket.on("pong", () => {
            alive = true;
          });
          this.#heartbeat = setInterval(() => {
            if (!alive) {
              socket.terminate();
              return;
            }
            alive = false;
            socket.ping();
          }, 15_000);
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });
    });
  }

  #request(socket: WebSocket, action: string, params: Record<string, unknown>): Promise<RpcResult> {
    if (socket !== this.#socket || socket.readyState !== WebSocket.OPEN)
      return Promise.resolve({ status: "failed", code: "not_connected" });
    if (this.#pending.size >= 64)
      return Promise.resolve({ status: "failed", code: "request_limit" });
    const echo = randomUUID();
    return new Promise<RpcResult>((resolve) => {
      const timeout = setTimeout(
        () => this.#settle(echo, { status: "unknown", code: "timeout" }),
        this.#timeout,
      );
      this.#pending.set(echo, { resolve, timeout, socket });
      // Once a write is attempted, a transport error does not prove non-delivery.
      try {
        socket.send(JSON.stringify({ action, params, echo }), (error) => {
          if (error) this.#settle(echo, { status: "unknown", code: "send_error" });
        });
      } catch {
        this.#settle(echo, { status: "unknown", code: "send_error" });
      }
    });
  }

  #settle(echo: string, result: RpcResult): void {
    const pending = this.#pending.get(echo);
    if (!pending) return;
    this.#pending.delete(echo);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }

  #receive(socket: WebSocket, raw: RawData, generation: number): void {
    let payload: unknown;
    try {
      const bytes = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : raw;
      if (bytes.byteLength > 512 * 1024) throw new Error("Frame limit");
      payload = JSON.parse(bytes.toString("utf8"));
    } catch {
      this.#setState({ status: "reconnecting", reason: "invalid_frame" });
      socket.terminate();
      return;
    }
    const record = object(payload);
    if (!record) return;
    if (typeof record.echo === "string") {
      const pending = this.#pending.get(record.echo);
      if (!pending || pending.socket !== socket) return;
      if (record.status === "ok" && record.retcode === 0)
        this.#settle(record.echo, { status: "ok", data: record.data });
      else if (
        record.status === "failed" &&
        Number.isSafeInteger(record.retcode) &&
        record.retcode !== 0
      )
        this.#settle(record.echo, {
          status: "failed",
          code: "api_rejected",
          retcode: record.retcode as number,
        });
      else
        this.#settle(record.echo, {
          status: "unknown",
          code: record.status === "async" ? "async_response" : "invalid_response",
        });
      return;
    }
    if (this.#state.status !== "ready" && this.#state.status !== "verifying") return;
    const normalized = normalizeOneBotMessage(record, this.config);
    if (normalized.kind === "rejected") {
      this.#ingressError({
        code: normalized.code,
        ...(normalized.messageId !== undefined && { messageId: normalized.messageId }),
      });
      return;
    }
    if (normalized.kind !== "message") return;
    if (this.#state.status === "verifying") {
      if (this.#beforeVerification.length < this.#incomingLimit)
        this.#beforeVerification.push(normalized.message);
      else {
        this.#ingressError({ code: "ingress_overflow", messageId: normalized.message.messageId });
        socket.terminate();
      }
      return;
    }
    this.#enqueue(normalized.message, socket, generation);
  }

  #enqueue(message: OneBotIncomingMessage, socket: WebSocket, generation: number): void {
    if (this.#incomingCount >= this.#incomingLimit) {
      this.#ingressError({ code: "ingress_overflow", messageId: message.messageId });
      this.#setState({ status: "reconnecting", reason: "ingress_overflow" });
      socket.terminate();
      return;
    }
    this.#incomingCount++;
    const signal = this.#incomingAbort.signal;
    this.#incomingQueue = this.#incomingQueue
      .then(async () => {
        if (!this.#active || signal.aborted || generation !== this.#generation) return;
        try {
          await this.#options.onIncoming(message, signal);
        } catch {
          this.#ingressError({
            code: "acceptance_failed",
            messageId: message.messageId,
          });
        }
      })
      .finally(() => {
        this.#incomingCount--;
      });
  }
}
