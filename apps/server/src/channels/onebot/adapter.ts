import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
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
import {
  historyCursor,
  normalizeOneBotHistoryRecord,
  type OneBotHistoryMessage,
} from "./history.ts";
import { GROUP_SCOPED_NAPCAT_ACTIONS, isAllowedNapCatAction } from "./capabilities.ts";
import { normalizeQqNativeGroupRole, type QqNativeGroupRole } from "./group-role.js";

const GROUP_SCOPED_ACTIONS = new Set(GROUP_SCOPED_NAPCAT_ACTIONS);

/**
 * The failure half of every narrow provider read, shared by history and group info.
 *
 * `failed` is a refusal or a provider-side rejection; `unknown` is a read whose outcome was
 * never observed. The distinction is what lets a caller report "unavailable" instead of
 * inventing a value: neither variant is evidence about the group's data.
 */
export type OneBotReadFailure =
  | {
      status: "failed";
      code: "invalid_group" | "not_connected" | "request_limit" | "api_rejected";
      retcode?: number;
    }
  | {
      status: "unknown";
      code: "timeout" | "disconnected" | "send_error" | "invalid_response" | "async_response";
    };

export type OneBotHistoryResult =
  | {
      status: "ok";
      messages: OneBotHistoryMessage[];
      /**
       * The provider short message id to pass back as `message_seq` to read the next older page.
       * Absent when the page carried no usable cursor, which is the caller's signal that
       * paging cannot advance and the walk must stop rather than repeat this page.
       */
      nextCursor?: string;
    }
  | OneBotReadFailure;

export type OneBotGroupInfoResult =
  | {
      status: "ok";
      groupId: string;
      /** The provider-reported group name, or `null` when it reported no usable one. */
      name: string | null;
    }
  | OneBotReadFailure;

export type OneBotGroupMemberRoleResult =
  | {
      status: "ok";
      groupId: string;
      userId: string;
      role: QqNativeGroupRole;
    }
  | OneBotReadFailure;

export type OneBotCapabilityResult =
  | { status: "ok"; data: unknown }
  | { status: "rejected"; code: "action_not_allowlisted" | "group_not_configured" }
  | { status: "failed"; code: "not_connected" | "request_limit" | "api_rejected"; retcode?: number }
  | {
      status: "unknown";
      code: "timeout" | "disconnected" | "send_error" | "invalid_response" | "async_response";
    };

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

