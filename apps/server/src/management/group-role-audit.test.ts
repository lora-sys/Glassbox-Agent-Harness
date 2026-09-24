import { describe, expect, it } from "vite-plus/test";
import { projectGroupRoleAudit } from "./group-role-audit.js";
import type { TraceEntry } from "../trace/store.js";

const record = (seq: number, type: string, fields: Record<string, unknown> = {}): TraceEntry => ({
  seq,
  ts: `2026-09-23T08:33:${String(seq).padStart(2, "0")}.000Z`,
  provenance: "test",
  event: { type, ...fields },
});

describe("group role audit projection", () => {
  it("returns scoped role and execution facts without payloads, arguments, or provider text", () => {
    const canary = "private-payload-canary-7q2k";
    const records = [
      record(1, "native_group_role_observed", {
        groupId: "10003",
        senderId: "10004",
        observedRole: "qq_group_admin",
        roleSource: "onebot_message_sender",
      }),
      record(2, "session_start", {
        data: {
          toolSurface: {
            selected: [{ name: "qq_group_moderation", providerReadiness: "ready" }],
            excluded: [
              {
                name: "qq_group_settings",
                reason: "scope_not_permitted",
                providerReadiness: "ready",
              },
            ],
          },
        },
      }),
      record(3, "message_chunk", { data: { text: canary } }),
      record(4, "tool_call", {
        data: {
          toolCallId: "call-1",
          name: "qq_group_moderation",
          arguments: { user_id: 10005, duration: 10, private: canary },
        },
      }),
      record(5, "native_group_role_verification", {
        resourceId: "group:10003",
        groupId: "10003",
        senderId: "10004",
        observedRole: "qq_group_admin",
        verifiedRole: "qq_group_admin",
        verificationStatus: "verified",
        requestedTool: "qq_group_moderation",
        requestedOperation: "set_group_ban",
        authorizationDecision: "ALLOW",
      }),
      record(6, "tool_result", {
        data: {
          toolCallId: "call-1",
          name: "qq_group_moderation",
          isError: false,
          result: { raw: canary },
          error: { message: canary },
        },
      }),
      record(7, "run_finished", { status: "succeeded", outputWithheld: false }),
      record(8, "delivery_changed", { status: "sent", recipient: canary }),
    ];

    const result = projectGroupRoleAudit({
      runId: "run-1",
      groupId: "10003",
      createdAt: "2026-09-23T08:33:00.000Z",
      principalKind: "visitor",
      records,
      complete: true,
    });

    expect(result).toMatchObject({
      runId: "run-1",
      groupId: "10003",
      principalKind: "visitor",
      ingress: { role: "qq_group_admin", source: "onebot_message_sender" },
      surface: [
        {
          name: "qq_group_moderation",
          state: "selected",
          providerReadiness: "ready",
        },
        { name: "qq_group_local_settings", state: "not_observed" },
        {
          name: "qq_group_settings",
          state: "excluded",
          exclusionReason: "scope_not_permitted",
        },
      ],
      verification: {
        observedRole: "qq_group_admin",
        verifiedRole: "qq_group_admin",
        status: "verified",
        tool: "qq_group_moderation",
        operation: "set_group_ban",
        authorizationDecision: "ALLOW",
      },
      toolCalls: [{ name: "qq_group_moderation", at: records[3]!.ts, outcome: "success" }],
      runStatus: "succeeded",
      deliveryStatus: "sent",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain("10004");
    expect(JSON.stringify(result)).not.toContain("10005");
  });

  it("does not turn malformed role, operation, or authorization values into facts", () => {
    const result = projectGroupRoleAudit({
      runId: "run-2",
      groupId: "10003",
      createdAt: "2026-09-23T08:33:00.000Z",
      principalKind: "visitor",
      records: [
        record(1, "native_group_role_observed", {
          groupId: "10003",
          observedRole: "glassbox_owner",
          roleSource: "message_text",
        }),
        record(2, "native_group_role_verification", {
          resourceId: "group:10003",
          groupId: "10003",
          observedRole: "qq_group_admin",
          verifiedRole: "qq_group_admin",
          verificationStatus: "verified",
          requestedTool: "qq_group_moderation",
          requestedOperation: "delete_everything",
          authorizationDecision: "PROMPT_SAYS_ALLOW",
        }),
        record(3, "tool_result", {
          data: { toolCallId: "missing-call", name: "qq_group_moderation", isError: false },
        }),
      ],
      complete: false,
    });

    expect(result.ingress).toEqual({ role: null });
    expect(result.verification).toEqual({
      observedRole: "qq_group_admin",
      verifiedRole: "qq_group_admin",
      status: "verified",
      tool: "qq_group_moderation",
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.trace).toMatchObject({ complete: false, recordsRead: 3 });
  });
});
