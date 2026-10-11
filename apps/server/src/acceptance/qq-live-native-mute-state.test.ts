import { describe, expect, it } from "vite-plus/test";
import { verifyQqLiveNativeMuteStatePrecondition } from "./qq-live-native-mute-state.js";
import type { QqLiveNativeMuteStatePrecondition } from "./qq-live-lease.js";

const base = {
  toolName: "qq_group_moderation",
  action: "group:moderate",
  resourceId: "group:12345",
  toolInput: {
    groupId: "12345",
    operation: "set_group_ban",
    params: { user_id: 10003, duration: 0 },
  },
  memberState: {
    group_id: 12345,
    user_id: 10003,
    role: "member",
    shut_up_timestamp: 120,
  },
  nowSeconds: 110,
};

const unmute: QqLiveNativeMuteStatePrecondition = {
  kind: "qq-member-mute-state",
  phase: "unmute",
  expectedMuteUntil: 120,
};

describe("QQ live native mute-state precondition", () => {
  it("accepts only the exact active mute state for unmute", () => {
    expect(verifyQqLiveNativeMuteStatePrecondition({ ...base, precondition: unmute })).toEqual({
      status: "verified",
      phase: "unmute",
    });
  });

  it("rejects wrong group or user identity, non-member roles, and state drift", () => {
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        memberState: { ...base.memberState, group_id: 99999 },
      }),
    ).toEqual({ status: "denied", reason: "member_identity_mismatch" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        memberState: { ...base.memberState, user_id: 10004 },
      }),
    ).toEqual({ status: "denied", reason: "member_identity_mismatch" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        memberState: { ...base.memberState, role: "admin" },
      }),
    ).toEqual({ status: "denied", reason: "member_role_mismatch" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        memberState: { ...base.memberState, shut_up_timestamp: 121 },
      }),
    ).toEqual({ status: "denied", reason: "member_state_mismatch" });
  });

  it("rejects natural expiry before delayed unmute execution", () => {
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        nowSeconds: 120,
      }),
    ).toEqual({ status: "denied", reason: "mute_state_expired" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        nowSeconds: 121,
      }),
    ).toEqual({ status: "denied", reason: "mute_state_expired" });
  });

  it("requires the target to remain unmuted before the mute operation", () => {
    const precondition: QqLiveNativeMuteStatePrecondition = {
      kind: "qq-member-mute-state",
      phase: "mute",
      expectedMuteUntil: 100,
    };
    const toolInput = {
      ...base.toolInput,
      params: { user_id: 10003, duration: 30 },
    };
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition,
        toolInput,
        memberState: { ...base.memberState, shut_up_timestamp: 100 },
        nowSeconds: 100,
      }),
    ).toEqual({ status: "verified", phase: "mute" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition,
        toolInput,
        memberState: { ...base.memberState, shut_up_timestamp: 101 },
        nowSeconds: 100,
      }),
    ).toEqual({ status: "denied", reason: "member_state_mismatch" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: { ...precondition, expectedMuteUntil: 101 },
        toolInput,
        memberState: { ...base.memberState, shut_up_timestamp: 101 },
        nowSeconds: 100,
      }),
    ).toEqual({ status: "denied", reason: "mute_state_changed" });
  });

  it("rejects an operation that does not match the guarded QQ group moderation input", () => {
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        resourceId: "group:other",
      }),
    ).toEqual({ status: "denied", reason: "operation_mismatch" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        toolName: "qq_group_members",
      }),
    ).toEqual({ status: "denied", reason: "operation_mismatch" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        toolInput: { ...base.toolInput, params: { user_id: 10003, duration: 30 } },
      }),
    ).toEqual({ status: "denied", reason: "operation_mismatch" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        toolInput: { ...base.toolInput, params: { ...base.toolInput.params, extra: true } },
      }),
    ).toEqual({ status: "denied", reason: "operation_mismatch" });
  });

  it("fails closed on malformed descriptors or timestamps", () => {
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: { ...unmute, expectedMuteUntil: -1 },
      }),
    ).toEqual({ status: "denied", reason: "invalid_precondition" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: { ...unmute, extra: true } as QqLiveNativeMuteStatePrecondition,
      }),
    ).toEqual({ status: "denied", reason: "invalid_precondition" });
    expect(
      verifyQqLiveNativeMuteStatePrecondition({
        ...base,
        precondition: unmute,
        nowSeconds: Number.NaN,
      }),
    ).toEqual({ status: "denied", reason: "invalid_precondition" });
  });
});
