/**
 * Runtime Tools for the QQ Capability Registry.
 *
 * Glassbox never hands the model a QQ runtime. Each Tool here is a fixed, allowlisted
 * projection over NapCat's public OneBot action contract: the model names a Tool and an
 * operation inside it, and Glassbox decides the Resource, the protected Action, the
 * provider target and the parameter set.
 *
 * Security properties enforced here:
 *  - The Tool surface is scope-gated: an ordinary group member sees only read capabilities,
 *    a QQ admin or group owner may see a fixed current-group mutation subset, an Owner-private
 *    Run sees its managed-group surface, and a Visitor-private Run sees none. Discovery is
 *    never authority, so every call is re-authorized.
 *  - The group is named once, at the top level, and Glassbox derives both the authorization
 *    Resource and the provider `group_id` from that single value. A group Run is bound to
 *    its own group and refuses a model-supplied one; a model-supplied `group_id` inside the
 *    provider params is refused rather than silently overwritten.
 *  - Policy (the Owner's intent) and grants (authority) are both required. Enabling a
 *    category for a group never creates a grant, and a grant never enables a category.
 *  - A mutating capability additionally requires the current user message to have asked for
 *    that exact operation on that exact group with exactly the parameters it named, so
 *    retrieved text cannot become authority and the model cannot add an optional provider
 *    parameter the message left unstated.
 *  - Only operations declared on the capability are reachable, so credential, packet,
 *    transport, restart and raw-send primitives have no path to the model — nor does an
 *    operation whose parameters have no authorization boundary, such as `upload_group_file`,
 *    whose `file` is a local server path.
 *  - The registry-search Tool never describes a provider action at all. Its results are built
 *    from the allowlisted registry and narrowed by assignment, policy, live grant and Tool
 *    discovery before any matching runs, so it cannot reveal a capability — or a group — the
 *    caller does not have.
 *  - The one provider-free operation on a provider-facing Tool is `qq_groups`' managed
 *    listing, and it is Owner-private: it is authorized on the Agent Resource, and a group
 *    Run resolves to a sentinel Resource, so a group Run can read its own group but never
 *    enumerate the Owner's managed set.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import { agentResourceId } from "../../persistence/index.js";
import type {
  QqCapability,
  QqCapabilityCategory,
  QqCapabilityResource,
} from "../../channels/onebot/capabilities.js";
import {
  QQ_CAPABILITIES,
  qqOperationParameterKind,
  resolveQqOperation,
} from "../../channels/onebot/capabilities.js";
import type { QqNativeGroupRole } from "../../channels/onebot/group-role.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
import { ProviderCallError } from "./provider-outcome.js";
import {
  consumeMutationIntent,
  createProtectedTool,
  requireMutationIntent,
  ToolAuthorizationError,
  ToolInputError,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { ToolExclusionReason } from "./tool-plane.js";
import type { PiRunContext } from "./types.js";

/** Sentinel Resource for a call outside the intended scope. Never registered, so it denies. */
export const UNRESOLVED_CAPABILITY_RESOURCE = "qq:capability:unresolved";

/**
 * The registry-search Tool.
 *
 * It is the one capability that issues no provider action: it searches Glassbox's own
 * allowlisted registry. It therefore gets a dedicated schema — a bounded text query and an
 * optional managed-group filter — rather than the `{operation, params}` envelope the
 * provider-facing capabilities use, because describing it as an operation-bearing Tool would
 * be a surface the model could never use.
 */
export const CAPABILITY_SEARCH_TOOL = "qq_capability_search";

const CAPABILITY_QUERY_MAX_LENGTH = 200;
const CAPABILITY_GROUP_FILTER_MAX = 32;

/**
 * The capability categories a Run *inside* a group may use.
 *
 * These are the classes every group member may use when policy enables them. Native QQ roles
 * do not widen this list. Their fixed mutation subset is declared per capability and requires
 * a fresh provider role verification before execution.
 */
export const GROUP_RUN_CAPABILITY_CATEGORIES: readonly QqCapabilityCategory[] = Object.freeze([
  "group.read",
  "group.members",
  "group.history",
  "group.content",
  "group.files.read",
]);

const GROUP_ID_PATTERN = /^[1-9]\d{0,15}$/u;

export type QqProviderParams = Record<string, string | number | boolean>;

