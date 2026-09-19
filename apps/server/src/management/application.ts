import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { CHANNEL_SAFE_ERRORS, type PublicChannelProfile } from "@glassbox/contracts";
import { ChannelProfileStore, ChannelConfigurationError } from "../config/channel-profiles.js";
import { GroupRuntimeStore } from "../config/group-runtime.js";
import type { ModelProfileStore } from "../config/model-profiles.js";
import { ExecutorConfiguration, ExecutorBusyError } from "../config/executors.js";
import {
  OneBotAdapter,
  OneBotConnectionError,
  type OneBotState,
} from "../channels/onebot/index.js";
import {
  RunService,
  type RunExecutionAdapter,
  type RunServiceEvent,
} from "../execution/run-service/index.js";
import { configuredModelAdapter } from "../execution/model-adapter.js";
import {
  KitLoader,
  piProfileName,
  PiRunExecutionAdapter,
  PiSdkRuntimeAdapter,
} from "../runtime/pi/index.js";
import { configuredPiModel } from "../runtime/pi/configured-model.js";
import { createOpsTools, OPS_TOOL_NAMES, type WorkerTarget } from "../runtime/pi/ops-tools.js";
import {
  createOwnerTools,
  type OwnerGroupAdminInput,
  OWNER_CONTROL_RESOURCE,
  OWNER_GROUP_ADMIN_TOOL,
} from "../runtime/pi/owner-tools.js";
import {
  createSkillTools,
  SKILL_CATALOG_RESOURCE,
  SKILL_READ_ACTION,
  SKILL_READ_TOOL,
} from "../runtime/pi/skill-tools.js";
import type { ProtectedToolContext } from "../runtime/pi/protected-tools.js";
import { AuthorizedOpsService, type WorkerPolicy } from "../ops/service.js";
import { OpsReconciler } from "../ops/reconciler.js";
import type { HerdrBridge } from "../ops/herdr-bridge.js";
import {
  openDomainStore,
  agentResourceId,
  type DomainStore,
  type TrustedChannelScope,
  type CallerContext,
} from "../persistence/index.js";
import { RunTraceStore } from "../trace/run-store.js";
import { createRunEvaluator, RunEvalError } from "../eval/index.js";
import { ManagementError } from "./access.js";
import { readManagementJson } from "./http.js";
import { grantOpsPermissions } from "./ops-grants.js";
import { createQqDeliveryPolicy, hostDeliveryForbiddenValues } from "../delivery/content-policy.js";

const OWNER_ID = "owner";
const AGENT_ID = "personal";
const ACTIONS = [
  "run:create",
  "run:control",
  "delivery:send",
  "conversation:read",
  "trace:write",
  "eval:write",
] as const;
const TOOL_DISCOVERY_ACTION = "tool:discover";
const toolResourceId = (name: string) => `tool:${name}`;

function idFromInput(input: unknown): string {
  if (
    !input ||
    typeof input !== "object" ||
    !("id" in input) ||
    typeof input.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(input.id)
  ) {
    throw new ManagementError("INVALID_REQUEST", "A valid configuration identifier is required");
  }
  return input.id;
}

/** Service composition. Only management HTTP handlers receive this object.
 * Incoming QQ messages receive RunService's scoped ingress API instead. */
export class ManagementApplication {
  readonly store: DomainStore;
  readonly channels: ChannelProfileStore;
  readonly groupRuntime: GroupRuntimeStore;
  readonly runs: RunService;
  readonly trace: RunTraceStore;
  readonly evaluator: ReturnType<typeof createRunEvaluator>;
  executors!: ExecutorConfiguration;
  private readonly connections = new Map<string, OneBotAdapter>();
  private readonly deliveryPolicy: ReturnType<typeof createQqDeliveryPolicy>;
  private readonly kitLoader: KitLoader;
  private readonly states = new Map<
    string,
    Pick<PublicChannelProfile, "connectionState" | "lastError">
  >();
  private operations: Promise<unknown> = Promise.resolve();
  private accepting = false;
  private releaseIngress!: () => void;
  private readonly ingressReady = new Promise<void>((resolve) => {
    this.releaseIngress = resolve;
  });

