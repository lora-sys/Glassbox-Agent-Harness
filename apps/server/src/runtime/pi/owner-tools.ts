import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QqSourceClass } from "@glassbox/contracts";
import { QQ_SOURCE_CLASSES } from "@glassbox/contracts";
import type { DomainStore } from "../../persistence/index.js";
import {
  QQ_CAPABILITY_CATEGORIES,
  type QqCapabilityCategory,
} from "../../channels/onebot/capabilities.js";
import { WEB_CAPABILITIES, type WebCapability } from "../../management/web-capability-policy.js";
import {
  createProtectedTool,
  requireMutationIntent,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

export const OWNER_GROUP_ADMIN_TOOL = "owner_group_admin";
export const OWNER_CONTROL_RESOURCE = "owner-control";

export type OwnerCapabilityCategory = QqCapabilityCategory | WebCapability;

export type OwnerGroupAdminInput =
  | { action: "get"; groupId: string }
  | { action: "set_access"; groupId: string; enabled: boolean }
  | { action: "set_skill"; groupId: string; skillName: string; enabled: boolean }
  | {
      action: "set_capability";
      groupId: string;
      category: OwnerCapabilityCategory;
      enabled: boolean;
    }
  | { action: "set_history"; groupId: string; enabled: boolean }
  | { action: "set_memory_source"; groupId: string; sourceClass: QqSourceClass; enabled: boolean };

type OwnerGroupAdminToolInput = Record<string, unknown> & {
  action:
    | "get"
    | "set_access"
    | "set_skill"
    | "set_capability"
    | "set_history"
    | "set_memory_source";
  groupId: string;
  enabled?: boolean;
  skillName?: string;
  category?: string;
  sourceClass?: string;
};

const CATEGORIES = new Set<string>([...QQ_CAPABILITY_CATEGORIES, ...WEB_CAPABILITIES]);
const SOURCE_CLASSES = new Set<string>(QQ_SOURCE_CLASSES);

/**
 * Validates one Owner mutation before it can reach durable state.
 *
 * A category or source class Glassbox does not implement is rejected here as well as in
 * the policy store, so a provider upgrade or a typo can never widen the Tool or source
 * surface by writing a name nobody validated.
 */
function validatedInput(input: OwnerGroupAdminToolInput): OwnerGroupAdminInput {
  if (input.action === "get") return { action: "get", groupId: input.groupId };
  if (input.action === "set_access" && typeof input.enabled === "boolean")
    return { action: "set_access", groupId: input.groupId, enabled: input.enabled };
  if (
    input.action === "set_skill" &&
    typeof input.enabled === "boolean" &&
    typeof input.skillName === "string"
  )
    return {
      action: "set_skill",
      groupId: input.groupId,
      skillName: input.skillName,
      enabled: input.enabled,
    };
  if (
    input.action === "set_capability" &&
    typeof input.enabled === "boolean" &&
    typeof input.category === "string" &&
    CATEGORIES.has(input.category)
  )
    return {
      action: "set_capability",
      groupId: input.groupId,
      category: input.category as OwnerCapabilityCategory,
      enabled: input.enabled,
    };
  if (input.action === "set_history" && typeof input.enabled === "boolean")
    return { action: "set_history", groupId: input.groupId, enabled: input.enabled };
  if (
    input.action === "set_memory_source" &&
    typeof input.enabled === "boolean" &&
    typeof input.sourceClass === "string" &&
    SOURCE_CLASSES.has(input.sourceClass)
  )
    return {
      action: "set_memory_source",
      groupId: input.groupId,
      sourceClass: input.sourceClass as QqSourceClass,
      enabled: input.enabled,
    };
  throw new Error("invalid_owner_group_admin_input");
}

export function createOwnerTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  manageGroup: (context: ProtectedToolContext, input: OwnerGroupAdminInput) => Promise<unknown>;
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
  return [
    createProtectedTool<OwnerGroupAdminToolInput>({
      name: OWNER_GROUP_ADMIN_TOOL,
      label: "QQ 群高级权限",
      description:
        "Read or change advanced QQ group permissions. This single Owner-only tool manages the strict group allowlist, the per-group Skill whitelist, QQ capability categories, web and browser capabilities, and which memory source classes may generate candidates. Use set_history to enable or disable searching one group's history. When the Owner explicitly requests a change, call it immediately without asking for a second confirmation.",
      // Keep the provider-facing schema as one object. Some OpenAI-compatible
      // providers expose top-level union schemas but fail to generate a valid
      // branch. Glassbox validates the action-specific fields before mutation.
      parameters: Type.Object(
        {
          action: Type.Unsafe<OwnerGroupAdminToolInput["action"]>({
            type: "string",
            enum: [
              "get",
              "set_access",
              "set_skill",
              "set_capability",
              "set_history",
              "set_memory_source",
            ],
          }),
          groupId: Type.String({ pattern: "^[1-9]\\d{0,15}$" }),
          enabled: Type.Optional(Type.Boolean()),
          skillName: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })),
          category: Type.Optional(
            Type.Unsafe<OwnerCapabilityCategory>({
              type: "string",
              enum: [...QQ_CAPABILITY_CATEGORIES, ...WEB_CAPABILITIES],
            }),
          ),
          sourceClass: Type.Optional(
            Type.Unsafe<QqSourceClass>({ type: "string", enum: [...QQ_SOURCE_CLASSES] }),
          ),
        },
        { additionalProperties: false },
      ),
      action: "group:manage",
      resourceId: OWNER_CONTROL_RESOURCE,
      authService: options.store.authorization,
      getContext,
      execute: (params, context) => {
        const input = validatedInput(params);
        // Reading the inventory is safe at any time. A mutation additionally needs the
        // current user message to have asked for exactly this change to exactly this group.
        if (input.action !== "get")
          requireMutationIntent(context, OWNER_GROUP_ADMIN_TOOL, {
            action: input.action,
            groupId: input.groupId,
            enabled: "enabled" in input ? input.enabled : undefined,
            skillName: "skillName" in input ? input.skillName : undefined,
            category: "category" in input ? input.category : undefined,
            sourceClass: "sourceClass" in input ? input.sourceClass : undefined,
          });
        return options.manageGroup(context, input);
      },
    }),
  ];
}