export interface CapabilityToolInput extends Record<string, unknown> {
  groupId?: string;
  operation?: string;
  params?: QqProviderParams;
}

export interface CapabilitySearchToolInput extends Record<string, unknown> {
  /** A bounded free-text query. Absent means "every capability this caller may use". */
  query?: string;
  /** Optional managed-group filter. Intersected with the caller's own assignment. */
  groupIds?: readonly string[];
}

export interface CapabilityInvocation {
  capability: QqCapability;
  /** The allowlisted provider action, already checked against this capability. */
  action: string;
  /** The exact parameter set Glassbox will forward. Never taken verbatim from the model. */
  params: QqProviderParams;
  context: ProtectedToolContext;
}

/**
 * The capability Tools a Run may see. The model never chooses its own surface.
 *
 * A group Run sees its policy-enabled read capabilities and, when the trusted ingress
 * observation qualifies, its fixed native-role subset. Disabling a category hides the Tool
 * on the next Run. Account-scoped capabilities describe the Agent's own connection and are
 * always available to the Glassbox Owner in private chat.
 */
/**
 * Every registered capability Tool, each with why it is or is not eligible for this scope.
 *
 * `availableCapabilityToolNames` is a projection of this, never a second implementation: the
 * names a Run may call and the surface a Run records must not be able to disagree.
 *
 * The reason distinguishes a scope boundary from an Owner policy choice. They look identical
 * in a name list and are completely different to an Owner reading why a Tool was missing.
 */
export function capabilityToolEligibility(input: {
  isOwner: boolean;
  chatType: "group" | "private";
  enabledCategories: readonly QqCapabilityCategory[];
  nativeGroupRole?: QqNativeGroupRole;
}): { name: string; exclusion: ToolExclusionReason | null }[] {
  const enabled = new Set(input.enabledCategories);
  return QQ_CAPABILITIES.map((capability) => {
    if (input.chatType === "group") {
      // A group Run is confined to its group. Read Tools remain available to members. A
      // mutation is considered only when this message carried an allowed QQ-native role.
      if (capability.resource !== "group")
        return { name: capability.tool, exclusion: "scope_not_permitted" as const };
      const readOnly = GROUP_RUN_CAPABILITY_CATEGORIES.includes(capability.category);
      const nativeRoleAllowed =
        input.nativeGroupRole !== undefined &&
        capability.nativeGroupRoles?.includes(input.nativeGroupRole) === true;
      if (!readOnly && !nativeRoleAllowed)
        return { name: capability.tool, exclusion: "scope_not_permitted" as const };
      return {
        name: capability.tool,
        exclusion: enabled.has(capability.category) ? null : ("policy_disabled" as const),
      };
    }
    // A Visitor-private Run reaches no QQ capability at all.
    if (!input.isOwner) return { name: capability.tool, exclusion: "scope_not_permitted" as const };
    if (capability.ownerPrivate === false)
      return { name: capability.tool, exclusion: "scope_not_permitted" as const };
    // Account status is the Owner's own provider state and is always readable by the Owner.
    if (capability.resource === "account") return { name: capability.tool, exclusion: null };
    return {
      name: capability.tool,
      exclusion: enabled.has(capability.category) ? null : ("policy_disabled" as const),
    };
  });
}

export function availableCapabilityToolNames(input: {
  isOwner: boolean;
  chatType: "group" | "private";
  enabledCategories: readonly QqCapabilityCategory[];
  nativeGroupRole?: QqNativeGroupRole;
}): string[] {
  return capabilityToolEligibility(input)
    .filter((entry) => entry.exclusion === null)
    .map((entry) => entry.name);
}

function validatedProviderParams(value: unknown): QqProviderParams {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ToolInputError("invalid_capability_params");
  return value as QqProviderParams;
}

/**
 * The protected Resource one capability call is authorized against.
 *
 * The Resource is derived, never accepted: a group Run is bound to its own group, an
 * Owner-private caller may name only a group it holds a grant for, and a scope that is neither
 * resolves to a sentinel no grant can exist for, so it denies.
 *
 * This is the single derivation for every path that reaches a capability — the Tools a Run
 * calls and the read acceptance that proves those same paths work — so an acceptance can never
 * authorize one Resource while the Tool a Run would call authorizes another. `listing` marks
 * `qq_groups`' provider-free managed inventory, which names no group and is the Owner's own
 * view, so it lives on the Agent Resource rather than on a group.
 */