  private constructor(
    private readonly options: {
      dataDirectory: string;
      kitPath?: string;
      models: ModelProfileStore;
      executors?: ReadonlyMap<string, RunExecutionAdapter>;
      ops?: {
        bridge: HerdrBridge;
        workerTarget: WorkerTarget;
        workerPolicy?: WorkerPolicy;
        protectedValues?: readonly string[];
      };
    },
    store: DomainStore,
    channels: ChannelProfileStore,
    groupRuntime: GroupRuntimeStore,
  ) {
    this.store = store;
    this.channels = channels;
    this.groupRuntime = groupRuntime;
    this.kitLoader = new KitLoader(options.kitPath);
    this.deliveryPolicy = createQqDeliveryPolicy({
      forbiddenValues: () => [
        ...hostDeliveryForbiddenValues({
          dataDirectory: options.dataDirectory,
          kitPath: process.env.LORA_PI_KIT_PATH,
          cwd: process.cwd(),
          modelValues: [
            ...options.models.list().flatMap((profile) => [profile.id, profile.baseUrl]),
            ...(options.ops
              ? [
                  ...(options.ops.protectedValues ?? []),
                  options.ops.workerTarget.workspaceId,
                  options.ops.workerTarget.agentKind,
                  options.ops.workerTarget.worktreePath,
                  options.ops.workerTarget.branch,
                ].filter((value): value is string => typeof value === "string")
              : []),
          ],
        }),
      ],
      protectedValues: () => [...options.models.protectedValues(), ...channels.protectedValues()],
    });
    this.trace = new RunTraceStore({
      dataDirectory: options.dataDirectory,
      maxEventBytes: 128 * 1024,
    });
    this.evaluator = createRunEvaluator({ store, trace: this.trace });
    this.runs = new RunService({
      store,
      resolveExecution: (reference) => this.execution(reference),
      transport: {
        send: async ({ destination, delivery, signal }) => {
          if (signal.aborted) return { status: "failed" };
          const connection = this.connections.get(destination.connectionId);
          if (!connection) return { status: "failed" };
          const result = await connection.send({
            deliveryId: delivery.id,
            target: destination,
            text: delivery.payloadText,
          });
          return result.status === "confirmed"
            ? { status: "sent", externalId: result.messageId }
            : { status: result.status };
        },
      },
      onEvent: (event) => this.recordEvent(event),
      prepareDelivery: async (candidate) => this.deliveryPolicy.prepare(candidate),
    });
  }

  static async open(options: {
    dataDirectory: string;
    databasePath?: string;
    kitPath?: string;
    models: ModelProfileStore;
    executors?: ReadonlyMap<string, RunExecutionAdapter>;
    ops?: {
      bridge: HerdrBridge;
      workerTarget: WorkerTarget;
      workerPolicy?: WorkerPolicy;
      protectedValues?: readonly string[];
    };
  }): Promise<ManagementApplication> {
    const channels = await ChannelProfileStore.open(options.dataDirectory);
    const groupRuntime = await GroupRuntimeStore.open(options.dataDirectory);
    const store = await openDomainStore({
      databasePath: options.databasePath ?? join(options.dataDirectory, "glassbox.db"),
    });
    const application = new ManagementApplication(options, store, channels, groupRuntime);
    try {
      application.executors = await ExecutorConfiguration.open({
        dataDirectory: options.dataDirectory,
        models: options.models,
        onEvent: async (event) => {
          const caller = await store.management.runCaller(OWNER_ID, event.runId);
          if (!caller) return;
          const cursor = await application.trace.append(event.runId, event, "claude-code");
          await store.evidence.advanceTrace(caller, cursor);
        },
      });
      await store.conversations.createAgent(AGENT_ID);
      if (options.ops) {
        await options.ops.bridge.connect();
        application.opsReconciler = new OpsReconciler(store.tasks, options.ops.bridge);
        await application.opsReconciler.start();
      }
      // Restore transport before durable queue dispatch. Incoming events wait for that same gate.
      for (const channel of channels.list()) {
        if (channel.autoConnect)
          await application.connect(channel.id, false).catch(() => undefined);
      }
      await application.runs.start({ recover: true });
      application.accepting = true;
      application.releaseIngress();
      return application;
    } catch (error) {
      await application.close();
      throw error;
    }
  }

  private readonly piAdapters = new Map<string, PiRunExecutionAdapter>();
  private opsReconciler?: OpsReconciler;

