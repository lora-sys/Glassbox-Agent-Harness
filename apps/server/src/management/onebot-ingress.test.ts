import { describe, expect, it, vi } from "vitest";
import type { OneBotIncomingMessage } from "../channels/onebot/index.js";
import type { CallerContext, TrustedChannelScope } from "../identity/scope.js";
import {
  admitOneBotIncomingMessage,
  resolveOneBotExecutionSelection,
  type OneBotIngressAdmissionDependencies,
} from "./onebot-ingress.js";

const ownerScope: TrustedChannelScope = {
  connectionId: "channel-1",
  botId: "bot-1",
  chatType: "private",
  chatId: "owner-1",
  senderId: "owner-1",
};
const groupScope: TrustedChannelScope = {
  connectionId: "channel-1",
  botId: "bot-1",
  chatType: "group",
  chatId: "group-1",
  senderId: "visitor-1",
};
const ownerFor = (scope: TrustedChannelScope): CallerContext => ({ principalId: "owner", scope });

function message(scope: TrustedChannelScope, text = "hello"): OneBotIncomingMessage {
  return {
    channel: "qq-onebot",
    scope,
    messageId: "message-1",
    text,
    parts: [{ type: "text", text }],
    receivedAt: "2026-10-14T00:00:00.000Z",
  };
}

function dependencies(
  overrides: Partial<OneBotIngressAdmissionDependencies> = {},
): OneBotIngressAdmissionDependencies {
  return {
    resolveCaller: async (scope) => ownerFor(scope),
    hasAcceptanceMarker: () => false,
    resolveAcceptance: () => ({ kind: "ordinary" }),
    auditDenied: async () => undefined,
    provisionAddressedGroupMember: async () => undefined,
    ...overrides,
  };
}

describe("OneBot ingress admission", () => {
  it("keeps the normalized scope and message identity on the admitted result", async () => {
    const incoming = message(groupScope);
    const admission = await admitOneBotIncomingMessage(incoming, dependencies());

    expect(admission).toMatchObject({
      messageId: incoming.messageId,
      scope: incoming.scope,
      caller: ownerFor(groupScope),
      leaseResolution: { kind: "ordinary" },
    });
  });

  it("denies a marker without a trusted caller before provisioning", async () => {
    const auditDenied = vi.fn(async () => undefined);
    const provisionAddressedGroupMember = vi.fn(async () => undefined);
    const admission = await admitOneBotIncomingMessage(
      message(groupScope, "acceptance-marker"),
      dependencies({
        resolveCaller: async () => null,
        hasAcceptanceMarker: () => true,
        auditDenied,
        provisionAddressedGroupMember,
      }),
    );

    expect(admission).toBeUndefined();
    expect(provisionAddressedGroupMember).not.toHaveBeenCalled();
    expect(auditDenied).toHaveBeenCalledWith({
      event: "message_denied",
      messageId: "message-1",
      scope: groupScope,
      reason: "lease_unavailable",
    });
  });

  it("denies an unresolved marker without exposing its body to audit", async () => {
    const auditDenied = vi.fn(async () => undefined);
    const admission = await admitOneBotIncomingMessage(
      message(ownerScope, "marker with private body"),
      dependencies({
        hasAcceptanceMarker: () => true,
        resolveAcceptance: () => ({ kind: "ordinary" }),
        auditDenied,
      }),
    );

    expect(admission).toBeUndefined();
    expect(auditDenied).toHaveBeenCalledWith({
      event: "message_denied",
      messageId: "message-1",
      scope: ownerScope,
      principalId: "owner",
      reason: "marker_resolution_failed",
    });
    expect(JSON.stringify(auditDenied.mock.calls)).not.toContain("private body");
  });

  it("provisions ordinary group members and resolves their current caller afterward", async () => {
    const resolveCaller = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ownerFor(groupScope));
    const provisionAddressedGroupMember = vi.fn(async () => undefined);
    const admission = await admitOneBotIncomingMessage(
      message(groupScope),
      dependencies({ resolveCaller, provisionAddressedGroupMember }),
    );

    expect(provisionAddressedGroupMember).toHaveBeenCalledWith(groupScope);
    expect(resolveCaller).toHaveBeenCalledTimes(2);
    expect(admission?.caller).toEqual(ownerFor(groupScope));
  });

  it("does not provision a marked message after it resolves to a lease", async () => {
    const provisionAddressedGroupMember = vi.fn(async () => undefined);
    const acceptance = {
      kind: "acceptance" as const,
      leaseId: "lease-1",
      marker: "marker-1",
      toolsSha256: "sha256",
    };
    const admission = await admitOneBotIncomingMessage(
      message(groupScope, "acceptance-marker"),
      dependencies({
        hasAcceptanceMarker: () => true,
        resolveAcceptance: () => acceptance,
        provisionAddressedGroupMember,
      }),
    );

    expect(admission?.leaseResolution).toEqual(acceptance);
    expect(provisionAddressedGroupMember).not.toHaveBeenCalled();
  });
});

describe("OneBot execution selection", () => {
  it("applies model overrides only to the configured Owner's private scope", () => {
    expect(
      resolveOneBotExecutionSelection({
        scope: ownerScope,
        ownerId: "owner-1",
        configuredExecutionRef: "pi:default",
        modelOverrideProfileId: "stepfun-step-5",
      }),
    ).toEqual({
      executionRef: "pi:stepfun-step-5",
      channelDefaultExecutionRef: "pi:default",
    });

    expect(
      resolveOneBotExecutionSelection({
        scope: { ...ownerScope, senderId: "visitor-1" },
        ownerId: "owner-1",
        configuredExecutionRef: "pi:default",
        modelOverrideProfileId: "stepfun-step-5",
      }),
    ).toEqual({ executionRef: "pi:default" });

    expect(
      resolveOneBotExecutionSelection({
        scope: { ...ownerScope, chatType: "group", chatId: "group-1" },
        ownerId: "owner-1",
        configuredExecutionRef: "model:default",
        modelOverrideProfileId: "stepfun-step-5",
      }),
    ).toEqual({ executionRef: "model:default" });
  });

  it("preserves unsupported execution kinds instead of inventing an override", () => {
    expect(
      resolveOneBotExecutionSelection({
        scope: ownerScope,
        ownerId: "owner-1",
        configuredExecutionRef: "worker:default",
        modelOverrideProfileId: "stepfun-step-5",
      }),
    ).toEqual({ executionRef: "worker:default" });
  });
});