/** Payload-free group ingress status for a bounded, Owner-authorized diagnostic projection. */
export interface OneBotIngressDiagnostic {
  groupId: string;
  stage: "normalized" | "ignored";
  reason?: "not_addressed" | "empty_message";
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

/**
 * Maps an RPC failure onto the read result shape. `invalid_target` / `invalid_message` are
 * delivery-specific and cannot occur for a read, so they surface as an unreadable provider
 * response rather than being passed through.
 */
function toReadFailure(result: Exclude<RpcResult, { status: "ok" }>): OneBotReadFailure {
  if (result.status === "unknown") return result;
  if (result.code === "invalid_target" || result.code === "invalid_message")
    return { status: "unknown", code: "invalid_response" };
  return {
    status: "failed",
    code: result.code,
    ...(result.retcode !== undefined ? { retcode: result.retcode } : {}),
  };
}

interface PendingRequest {
  resolve: (result: RpcResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  socket: WebSocket;
}

const QQ_DIRECT_TEXT_LIMIT = 3_500;
const QQ_PNG_MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isBoundedPngBase64(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > Math.ceil(QQ_PNG_MAX_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return false;
  const bytes = Buffer.from(value, "base64");
  return (
    bytes.length <= QQ_PNG_MAX_BYTES &&
    bytes.length >= 24 &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    bytes.readUInt32BE(8) === 13 &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.toString("base64") === value
  );
}
const QQ_FORWARD_NODE_LIMIT = 1_800;
const ONE_BOT_HISTORY_PAGE_LIMIT = 100;

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
    groupId?: string;
  }) => void;
  /** Receives only a configured group id and fixed status codes, never message or member data. */
  onIngressDiagnostic?: (diagnostic: OneBotIngressDiagnostic) => void;
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
    });
    return result.status === "ok" && qqId(object(result.data)?.group_id) === groupId;
  }

  /**
   * Reads real group history through the existing authenticated OneBot connection.
   *
   * `groupId` must be in the configured strict allowlist: this bridge can never be used
   * to read an arbitrary group. NapCat remains the runtime; Glassbox only normalizes the
   * page and never returns raw provider payloads.
   */
  async getGroupHistory(input: {
    groupId: string;
    count?: number;
    cursor?: string;
  }): Promise<OneBotHistoryResult> {
    const parsed = parseOneBotConfig({ ...this.config, groupIds: [input.groupId] });
    const groupId = parsed.groupIds[0];
    // Reject before any RPC when the group is not configured.
    if (groupId !== input.groupId || !this.config.groupIds.includes(input.groupId))
      return { status: "failed", code: "invalid_group" };
    const socket = this.#socket;
    if (this.#state.status !== "ready" || !socket)
      return { status: "failed", code: "not_connected" };
    const count = Math.max(
      1,
      Math.min(input.count ?? ONE_BOT_HISTORY_PAGE_LIMIT, ONE_BOT_HISTORY_PAGE_LIMIT),
    );
    const cursor = input.cursor === undefined ? undefined : messageId(input.cursor);
    if (input.cursor !== undefined && cursor === undefined)
      return { status: "failed", code: "invalid_group" };
    const result = await this.#request(socket, "get_group_msg_history", {
      group_id: Number(groupId),
      count,
      ...(cursor !== undefined ? { message_seq: Number(cursor), reverse_order: true } : {}),
    });
    if (result.status !== "ok") return toReadFailure(result);
    const raw = object(result.data)?.messages;
    if (!Array.isArray(raw)) return { status: "unknown", code: "invalid_response" };
    const messages: OneBotHistoryMessage[] = [];
    let oldestCursor: { id: string; occurredAt: string } | undefined;
    for (const record of raw) {
      const candidate = historyCursor(record);
      if (
        candidate !== undefined &&
        (oldestCursor === undefined || candidate.occurredAt < oldestCursor.occurredAt)
      )
        oldestCursor = candidate;
      const normalized = normalizeOneBotHistoryRecord(record, groupId, this.config.botId);
      if (normalized) messages.push(normalized);
    }
    messages.sort((a, b) =>
      a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
    );
    // The oldest record on this page is the cursor for the next older page. Deriving it from
    // raw records means an attachment-only page still advances instead of stalling the walk.
    return {
      status: "ok",
      messages,
      ...(oldestCursor === undefined ? {} : { nextCursor: oldestCursor.id }),
    };
  }

  /**
   * Reads one managed group's live metadata through the existing authenticated connection.
   *
   * This is the only provider read the Owner inventory performs, and it is deliberately narrow:
   * `groupId` must be in the configured strict allowlist, so the bridge can never be used to
   * probe a group Glassbox did not configure. The response is reduced to the one fact Glassbox
   * does not own — the group's name — and a provider that reports no usable name yields `null`
   * rather than an empty string. A provider that answered for this group is by construction
   * able to reach it, which is what the caller records as reachability.
   */
  async getGroupInfo(input: { groupId: string }): Promise<OneBotGroupInfoResult> {
    const parsed = parseOneBotConfig({ ...this.config, groupIds: [input.groupId] });
    const groupId = parsed.groupIds[0];
    if (groupId !== input.groupId || !this.config.groupIds.includes(input.groupId))
      return { status: "failed", code: "invalid_group" };
    const socket = this.#socket;
    if (this.#state.status !== "ready" || !socket)
      return { status: "failed", code: "not_connected" };
    const result = await this.#request(socket, "get_group_info", { group_id: Number(groupId) });
    if (result.status !== "ok") return toReadFailure(result);
    const data = object(result.data);
    // A reply about a different group is not evidence about this one.
    if (!data || qqId(data.group_id) !== groupId)
      return { status: "unknown", code: "invalid_response" };
    const name = typeof data.group_name === "string" ? data.group_name.trim() : "";
    return { status: "ok", groupId, name: name === "" ? null : name };
  }

  /**
   * Re-reads one member's current QQ-native role immediately before a protected mutation.
   *
   * The target group must be configured, the authenticated socket must be ready, and the
   * response must identify the same group and member. Only the normalized role leaves the
   * adapter. Profile fields and the raw provider payload never enter model-visible Context.
   */
  async getGroupMemberRole(input: {
    groupId: string;
    userId: string;
  }): Promise<OneBotGroupMemberRoleResult> {
    const parsed = parseOneBotConfig({ ...this.config, groupIds: [input.groupId] });
    const groupId = parsed.groupIds[0];
    const userId = qqId(input.userId);
    if (
      groupId !== input.groupId ||
      !this.config.groupIds.includes(input.groupId) ||
      userId !== input.userId
    )
      return { status: "failed", code: "invalid_group" };
    const socket = this.#socket;
    if (this.#state.status !== "ready" || !socket)
      return { status: "failed", code: "not_connected" };
    const result = await this.#request(socket, "get_group_member_info", {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: true,
    });
    if (result.status !== "ok") return toReadFailure(result);
    const data = object(result.data);
    if (
      !data ||
      qqId(data.group_id) !== groupId ||
      qqId(data.user_id) !== userId ||
      (data.role !== "owner" && data.role !== "admin" && data.role !== "member")
    )
      return { status: "unknown", code: "invalid_response" };
    return { status: "ok", groupId, userId, role: normalizeQqNativeGroupRole(data.role) };
  }

  /**
   * The only outbound provider path a capability Tool may reach.
   *
   * This is deliberately not a generic RPC bridge. The action must be in the registry's
   * allowlist, and a group-scoped action must name a group in the configured allowlist.
   * Credential, packet, transport, restart and raw-send primitives are absent from that
   * allowlist, so they are unreachable from model-visible Context even by name.
   */
  async invokeCapability(input: {
    action: string;
    params: Record<string, string | number | boolean>;
  }): Promise<OneBotCapabilityResult> {
    if (!isAllowedNapCatAction(input.action))
      return { status: "rejected", code: "action_not_allowlisted" };
    const params = { ...input.params };
    if ("group_id" in params) {
      const groupId = String(params.group_id);
      if (!this.config.groupIds.includes(groupId))
        return { status: "rejected", code: "group_not_configured" };
    } else if (GROUP_SCOPED_ACTIONS.has(input.action)) {
      // A group action that names no group would otherwise run against the runtime's
      // default target, which Glassbox never chose.
      return { status: "rejected", code: "group_not_configured" };
    }
    const socket = this.#socket;
    if (this.#state.status !== "ready" || !socket)
      return { status: "failed", code: "not_connected" };
    const result = await this.#request(socket, input.action, params);
    if (result.status === "ok") return { status: "ok", data: result.data };
    if (result.status === "unknown") return result;
    if (result.code === "invalid_target" || result.code === "invalid_message")
      return { status: "unknown", code: "invalid_response" };
    return {
      status: "failed",
      code: result.code,
      ...(result.retcode !== undefined ? { retcode: result.retcode } : {}),
    };
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
    image?: { pngBase64: string };
  }): Promise<OneBotDeliveryResult> {
    const target = input.target;
    if (!target) return { status: "failed", code: "invalid_target" };
    const isOwnerTarget =
      target.senderId === this.config.ownerId ||
      (this.config.coOwnerId !== undefined && target.senderId === this.config.coOwnerId);
    const isConfiguredPrivateTarget =
      isOwnerTarget || this.config.visitorIds.includes(target.senderId);
    if (
      target.connectionId !== this.config.connectionId ||
      target.botId !== this.config.botId ||
      target.threadId !== undefined ||
      (target.chatType === "private"
        ? target.chatId !== target.senderId || !isConfiguredPrivateTarget
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
      (input.replyTo !== undefined && replyTo === undefined) ||
      (input.image !== undefined &&
        (!isBoundedPngBase64(input.image.pngBase64) ||
          Array.from(input.text).length > QQ_DIRECT_TEXT_LIMIT))
    )
      return { status: "failed", code: "invalid_message" };
    const socket = this.#socket;
    if (this.#state.status !== "ready" || !socket)
      return { status: "failed", code: "not_connected" };
    if (Array.from(input.text).length > QQ_DIRECT_TEXT_LIMIT) {
      const messages = splitForwardText(input.text).map((text, index) => ({
        type: "node",
        data: {
          user_id: Number(this.config.botId),
          nickname: this.config.label.slice(0, 64),
          content: [
            ...(target.chatType === "group" && index === 0
              ? [{ type: "at", data: { qq: Number(target.senderId) } }]
              : []),
            { type: "text", data: { text } },
          ],
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
      ...(target.chatType === "group"
        ? [{ type: "at", data: { qq: Number(target.senderId) } }]
        : []),
      { type: "text", data: { text: input.text } },
      ...(input.image === undefined
        ? []
        : [{ type: "image", data: { file: `base64://${input.image.pngBase64}` } }]),
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

  #ingressDiagnostic(diagnostic: OneBotIngressDiagnostic): void {
    if (!this.config.groupIds.includes(diagnostic.groupId)) return;
    try {
      this.#options.onIngressDiagnostic?.(diagnostic);
    } catch {
      /* Diagnostics cannot affect message acceptance. */
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
        ...(normalized.groupId !== undefined && { groupId: normalized.groupId }),
      });
      return;
    }
    if (normalized.kind === "ignored") {
      if (normalized.diagnostic)
        this.#ingressDiagnostic({
          groupId: normalized.diagnostic.groupId,
          stage: "ignored",
          reason: normalized.diagnostic.reason,
        });
      return;
    }
    if (this.#state.status === "verifying") {
      if (this.#beforeVerification.length < this.#incomingLimit)
        this.#beforeVerification.push(normalized.message);
      else {
        this.#ingressError({
          code: "ingress_overflow",
          messageId: normalized.message.messageId,
          ...(normalized.message.scope.chatType === "group"
            ? { groupId: normalized.message.scope.chatId }
            : {}),
        });
        socket.terminate();
      }
      return;
    }
    this.#enqueue(normalized.message, socket, generation);
  }

  #enqueue(message: OneBotIncomingMessage, socket: WebSocket, generation: number): void {
    if (message.scope.chatType === "group")
      this.#ingressDiagnostic({ groupId: message.scope.chatId, stage: "normalized" });
    if (this.#incomingCount >= this.#incomingLimit) {
      this.#ingressError({
        code: "ingress_overflow",
        messageId: message.messageId,
        ...(message.scope.chatType === "group" ? { groupId: message.scope.chatId } : {}),
      });
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
            ...(message.scope.chatType === "group" ? { groupId: message.scope.chatId } : {}),
          });
        }
      })
      .finally(() => {
        this.#incomingCount--;
      });
  }
}