  private getOrCreateDefaultPiAdapter(profileId: string): PiRunExecutionAdapter {
    const existing = this.piAdapters.get(profileId);
    if (existing) return existing;
    const runtime = new PiSdkRuntimeAdapter({
      kitPath: this.kitLoader.getKitPath(),
      runtimeBaseDir: join(this.options.dataDirectory, "pi"),
      resolveModel: () => configuredPiModel(this.options.models, profileId),
      createTools: (getContext) => [
        ...(this.options.ops
          ? createOpsTools({
              store: this.store,
              service: new AuthorizedOpsService(
                this.store,
                this.options.ops!.bridge,
                this.options.ops!.workerPolicy,
              ),
              workerTarget: this.options.ops!.workerTarget,
              getContext,
            })
          : []),
        ...createOwnerTools({
          store: this.store,
          getContext,
          manageGroup: (context, input) => this.manageGroup(context, input),
        }),
        ...createSkillTools({
          store: this.store,
          loader: this.kitLoader,
          getContext,
          isSkillAuthorized: (context, skillName) => this.isSkillAuthorized(context, skillName),
        }),
      ],
      resolveSkillNames: async (context, profile) => {
        if (!context.caller) return { names: [], policy: { source: "no-caller" } };
        if (context.caller.scope.chatType === "group") {
          if (await this.store.identities.isOwner(context.caller.principalId)) {
            return {
              names: profile.enabledSkills,
              policy: { source: "owner-profile", profile: profile.name },
            };
          }
          const configured = this.groupRuntime.get(
            context.caller.scope.connectionId,
            context.caller.scope.chatId,
            this.kitLoader.loadProfile("qq-group").enabledSkills,
          );
          const available = new Set(this.kitLoader.availableSkills().map((skill) => skill.name));
          return {
            names: configured.enabledSkills.filter((name) => available.has(name)),
            policy: {
              source: "group-whitelist",
              groupId: configured.groupId,
              configVersion: configured.version,
            },
          };
        }
        return { names: profile.enabledSkills, policy: { source: "kit-profile" } };
      },
      resolveToolNames: async (context) => {
        if (!context.caller || !context.conversationId || !context.runId) return [];
        const isOwner = await this.store.identities.isOwner(context.caller.principalId);
        const candidates = [
          ...(context.authorizedSkillNames?.length ? [SKILL_READ_TOOL] : []),
          ...(isOwner && context.caller.scope.chatType === "private"
            ? [...(this.options.ops ? OPS_TOOL_NAMES : []), OWNER_GROUP_ADMIN_TOOL]
            : []),
        ];
        const selected: string[] = [];
        for (const name of candidates) {
          const decision = await this.store.authorization.check({
            caller: context.caller,
            resourceId: toolResourceId(name),
            action: TOOL_DISCOVERY_ACTION,
            conversationId: context.conversationId,
            runId: context.runId,
          });
          if (decision.decision === "ALLOW") selected.push(name);
        }
        return selected;
      },
      onEvent: async (event) => {
        const runId =
          event.runId ?? (typeof event.data.runId === "string" ? event.data.runId : undefined);
        if (!runId || !event.principalId) throw new Error("Pi trace identity missing");
        const caller = await this.store.lifecycle.traceCaller(runId, event.principalId);
        const cursor = await this.trace.append(runId, event, "pi");
        await this.store.evidence.advanceTrace(caller, cursor);
      },
    });
    const adapter = new PiRunExecutionAdapter(runtime, {
      isOwner: (input) => this.store.identities.isOwner(input.caller.principalId),
      resolveProfileName: async (input) =>
        piProfileName(
          input.caller.scope.chatType,
          await this.store.identities.isOwner(input.caller.principalId),
        ),
    });
    this.piAdapters.set(profileId, adapter);
    return adapter;
  }

  private execution(reference: string): RunExecutionAdapter | undefined {
    const harness = this.options.executors?.get(reference);
    if (harness) return harness;
    if (reference === "claude-code") return this.executors.adapter();
    if (reference.startsWith("pi:")) {
      const profileId = reference.slice(3);
      if (!this.options.models.list().some((profile) => profile.id === profileId)) return undefined;
      return this.getOrCreateDefaultPiAdapter(profileId);
    }
    if (!reference.startsWith("model:")) return undefined;
    const profileId = reference.slice(6);
    if (!this.options.models.list().some((profile) => profile.id === profileId)) return undefined;
    return configuredModelAdapter({
      profiles: this.options.models,
      profileId,
      onEvent: async (runId, event) => {
        const caller = await this.store.management.runCaller(OWNER_ID, runId);
        if (!caller) return;
        const cursor = await this.trace.append(runId, event, "glassbox-model");
        await this.store.evidence.advanceTrace(caller, cursor);
      },
    });
  }

