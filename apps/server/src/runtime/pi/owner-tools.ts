import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import { createProtectedTool, type ProtectedToolContext } from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

export const OWNER_GROUP_ADMIN_TOOL = "owner_group_admin";
export const OWNER_CONTROL_RESOURCE = "owner-control";

export type OwnerGroupAdminInput =
  | { action: "get"; groupId: string }
  | { action: "set_access"; groupId: string; enabled: boolean }
  | { action: "set_skill"; groupId: string; skillName: string; enabled: boolean };

type OwnerGroupAdminToolInput = Record<string, unknown> & {
  action: "get" | "set_access" | "set_skill";
  groupId: string;
  enabled?: boolean;
  skillName?: string;
};

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
      ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
      : undefined;
  };
  return [
    createProtectedTool<OwnerGroupAdminToolInput>({
      name: OWNER_GROUP_ADMIN_TOOL,
      label: "QQ 群高级权限",
      description:
        "Read or change advanced QQ group permissions. This single Owner-only tool manages the strict group allowlist and the per-group Skill whitelist. When the Owner explicitly requests a change, call it immediately without asking for a second confirmation.",
      // Keep the provider-facing schema as one object. Some OpenAI-compatible
      // providers expose top-level union schemas but fail to generate a valid
      // branch. Glassbox validates the action-specific fields before mutation.
      parameters: Type.Object(
        {
          action: Type.Unsafe<OwnerGroupAdminToolInput["action"]>({
            type: "string",
            enum: ["get", "set_access", "set_skill"],
          }),
          groupId: Type.String({ pattern: "^[1-9]\\d{0,15}$" }),
          enabled: Type.Optional(Type.Boolean()),
          skillName: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })),
        },
        { additionalProperties: false },
      ),
      action: "group:manage",
      resourceId: OWNER_CONTROL_RESOURCE,
      authService: options.store.authorization,
      getContext,
      execute: (params, context) => options.manageGroup(context, validatedInput(params)),
    }),
  ];
}
