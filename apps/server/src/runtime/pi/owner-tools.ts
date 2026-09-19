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
    createProtectedTool<OwnerGroupAdminInput>({
      name: OWNER_GROUP_ADMIN_TOOL,
      label: "QQ 群高级权限",
      description:
        "Read or change advanced QQ group permissions. This single Owner-only tool manages the strict group allowlist and the per-group Skill whitelist. When the Owner explicitly requests a change, call it immediately without asking for a second confirmation.",
      parameters: Type.Union(
        [
          Type.Object(
            {
              action: Type.Literal("get"),
              groupId: Type.String({ pattern: "^[1-9]\\d{0,15}$" }),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              action: Type.Literal("set_access"),
              groupId: Type.String({ pattern: "^[1-9]\\d{0,15}$" }),
              enabled: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              action: Type.Literal("set_skill"),
              groupId: Type.String({ pattern: "^[1-9]\\d{0,15}$" }),
              skillName: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
              enabled: Type.Boolean(),
            },
            { additionalProperties: false },
          ),
        ],
        { additionalProperties: false },
      ),
      action: "group:manage",
      resourceId: OWNER_CONTROL_RESOURCE,
      authService: options.store.authorization,
      getContext,
      execute: (params, context) => options.manageGroup(context, params),
    }),
  ];
}