  private async recordEvent(event: RunServiceEvent) {
    if (event.type === "recovered") {
      for (const runId of [...event.interruptedRunIds, ...event.unknownRunIds]) {
        const caller = await this.store.management.runCaller(OWNER_ID, runId);
        if (!caller) continue;
        const run = await this.store.conversations.getRun(caller, runId);
        const cursor = await this.trace.append(
          runId,
          {
            type: "run_finished",
            runId,
            conversationId: run.conversationId,
            status: run.status,
            outputWithheld: true,
            recovered: true,
          },
          "glassbox-recovery",
        );
        await this.store.evidence.advanceTrace(caller, cursor);
      }
      for (const deliveryId of event.unknownDeliveryIds) {
        const runId = await this.store.management.deliveryRunId(OWNER_ID, deliveryId);
        if (!runId) continue;
        const caller = await this.store.management.runCaller(OWNER_ID, runId);
        if (!caller) continue;
        const cursor = await this.trace.append(
          runId,
          { type: "delivery_changed", runId, deliveryId, status: "unknown", recovered: true },
          "glassbox-recovery",
        );
        await this.store.evidence.advanceTrace(caller, cursor);
      }
      return;
    }
    if (!("runId" in event)) return;
    const caller = await this.store.lifecycle.traceCaller(event.runId);
    // Denials and revoked grants remain in the authorization ledger. No withheld output is copied here.
    if (!caller) return;
    const cursor = await this.trace.append(event.runId, event, "glassbox-run");
    await this.store.evidence.advanceTrace(caller, cursor);
  }

  listChannels(): PublicChannelProfile[] {
    return this.channels.list().map((channel) => ({ ...channel, ...this.states.get(channel.id) }));
  }

  private publicChannel(id: string): PublicChannelProfile {
    const channel = this.listChannels().find((entry) => entry.id === id);
    if (!channel) throw new ManagementError("NOT_FOUND", "Channel was not found", 404);
    return channel;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operations.catch(() => undefined).then(operation);
    this.operations = current;
    return current;
  }

  saveChannel(input: unknown): Promise<PublicChannelProfile> {
    return this.serialize(async () => {
      const id = idFromInput(input);
      if (this.connections.has(id))
        throw new ManagementError(
          "CHANNEL_ACTIVE",
          "Disconnect the channel before editing its configuration",
          409,
        );
      const channel = await this.channels.save(input);
      this.states.delete(id);
      return channel;
    });
  }

  connectChannel(id: string): Promise<PublicChannelProfile> {
    return this.serialize(() => this.connect(id, true));
  }

  private async connect(id: string, remember: boolean): Promise<PublicChannelProfile> {
    if (this.connections.has(id)) return this.publicChannel(id);
    const configured = this.channels.resolve(id);
    const execution = this.execution(configured.executionRef);
    if (!configured.token)
      throw new ManagementError("INVALID_CONFIGURATION", CHANNEL_SAFE_ERRORS.configuration);
    if (!execution || (configured.config.groupIds.length > 0 && !execution.supportsGroup)) {
      this.states.set(id, { connectionState: "error", lastError: CHANNEL_SAFE_ERRORS.execution });
      throw new ManagementError("INVALID_CONFIGURATION", CHANNEL_SAFE_ERRORS.execution);
    }
    this.states.set(id, { connectionState: "connecting" });
    let connectionAccepted = false;
    let connectionReleased = false;
    let releaseConnection!: () => void;
    const connectionReady = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    const acceptConnection = () => {
      connectionAccepted = true;
      if (!connectionReleased) {
        connectionReleased = true;
        releaseConnection();
      }
      this.runs.refresh();
    };
    let provisionPromise: Promise<void> | undefined;
    const provisionConfiguredAccess = () => {
      provisionPromise ??= remember
        ? this.provisionConfiguredAccess(configured)
        : this.serialize(() => this.provisionConfiguredAccess(configured));
      return provisionPromise;
    };
    const adapter = new OneBotAdapter({
      config: configured.config,
      token: configured.token,
      onState: (state) => {
        this.updateChannelState(id, state);
        if (!remember && state.status === "ready") {
          void provisionConfiguredAccess()
            .then(acceptConnection)
            .catch(() => {
              this.states.set(id, {
                connectionState: "error",
                lastError: CHANNEL_SAFE_ERRORS.connection,
              });
              connectionAccepted = false;
              if (!connectionReleased) {
                connectionReleased = true;
                releaseConnection();
              }
              void adapter.stop().catch(() => undefined);
              if (this.connections.get(id) === adapter) this.connections.delete(id);
            });
        }
      },
      onIncoming: async (message, signal) => {
        await this.ingressReady;
        await connectionReady;
        if (!this.accepting || !connectionAccepted || signal.aborted) return;
        const control = /^\/(status|cancel)\s+([a-zA-Z0-9-]{1,80})\s*$/u.exec(message.text);
        if (control) {
          const caller = await this.store.identities.resolve(message.scope);
          if (!caller) return;
          const run =
            control[1] === "cancel"
              ? await this.runs.cancel(caller, control[2]!)
              : await this.runs.getRun(caller, control[2]!);
          await this.runs.publishControlReply(caller, run.id, {
            messageId: message.messageId,
            text: `任务 ${run.id} 当前状态为 ${run.status}。`,
          });
          return;
        }
        await this.runs.receive({
          agentId: AGENT_ID,
          scope: message.scope,
          messageId: message.messageId,
          text: message.text,
          executionRef: configured.executionRef,
        });
      },
    });
    this.connections.set(id, adapter);
    try {
      await adapter.start();
      if (remember || configured.autoConnect) await provisionConfiguredAccess();
      if (remember) await this.channels.setAutoConnect(id, true);
      acceptConnection();
      return this.publicChannel(id);
    } catch (error) {
      if (!remember && configured.autoConnect && adapter.state.status === "reconnecting")
        return this.publicChannel(id);
      if (!connectionReleased) {
        connectionReleased = true;
        releaseConnection();
      }
      await adapter.stop();
      this.connections.delete(id);
      const key =
        error instanceof OneBotConnectionError && error.code === "authentication_failed"
          ? "auth"
          : error instanceof OneBotConnectionError && error.code === "identity_mismatch"
            ? "identity"
            : "connection";
      this.states.set(id, { connectionState: "error", lastError: CHANNEL_SAFE_ERRORS[key] });
      throw new ManagementError("CONNECTION_FAILED", CHANNEL_SAFE_ERRORS[key], 503);
    }
  }

