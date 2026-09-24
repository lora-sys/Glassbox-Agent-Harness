import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { ModelProfileStore } from "../config/model-profiles.js";
import type {
  ExecutionInput,
  ExecutionResult,
  RunExecutionAdapter,
} from "../execution/run-service/types.js";
import {
  qqCapabilitiesForCategory,
  type QqCapabilityCategory,
} from "../channels/onebot/capabilities.js";
import { ManagementApplication } from "./application.js";
import type { ToolDescriptor, ToolExclusionReason } from "../runtime/pi/tool-plane.js";

class Inbox<T> {
  private items: T[] = [];
  private waiters: Array<{ match: (value: T) => boolean; resolve: (value: T) => void }> = [];
  put(item: T) {
    const index = this.waiters.findIndex((waiter) => waiter.match(item));
    if (index < 0) this.items.push(item);
    else this.waiters.splice(index, 1)[0]!.resolve(item);
  }
  take(match: (value: T) => boolean = () => true): Promise<T> {
    const index = this.items.findIndex(match);
    if (index >= 0) return Promise.resolve(this.items.splice(index, 1)[0]!);
    return new Promise((resolve) => this.waiters.push({ match, resolve }));
  }
}
export interface Action {
  action: string;
  echo: string;
  params: {
    group_id?: number;
    user_id?: number;
    message_seq?: number;
    no_cache?: boolean;
    message?: Array<{ data: { text: string } }>;
  };
}

export type OwnerContext = {
  caller: ExecutionInput["caller"];
  conversationId: string;
  runId: string;
};
export interface ManagedGroupProjection {
  connectionId: string;
  groups: Array<{
    groupId: string;
    /** The live provider name, or `null` when it was not observed. */
    name: string | null;
    /** The live provider reachability, or `null` when it was not observed. */
    reachable: boolean | null;
    /**
     * `true` when the provider proved the Bot is in this exact group; `null` when it did not.
     * Never `false`: this read path cannot prove absence of membership.
     */
    botMembership: boolean | null;
    access: {
      /** The acting Owner's own assignment of this group. Always `true` in the inventory. */
      assigned: boolean;
      grantedCategories: QqCapabilityCategory[];
      historyRead: boolean;
    };
    categories: Record<string, boolean>;
    memorySources: Record<string, boolean>;
    skills: { enabledSkills: string[]; version: number };
    version: number;
  }>;
}

/** One entry of the registry search, as `qq_capability_search` returns it. */
export interface CapabilitySearchEntry {
  tool: string;
  description: string;
  category: QqCapabilityCategory;
  readOnly: boolean;
  groupIds: string[];
}
export interface CapabilitySearchResult {
  query: string | null;
  groups: string[];
  capabilities: CapabilitySearchEntry[];
}

/**
 * The Owner-private management surface as the Owner Tools call it.
 *
 * The Tools themselves are covered by `owner-tools.test.ts`; these tests drive the durable
 * per-Owner behavior through the real `ManagementApplication` path.
 */
