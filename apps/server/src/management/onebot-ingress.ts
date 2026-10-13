import type { QqLiveInboundResolution } from "../acceptance/qq-live-lease.js";
import type { OneBotIncomingMessage } from "../channels/onebot/index.js";
import type { CallerContext, TrustedChannelScope } from "../identity/scope.js";

export interface OneBotIngressDenial {
  event: "message_denied";
  messageId: string;
  scope: TrustedChannelScope;
  principalId?: string;
  reason: "lease_unavailable" | "lease_expired" | "binding_mismatch" | "marker_resolution_failed";
}

export interface OneBotIngressAdmission {
  messageId: string;
  scope: TrustedChannelScope;
  caller: CallerContext | null;
  leaseResolution: QqLiveInboundResolution;
}

export interface OneBotIngressAdmissionDependencies {
  resolveCaller(scope: TrustedChannelScope): Promise<CallerContext | null>;
  hasAcceptanceMarker(text: string): boolean;
  resolveAcceptance(input: {
    principalId: string;
    scope: TrustedChannelScope;
    messageId: string;
    text: string;
  }): QqLiveInboundResolution;
  auditDenied(record: OneBotIngressDenial): Promise<unknown>;
  provisionAddressedGroupMember(scope: TrustedChannelScope): Promise<void>;
}

/**
 * Resolves a normalized OneBot message into its current caller and acceptance lease.
 * Marker messages are checked before visitor provisioning so an untrusted sender cannot
 * become an acceptance caller as a side effect of this admission path.
 */
export async function admitOneBotIncomingMessage(
  message: OneBotIncomingMessage,
  dependencies: OneBotIngressAdmissionDependencies,
): Promise<OneBotIngressAdmission | undefined> {
  let caller = await dependencies.resolveCaller(message.scope);
  let leaseResolution: QqLiveInboundResolution = { kind: "ordinary" };

  if (dependencies.hasAcceptanceMarker(message.text)) {
    leaseResolution = caller
      ? dependencies.resolveAcceptance({
          principalId: caller.principalId,
          scope: message.scope,
          messageId: message.messageId,
          text: message.text,
        })
      : { kind: "denied", reason: "lease_unavailable" };
    if (leaseResolution.kind !== "acceptance") {
      await dependencies
        .auditDenied({
          event: "message_denied",
          messageId: message.messageId,
          scope: message.scope,
          ...(caller ? { principalId: caller.principalId } : {}),
          reason:
            leaseResolution.kind === "denied" ? leaseResolution.reason : "marker_resolution_failed",
        })
        .catch(() => undefined);
      return undefined;
    }
  }

  if (message.scope.chatType === "group" && leaseResolution.kind === "ordinary") {
    await dependencies.provisionAddressedGroupMember(message.scope);
    caller = await dependencies.resolveCaller(message.scope);
  }

  return {
    messageId: message.messageId,
    scope: message.scope,
    caller,
    leaseResolution,
  };
}

export interface OneBotExecutionSelection {
  executionRef: string;
  channelDefaultExecutionRef?: string;
}

/** Resolve a private Owner model override without treating it as durable channel state. */
export function resolveOneBotExecutionSelection(input: {
  scope: TrustedChannelScope;
  ownerId: string;
  configuredExecutionRef: string;
  modelOverrideProfileId?: string;
}): OneBotExecutionSelection {
  const executionKind = /^(pi|model):/u.exec(input.configuredExecutionRef)?.[1];
  const ownerPrivate = input.scope.chatType === "private" && input.scope.senderId === input.ownerId;
  if (!ownerPrivate || !input.modelOverrideProfileId || !executionKind)
    return { executionRef: input.configuredExecutionRef };

  return {
    executionRef: `${executionKind}:${input.modelOverrideProfileId}`,
    channelDefaultExecutionRef: input.configuredExecutionRef,
  };
}