export function capabilityResourceId(input: {
  /** The capability's Resource class: `account` is the Agent itself, `group` is one group. */
  resource: QqCapabilityResource;
  scope: { chatType: string; chatId: string };
  /** The group the call targets, when the caller named one. */
  groupId?: string | undefined;
  /** True only for `qq_groups`' managed listing. */
  listing?: boolean;
}): string {
  const { scope } = input;
  if (input.resource === "account") return agentResourceId("personal");
  if (scope.chatType === "group")
    return input.listing === true ? UNRESOLVED_CAPABILITY_RESOURCE : groupResourceId(scope.chatId);
  if (scope.chatType !== "private") return UNRESOLVED_CAPABILITY_RESOURCE;
  if (input.listing === true) return agentResourceId("personal");
  return typeof input.groupId === "string" && GROUP_ID_PATTERN.test(input.groupId)
    ? groupResourceId(input.groupId)
    : UNRESOLVED_CAPABILITY_RESOURCE;
}

/** A blank query is "no filter", not an error; an over-long one is refused rather than cut. */
function validatedCapabilityQuery(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > CAPABILITY_QUERY_MAX_LENGTH)
    throw new ToolInputError("invalid_capability_query");
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The requested group filter. It narrows the caller's own assignment; it never widens it. */
function validatedCapabilityGroupFilter(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > CAPABILITY_GROUP_FILTER_MAX)
    throw new ToolInputError("invalid_capability_group_filter");
  for (const groupId of value)
    if (typeof groupId !== "string" || !GROUP_ID_PATTERN.test(groupId))
      throw new ToolInputError("invalid_capability_group_filter");
  return [...new Set(value as string[])];
}

