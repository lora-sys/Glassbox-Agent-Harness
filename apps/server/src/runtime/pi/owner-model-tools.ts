import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PublicModelProfile } from "../../config/model-profiles.js";
import type { DomainStore } from "../../persistence/index.js";
import {
  consumeMutationIntent,
  createProtectedTool,
  type ProtectedToolContext,
} from "./protected-tools.js";
import type { PiRunContext } from "./types.js";

export const OWNER_MODEL_ADMIN_TOOL = "owner_model_admin";

export interface OwnerModelSelection {
  profileId: string;
  label: string;
  model: string;
  providerId?: string;
  supportsTools: boolean | null;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  routingAvailable: boolean;
  unavailableReason?: "disabled" | "tools_unsupported" | "tools_unknown" | "capacity_unknown";
}

export function createOwnerModelTools(options: {
  store: DomainStore;
  getContext: () => PiRunContext | undefined;
  listModels: () => readonly PublicModelProfile[];
  currentModel: (context: ProtectedToolContext) => string | undefined;
  selectModel: (context: ProtectedToolContext, profileId: string | null) => Promise<void>;
  recordSelection: (context: ProtectedToolContext, profileId: string | null) => Promise<void>;
}): ToolDefinition[] {
  const getContext = (): ProtectedToolContext | undefined => {
    const value = options.getContext();
    if (
      !value?.caller ||
      !value.conversationId ||
      !value.runId ||
      value.caller.scope.chatType !== "private"
    )
      return undefined;
    return {
      caller: value.caller,
      conversationId: value.conversationId,
      runId: value.runId,
      ...(value.acceptanceLease ? { acceptanceLease: value.acceptanceLease } : {}),
      ...(value.requiredToolName === undefined ? {} : { requiredToolName: value.requiredToolName }),
      ...(value.requiredToolInput === undefined
        ? {}
        : { requiredToolInput: value.requiredToolInput }),
    };
  };
  return [
    createProtectedTool<{
      action: "list" | "current" | "select" | "clear";
      profileId?: string;
    }>({
      name: OWNER_MODEL_ADMIN_TOOL,
      label: "模型选择",
      description:
        "Read configured model profiles or select one for later Owner-private Runs on this QQ connection. Selection is Owner private-chat only and must match the current message exactly. A selected model is subject to Glassbox capability and context safety checks.",
      parameters: Type.Object(
        {
          action: Type.Unsafe<"list" | "current" | "select">({
            type: "string",
            enum: ["list", "current", "select", "clear"],
          }),
          // Pi model IDs are provider-owned and may contain punctuation such as dots.
          // Accept the requested name here, then resolve only against the safe catalog below.
          profileId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
        },
        { additionalProperties: false },
      ),
      action: (params) =>
        params.action === "select" || params.action === "clear" ? "model:switch" : "model:read",
      resourceId: "owner-control",
      deliverySource: "content_source",
      authService: options.store.authorization,
      getContext,
      execute: async (params, context) => {
        if (params.action === "list") return { models: options.listModels().map(safeModel) };
        if (params.action === "current")
          return { profileId: options.currentModel(context) ?? null };
        if (params.action === "clear") {
          consumeMutationIntent(context, OWNER_MODEL_ADMIN_TOOL, { action: "clear" });
          await options.selectModel(context, null);
          await options.recordSelection(context, null);
          return { profileId: options.currentModel(context) ?? null, resetToChannelDefault: true };
        }
        if (typeof params.profileId !== "string") throw new Error("invalid_model_profile");
        consumeMutationIntent(context, OWNER_MODEL_ADMIN_TOOL, {
          action: "select",
          profileId: params.profileId,
        });
        const models = options.listModels();
        const exactId = models.find((item) => item.id === params.profileId);
        const namedMatches = exactId
          ? []
          : models.filter(
              (item) => item.model === params.profileId || item.label === params.profileId,
            );
        if (namedMatches.length > 1) throw new Error("model_profile_ambiguous");
        const profile = exactId ?? namedMatches[0];
        if (!profile) throw new Error("model_profile_not_found");
        if (profile.routingAvailable === false) throw new Error("model_profile_unavailable");
        if (
          profile.supportsTools !== true ||
          profile.contextWindowTokens === undefined ||
          profile.maxOutputTokens === undefined
        )
          throw new Error("model_profile_capability_incomplete");
        await options.selectModel(context, profile.id);
        await options.recordSelection(context, profile.id);
        return {
          selected: safeModel(profile),
          appliesTo: "later_owner_private_runs_on_this_qq_connection",
        };
      },
    }),
  ];
}

function safeModel(profile: PublicModelProfile): OwnerModelSelection {
  const unavailableReason =
    profile.routingAvailable === false
      ? "disabled"
      : profile.supportsTools === false
        ? "tools_unsupported"
        : profile.supportsTools !== true
          ? "tools_unknown"
          : profile.contextWindowTokens === undefined || profile.maxOutputTokens === undefined
            ? "capacity_unknown"
            : undefined;
  return {
    profileId: profile.id,
    label: profile.label,
    model: profile.model,
    ...(profile.providerId === undefined ? {} : { providerId: profile.providerId }),
    supportsTools: profile.supportsTools ?? null,
    contextWindowTokens: profile.contextWindowTokens ?? null,
    maxOutputTokens: profile.maxOutputTokens ?? null,
    routingAvailable: unavailableReason === undefined,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}
