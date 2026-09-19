import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import { createProtectedTool, type ProtectedToolContext } from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

export const OWNER_GROUP_ACCESS_TOOL = "owner_group_set_access";
export const OWNER_CONTROL_RESOURCE = "owner-control";

export function createOwnerTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  setGroupAccess: (
    context: ProtectedToolContext,
    input: { groupId: string; enabled: boolean },
  ) => Promise<{ groupId: string; enabled: boolean }>;
}): ToolDefinition[] {
  const getContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    return value?.caller && value.conversationId && value.runId
      ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
      : undefined;
  };
  return [
    createProtectedTool<{ groupId: string; enabled: boolean }>({
      name: OWNER_GROUP_ACCESS_TOOL,
      description:
        "Enable or disable this Bot in an existing QQ group for the Owner and registered Visitors. When the Owner explicitly asks for this action, call the tool immediately without asking for a second confirmation.",
      parameters: Type.Object(
        {
          groupId: Type.String({ pattern: "^[1-9]\\d{0,15}$" }),
          enabled: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      action: "group:manage",
      resourceId: OWNER_CONTROL_RESOURCE,
      authService: options.store.authorization,
      getContext,
      execute: (params, context) => options.setGroupAccess(context, params),
    }),
  ];
}