/** Builds the dedicated registry-search Tool. It reaches no provider action. */
function createCapabilitySearchTool(options: {
  capability: QqCapability;
  authService: DomainStore["authorization"];
  getContext: () => ProtectedToolContext | undefined;
  search: (input: {
    query: string | undefined;
    groupIds: readonly string[] | undefined;
    context: ProtectedToolContext;
  }) => Promise<unknown>;
}): ToolDefinition {
  return createProtectedTool<CapabilitySearchToolInput>({
    name: options.capability.tool,
    label: options.capability.tool,
    description: options.capability.description,
    parameters: Type.Object(
      {
        query: Type.Optional(Type.String({ maxLength: CAPABILITY_QUERY_MAX_LENGTH })),
        groupIds: Type.Optional(
          Type.Array(Type.String({ pattern: "^[1-9]\\d{0,15}$" }), {
            minItems: 1,
            maxItems: CAPABILITY_GROUP_FILTER_MAX,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    action: options.capability.action,
    // The registry search describes the Agent's own capability surface, not a group's, so it
    // is gated on the Agent Resource. A non-private scope resolves to a sentinel that was
    // never registered and therefore denies — the Tool is Owner-private discovery only.
    resourceId: (_params, context) =>
      context.caller.scope.chatType === "private"
        ? agentResourceId("personal")
        : UNRESOLVED_CAPABILITY_RESOURCE,
    authService: options.authService,
    getContext: options.getContext,
    execute: (params, context) =>
      options.search({
        query: validatedCapabilityQuery(params.query),
        groupIds: validatedCapabilityGroupFilter(params.groupIds),
        context,
      }),
  });
}

/**
 * The `qq_groups` domain Tool: the Owner's managed-group listing, or one group's metadata.
 *
 * `qq_groups` is the one capability with a second, provider-free operation. Naming no
 * operation is the managed-group projection — the explicit "which groups do I manage" view,
 * which spans several group Resources and so cannot be gated on any one of them. It is an
 * Owner-private view: the Agent Resource carries the `group:read` grant that authorizes
 * enumerating this Owner's own managed groups, and a group Run resolves to a sentinel
 * Resource that was never registered, so it can never list the Owner's groups.
 *
 * Naming an operation is the ordinary provider path, unchanged.
 */
export const GROUP_INVENTORY_TOOL = "qq_groups";

function providerToolParameters(capability: QqCapability, allowListing = false) {
  const groupId = Type.Optional(
    Type.String({
      pattern: "^[1-9]\\d{0,15}$",
      description: "Required only in Owner private chat. Omit inside a group.",
    }),
  );
  const variants = capability.operations.map((operation) => {
    const modelParams = operation.params.filter((name) => name !== "group_id");
    const requiredParams = new Set(operation.required.filter((name) => name !== "group_id"));
    const params = Object.fromEntries(
      modelParams.map((name) => [
        name,
        requiredParams.has(name)
          ? providerParameterSchema(name)
          : Type.Optional(providerParameterSchema(name)),
      ]),
    );
    return Type.Object(
      {
        groupId,
        operation: Type.Literal(operation.action),
        ...(modelParams.length === 0
          ? { params: Type.Optional(Type.Object({}, { additionalProperties: false })) }
          : {
              params:
                requiredParams.size > 0
                  ? Type.Object(params, { additionalProperties: false })
                  : Type.Optional(Type.Object(params, { additionalProperties: false })),
            }),
      },
      { additionalProperties: false },
    );
  });
  if (allowListing)
    return Type.Union([Type.Object({ groupId }, { additionalProperties: false }), ...variants]);
  return variants.length === 1 ? variants[0]! : Type.Union(variants);
}

function providerParameterSchema(name: string) {
  switch (qqOperationParameterKind(name)) {
    case "boolean":
      return Type.Boolean();
    case "count":
      return Type.Number({ minimum: 1, multipleOf: 1 });
    case "duration":
      return Type.Number({ minimum: 0, multipleOf: 1 });
    case "message_sequence":
      return Type.Union([
        Type.String({ pattern: "^\\d{1,128}$" }),
        Type.Number({ minimum: 0, multipleOf: 1 }),
      ]);
    case "qq_id":
      return Type.Union([
        Type.String({ pattern: "^[1-9]\\d{0,15}$" }),
        Type.Number({ minimum: 1, multipleOf: 1 }),
      ]);
    case "opaque_id":
      return Type.Union([
        Type.String({ minLength: 1, maxLength: 2_048 }),
        Type.Number({ minimum: 0, multipleOf: 1 }),
      ]);
    case "text":
      return Type.String({ maxLength: 2_048 });
  }
}

function providerToolDescription(capability: QqCapability): string {
  const operations = capability.operations
    .map((operation) => {
      const modelParams = operation.params.filter((name) => name !== "group_id");
      const required = operation.required.filter((name) => name !== "group_id");
      return `${operation.action}: params may contain ${modelParams.join(", ") || "nothing"}; required ${required.join(", ") || "nothing"}`;
    })
    .join(". ");
  return `${capability.description} Set operation to one listed action. Put provider arguments in params. In a group omit groupId. In Owner private chat provide groupId. ${operations}.`;
}

function safeQqId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  if (typeof value === "string" && !/^\d+$/u.test(value)) return undefined;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return undefined;
  return String(numeric);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ProviderCallOptions {
  /** Durable Owner intent for one group's capability class. Not an authorization decision. */
  isCategoryEnabled: (
    connectionId: string,
    groupId: string,
    category: QqCapabilityCategory,
  ) => Promise<boolean>;
  /** Executes one validated allowlisted provider action. The only outbound provider path. */
  invoke: (input: CapabilityInvocation) => Promise<unknown>;
  /** Re-reads the caller's role from QQ immediately before one native-role mutation. */
  verifyNativeGroupRole?: (input: {
    context: ProtectedToolContext;
    groupId: string;
    capability: QqCapability;
    operation: string;
  }) => Promise<QqNativeGroupRole>;
}

/**
 * Runs one provider-facing capability call.
 *
 * Shared by the generic capability factory and the `qq_groups` domain Tool, so the group
 * binding, the operation allowlist, the Owner-policy gate and the mutation-intent gate have
 * exactly one implementation.
 */
async function executeProviderCall(
  capability: QqCapability,
  params: CapabilityToolInput,
  context: ProtectedToolContext,
  options: ProviderCallOptions,
): Promise<unknown> {
  const supplied = validatedProviderParams(params.params);
  let providerParams: QqProviderParams = supplied;
  let groupId: string | undefined;
  if (capability.resource === "group") {
    const scope = context.caller.scope;
    if (scope.chatType === "group") {
      // A group Run targets its own group. Naming another one is refused rather than
      // silently overwritten, so a call can never authorize one group and reach another.
      if (params.groupId !== undefined) throw new ToolInputError("invalid_capability_group");
      groupId = scope.chatId;
    } else {
      if (typeof params.groupId !== "string" || !GROUP_ID_PATTERN.test(params.groupId))
        throw new ToolInputError("invalid_capability_group");
      groupId = params.groupId;
    }
    // The group is named exactly once, at the top level. Accepting it here as well
    // would let a caller authorize one group and target another.
    if ("group_id" in supplied) throw new ToolInputError("invalid_capability_params");
    const providerGroupId = Number(groupId);
    if (!Number.isSafeInteger(providerGroupId))
      throw new ToolInputError("invalid_capability_group");
    providerParams = { ...supplied, group_id: providerGroupId };
  }

  const action = params.operation;
  if (typeof action !== "string" || !capability.operations.some((op) => op.action === action))
    throw new ToolInputError("invalid_capability_operation");
  if (!resolveQqOperation(capability, action, providerParams))
    throw new ToolInputError("invalid_capability_params");

  // Owner intent is a second, independent gate: the grant alone is not enough.
  if (
    capability.resource === "group" &&
    !(await options.isCategoryEnabled(
      context.caller.scope.connectionId,
      groupId!,
      capability.category,
    ))
  )
    throw new ToolInputError("capability_category_disabled");

  // A mutating capability additionally requires that the *current user message* asked
  // for this exact operation on this exact group, with exactly the provider parameters
  // it named — an optional flag the message left unstated cannot be supplied by the
  // model. Retrieved text cannot supply that either. The compared parameters are the
  // model-supplied provider parameters — the server-derived `group_id` is not one of
  // them, so the message never has to (and cannot) restate the group the Run bound.
  if (capability.risk !== "read")
    requireMutationIntent(context, capability.tool, {
      groupId: groupId!,
      operation: action,
      params: supplied,
    });

  if (context.caller.scope.chatType === "group" && capability.risk !== "read") {
    const observed = context.caller.scope.nativeGroupRole?.role ?? "qq_group_member";
    if (!capability.nativeGroupRoles?.includes(observed))
      throw new ToolAuthorizationError("native_group_role_denied");
    if (!options.verifyNativeGroupRole)
      throw new ToolAuthorizationError("native_group_role_unverified");
    const verified = await options.verifyNativeGroupRole({
      context,
      groupId: groupId!,
      capability,
      operation: action,
    });
    if (!capability.nativeGroupRoles.includes(verified))
      throw new ToolAuthorizationError("native_group_role_denied");
  }

  if (capability.risk !== "read")
    consumeMutationIntent(context, capability.tool, {
      groupId: groupId!,
      operation: action,
      params: supplied,
    });

  const result = await options.invoke({ capability, action, params: providerParams, context });
  if (capability.tool === "qq_group_members" && action === "get_group_member_list") {
    // The request is authorized to read group membership, but that does not make every
    // provider profile field necessary or safe to expose to a group audience. Keep the
    // model-visible result at the aggregate level. Fail closed on unexpected provider
    // shapes so a future protocol change cannot fall back to raw member records.
    if (
      !Array.isArray(result) ||
      result.some((member) => !isRecord(member) || !safeQqId(member.user_id))
    )
      throw new ProviderCallError("provider_failed", "invalid_response");
    const memberIds = result.map((member) =>
      safeQqId((member as Record<string, unknown>).user_id)!,
    );
    if (new Set(memberIds).size !== memberIds.length)
      throw new ProviderCallError("provider_failed", "invalid_response");
    return { memberCount: result.length };
  }
  if (capability.tool === "qq_group_members" && action === "get_group_member_info") {
    // The model requests one member, but only the verified native role is needed by the
    // authorization surface. Match both identities before disclosing even that projection.
    const expectedGroupId = safeQqId(providerParams.group_id);
    const expectedUserId = safeQqId(providerParams.user_id);
    if (
      !expectedGroupId ||
      !expectedUserId ||
      !isRecord(result) ||
      safeQqId(result.group_id) !== expectedGroupId ||
      safeQqId(result.user_id) !== expectedUserId ||
      (result.role !== "owner" && result.role !== "admin" && result.role !== "member")
    )
      throw new ProviderCallError("provider_failed", "invalid_response");
    const role =
      result.role === "owner"
        ? "qq_group_owner"
        : result.role === "admin"
          ? "qq_group_admin"
          : "qq_group_member";
    return { role };
  }
  return result;
}

function createProviderCapabilityTool(
  capability: QqCapability,
  store: DomainStore,
  getContext: () => ProtectedToolContext | undefined,
  options: ProviderCallOptions,
): ToolDefinition {
  return createProtectedTool<CapabilityToolInput>({
    name: capability.tool,
    label: capability.tool,
    description: providerToolDescription(capability),
    parameters: providerToolParameters(capability),
    action: capability.action,
    ...(capability.risk === "read" ? { deliverySource: "content_source" as const } : {}),
    // The Resource is derived, never accepted: a group Run is bound to its own group, and
    // an Owner-private Run may name only a group its policy covers.
    resourceId: (params, context) =>
      capabilityResourceId({
        resource: capability.resource,
        scope: context.caller.scope,
        groupId: typeof params.groupId === "string" ? params.groupId : undefined,
      }),
    authService: store.authorization,
    getContext,
    execute: (params, context) => executeProviderCall(capability, params, context, options),
  });
}

function createGroupInventoryTool(
  options: {
    capability: QqCapability;
    authService: DomainStore["authorization"];
    getContext: () => ProtectedToolContext | undefined;
    projectManagedGroups: (context: ProtectedToolContext) => Promise<unknown>;
  } & ProviderCallOptions,
): ToolDefinition {
  return createProtectedTool<CapabilityToolInput>({
    name: options.capability.tool,
    label: options.capability.tool,
    description: options.capability.description,
    parameters: providerToolParameters(options.capability, true),
    action: options.capability.action,
    ...(options.capability.risk === "read" ? { deliverySource: "content_source" as const } : {}),
    resourceId: (params, context) =>
      capabilityResourceId({
        resource: options.capability.resource,
        scope: context.caller.scope,
        groupId: typeof params.groupId === "string" ? params.groupId : undefined,
        // `qq_groups`' managed listing is the Owner's own inventory and is authorized on the
        // Agent Resource, which is what makes it a view of the managed set rather than a read
        // of one concrete group.
        listing: params.operation === undefined,
      }),
    authService: options.authService,
    getContext: options.getContext,
    execute: (params, context) => {
      if (params.operation !== undefined)
        return executeProviderCall(options.capability, params, context, options);
      // The listing names no group and never runs in a group Run: both facts are the
      // inventory's definition, not a hint, so a call that breaks either is refused.
      if (context.caller.scope.chatType !== "private" || params.groupId !== undefined)
        throw new ToolInputError("invalid_capability_group");
      return options.projectManagedGroups(context);
    },
  });
}

export function createCapabilityTools(
  options: {
    store: DomainStore;
    getContext: () => PiRunContext | undefined;
    /**
     * Runs the registry search against the caller's already-authorized capability set.
     *
     * The set is built and filtered below this layer, from durable policy and live grants, so
     * the Tool only has to bound its query and hand it on.
     */
    search: (input: {
      query: string | undefined;
      groupIds: readonly string[] | undefined;
      context: ProtectedToolContext;
    }) => Promise<unknown>;
    /** Builds the Owner's managed-group inventory. Reads no provider action. */
    projectManagedGroups: (context: ProtectedToolContext) => Promise<unknown>;
  } & ProviderCallOptions,
): ToolDefinition[] {
  const getContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    return value?.caller && value.conversationId && value.runId
      ? {
          caller: value.caller,
          conversationId: value.conversationId,
          runId: value.runId,
          ...(value.requiredToolName === undefined
            ? {}
            : { requiredToolName: value.requiredToolName }),
          ...(value.requiredToolInput === undefined
            ? {}
            : { requiredToolInput: value.requiredToolInput }),
        }
      : undefined;
  };

  return QQ_CAPABILITIES.map((capability) => {
    if (capability.tool === CAPABILITY_SEARCH_TOOL)
      return createCapabilitySearchTool({
        capability,
        authService: options.store.authorization,
        getContext,
        search: options.search,
      });
    if (capability.tool === GROUP_INVENTORY_TOOL)
      return createGroupInventoryTool({
        capability,
        authService: options.store.authorization,
        getContext,
        isCategoryEnabled: options.isCategoryEnabled,
        invoke: options.invoke,
        verifyNativeGroupRole: options.verifyNativeGroupRole,
        projectManagedGroups: options.projectManagedGroups,
      });
    return createProviderCapabilityTool(capability, options.store, getContext, options);
  });
}