  private async provisionConfiguredAccess(
    configured: ReturnType<ChannelProfileStore["resolve"]>,
  ): Promise<void> {
    const ownerIds = [
      configured.config.ownerId,
      ...(configured.config.coOwnerId ? [configured.config.coOwnerId] : []),
    ];

    for (const [index, ownerId] of ownerIds.entries()) {
      const principalId = index === 0 ? OWNER_ID : `owner-${ownerId}`;
      const identity = {
        connectionId: configured.config.connectionId,
        botId: configured.config.botId,
        senderId: ownerId,
      };
      const scopes: TrustedChannelScope[] = [
        { ...identity, chatType: "private", chatId: ownerId },
        ...configured.config.groupIds.map((groupId) => ({
          ...identity,
          chatType: "group" as const,
          chatId: groupId,
        })),
      ];
      await this.store.identities.bindOwner(principalId, identity);
      for (const scope of scopes) await this.grantScope(scope, principalId);
    }

    for (const visitorId of configured.config.visitorIds) {
      const principalId = `qq-visitor-${visitorId}`;
      const visitorIdentity = {
        connectionId: configured.config.connectionId,
        botId: configured.config.botId,
        senderId: visitorId,
      };
      await this.store.identities.createPrincipal(principalId, "visitor");
      await this.store.identities.bindPrincipal(principalId, visitorIdentity);
      const visitorScopes: TrustedChannelScope[] = [
        { ...visitorIdentity, chatType: "private", chatId: visitorId },
        ...configured.config.groupIds.map((chatId) => ({
          ...visitorIdentity,
          chatType: "group" as const,
          chatId,
        })),
      ];
      for (const scope of visitorScopes) await this.grantScope(scope, principalId);
    }
  }

  private async grantScope(scope: TrustedChannelScope, principalId = OWNER_ID) {
    const isOwner = await this.store.identities.isOwner(principalId);
    const caller: CallerContext = { principalId, scope };
    for (const action of ACTIONS) {
      if (!isOwner && action === "eval:write") continue;
      const existing = await this.store.authorization.check({
        caller,
        resourceId: agentResourceId(AGENT_ID),
        action,
      });
      if (existing.decision !== "ALLOW")
        await this.store.authorization.grant({
          principalId,
          resourceId: agentResourceId(AGENT_ID),
          action,
          scope,
          effect: "allow",
        });
    }
    await this.store.authorization.registerResource({
      id: SKILL_CATALOG_RESOURCE,
      kind: "skill-catalog",
      visibility: "public",
      ifAbsent: true,
    });
    await this.store.authorization.grant({
      principalId,
      resourceId: SKILL_CATALOG_RESOURCE,
      action: SKILL_READ_ACTION,
      scope,
      effect: "allow",
    });
    const skillToolResource = toolResourceId(SKILL_READ_TOOL);
    await this.store.authorization.registerResource({
      id: skillToolResource,
      kind: "tool-definition",
      visibility: "public",
      ifAbsent: true,
    });
    await this.store.authorization.grant({
      principalId,
      resourceId: skillToolResource,
      action: TOOL_DISCOVERY_ACTION,
      scope,
      effect: "allow",
    });
    if (isOwner && scope.chatType === "private") {
      await this.store.authorization.registerResource({
        id: OWNER_CONTROL_RESOURCE,
        kind: "owner-control",
        visibility: "private",
        ownerId: OWNER_ID,
        ifAbsent: true,
      });
      await this.store.authorization.grant({
        principalId,
        resourceId: OWNER_CONTROL_RESOURCE,
        action: "group:manage",
        scope,
        effect: "allow",
      });
      for (const name of [...(this.options.ops ? OPS_TOOL_NAMES : []), OWNER_GROUP_ADMIN_TOOL]) {
        const resourceId = toolResourceId(name);
        await this.store.authorization.registerResource({
          id: resourceId,
          kind: "tool-definition",
          visibility: "private",
          ownerId: OWNER_ID,
          ifAbsent: true,
        });
        await this.store.authorization.grant({
          principalId,
          resourceId,
          action: TOOL_DISCOVERY_ACTION,
          scope,
          effect: "allow",
        });
      }
    }
  }

