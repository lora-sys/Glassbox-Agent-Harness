import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import {
  CHANNEL_SAFE_ERRORS,
  type PublicChannelProfile,
  type QqSourceClass,
} from "@glassbox/contracts";
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
import {
  availableHistoryToolNames,
  createHistoryTools,
  historyToolEligibility,
  OWNER_HISTORY_ACTION,
  OWNER_HISTORY_RESOURCE,
  type HistorySyncOutcome,
} from "../runtime/pi/history-tools.js";
import {
  availableCapabilityToolNames,
  capabilityResourceId,
  capabilityToolEligibility,
  createCapabilityTools,
  GROUP_RUN_CAPABILITY_CATEGORIES,
} from "../runtime/pi/capability-tools.js";
import { resolveSkillVisibility } from "../runtime/pi/skill-visibility.js";
import { requireProviderSuccess } from "../runtime/pi/provider-outcome.js";
import {
  TOOL_DESCRIPTORS,
  type ToolDescriptor,
  type ToolExclusionReason,
  type ToolSurfaceCandidate,
} from "../runtime/pi/tool-plane.js";
import type { PiRunContext } from "../runtime/pi/types.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_GROUP_CAPABILITY_POLICY,
  enabledCategories,
  isCategoryEnabled,
  type GroupCapabilityPolicy,
} from "./capability-policy.js";
import {
  QQ_CAPABILITIES,
  QQ_CAPABILITY_CATEGORIES,
  qqCapabilitiesForCategory,
  type QqCapabilityCategory,
} from "../channels/onebot/capabilities.js";
import {
  matchCapabilityEntries,
  type CapabilitySearchEntry,
} from "../channels/onebot/capability-search.js";
import {
  probeReadCapabilities,
  type CapabilityProbeObservation,
  type CapabilityProbeReport,
} from "../channels/onebot/capability-probe.js";
import { ChannelArchiveStore } from "../retrieval/channel-archive.js";
import { groupResourceId, resolveAssignedGroupIds } from "../retrieval/source-resolver.js";
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
/**
 * A context an authorization decision can be made in that is not necessarily a Run.
 *
 * `conversationId` and `runId` are optional because `authorization_decisions` records them as
 * real references to real rows. A management-initiated operation — the capability acceptance —
 * belongs to no Conversation and no Run, and it must say so by leaving them absent rather than
 * inventing identifiers: a placeholder string would make the evidence claim a Conversation and
 * a Run that never existed, which is exactly the kind of unproven claim the acceptance exists
 * to rule out. A `ProtectedToolContext` satisfies this, so a Tool call is unaffected and still
 * records the Run it really ran in.
 */
type AuthorizationContext = {
  caller: CallerContext;
  conversationId?: string;
  runId?: string;
};
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

/**
 * The two group-scoped Actions the managed-group projection reasons about by name.
 *
 * `categoryActions` derives them from the registry, so these are not a second source of truth:
 * they exist because the projection needs the `history:read` and `group:read` decisions
 * individually — one reported as the access fact, one gating the live provider read.
 */
const HISTORY_READ_ACTION = "history:read";
const GROUP_READ_ACTION = "group:read";

/** Provider page size for one `get_group_msg_history` call. */
const HISTORY_SYNC_PAGE_SIZE = 100;
/** Upper bound on pages walked per sync, so one search cannot scan unbounded history. */
const HISTORY_SYNC_MAX_PAGES = 5;

/**
 * The fixed capability bundle an Owner's first `set_access enabled` persists for a group.
 *
 * These are the read-only P4 capabilities the acceptance path needs — group metadata,
 * members, live history, notices/essence, file reads and the memory source class. Mutation
 * categories (`group.files.write`, `group.moderate`, `group.settings`, `message.manage`)
 * are deliberately absent: they stay an explicit later Owner decision.
 */
export const DEFAULT_OWNER_GROUP_CATEGORIES: readonly QqCapabilityCategory[] = Object.freeze([
  "group.read",
  "group.members",
  "group.history",
  "group.content",
  "group.files.read",
  "memory.source",
]);

/**
 * The memory source classes the default bundle enables.
 *
 * Every name here has a real capability behind it; `album` is absent because the registry
 * declares no album operation, and enabling it would write a dead grant.
 */
export const DEFAULT_OWNER_GROUP_SOURCES: readonly QqSourceClass[] = Object.freeze([
  "history",
  "notice",
  "essence",
  "metadata",
  "file",
]);

/** The durable policy one Owner's first `set_access enabled` persists for a group. */
export const DEFAULT_OWNER_GROUP_POLICY: GroupCapabilityPolicy = (() => {
  const categories: Partial<Record<QqCapabilityCategory, boolean>> = {};
  for (const category of DEFAULT_OWNER_GROUP_CATEGORIES) categories[category] = true;
  const memorySources: Partial<Record<QqSourceClass, boolean>> = {};
  for (const sourceClass of DEFAULT_OWNER_GROUP_SOURCES) memorySources[sourceClass] = true;
  return { categories, memorySources };
})();

/** The Action that records one Owner's assignment of one managed group. */
const GROUP_ASSIGN_ACTION = "group:manage";

/**
 * The Action that permits a result derived from one Resource to reach the current audience.
 *
 * It is granted on a *group* Resource, in one exact scope, and it is deliberately separate
 * from every read Action: `authorizeDeliverySources` re-checks each protected read a Run
 * admitted against this Action on the same Resource, in the Run's own scope, immediately
 * before transport. Read authority therefore never becomes delivery authority, and the
 * reverse states stay explicit. An unassigned group, a sibling Owner, another audience and
 * a Visitor private chat hold no such grant.
 */
const DELIVERY_SEND_ACTION = "delivery:send";

/**
 * One managed group's durable facts, before any live provider observation.
 *
 * Shared by the managed-group inventory and the capability search so the two cannot disagree
 * about which groups exist, what each one's policy says, or what the Principal may do.
 */