export const admin = (app: ManagementApplication) =>
  app as unknown as {
    setGroupAccess(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<{ groupId: string; enabled: boolean; enabledSkills: string[]; version: number }>;
    setGroupHistory(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<unknown>;
    setGroupCategory(
      context: OwnerContext,
      input: { groupId: string; category: QqCapabilityCategory; enabled: boolean },
    ): Promise<unknown>;
    setGroupSkill(
      context: OwnerContext,
      input: { groupId: string; skillName: string; enabled: boolean },
    ): Promise<unknown>;
    manageGroup(context: OwnerContext, input: { action: "get"; groupId: string }): Promise<unknown>;
    projectManagedGroups(context: OwnerContext): Promise<ManagedGroupProjection>;
    resolveRunToolNames(context: OwnerContext): Promise<string[]>;
    resolveRunToolCandidates(
      context: OwnerContext,
      registered?: readonly ToolDescriptor[],
    ): Promise<{ name: string; exclusion: ToolExclusionReason | null }[]>;
    createRuntimeTools(getContext: () => OwnerContext | undefined): Array<{
      name: string;
      execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ details?: unknown }>;
    }>;
  };

/** The mutation categories the fixed default bundle must never enable. */
export const MUTATION_CATEGORIES: readonly QqCapabilityCategory[] = [
  "group.files.write",
  "group.moderate",
  "group.settings",
  "message.manage",
];

/** The group-scoped Actions a set of categories confers on a group Resource. */
export const groupActions = (categories: readonly QqCapabilityCategory[]): string[] => [
  ...new Set(
    categories.flatMap((category) =>
      qqCapabilitiesForCategory(category)
        .filter(
          (capability) => capability.resource === "group" && capability.ownerPrivate !== false,
        )
        .map((capability) => capability.action),
    ),
  ),
];

/**
 * The group-Run surface as the real application computes and builds it.
 *
 * These tests drive `ManagementApplication` itself rather than the pure helpers, so they
 * prove the provisioning grants, the discovery candidate list and a real protected Tool call
 * all agree — which is the product path a helper-only test cannot cover.
 */
export const groupRun = (app: ManagementApplication) =>
  app as unknown as {
    setGroupAccess(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<unknown>;
    setGroupCategory(
      context: OwnerContext,
      input: { groupId: string; category: QqCapabilityCategory; enabled: boolean },
    ): Promise<unknown>;
    setGroupHistory(
      context: OwnerContext,
      input: { groupId: string; enabled: boolean },
    ): Promise<unknown>;
    resolveRunToolNames(context: OwnerContext): Promise<string[]>;
    resolveRunToolCandidates(
      context: OwnerContext,
      registered?: readonly ToolDescriptor[],
    ): Promise<{ name: string; exclusion: ToolExclusionReason | null }[]>;
    createRuntimeTools(getContext: () => OwnerContext | undefined): Array<{
      name: string;
      execute(id: string, params: unknown, signal?: AbortSignal): Promise<{ details?: unknown }>;
    }>;
  };

/** The read-only capability Tools a configured group Run may use, and the ones it never may. */
export const GROUP_RUN_READ_TOOLS = [
  "group_history_search",
  "qq_groups",
  "qq_group_members",
  "qq_group_history",
  "qq_group_content",
  "qq_group_files",
] as const;
export const GROUP_RUN_FORBIDDEN_TOOLS = [
  "qq_group_moderation",
  "qq_group_local_settings",
  "qq_group_settings",
  "qq_group_file_ops",
  "qq_capability_search",
  "qq_account_status",
] as const;

export function createApplicationFixtureScope() {
  const cleanup: Array<() => Promise<unknown>> = [];
  const afterEachCleanup = async () => {
    for (const close of cleanup.reverse()) await close();
    cleanup.length = 0;
  };

  /** libSQL can retain Windows file handles until the test process exits. */
  const removeDirectory = (directory: string) =>
    rm(directory, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
    });

  async function fixture(
    execute: (input: ExecutionInput) => Promise<ExecutionResult>,
    options: {
      /** Deterministic `get_group_msg_history` responder, paged by the requested `message_seq`. */
      history?: (params: { group_id?: number; message_seq?: number }) => Record<string, unknown>[];
      /** The `group_name` the peer reports for `get_group_info`; absent means "unreported". */
      groupName?: string;
      /** Second Owner identity, resolved to its own `owner-<id>` Principal. */
      coOwnerId?: string;
      /** File-backed database so a test can close and reopen the same durable state. */
      persistentDatabase?: boolean;
      /** Current provider role returned by the execution-time member lookup. */
      memberRole?: () => "owner" | "admin" | "member";
      /** One provider mutation to reject after caller authorization has passed. */
      failAction?: string;
      /** Applies provider-side state changes before the fake peer answers an action. */
      onAction?: (action: Action) => void;
    } = {},
  ) {
    const directory = await mkdtemp(join(tmpdir(), "glassbox-channel-loop-"));
    cleanup.push(() => removeDirectory(directory));
    const actions = new Inbox<Action>();
    const actionLog: Action[] = [];
    const sockets = new Inbox<WebSocket>();
    const calls: ExecutionInput[] = [];
    const started = new Inbox<ExecutionInput>();
    // How many `get_group_info` reads the peer has actually been asked for. Counted rather than
    // inferred from the reply, so a test can prove a projection issued *no* provider call.
    let groupInfoRequests = 0;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanup.push(async () => {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    // Flippable at runtime: enabling a managed group asks the peer for its metadata, so a test
    // that wants a *later* observation to fail must first let the earlier one succeed.
    let groupInfoFails = false;
    server.on("connection", (socket) => {
      sockets.put(socket);
      socket.on("message", (raw) => {
        const bytes = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        const action = JSON.parse(bytes.toString("utf8")) as Action;
        actionLog.push(action);
        actions.put(action);
        options.onAction?.(action);
        if (action.action === "get_group_info") groupInfoRequests += 1;
        // A rejected `get_group_info` is the peer's own failure reply: `status: "failed"` with a
        // non-zero `retcode`, which the adapter maps to a provider error rather than to data.
        const groupInfoFailed = action.action === "get_group_info" && groupInfoFails;
        const actionFailed = groupInfoFailed || action.action === options.failAction;
        socket.send(
          JSON.stringify({
            echo: action.echo,
            status: actionFailed ? "failed" : "ok",
            retcode: actionFailed ? 100 : 0,
            data: actionFailed
              ? null
              : action.action === "get_login_info"
                ? { user_id: 10001 }
                : action.action === "get_group_info"
                  ? {
                      group_id: action.params.group_id,
                      ...(options.groupName === undefined ? {} : { group_name: options.groupName }),
                    }
                  : action.action === "get_group_member_info"
                    ? {
                        group_id: action.params.group_id,
                        user_id: action.params.user_id,
                        role: options.memberRole?.() ?? "member",
                      }
                    : action.action === "get_group_msg_history"
                      ? { messages: options.history?.(action.params) ?? [] }
                      : { message_id: 20001 },
          }),
        );
      });
    });
    await once(server, "listening");
    const models = await ModelProfileStore.open(directory);
    const executors = new Map<string, RunExecutionAdapter>([
      [
        "claude-code",
        {
          supportsGroup: true,
          execute: async (input) => {
            calls.push(input);
            started.put(input);
            return execute(input);
          },
        },
      ],
    ]);
    const open = () =>
      ManagementApplication.open({
        dataDirectory: directory,
        databasePath: options.persistentDatabase ? join(directory, "glassbox.db") : ":memory:",
        kitPath: fileURLToPath(new URL("../runtime/pi/fixtures/lora-pi-kit", import.meta.url)),
        models,
        executors,
      });
    let app = await open();
    cleanup.push(() => app.close());
    const reopen = async () => {
      await app.close();
      app = await open();
      return app;
    };
    await app.saveChannel({
      id: "fixture",
      label: "Disposable QQ fixture",
      kind: "qq-onebot",
      endpoint: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`,
      botId: "10001",
      ownerId: "10002",
      ...(options.coOwnerId !== undefined ? { coOwnerId: options.coOwnerId } : {}),
      visitorIds: ["10004"],
      groupIds: ["10003"],
      token: "fixture-token",
      executionRef: "claude-code",
    });
    await app.connectChannel("fixture");
    const socket = await sockets.take();
    const send = (
      id: number,
      text: string,
      privateChat = false,
      senderId = 10002,
      groupId = 10003,
      role: "owner" | "admin" | "member" | null = "member",
    ) =>
      socket.send(
        JSON.stringify({
          post_type: "message",
          self_id: 10001,
          user_id: senderId,
          message_id: id,
          message_type: privateChat ? "private" : "group",
          sub_type: privateChat ? "friend" : "normal",
          group_id: groupId,
          anonymous: null,
          sender: role === null ? {} : { role },
          message: [
            ...(privateChat ? [] : [{ type: "at", data: { qq: "10001" } }]),
            { type: "text", data: { text } },
          ],
        }),
      );
    const reply = (text: string) =>
      actions.take(
        (action) => action.params.message?.some((part) => part.data.text === text) === true,
      );
    const setGroupInfoFails = (value: boolean) => {
      groupInfoFails = value;
    };
    return {
      app,
      calls,
      started,
      send,
      reply,
      actions,
      actionLog,
      reopen,
      setGroupInfoFails,
      groupInfoRequests: () => groupInfoRequests,
    };
  }

  return { fixture, afterEachCleanup, cleanup, removeDirectory };
}