  private async setGroupAccess(
    context: ProtectedToolContext,
    input: { groupId: string; enabled: boolean },
  ): Promise<{ groupId: string; enabled: boolean; enabledSkills: string[]; version: number }> {
    return this.serialize(async () => {
      const caller = context.caller;
      const isOwner = await this.store.identities.isOwner(caller.principalId);
      if (!isOwner || caller.scope.chatType !== "private")
        throw new Error("owner_private_required");
      const connection = this.connections.get(caller.scope.connectionId);
      if (!connection) throw new Error("channel_not_connected");
      const configured = this.channels.resolve(caller.scope.connectionId);
      if (input.enabled && !(await connection.hasGroup(input.groupId)))
        throw new Error("bot_not_in_group");

      const ownerIds = [
        configured.config.ownerId,
        ...(configured.config.coOwnerId ? [configured.config.coOwnerId] : []),
      ];
      const groupScopes = [...ownerIds, ...configured.config.visitorIds].map((senderId) => ({
        connectionId: configured.config.connectionId,
        botId: configured.config.botId,
        chatType: "group" as const,
        chatId: input.groupId,
        senderId,
      }));
      if (!input.enabled) {
        for (const scope of groupScopes) {
          const principalId = ownerIds.includes(scope.senderId)
            ? scope.senderId === configured.config.ownerId
              ? OWNER_ID
              : `owner-${scope.senderId}`
            : `qq-visitor-${scope.senderId}`;
          for (const resourceId of [
            agentResourceId(AGENT_ID),
            SKILL_CATALOG_RESOURCE,
            toolResourceId(SKILL_READ_TOOL),
          ])
            await this.store.authorization.revokeScope({ principalId, resourceId, scope });
        }
      }
      const profile = await this.channels.setGroupEnabled(
        caller.scope.connectionId,
        input.groupId,
        input.enabled,
      );
      if (input.enabled) {
        for (const scope of groupScopes) {
          const principalId = ownerIds.includes(scope.senderId)
            ? scope.senderId === configured.config.ownerId
              ? OWNER_ID
              : `owner-${scope.senderId}`
            : `qq-visitor-${scope.senderId}`;
          await this.grantScope(scope, principalId);
        }
      }
      connection.setAllowedGroups(profile.groupIds);
      const cursor = await this.trace.append(
        context.runId,
        {
          type: "group_access_changed",
          runId: context.runId,
          principalId: caller.principalId,
          connectionId: caller.scope.connectionId,
          groupId: input.groupId,
          enabled: input.enabled,
        },
        "glassbox-owner-control",
      );
      await this.store.evidence.advanceTrace(caller, cursor);
      this.runs.refresh();
      const runtime = this.groupRuntime.get(
        caller.scope.connectionId,
        input.groupId,
        this.kitLoader.loadProfile("qq-group").enabledSkills,
      );
      return {
        groupId: input.groupId,
        enabled: input.enabled,
        enabledSkills: runtime.enabledSkills,
        version: runtime.version,
      };
    });
  }

  private async manageGroup(
    context: ProtectedToolContext,
    input: OwnerGroupAdminInput,
  ): Promise<unknown> {
    const caller = context.caller;
    const isOwner = await this.store.identities.isOwner(caller.principalId);
    if (!isOwner || caller.scope.chatType !== "private") throw new Error("owner_private_required");
    if (input.action === "set_access") return this.setGroupAccess(context, input);
    if (input.action === "set_skill") return this.setGroupSkill(context, input);
    const configured = this.channels.resolve(caller.scope.connectionId);
    const runtime = this.groupRuntime.get(
      caller.scope.connectionId,
      input.groupId,
      this.kitLoader.loadProfile("qq-group").enabledSkills,
    );
    return {
      groupId: input.groupId,
      enabled: configured.config.groupIds.includes(input.groupId),
      enabledSkills: runtime.enabledSkills,
      availableSkills: this.kitLoader.availableSkills().map((skill) => skill.name),
      version: runtime.version,
    };
  }