interface ManagedGroupFacts {
  groupId: string;
  /** The durable Owner intent for this group's capability classes. */
  policy: GroupCapabilityPolicy;
  /** The durable policy version. */
  version: number;
  /** The categories whose group-scoped Action is currently ALLOW for this Principal. */
  grantedCategories: QqCapabilityCategory[];
  /** The execution-time `history:read` decision for this Principal and group. */
  historyRead: boolean;
  /** The execution-time `group:read` decision, which gates the live provider observation. */
  groupRead: boolean;
  /** The durable group runtime whitelist, read from the store rather than the live session. */
  skills: { enabledSkills: string[]; version: number };
}

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
  /** Durable Channel history, separate from Run inputs. */
  readonly archive: ChannelArchiveStore;
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
    this.archive = new ChannelArchiveStore(store.db);
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
      createTools: (getContext) => this.createRuntimeTools(getContext),
      resolveSkillNames: async (context, profile) => {
        if (!context.caller)
          return resolveSkillVisibility({
            caller: null,
            isOwner: false,
            profile,
            group: null,
            availableSkills: [],
          });
        const caller = context.caller;
        const isOwner = await this.store.identities.isOwner(caller.principalId);
        // The group's configuration is read only when the group is the audience that decides
        // it. An Owner-private Run has no group whitelist to consult.
        const group =
          caller.scope.chatType === "group" && !isOwner
            ? this.groupRuntime.get(
                caller.scope.connectionId,
                caller.scope.chatId,
                this.kitLoader.loadProfile("qq-group").enabledSkills,
              )
            : null;
        return resolveSkillVisibility({
          caller,
          isOwner,
          profile,
          group: group
            ? {
                groupId: group.groupId,
                configVersion: group.version,
                enabledSkills: group.enabledSkills,
              }
            : null,
          availableSkills: this.kitLoader.availableSkills().map((skill) => skill.name),
        });
      },
      resolveToolNames: (context) => this.resolveRunToolNames(context),
      resolveToolCandidates: (context) => this.resolveRunToolCandidates(context),
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
      // What the Runtime required a Run to observe, and how the Run answered it. Safe evidence:
      // domains, Tool names and outcomes, never provider text or protected content.
      onEvidence: async (record) => {
        const caller = await this.store.lifecycle.traceCaller(record.runId, record.principalId);
        const cursor = await this.trace.append(record.runId, record, "glassbox-tool-evidence");
        await this.store.evidence.advanceTrace(caller, cursor);
      },
    });
    this.piAdapters.set(profileId, adapter);
    return adapter;
  }

  /**
   * The Runtime Tools every Pi Run receives.
   *
   * Extracted from the adapter wiring so a test can build the real Tool surface through the
   * real application instead of re-deriving it, which is the only way a discovery/execution
   * test proves the product path rather than the helper.
   */
  private createRuntimeTools(getContext: () => PiRunContext | undefined): ToolDefinition[] {
    return [
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
      ...createHistoryTools({
        store: this.store,
        archive: this.archive,
        getContext,
        isHistoryEnabled: (connectionId, groupId) => this.isHistoryEnabled(connectionId, groupId),
        // The walk's outcome is passed straight through: it is what the search reports as its
        // source coverage, and only `end_of_source` lets an answer say the group was read.
        syncGroup: (groupId, context) =>
          this.syncGroupHistory(context.caller.scope.connectionId, groupId),
        botIdForConnection: (connectionId) => this.channels.resolve(connectionId).config.botId,
        // Safe retrieval evidence: Run, Resource, source kind and id, mode, score, rank and
        // matched terms — never a snippet or protected message text.
        recordEvidence: async (evidence, context) => {
          const cursor = await this.trace.append(context.runId, evidence, "glassbox-retrieval");
          await this.store.evidence.advanceTrace(context.caller, cursor);
        },
      }),
      ...createCapabilityTools({
        store: this.store,
        getContext,
        // Owner intent, read fresh on every call so a policy change applies at once.
        isCategoryEnabled: (connectionId, groupId, category) =>
          this.isCategoryEnabled(connectionId, groupId, category),
        invoke: async ({ action, params, context }) => {
          const connection = this.connections.get(context.caller.scope.connectionId);
          if (!connection) throw new Error("channel_not_connected");
          // The one outbound provider path. A provider result that is not `ok` fails the Tool
          // call here rather than travelling back as a successful result carrying a failure
          // envelope, which a model could describe as data and an evidence check could count
          // as an answer.
          return requireProviderSuccess(await connection.invokeCapability({ action, params }));
        },
        search: (input) => this.searchCapabilities(input.context, input),
        projectManagedGroups: (context) => this.projectManagedGroups(context),
      }),
    ];
  }

  /** One group's durable Owner intent for a capability class. Not an authorization decision. */
  private async isCategoryEnabled(
    connectionId: string,
    groupId: string,
    category: QqCapabilityCategory,
  ): Promise<boolean> {
    return isCategoryEnabled(
      (await this.store.capabilities.read(connectionId, groupId))?.policy ??
        DEFAULT_GROUP_CAPABILITY_POLICY,
      category,
    );
  }

  /**
   * One group's durable Owner intent for history.
   *
   * History is a capability category, so this is the same policy read the capability Tools
   * use. Reading it fresh is what makes `set_history` and `set_capability(group.history)`
   * agree: both move the same flag, and the next Run and the next execution both see it.
   */
  private async isHistoryEnabled(connectionId: string, groupId: string): Promise<boolean> {
    return this.isCategoryEnabled(connectionId, groupId, "group.history");
  }

  /**
   * Every registered Tool, classified for this Run's scope, policy and grants.
   *
   * This is the one implementation of Tool discovery; `resolveRunToolNames` is its
   * projection. Splitting them would let the names a Run may call and the surface a Run
   * records disagree, which is the drift Issue #16 exists to remove.
   *
   * The classification runs over the whole registered universe so an exclusion is always
   * explainable, but the `tool:discover` authorization check is issued only for names that
   * survive the scope and policy gates. Checking Tools a scope was never eligible for would
   * add authorization evidence for operations that were never on the table.
   *
   * The capability surface follows current policy, never a cached bundle: a group Run sees
   * only what its own group's policy enables, and an Owner-private Run sees the union over
   * the groups the current Principal is assigned to. Discovery is granted as a superset, so
   * a policy change applies on the very next Run with no re-grant.
   *
   * `registered` is the universe to classify. It defaults to the real registry and is a
   * parameter so a test can classify a registry that contains a Tool no rule knows — which is
   * the wiring bug the `unclassified` guard exists for, and which no Run over the real table
   * can reproduce while every real Tool happens to be wired.
   */
  async resolveRunToolCandidates(
    context: PiRunContext,
    registered: readonly ToolDescriptor[] = TOOL_DESCRIPTORS,
  ): Promise<ToolSurfaceCandidate[]> {
    if (!context.caller || !context.conversationId || !context.runId)
      return registered.map((descriptor) => ({
        name: descriptor.name,
        exclusion: "no_caller_context" as const,
      }));
    const isOwner = await this.store.identities.isOwner(context.caller.principalId);
    const scope = context.caller.scope;
    const capabilityCategories =
      scope.chatType === "group"
        ? enabledCategories(
            (await this.store.capabilities.read(scope.connectionId, scope.chatId))?.policy,
          )
        : isOwner
          ? await this.assignedCategories(context.caller)
          : [];

    // Eligibility is *absence of an exclusion*, so a bare `scopeGates.get(name) ?? reason`
    // cannot tell "this rule found it eligible" from "no rule ever looked at it" — both are
    // a missing key. `classified` records the first, so the second is detectable and fails
    // closed. Without it the `unclassified` reason below is unreachable, and a Tool wired
    // into the registry but into no rule would be offered to every scope that holds a
    // discovery grant.
    const classified = new Set<string>();
    const scopeGates = new Map<string, ToolExclusionReason>();
    const classify = (
      entries: readonly { name: string; exclusion: ToolExclusionReason | null }[],
    ) => {
      for (const entry of entries) {
        classified.add(entry.name);
        if (entry.exclusion !== null) scopeGates.set(entry.name, entry.exclusion);
      }
    };
    classify(
      historyToolEligibility({
        isOwner,
        chatType: scope.chatType,
        enabledCategories: capabilityCategories,
      }),
    );
    classify(
      capabilityToolEligibility({
        isOwner,
        chatType: scope.chatType,
        enabledCategories: capabilityCategories,
      }),
    );

    // The Agent Ops and Owner-control surface is Owner-private. A group Run reaches neither,
    // however the Owner's own grants look, so this is a scope boundary rather than a policy.
    const ownerPrivate = isOwner && scope.chatType === "private";
    for (const name of OPS_TOOL_NAMES) {
      classified.add(name);
      if (!(ownerPrivate && this.options.ops)) scopeGates.set(name, "scope_not_permitted");
    }
    classified.add(OWNER_GROUP_ADMIN_TOOL);
    if (!ownerPrivate) scopeGates.set(OWNER_GROUP_ADMIN_TOOL, "scope_not_permitted");
    classified.add(SKILL_READ_TOOL);
    if (!context.authorizedSkillNames?.length) scopeGates.set(SKILL_READ_TOOL, "policy_disabled");

    const candidates: ToolSurfaceCandidate[] = [];
    for (const descriptor of registered) {
      if (descriptor.origin === "pi_builtin") {
        // A Pi built-in is classified by its origin, and excluded on the same evidence the
        // real session uses: the host never offers it to a Glassbox Run.
        classified.add(descriptor.name);
        candidates.push({ name: descriptor.name, exclusion: "disabled_by_host" });
        continue;
      }
      // A registered Tool no rule classified is a wiring bug. Withholding it keeps it out of
      // the model's surface and makes the gap visible instead of silently offering it.
      if (!classified.has(descriptor.name)) {
        candidates.push({ name: descriptor.name, exclusion: "unclassified" });
        continue;
      }
      const gate = scopeGates.get(descriptor.name);
      if (gate !== undefined) {
        candidates.push({ name: descriptor.name, exclusion: gate });
        continue;
      }
      const decision = await this.store.authorization.check({
        caller: context.caller,
        resourceId: toolResourceId(descriptor.name),
        action: TOOL_DISCOVERY_ACTION,
        conversationId: context.conversationId,
        runId: context.runId,
      });
      candidates.push({
        name: descriptor.name,
        exclusion: decision.decision === "ALLOW" ? null : "discovery_denied",
      });
    }
    return candidates;
  }

  private async resolveRunToolNames(context: PiRunContext): Promise<string[]> {
    return (await this.resolveRunToolCandidates(context))
      .filter((candidate) => candidate.exclusion === null)
      .map((candidate) => candidate.name);
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
        if (message.scope.chatType === "group") {
          // Group assignments can change while the socket stays connected. Resolve the
          // current profile instead of preserving the connect-time allowlist in this closure.
          await this.provisionAddressedGroupMember(this.channels.resolve(id), message.scope);
        }
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
      // An assignment persisted before the explicit delivery grant existed must not require the
      // Owner to remove and re-add the group. The set is read from this Owner's own active
      // `group:manage` grants, so the backfill restores exactly the assignments that already
      // exist. It can never manufacture one, and a group this Owner never assigned stays
      // without authority however often the Channel reconnects.
      const privateScope = scopes[0]!;
      for (const groupId of await resolveAssignedGroupIds(this.store, {
        principalId,
        scope: privateScope,
      }))
        await this.grantGroupDelivery({ principalId, scope: privateScope, groupId });
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

  /**
   * Gives one explicitly addressed member of an enabled group only that group's Visitor
   * authority. Normalization has already required a real @ mention and an allowed group.
   * Private chat remains restricted to configured identities, and no Owner control grant is
   * created here.
   */
  private async provisionAddressedGroupMember(
    configured: ReturnType<ChannelProfileStore["resolve"]>,
    scope: TrustedChannelScope,
  ): Promise<void> {
    if (scope.chatType !== "group" || !configured.config.groupIds.includes(scope.chatId)) return;
    let caller = await this.store.identities.resolve(scope);
    if (!caller) {
      const principalId = `qq-visitor-${scope.senderId}`;
      await this.store.identities.createPrincipal(principalId, "visitor");
      await this.store.identities.bindPrincipal(principalId, scope);
      caller = { principalId, scope };
    }
    const current = await this.store.authorization.check({
      caller,
      resourceId: agentResourceId(AGENT_ID),
      action: "run:create",
    });
    if (current.decision !== "ALLOW") await this.grantScope(scope, caller.principalId);
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
    // A group is a protected Resource. Bot membership never creates this row: it exists only
    // for a group Glassbox has configured, and reading it still needs an explicit grant.
    if (scope.chatType === "group") {
      const groupResource = groupResourceId(scope.chatId);
      await this.store.authorization.registerResource({
        id: groupResource,
        kind: "qq_group",
        visibility: "public",
        ifAbsent: true,
      });
      // A Run inside a configured group may read that same group. This is not implied by bot
      // membership: the grant exists only for a group Glassbox has configured, it is scoped to
      // that one group, and it covers only the read-only categories. The Run's candidate list
      // narrows them to the Owner's current policy, and every call is re-authorized.
      for (const action of this.groupRunReadActions()) {
        const existing = await this.store.authorization.check({
          caller,
          resourceId: groupResource,
          action,
        });
        if (existing.decision !== "ALLOW")
          await this.store.authorization.grant({
            principalId,
            resourceId: groupResource,
            action,
            scope,
            effect: "allow",
          });
      }
      // Answering back into this group is its own decision, granted separately from reading it.
      // The Run's own group scope is the audience it already owns, so this is the one delivery
      // authority a group Run can hold. It is granted only because Glassbox configured
      // this group. Bot membership alone registers nothing and grants nothing.
      await this.grantGroupDelivery({ principalId, scope, groupId: scope.chatId });
      // Discovery is a superset of authority, exactly as for the Owner-private scope: the
      // Run's candidate list narrows it to policy, so a category change applies on the next
      // Run with no re-grant and a revoked category cannot survive as stale discovery.
      await this.grantCapabilityDiscovery({ principalId, scope });
    }
    for (const name of availableHistoryToolNames({
      isOwner,
      chatType: scope.chatType,
      enabledCategories: [...QQ_CAPABILITY_CATEGORIES],
    })) {
      const resourceId = toolResourceId(name);
      await this.store.authorization.registerResource({
        id: resourceId,
        kind: "tool-definition",
        visibility: scope.chatType === "group" ? "public" : "private",
        ...(scope.chatType === "group" ? {} : { ownerId: OWNER_ID }),
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
      await this.grantCapabilityDiscovery({ principalId, scope });
      // The Owner cross-group history Tool spans several group Resources, so it is gated on
      // this Owner-private search capability. Each concrete group Resource is still
      // re-authorized inside the Tool and the decision recorded with the Run.
      await this.store.authorization.registerResource({
        id: OWNER_HISTORY_RESOURCE,
        kind: "owner-history",
        visibility: "private",
        ownerId: OWNER_ID,
        ifAbsent: true,
      });
      await this.store.authorization.grant({
        principalId,
        resourceId: OWNER_HISTORY_RESOURCE,
        action: OWNER_HISTORY_ACTION,
        scope,
        effect: "allow",
      });
      // Reading the managed-group inventory, searching the capability registry and reading
      // the bot's own status are protected Actions on the Agent, not free metadata. The
      // inventory is the `group:read` Action on the Agent Resource — the same Action that
      // reads one group, applied to the Agent's own managed set — so an Owner may enumerate
      // exactly the groups they manage and no others.
      for (const action of ["group:read", "qq:capability:read", "account:status:read"]) {
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
    }
  }

  /**
   * The one explicit delivery authority Glassbox writes for a group Resource.
   *
   * It says exactly: a result derived from *this* group's protected content may be delivered
   * to *this* Principal in *this* scope. Every narrowing the Delivery Gate needs is carried by
   * that sentence. The Resource is named, the Principal is named and the audience is the
   * scope the grant lives in. Nothing has to be inferred from a read Action, a role, a
   * connection-wide group list or bot membership.
   *
   * Idempotent, and it never creates an assignment: the caller decides *which* Resource and
   * *which* scope, and both callers derive that from state that already exists, a configured
   * group scope, or this Owner's own persisted `group:manage` assignment.
   */
  private async grantGroupDelivery(input: {
    principalId: string;
    scope: TrustedChannelScope;
    groupId: string;
  }): Promise<void> {
    const resourceId = groupResourceId(input.groupId);
    await this.store.authorization.registerResource({
      id: resourceId,
      kind: "qq_group",
      visibility: "public",
      ifAbsent: true,
    });
    const caller: CallerContext = { principalId: input.principalId, scope: input.scope };
    const existing = await this.store.authorization.check({
      caller,
      resourceId,
      action: DELIVERY_SEND_ACTION,
    });
    if (existing.decision !== "ALLOW")
      await this.store.authorization.grant({
        principalId: input.principalId,
        resourceId,
        action: DELIVERY_SEND_ACTION,
        scope: input.scope,
        effect: "allow",
      });
  }

  /**
   * Registers and grants Tool discovery for the capability surface a scope could ever use.
   *
   * Discovery is not authority, and it is deliberately a superset: the Run's candidate list
   * narrows it to current policy, and the category's protected Action on the concrete group
   * Resource is still checked at call time. Granting it once per scope means a policy change
   * takes effect on the next Run without a re-grant, and a revoked category cannot survive
   * as stale discovery because the candidate list never includes it.
   *
   * The Tool definition is registered `public` for every scope because one Tool name serves
   * both the Owner-private and the group surface, and authorization denies a *private*
   * resource in a group context outright — a private registration would make the group Run's
   * discovery impossible. Visibility is metadata, not authority: the group Run still needs
   * its own `tool:discover` grant, which is what this method writes.
   */
  private async grantCapabilityDiscovery(input: {
    principalId: string;
    scope: TrustedChannelScope;
  }): Promise<void> {
    const isOwner = await this.store.identities.isOwner(input.principalId);
    const names = availableCapabilityToolNames({
      isOwner,
      chatType: input.scope.chatType,
      enabledCategories: [...QQ_CAPABILITY_CATEGORIES],
    });
    for (const name of names) {
      const resourceId = toolResourceId(name);
      await this.store.authorization.registerResource({
        id: resourceId,
        kind: "tool-definition",
        visibility: "public",
        ifAbsent: true,
      });
      const existing = await this.store.authorization.check({
        caller: { principalId: input.principalId, scope: input.scope },
        resourceId,
        action: TOOL_DISCOVERY_ACTION,
      });
      if (existing.decision !== "ALLOW")
        await this.store.authorization.grant({
          principalId: input.principalId,
          resourceId,
          action: TOOL_DISCOVERY_ACTION,
          scope: input.scope,
          effect: "allow",
        });
    }
  }

  /**
   * One Owner's explicit decision to manage, or stop managing, one QQ group.
   *
   * Assignment is per Owner and authorization-backed: it is the `group:manage` grant on the
   * group Resource in the acting Owner's own private scope. Enabling never grants a sibling
   * Owner, and revoking never removes a sibling Owner's independent assignment or grants.
   * The connection-wide transport group stays enabled while any Owner remains assigned, and
   * only its last Owner's revocation tears the group-scope grants down.
   */
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

      const groupResource = groupResourceId(input.groupId);
      const actingOwner = { principalId: caller.principalId, scope: caller.scope };
      const groupScopes = this.groupScopes(configured, input.groupId);
      // True only once no Owner is left assigned. Enabling always touches the transport; a
      // disable touches it only when the acting Owner was the group's last one.
      let lastAssignedOwner = false;

      if (input.enabled) {
        await this.store.authorization.registerResource({
          id: groupResource,
          kind: "qq_group",
          visibility: "public",
          ifAbsent: true,
        });
        // Assignment records only the acting Owner's claim on this group.
        await this.store.authorization.grant({
          principalId: actingOwner.principalId,
          resourceId: groupResource,
          action: GROUP_ASSIGN_ACTION,
          scope: actingOwner.scope,
          effect: "allow",
        });
        // The fixed P4 bundle is persisted once for the group and never overwritten, so a
        // second Owner joining later keeps their own view of the policy the first one set.
        if (!(await this.store.capabilities.read(configured.config.connectionId, input.groupId)))
          await this.store.capabilities.write({
            connectionId: configured.config.connectionId,
            groupId: input.groupId,
            principalId: actingOwner.principalId,
            policy: DEFAULT_OWNER_GROUP_POLICY,
          });
        // Grant the bundle's category Actions on this group Resource for the acting Owner's
        // private scope only. `group.history` carries `history:read`, so the acting Owner's
        // cross-group search gains this group in the same step.
        await this.applyCategoryAuthority({
          context,
          groupId: input.groupId,
          actions: this.bundleActions(),
          enabled: true,
        });
        // Assignment also carries delivery: this Owner's private chat may receive a result
        // derived from this assigned group. It travels with the assignment rather than with a
        // category, so disabling one category cannot leave a cross-group answer unanswerable
        // while its sibling categories stay enabled. The disable branch below uses one
        // `revokeScope` on this Resource in this scope and removes it with everything else.
        await this.grantGroupDelivery({
          principalId: actingOwner.principalId,
          scope: actingOwner.scope,
          groupId: input.groupId,
        });
        // A Run inside the group needs its own group-scope grants, for the Owner and for
        // every Visitor the transport serves. These are group scope, not Owner assignment.
        for (const scope of groupScopes)
          await this.grantScope(scope, this.principalForScope(configured, scope));
      } else {
        // Revoke exactly the acting Owner's assignment, bundle and history grant.
        await this.store.authorization.revokeScope({
          principalId: actingOwner.principalId,
          resourceId: groupResource,
          scope: actingOwner.scope,
        });
        const actingGroupScope = groupScopes.find(
          (scope) => scope.senderId === caller.scope.senderId,
        );
        if (actingGroupScope)
          await this.revokeGroupScopeAuthority(configured, groupResource, actingGroupScope);
        // Only the last assigned Owner's revocation removes the connection-wide group and
        // its group-scope grants. A sibling Owner's assignment keeps the group alive.
        lastAssignedOwner = (await this.assignedOwners(configured, input.groupId)).length === 0;
        if (lastAssignedOwner) {
          await this.store.authorization.revokeResource(groupResource);
          // Dynamic group members are not part of the static profile. Revoke the whole
          // Channel location so no sender-specific Agent or Tool grant survives disable.
          await this.store.authorization.revokeLocationScopes({
            connectionId: configured.config.connectionId,
            botId: configured.config.botId,
            chatType: "group",
            chatId: input.groupId,
          });
        }
      }

      // The transport group stays enabled while any Owner remains assigned: a sibling
      // Owner's assignment is what keeps the bot in the group, not the acting Owner's.
      if (input.enabled || lastAssignedOwner) {
        const profile = await this.channels.setGroupEnabled(
          caller.scope.connectionId,
          input.groupId,
          input.enabled,
        );
        connection.setAllowedGroups(profile.groupIds);
      }
      await this.recordOwnerControl(context, {
        type: "group_access_changed",
        connectionId: caller.scope.connectionId,
        groupId: input.groupId,
        enabled: input.enabled,
      });
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

  /** The group-scope identities a transport-enabled group serves: every Owner and Visitor. */
  private groupScopes(
    configured: ReturnType<ChannelProfileStore["resolve"]>,
    groupId: string,
  ): TrustedChannelScope[] {
    const senderIds = [
      configured.config.ownerId,
      ...(configured.config.coOwnerId ? [configured.config.coOwnerId] : []),
      ...configured.config.visitorIds,
    ];
    return senderIds.map((senderId) => ({
      connectionId: configured.config.connectionId,
      botId: configured.config.botId,
      chatType: "group" as const,
      chatId: groupId,
      senderId,
    }));
  }

  /** The Principal one group-scope identity resolves to. */
  private principalForScope(
    configured: ReturnType<ChannelProfileStore["resolve"]>,
    scope: TrustedChannelScope,
  ): string {
    if (scope.senderId === configured.config.ownerId) return OWNER_ID;
    if (configured.config.coOwnerId && scope.senderId === configured.config.coOwnerId)
      return `owner-${configured.config.coOwnerId}`;
    return `qq-visitor-${scope.senderId}`;
  }

  /** Revokes one identity's group-scope grants for one group, leaving other groups alone. */
  private async revokeGroupScopeAuthority(
    configured: ReturnType<ChannelProfileStore["resolve"]>,
    groupResource: string,
    scope: TrustedChannelScope,
  ): Promise<void> {
    const principalId = this.principalForScope(configured, scope);
    for (const resourceId of [
      agentResourceId(AGENT_ID),
      SKILL_CATALOG_RESOURCE,
      toolResourceId(SKILL_READ_TOOL),
      // The group Run's Tool discovery is granted as a superset for the same reason the
      // Owner-private one is, so it is revoked here for the same reason: leaving it behind
      // would let a re-configured group rediscover a surface it no longer has authority for.
      ...this.groupRunToolNames().map((name) => toolResourceId(name)),
      groupResource,
    ])
      await this.store.authorization.revokeScope({ principalId, resourceId, scope });
  }

  /**
   * The read-only protected Actions a Run inside a configured group may perform on that group.
   *
   * Derived from the same category registry the Tools are, so the grant and the Tool surface
   * cannot drift. Mutation categories are absent from `GROUP_RUN_CAPABILITY_CATEGORIES`, so a
   * group Run can never acquire one through this path.
   */
  private groupRunReadActions(): string[] {
    return [
      ...new Set(
        GROUP_RUN_CAPABILITY_CATEGORIES.flatMap((category) => this.categoryActions(category)),
      ),
    ];
  }

  /**
   * The capability and history Tools a configured group scope may discover.
   *
   * A superset of what any policy enables, matching `grantCapabilityDiscovery`: the Run's
   * candidate list narrows it to current policy and each call is still re-authorized. It is
   * computed from the same registries the candidate list uses, so a Tool cannot be
   * discoverable-but-ungranted or granted-but-undiscoverable.
   */
  private groupRunToolNames(): string[] {
    return [
      ...new Set([
        ...availableHistoryToolNames({
          isOwner: false,
          chatType: "group",
          enabledCategories: [...QQ_CAPABILITY_CATEGORIES],
        }),
        ...availableCapabilityToolNames({
          isOwner: false,
          chatType: "group",
          enabledCategories: [...QQ_CAPABILITY_CATEGORIES],
        }),
      ]),
    ];
  }

  /** Every Owner whose assignment currently covers this group. */
  private async assignedOwners(
    configured: ReturnType<ChannelProfileStore["resolve"]>,
    groupId: string,
  ): Promise<string[]> {
    const assigned: string[] = [];
    for (const owner of this.ownerPrivateScopes(configured)) {
      if (
        await this.store.authorization.hasActiveGrant({
          principalId: owner.principalId,
          resourceId: groupResourceId(groupId),
          action: GROUP_ASSIGN_ACTION,
          scope: owner.scope,
        })
      )
        assigned.push(owner.principalId);
    }
    return assigned;
  }

  /** The protected Actions the fixed P4 bundle confers on a group Resource. */
  private bundleActions(): string[] {
    return [
      ...new Set(
        DEFAULT_OWNER_GROUP_CATEGORIES.flatMap((category) => this.categoryActions(category)),
      ),
    ];
  }

  /** Every capability category enabled for a group the current Principal is assigned to. */
  private async assignedCategories(caller: CallerContext): Promise<QqCapabilityCategory[]> {
    const assigned = new Set(await resolveAssignedGroupIds(this.store, caller));
    if (assigned.size === 0) return [];
    const enabled = new Set<QqCapabilityCategory>();
    for (const stored of await this.store.capabilities.list(caller.scope.connectionId)) {
      if (!assigned.has(stored.groupId)) continue;
      for (const category of enabledCategories(stored.policy)) enabled.add(category);
    }
    return [...enabled];
  }

  /**
   * Pulls real group history through the existing authenticated OneBot connection into
   * the durable archive. Only called for a group whose `history:read` decision was ALLOW.
   *
   * Older history is reachable: the walk follows the provider's `nextCursor` backwards for
   * up to `maxPages` pages, so a single recent page is never the only thing archived. It
   * stops on a failed/empty page, on a cursor that cannot advance (no provider sequence, or
   * the same cursor twice), on a page older than `since`, and on the page bound — so it can
   * never loop forever. Ingest is deduped by (channel, connection, group, external message
   * id) and by message id within one walk, so repeated syncs are idempotent and never
   * create Runs.
   *
   * It returns why it stopped, because the caller reports that as the search's source
   * coverage. Only `end_of_source` means the archive now holds this group back to its
   * beginning; every other stop leaves history the search cannot see, and a caller that
   * could not tell those apart would report the window as exhausted either way.
   */
  private async syncGroupHistory(
    connectionId: string,
    groupId: string,
    options: { maxPages?: number; since?: string; until?: string } = {},
  ): Promise<HistorySyncOutcome> {
    const connection = this.connections.get(connectionId);
    if (!connection) return { pagesWalked: 0, stop: "provider_unavailable" };
    const maxPages = Math.max(1, Math.min(options.maxPages ?? HISTORY_SYNC_MAX_PAGES, 20));
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pagesWalked = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await connection.getGroupHistory({
        groupId,
        cursor,
        count: HISTORY_SYNC_PAGE_SIZE,
      });
      if (result.status !== "ok")
        return {
          pagesWalked,
          stop:
            result.status === "unknown"
              ? "provider_unknown"
              : result.code === "not_connected"
                ? "provider_unavailable"
                : "provider_failed",
        };
      pagesWalked += 1;
      let reachedBound = false;
      for (const message of result.messages) {
        if (options.since && message.occurredAt < options.since) {
          reachedBound = true;
          continue;
        }
        if (options.until && message.occurredAt > options.until) continue;
        if (seen.has(message.messageId)) continue;
        seen.add(message.messageId);
        await this.archive.ingest({
          channel: "qq-onebot",
          connectionId,
          groupId,
          externalMessageId: message.messageId,
          senderId: message.senderId,
          senderName: message.senderName,
          mentionTargetIds: message.mentionTargetIds,
          normalizedText: message.text,
          occurredAt: message.occurredAt,
        });
      }
      // The bound is checked before the cursor, because it is the reason the walk stopped:
      // a page that reached `since` and also carried a next cursor was still stopped by the
      // caller's bound, and reporting it as the end of the source would overstate the walk.
      const next = result.nextCursor;
      // No usable sequence to continue from. The adapter omits the cursor both for a page
      // that carried nothing and for a page that carried records it could not sequence, and
      // only the first of those is the provider saying it has nothing older. Calling the
      // second one the end of the source is how a walk that stalled would let a search
      // report the group as fully read.
      if (next === undefined)
        return {
          pagesWalked,
          stop: result.messages.length === 0 ? "end_of_source" : "provider_unknown",
        };
      if (next === cursor) return { pagesWalked, stop: "cursor_stuck" };
      cursor = next;
      if (reachedBound) return { pagesWalked, stop: "since_bound_reached" };
    }
    return { pagesWalked, stop: "page_bound_reached" };
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
    if (input.action === "set_capability") return this.setGroupCategory(context, input);
    if (input.action === "set_memory_source") return this.setGroupMemorySource(context, input);
    if (input.action === "set_history") return this.setGroupHistory(context, input);
    const runtime = this.groupRuntime.get(
      caller.scope.connectionId,
      input.groupId,
      this.kitLoader.loadProfile("qq-group").enabledSkills,
    );
    const stored = await this.store.capabilities.read(caller.scope.connectionId, input.groupId);
    // The managed inventory is the current Principal's own assignment, never the
    // connection-wide transport list and never every group the bot happens to have joined.
    const managedGroups = await resolveAssignedGroupIds(this.store, caller);
    return {
      groupId: input.groupId,
      enabled: managedGroups.includes(input.groupId),
      enabledSkills: runtime.enabledSkills,
      availableSkills: this.kitLoader.availableSkills().map((skill) => skill.name),
      version: runtime.version,
      managedGroups,
      categories: stored?.policy.categories ?? {},
      memorySources: stored?.policy.memorySources ?? {},
      capabilityVersion: stored?.version ?? 0,
    };
  }

  /** The protected Actions one capability category confers on a group Resource. */
  private categoryActions(category: QqCapabilityCategory): string[] {
    return [
      ...new Set(
        qqCapabilitiesForCategory(category)
          // Account-scoped capabilities describe the Agent's own connection; granting their
          // Action on a group Resource would be a dead grant, so the bundle never writes one.
          .filter((capability) => capability.resource === "group")
          .map((capability) => capability.action),
      ),
    ];
  }

  /** Owner-private scopes for a connection. Capability Tools exist only there. */
  private ownerPrivateScopes(
    configured: ReturnType<ChannelProfileStore["resolve"]>,
  ): Array<{ principalId: string; scope: TrustedChannelScope }> {
    const ownerIds = [
      configured.config.ownerId,
      ...(configured.config.coOwnerId ? [configured.config.coOwnerId] : []),
    ];
    return ownerIds.map((ownerId, index) => ({
      principalId: index === 0 ? OWNER_ID : `owner-${ownerId}`,
      scope: {
        connectionId: configured.config.connectionId,
        botId: configured.config.botId,
        chatType: "private" as const,
        chatId: ownerId,
        senderId: ownerId,
      },
    }));
  }

  /**
   * Moves the grant that backs one Owner capability decision.
   *
   * Only the acting Owner's private scope moves: a sibling Owner's grants on the same group
   * Resource are untouched, so one Owner's decision never silently changes another's.
   * Enabling grants exactly the category's Actions; disabling revokes exactly those Actions,
   * so a sibling category on the same Resource keeps its grant.
   */
  private async applyCategoryAuthority(input: {
    context: ProtectedToolContext;
    groupId: string;
    actions: readonly string[];
    enabled: boolean;
  }): Promise<void> {
    const resourceId = groupResourceId(input.groupId);
    const principalId = input.context.caller.principalId;
    const scope = input.context.caller.scope;
    for (const action of input.actions) {
      if (input.enabled) {
        const existing = await this.store.authorization.check({
          caller: input.context.caller,
          resourceId,
          action,
        });
        if (existing.decision !== "ALLOW")
          await this.store.authorization.grant({
            principalId,
            resourceId,
            action,
            scope,
            effect: "allow",
          });
      } else {
        await this.store.authorization.revokeScopeAction({
          principalId,
          resourceId,
          action,
          scope,
        });
      }
    }
  }

  private async requireManagedGroup(
    context: ProtectedToolContext,
    groupId: string,
  ): Promise<ReturnType<ChannelProfileStore["resolve"]>> {
    const caller = context.caller;
    const isOwner = await this.store.identities.isOwner(caller.principalId);
    if (!isOwner || caller.scope.chatType !== "private") throw new Error("owner_private_required");
    const configured = this.channels.resolve(caller.scope.connectionId);
    // A group is managed for this Owner only while this Owner's own assignment is active.
    if (
      !(await this.store.authorization.hasActiveGrant({
        principalId: caller.principalId,
        resourceId: groupResourceId(groupId),
        action: GROUP_ASSIGN_ACTION,
        scope: caller.scope,
      }))
    )
      throw new Error("group_not_enabled");
    return configured;
  }

  private async recordOwnerControl(
    context: ProtectedToolContext,
    event: Record<string, unknown>,
  ): Promise<void> {
    const cursor = await this.trace.append(
      context.runId,
      { ...event, runId: context.runId, principalId: context.caller.principalId },
      "glassbox-owner-control",
    );
    await this.store.evidence.advanceTrace(context.caller, cursor);
  }

  private async setGroupCategory(
    context: ProtectedToolContext,
    input: { groupId: string; category: QqCapabilityCategory; enabled: boolean },
  ): Promise<unknown> {
    return this.serialize(async () => {
      await this.requireManagedGroup(context, input.groupId);
      const { version } = await this.store.capabilities.setCategory({
        connectionId: context.caller.scope.connectionId,
        groupId: input.groupId,
        principalId: context.caller.principalId,
        category: input.category,
        enabled: input.enabled,
      });
      await this.applyCategoryAuthority({
        context,
        groupId: input.groupId,
        actions: this.categoryActions(input.category),
        enabled: input.enabled,
      });
      await this.recordOwnerControl(context, {
        type: "group_capability_changed",
        connectionId: context.caller.scope.connectionId,
        groupId: input.groupId,
        category: input.category,
        enabled: input.enabled,
        policyVersion: version,
      });
      return { groupId: input.groupId, category: input.category, enabled: input.enabled, version };
    });
  }

  private async setGroupMemorySource(
    context: ProtectedToolContext,
    input: { groupId: string; sourceClass: QqSourceClass; enabled: boolean },
  ): Promise<unknown> {
    return this.serialize(async () => {
      await this.requireManagedGroup(context, input.groupId);
      const { version } = await this.store.capabilities.setMemorySource({
        connectionId: context.caller.scope.connectionId,
        groupId: input.groupId,
        principalId: context.caller.principalId,
        sourceClass: input.sourceClass,
        enabled: input.enabled,
      });
      await this.recordOwnerControl(context, {
        type: "group_memory_source_changed",
        connectionId: context.caller.scope.connectionId,
        groupId: input.groupId,
        sourceClass: input.sourceClass,
        enabled: input.enabled,
        policyVersion: version,
      });
      return {
        groupId: input.groupId,
        sourceClass: input.sourceClass,
        enabled: input.enabled,
        version,
      };
    });
  }

  /**
   * One Owner-facing decision for "may this group's history be searched".
   *
   * History spans two separate mechanisms — the `group.history` capability category that
   * exposes the Tool, and the `history` memory source class the P4A reader may draw on —
   * so this action moves both together and keeps their grants in step.
   */
  private async setGroupHistory(
    context: ProtectedToolContext,
    input: { groupId: string; enabled: boolean },
  ): Promise<unknown> {
    return this.serialize(async () => {
      await this.requireManagedGroup(context, input.groupId);
      const common = {
        connectionId: context.caller.scope.connectionId,
        groupId: input.groupId,
        principalId: context.caller.principalId,
        enabled: input.enabled,
      };
      await this.store.capabilities.setCategory({ ...common, category: "group.history" });
      const { version } = await this.store.capabilities.setMemorySource({
        ...common,
        sourceClass: "history",
      });
      await this.applyCategoryAuthority({
        context,
        groupId: input.groupId,
        actions: this.categoryActions("group.history"),
        enabled: input.enabled,
      });
      await this.recordOwnerControl(context, {
        type: "group_history_changed",
        connectionId: context.caller.scope.connectionId,
        groupId: input.groupId,
        enabled: input.enabled,
        policyVersion: version,
      });
      return { groupId: input.groupId, enabled: input.enabled, version };
    });
  }

  /**
   * The durable facts for every group the current Principal is assigned to.
   *
   * This is the one projection both the managed-group inventory and the capability search
   * read, so the two cannot disagree about which groups exist, what each one's policy says,
   * or what this Principal is actually authorized to do. The set is the Principal's own
   * `group:manage` assignment — never the connection-wide transport list and never every
   * group the bot has joined. Every protected fact is re-authorized here, so the Owner role
   * alone is never a bypass.
   *
   * Each fact is the real `authorization.check` decision for this Principal, this concrete
   * `group:<id>` Resource and this Run — the same call the capability and history Tools make,
   * recording the same `authorization_decisions` evidence, with the current Conversation and
   * Run attached when the caller has them. `hasActiveGrant` is deliberately not used: it
   * answers the management reverse-state question ("does anyone still hold this assignment")
   * and bypasses identity and visibility evaluation, so a grant it finds is not an
   * authorization decision.
   */
  private async managedGroupFacts(context: AuthorizationContext): Promise<ManagedGroupFacts[]> {
    const caller = context.caller;
    const connectionId = caller.scope.connectionId;
    const groupIds = await resolveAssignedGroupIds(this.store, caller);
    const policies = new Map(
      (await this.store.capabilities.list(connectionId)).map((entry) => [entry.groupId, entry]),
    );
    const defaultSkills = this.kitLoader.loadProfile("qq-group").enabledSkills;
    const facts: ManagedGroupFacts[] = [];
    for (const groupId of groupIds) {
      const resourceId = groupResourceId(groupId);
      // One decision per distinct Action, reused across the categories of this single
      // projection so a category and `historyRead` cannot disagree about the same Action.
      // The map dies with the call: nothing is cached across projections or Runs, so a
      // revoke, a new Conversation or a new Run is always re-evaluated.
      const decisions = new Map<string, boolean>();
      const allowed = async (action: string): Promise<boolean> => {
        const known = decisions.get(action);
        if (known !== undefined) return known;
        const decision = await this.store.authorization.check({
          caller,
          resourceId,
          action,
          conversationId: context.conversationId,
          runId: context.runId,
        });
        const granted = decision.decision === "ALLOW";
        decisions.set(action, granted);
        return granted;
      };
      // A category counts as granted only when every group-scoped Action it confers is
      // currently ALLOW for this Principal in this scope. A partially-revoked category is
      // therefore reported as not granted rather than as half-usable.
      const grantedCategories: QqCapabilityCategory[] = [];
      for (const category of QQ_CAPABILITY_CATEGORIES) {
        const actions = this.categoryActions(category);
        if (actions.length === 0) continue;
        let granted = true;
        for (const action of actions) granted = granted && (await allowed(action));
        if (granted) grantedCategories.push(category);
      }
      const runtime = this.groupRuntime.get(connectionId, groupId, defaultSkills);
      facts.push({
        groupId,
        policy: policies.get(groupId)?.policy ?? DEFAULT_GROUP_CAPABILITY_POLICY,
        version: policies.get(groupId)?.version ?? 0,
        grantedCategories,
        // The `history:read` decision itself — the same Action the history Tools check — not
        // a flag inferred from the category that happens to contain it.
        historyRead: await allowed(HISTORY_READ_ACTION),
        groupRead: await allowed(GROUP_READ_ACTION),
        skills: { enabledSkills: [...runtime.enabledSkills], version: runtime.version },
      });
    }
    return facts;
  }

  /**
   * One group's live provider observation, or explicit `null`s when it could not be observed.
   *
   * A disconnected provider, a provider error, a reply about a different group and an
   * unreported name all collapse to the same "unknown" rather than to `false`, an empty name
   * or a success — Glassbox never claims an observation it did not make. Only the existing
   * authenticated OneBot connection is used, through the narrow typed `getGroupInfo` read
   * path: no raw RPC and no second QQ client.
   *
   * `botMembership` is `true` only on a typed success for the exact group: a provider that
   * answered about this group is proof the bot is in it. Every failure stays `null`, including
   * an explicit rejection, because this read path cannot distinguish "not a member" from a
   * rate limit, a timeout or a transient provider error — reporting `false` for any of those
   * would be an unproven claim. The field is typed `boolean | null` so a future unambiguous
   * not-a-member signal can use `false` without changing the shape.
   */
  private async observeGroup(
    connection: OneBotAdapter | undefined,
    groupId: string,
  ): Promise<{ name: string | null; reachable: boolean | null; botMembership: boolean | null }> {
    if (!connection) return { name: null, reachable: null, botMembership: null };
    try {
      const result = await connection.getGroupInfo({ groupId });
      if (result.status !== "ok") return { name: null, reachable: null, botMembership: null };
      return { name: result.name, reachable: true, botMembership: true };
    } catch {
      return { name: null, reachable: null, botMembership: null };
    }
  }

  /**
   * The current Principal's managed-group inventory.
   *
   * Durable policy truth — categories, memory sources, the Skill whitelist and its version,
   * and the Principal's own access — always appears. Only the live provider observation of a
   * group's name, reachability and Bot membership can be missing, and a provider failure for
   * one group never erases the rest of the inventory or fails the whole projection.
   *
   * Live metadata is read only after the current `group:read` decision for this Principal and
   * group is ALLOW, so a protected group fact is re-authorized before any provider call and a
   * denied group never causes one.
   */
  private async projectManagedGroups(context: AuthorizationContext): Promise<unknown> {
    const connection = this.connections.get(context.caller.scope.connectionId);
    const facts = await this.managedGroupFacts(context);
    const groups = [];
    for (const fact of facts) {
      const observation = fact.groupRead
        ? await this.observeGroup(connection, fact.groupId)
        : { name: null, reachable: null, botMembership: null };
      groups.push({
        groupId: fact.groupId,
        name: observation.name,
        reachable: observation.reachable,
        botMembership: observation.botMembership,
        access: {
          // The inventory *is* this Principal's own assignment — that is what
          // `resolveAssignedGroupIds` selected — so the entry states it explicitly rather
          // than leaving the reader to infer it from presence. It is never derived from Bot
          // membership or from another Owner's assignment.
          assigned: true,
          grantedCategories: fact.grantedCategories,
          historyRead: fact.historyRead,
        },
        categories: fact.policy.categories,
        memorySources: fact.policy.memorySources,
        skills: fact.skills,
        version: fact.version,
      });
    }
    return { connectionId: context.caller.scope.connectionId, groups };
  }

  /**
   * The read-only QQ acceptance: really calling each provider-backed read path once.
   *
   * A capability that is registered, allowlisted and covered by deterministic tests is still
   * not known to work against the bridge in front of it, and a Run must not report the first
   * as the second. This is the fresh, time-stamped observation that answers the difference.
   *
   * Three things keep it honest. The provider call goes through `invokeCapability` — the same
   * allowlisted outbound path a capability Tool uses, including the group binding — so the
   * acceptance can only prove calls Glassbox would really make. Every path is authorized first,
   * against the same Resource the Tool would derive and under the same Owner policy, so the
   * acceptance is a measurement *inside* the authorization boundary rather than a way around
   * it: a group the Owner has not assigned reports `denied` and calls nothing, and a report can
   * therefore never show a bridge working for a read no Run could perform. And each observation
   * is appended to the Trace as it is made, so the evidence survives the probe failing partway
   * rather than depending on the caller reporting back.
   *
   * The provider's raw result is classified here rather than thrown through
   * `requireProviderSuccess`: an acceptance has to record *which* way a call failed, and a
   * thrown failure would collapse every one of them into the same opaque code.
   *
   * The one provider-free path (`qq_groups`' managed listing) is probed too, because the
   * issue asks for it — under a management context, since this probe is not a Run and must not
   * borrow a Run's identity. Its success is recorded with `providerBacked: false` and never
   * counted as provider health.
   */
  async probeCapabilities(channelId: string, groupId: string): Promise<CapabilityProbeReport> {
    const configured = this.channels.resolve(channelId);
    // The target is the dedicated acceptance group the operator named, and it must be one this
    // Channel is configured for. A group Glassbox does not manage is refused here rather than
    // discovered by the provider.
    if (!configured.config.groupIds.includes(groupId))
      throw new ManagementError("INVALID_REQUEST", "The group is not configured for this channel");
    const connection = this.connections.get(channelId);
    if (!connection) throw new ManagementError("NOT_FOUND", "The channel is not connected", 404);

    const owner = this.ownerPrivateScopes(configured)[0];
    if (!owner) throw new ManagementError("INVALID_REQUEST", "The channel has no owner");
    // The acceptance runs as the Owner, in the Owner's scope, and in no Run: the decisions it
    // records carry no Conversation and no Run because it has neither. That is what lets a
    // reader tell an acceptance apart from an Agent execution in `authorization_decisions`,
    // and it is why the decision row can be written at all — those columns reference real
    // `conversations` and `runs` rows, so a placeholder name would either fail the reference
    // or, worse, be a decision claiming a context that never existed.
    const context: AuthorizationContext = {
      caller: { principalId: owner.principalId, scope: owner.scope },
    };

    return probeReadCapabilities({
      groupId,
      // Acceptance asks the same question a Run's Tool call is re-authorized with, on the same
      // Resource derivation and under the same Owner policy, and records the answer instead of
      // assuming it. Being configured for a group is a transport fact, not authority: a group
      // the Owner has not assigned has no grants, so every path against it is denied here
      // exactly as it would be for a Run — which is what makes a `complete` acceptance evidence
      // that the bridge works on a group Glassbox would really read.
      decide: async (path, target) => {
        const decision = await this.store.authorization.check({
          caller: context.caller,
          resourceId: capabilityResourceId({
            resource: path.resource,
            scope: context.caller.scope,
            groupId: target ?? undefined,
            listing: path.listing,
          }),
          action: path.action,
        });
        if (decision.decision !== "ALLOW") return "denied";
        // Owner intent is a second, independent gate: the grant alone is not enough. The
        // managed listing names no group, so it has no per-group policy to consult.
        if (path.listing) return "allowed";
        return (await this.isCategoryEnabled(channelId, groupId, path.category))
          ? "allowed"
          : "denied";
      },
      invoke: (input) => connection.invokeCapability(input),
      projectManagedGroups: () => this.projectManagedGroups(context),
      record: async (observation: CapabilityProbeObservation) => {
        await this.store.tasks.recordTrace({
          type: "capability.probed",
          principalId: owner.principalId,
          data: { connectionId: channelId, ...observation },
        });
      },
    });
  }

  /**
   * The capability search the Owner-private `qq_capability_search` Tool runs.
   *
   * The candidate set is the allowlisted Glassbox registry — never raw NapCat actions — and
   * every entry must clear four independent gates before it can appear: Tool discovery for
   * this Run, the capability's own protected Action on its Resource, the Owner's durable
   * policy, and the Principal's live authorization decision. A disabled category, a revoked
   * grant, another Owner's group and a server-only or deferred action all contribute nothing,
   * and matching runs only over what survived, so a query can never reveal a capability the
   * caller lacks.
   */
  private async searchCapabilities(
    context: ProtectedToolContext,
    input: { query: string | undefined; groupIds: readonly string[] | undefined },
  ): Promise<unknown> {
    const caller = context.caller;
    const facts = await this.managedGroupFacts(context);
    const requested = input.groupIds ? new Set(input.groupIds) : undefined;
    // A requested filter narrows the caller's own assignment; it never widens it.
    const considered = requested ? facts.filter((fact) => requested.has(fact.groupId)) : facts;

    const entries: CapabilitySearchEntry[] = [];
    for (const capability of QQ_CAPABILITIES) {
      // Discovery is re-checked per Run rather than trusted from the Tool surface.
      const discovery = await this.store.authorization.check({
        caller,
        resourceId: toolResourceId(capability.tool),
        action: TOOL_DISCOVERY_ACTION,
        conversationId: context.conversationId,
        runId: context.runId,
      });
      if (discovery.decision !== "ALLOW") continue;

      if (capability.resource === "account") {
        const decision = await this.store.authorization.check({
          caller,
          resourceId: agentResourceId(AGENT_ID),
          action: capability.action,
          conversationId: context.conversationId,
          runId: context.runId,
        });
        if (decision.decision !== "ALLOW") continue;
        entries.push({
          tool: capability.tool,
          description: capability.description,
          category: capability.category,
          readOnly: capability.risk === "read",
          // An Agent-scoped entry is not group-bound, so it carries no group association.
          groupIds: [],
        });
        continue;
      }

      // A group-scoped entry is usable only where the Owner's policy enables its category
      // *and* this Principal holds that category's live grant.
      const usableIn = considered.filter(
        (fact) =>
          isCategoryEnabled(fact.policy, capability.category) &&
          fact.grantedCategories.includes(capability.category),
      );
      if (usableIn.length === 0) continue;
      entries.push({
        tool: capability.tool,
        description: capability.description,
        category: capability.category,
        readOnly: capability.risk === "read",
        groupIds: usableIn.map((fact) => fact.groupId),
      });
    }

    return {
      query: input.query ?? null,
      groups: considered.map((fact) => fact.groupId),
      capabilities: matchCapabilityEntries(entries, input.query),
    };
  }

  private async setGroupSkill(
    context: ProtectedToolContext,
    input: Extract<OwnerGroupAdminInput, { action: "set_skill" }>,
  ): Promise<unknown> {
    return this.serialize(async () => {
      const caller = context.caller;
      await this.requireManagedGroup(context, input.groupId);
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
      if (request.method === "POST" && path === "/manage/capabilities/probe") {
        const input = await readManagementJson(request);
        const value = (input ?? {}) as Record<string, unknown>;
        if (typeof value.channelId !== "string" || typeof value.groupId !== "string")
          throw new ManagementError("INVALID_REQUEST", "A channel and a group are required");
        return ok({
          probe: await this.probeCapabilities(value.channelId, value.groupId),
        });
      }
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
