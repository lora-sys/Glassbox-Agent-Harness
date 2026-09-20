/**
 * Runtime Tools for the QQ Capability Registry.
 *
 * Glassbox never hands the model a QQ runtime. Each Tool here is a fixed, allowlisted
 * projection over NapCat's public OneBot action contract: the model names a Tool and an
 * operation inside it, and Glassbox decides the Resource, the protected Action, the
 * provider target and the parameter set.
 *
 * Security properties enforced here:
 *  - The Tool surface is scope-gated: a group Run sees only the read-only capabilities its
 *    own group's policy enables, an Owner-private Run additionally sees the mutating
 *    categories the Owner enabled, and a Visitor-private Run sees none. Discovery is never
 *    authority, so every call is re-authorized.
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
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import { agentResourceId } from "../../persistence/index.js";
import type { QqCapability, QqCapabilityCategory } from "../../channels/onebot/capabilities.js";
import { QQ_CAPABILITIES, resolveQqOperation } from "../../channels/onebot/capabilities.js";
import { groupResourceId } from "../../retrieval/source-resolver.js";
import {
  createProtectedTool,
  requireMutationIntent,
  ToolInputError,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

/** Sentinel Resource for a call outside the intended scope. Never registered, so it denies. */
export const UNRESOLVED_CAPABILITY_RESOURCE = "qq:capability:unresolved";

/**
 * The capability categories a Run *inside* a group may use.
 *
 * These are the read-only classes the group's own policy can expose. Mutating categories
 * (`group.files.write`, `group.moderate`, `group.settings`, `message.manage`) stay
 * Owner-private: a group Run can look at its group but never change it.
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
 * A group Run sees only the read-only capabilities its own group's policy enables, so
 * disabling a category hides the Tool on the next Run. Account-scoped capabilities describe
 * the Agent's own connection and are always available to the Owner. An Owner-private Run
 * additionally sees every mutating category the Owner enabled somewhere.
 */
export function availableCapabilityToolNames(input: {
  isOwner: boolean;
  chatType: "group" | "private";
  enabledCategories: readonly QqCapabilityCategory[];
}): string[] {
  const enabled = new Set(input.enabledCategories);
  if (input.chatType === "group")
    return QQ_CAPABILITIES.filter(
      (capability) =>
        capability.resource === "group" &&
        GROUP_RUN_CAPABILITY_CATEGORIES.includes(capability.category) &&
        enabled.has(capability.category),
    ).map((capability) => capability.tool);
  if (!input.isOwner) return [];
  return QQ_CAPABILITIES.filter(
    (capability) => capability.resource === "account" || enabled.has(capability.category),
  ).map((capability) => capability.tool);
}

function validatedProviderParams(value: unknown): QqProviderParams {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ToolInputError("invalid_capability_params");
  return value as QqProviderParams;
}

export function createCapabilityTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  /** Durable Owner intent for one group's capability class. Not an authorization decision. */
  isCategoryEnabled: (
    connectionId: string,
    groupId: string,
    category: QqCapabilityCategory,
  ) => Promise<boolean>;
  /** Executes one validated allowlisted provider action. The only outbound provider path. */
  invoke: (input: CapabilityInvocation) => Promise<unknown>;
  /** Builds the managed-group projection without touching the provider. */
  project: (input: { capability: QqCapability; context: ProtectedToolContext }) => Promise<unknown>;
}): ToolDefinition[] {
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

  return QQ_CAPABILITIES.map((capability) =>
    createProtectedTool<CapabilityToolInput>({
      name: capability.tool,
      label: capability.tool,
      description: capability.description,
      parameters: Type.Object(
        {
          groupId: Type.Optional(Type.String({ pattern: "^[1-9]\\d{0,15}$" })),
          operation: Type.Optional(Type.String({ maxLength: 64 })),
          params: Type.Optional(
            Type.Record(
              Type.String({ maxLength: 64 }),
              Type.Union([Type.String({ maxLength: 2_048 }), Type.Number(), Type.Boolean()]),
            ),
          ),
        },
        { additionalProperties: false },
      ),
      action: capability.action,
      // The Resource is derived, never accepted: a group Run is bound to its own group, and
      // an Owner-private Run may name only a group its policy covers.
      resourceId: (params, context) => {
        if (capability.resource === "account") return agentResourceId("personal");
        if (context.caller.scope.chatType === "group")
          return groupResourceId(context.caller.scope.chatId);
        if (context.caller.scope.chatType !== "private") return UNRESOLVED_CAPABILITY_RESOURCE;
        return typeof params.groupId === "string" && GROUP_ID_PATTERN.test(params.groupId)
          ? groupResourceId(params.groupId)
          : UNRESOLVED_CAPABILITY_RESOURCE;
      },
      authService: options.store.authorization,
      getContext,
      execute: async (params, context) => {
        if (capability.operations.length === 0) return options.project({ capability, context });

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
          providerParams = { ...supplied, group_id: Number(groupId) };
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

        return options.invoke({ capability, action, params: providerParams, context });
      },
    }),
  );
}