  private async setGroupSkill(
    context: ProtectedToolContext,
    input: Extract<OwnerGroupAdminInput, { action: "set_skill" }>,
  ): Promise<unknown> {
    return this.serialize(async () => {
      const caller = context.caller;
      const isOwner = await this.store.identities.isOwner(caller.principalId);
      if (!isOwner || caller.scope.chatType !== "private")
        throw new Error("owner_private_required");
      const configured = this.channels.resolve(caller.scope.connectionId);
      if (!configured.config.groupIds.includes(input.groupId)) throw new Error("group_not_enabled");
      const availableSkills = this.kitLoader.availableSkills().map((skill) => skill.name);
      const profile = await this.groupRuntime.setSkillEnabled({
        connectionId: caller.scope.connectionId,
        groupId: input.groupId,
        skillName: input.skillName,
        enabled: input.enabled,
        availableSkills,
        defaultSkills: this.kitLoader.loadProfile("qq-group").enabledSkills,
        principalId: caller.principalId,
      });
      const cursor = await this.trace.append(
        context.runId,
        {
          type: "group_skill_changed",
          runId: context.runId,
          principalId: caller.principalId,
          connectionId: caller.scope.connectionId,
          groupId: input.groupId,
          skillName: input.skillName,
          enabled: input.enabled,
          configVersion: profile.version,
          enabledSkills: profile.enabledSkills,
        },
        "glassbox-owner-control",
      );
      await this.store.evidence.advanceTrace(caller, cursor);
      return {
        groupId: input.groupId,
        skillName: input.skillName,
        enabled: input.enabled,
        enabledSkills: profile.enabledSkills,
        version: profile.version,
      };
    });
  }

  private async isSkillAuthorized(
    context: ProtectedToolContext,
    skillName: string,
  ): Promise<boolean> {
    const available = new Set(this.kitLoader.availableSkills().map((skill) => skill.name));
    if (!available.has(skillName)) return false;
    if (
      context.caller.scope.chatType === "private" ||
      (await this.store.identities.isOwner(context.caller.principalId))
    )
      return this.kitLoader.loadProfile("main-agent").enabledSkills.includes(skillName);
    const configured = this.channels.resolve(context.caller.scope.connectionId);
    if (!configured.config.groupIds.includes(context.caller.scope.chatId)) return false;
    return this.groupRuntime
      .get(
        context.caller.scope.connectionId,
        context.caller.scope.chatId,
        this.kitLoader.loadProfile("qq-group").enabledSkills,
      )
      .enabledSkills.includes(skillName);
  }

  disconnectChannel(id: string): Promise<PublicChannelProfile> {
    return this.serialize(async () => {
      this.publicChannel(id);
      await this.channels.setAutoConnect(id, false);
      await this.connections.get(id)?.stop();
      this.connections.delete(id);
      this.states.set(id, { connectionState: "disconnected" });
      return this.publicChannel(id);
    });
  }

  private updateChannelState(id: string, state: OneBotState) {
    if (state.status === "ready") this.states.set(id, { connectionState: "connected" });
    else if (state.status === "stopped") this.states.set(id, { connectionState: "disconnected" });
    else if (state.status === "faulted")
      this.states.set(id, { connectionState: "error", lastError: CHANNEL_SAFE_ERRORS.connection });
    else this.states.set(id, { connectionState: "connecting" });
  }

  private async runCaller(runId: string) {
    const caller = await this.store.management.runCaller(OWNER_ID, runId);
    if (!caller)
      throw new ManagementError("NOT_FOUND", "Run was not found or access is unavailable", 404);
    return caller;
  }

