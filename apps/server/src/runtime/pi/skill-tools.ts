import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DomainStore } from "../../persistence/index.js";
import { createProtectedTool, type ProtectedToolContext } from "./protected-tools.js";
import type { PiRunContext } from "./types.js";
import type { KitLoader } from "./kit-loader.js";

export const SKILL_READ_TOOL = "skill_read";
export const SKILL_CATALOG_RESOURCE = "skill-catalog";
export const SKILL_READ_ACTION = "skill:read";

export function createSkillTools(options: {
  store: DomainStore;
  loader: KitLoader;
  getContext: () => PiRunContext | undefined;
  isSkillAuthorized: (context: ProtectedToolContext, skillName: string) => Promise<boolean>;
}): ToolDefinition[] {
  const protectedContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    return value?.caller && value.conversationId && value.runId
      ? { caller: value.caller, conversationId: value.conversationId, runId: value.runId }
      : undefined;
  };
  return [
    createProtectedTool<{ skillName: string; path?: string }>({
      name: SKILL_READ_TOOL,
      label: "Read authorized Skill",
      description:
        "Read one locked file from a Skill listed for this Run. Load SKILL.md first, then request only referenced files needed for the current task.",
      parameters: Type.Object(
        {
          skillName: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
          path: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        },
        { additionalProperties: false },
      ),
      action: SKILL_READ_ACTION,
      resourceId: SKILL_CATALOG_RESOURCE,
      authService: options.store.authorization,
      getContext: protectedContext,
      execute: async (params, context) => {
        const runContext = options.getContext();
        if (!runContext?.authorizedSkillNames?.includes(params.skillName))
          throw new Error("skill_not_visible_for_run");
        if (!(await options.isSkillAuthorized(context, params.skillName)))
          throw new Error("skill_authority_changed");
        return {
          skillName: params.skillName,
          path: params.path ?? "SKILL.md",
          content: options.loader.readSkillFile(params.skillName, params.path),
        };
      },
    }),
  ];
}