  async route(request: IncomingMessage): Promise<{ status: number; body: unknown } | undefined> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (request.method === "POST" && path === "/manage/ops/grants") {
      const result = await grantOpsPermissions(
        this.store,
        this.options.ops?.workerPolicy,
        await readManagementJson(request),
      );
      return { status: 200, body: result };
    }
    const revokeOpsGrant = /^\/manage\/ops\/grants\/([a-zA-Z0-9-]{1,80})\/revoke$/u.exec(path);
    if (request.method === "POST" && revokeOpsGrant) {
      await this.store.authorization.revoke(revokeOpsGrant[1]!);
      await this.store.tasks.recordTrace({
        type: "authorization.revoked",
        principalId: OWNER_ID,
        data: { grantId: revokeOpsGrant[1], authority: "local-management" },
      });
      return { status: 200, body: { revoked: true } };
    }
    const options = {
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
      limit: 30,
    };
    const ok = (body: unknown) => ({ status: 200, body });
    try {
      if (path === "/manage/executors") {
        if (request.method === "GET") return ok({ executors: await this.executors.list() });
        if (request.method === "POST")
          return ok({ executor: await this.executors.save(await readManagementJson(request)) });
      }
      if (request.method === "POST" && path === "/manage/executors/claude-code/check") {
        await readManagementJson(request);
        return ok({ executor: await this.executors.check() });
      }
      if (path === "/manage/channels") {
        if (request.method === "GET") return ok({ channels: this.listChannels() });
        if (request.method === "POST")
          return ok({ channel: await this.saveChannel(await readManagementJson(request)) });
      }
      const channelAction = /^\/manage\/channels\/([A-Za-z0-9_-]+)\/(connect|disconnect)$/u.exec(
        path,
      );
      if (request.method === "POST" && channelAction)
        return ok({
          channel:
            channelAction[2] === "connect"
              ? await this.connectChannel(channelAction[1]!)
              : await this.disconnectChannel(channelAction[1]!),
        });
      if (request.method === "GET" && path === "/manage/conversations")
        return ok(await this.store.management.listConversations(OWNER_ID, options));
      if (request.method === "GET" && path === "/manage/runs") {
        const conversationId = url.searchParams.get("conversationId");
        if (conversationId && !/^[A-Za-z0-9-]{1,80}$/u.test(conversationId))
          throw new ManagementError("INVALID_REQUEST", "Invalid conversation identifier");
        return ok(
          await this.store.management.listRuns(OWNER_ID, {
            ...options,
            ...(conversationId ? { conversationId } : {}),
          }),
        );
      }
      const runAction =
        /^\/manage\/runs\/([A-Za-z0-9-]+)(?:\/(cancel|trace|deliveries|evals))?$/u.exec(path);
      if (runAction) {
        const runId = runAction[1]!;
        const caller = await this.runCaller(runId);
        if (request.method === "POST" && runAction[2] === "evals") {
          const input = await readManagementJson(request);
          if (
            !input ||
            typeof input !== "object" ||
            !("suiteId" in input) ||
            typeof input.suiteId !== "string"
          )
            throw new ManagementError("INVALID_REQUEST", "An Eval suite is required");
          return ok({ evaluation: await this.evaluator.evaluate(caller, runId, input.suiteId) });
        }
        if (request.method === "GET" && runAction[2] === "evals")
          return ok(await this.evaluator.list(caller, runId, options));
        if (request.method === "POST" && runAction[2] === "cancel")
          return ok({ run: await this.runs.cancel(caller, runId) });
        if (request.method === "GET" && runAction[2] === "deliveries")
          return ok(await this.store.lifecycle.listDeliveries(caller, runId, options));
        if (request.method === "GET" && runAction[2] === "trace") {
          const indexed = await this.store.evidence.getTrace(caller, runId);
          if (!indexed) return ok({ records: [], nextCursor: null, indexed: null });
          const { records, nextCursor } = await this.trace.readPage(runId, {
            ...options,
            redactSecrets: true,
          });
          // Recheck after file I/O before returning a protected projection.
          await this.store.conversations.getRun(caller, runId);
          return ok({ records, nextCursor, indexed });
        }
        if (request.method === "GET" && !runAction[2])
          return ok({ run: await this.store.conversations.getRun(caller, runId) });
      }
      return undefined;
    } catch (error) {
      if (error instanceof RunEvalError)
        throw new ManagementError(
          error.code,
          error.message,
          error.code === "EVAL_SUITE_NOT_FOUND" ? 400 : 409,
        );
      if (error instanceof ExecutorBusyError)
        throw new ManagementError("EXECUTOR_BUSY", error.message, 409);
      if (error instanceof ChannelConfigurationError)
        throw new ManagementError("INVALID_CONFIGURATION", CHANNEL_SAFE_ERRORS.configuration);
      throw error;
    }
  }

  async close() {
    this.accepting = false;
    this.releaseIngress();
    await this.operations.catch(() => undefined);
    await Promise.allSettled([...this.connections.values()].map((adapter) => adapter.stop()));
    this.connections.clear();
    await this.runs.stop({ abortRunning: true, wait: true });
    for (const adapter of this.piAdapters.values()) await adapter.cleanup();
    this.piAdapters.clear();
    await this.opsReconciler?.stop();
    await this.options.ops?.bridge.disconnect();
    await this.store.close();
  }
}
