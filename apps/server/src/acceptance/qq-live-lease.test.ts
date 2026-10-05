import { describe, expect, it } from "vite-plus/test";
import {
  canonicalQqLiveToolsSha256,
  canonicalQqLiveTextSha256,
  QqLiveLeaseRegistry,
  QQ_LIVE_ACCEPTANCE_MAX_TOMBSTONES,
  QQ_LIVE_ACCEPTANCE_MAX_LEASES,
  QQ_LIVE_ACCEPTANCE_MAX_TTL_MS,
  type QqLiveLeaseTool,
} from "./qq-live-lease.js";
import type { TrustedChannelScope } from "../identity/scope.js";

const scope: TrustedChannelScope = {
  connectionId: "qq-acceptance",
  botId: "10001",
  chatType: "private",
  chatId: "10002",
  senderId: "10002",
};
const marker = "aabbccddeeff00112233445566778899";
const text = `GLASSBOX_ACCEPTANCE_V1 ${marker}\nPlease check status.`;
const tools: QqLiveLeaseTool[] = [
  {
    name: "qq_group_members",
    operations: [
      {
        action: "qq:group:members:read",
        resourceId: "group:12345",
        inputConstraint: { groupId: "12345", filter: { role: "owner" } },
      },
    ],
  },
];

function fixture(ttlMs = 10_000) {
  let now = 100_000;
  const registry = new QqLiveLeaseRegistry({ now: () => now });
  const registration = registry.register({
    principalId: "owner",
    scope,
    marker,
    textSha256: canonicalQqLiveTextSha256(text),
    ttlMs,
    expiresAt: now + ttlMs,
    tools,
  });
  const inbound = () =>
    registry.resolveInbound({ principalId: "owner", scope, messageId: "message-1", text });
  const binding = (runId = "run-1") => ({
    leaseId: registration.leaseId,
    principalId: "owner",
    scope,
    messageId: "message-1",
    runId,
  });
  const bind = (runId = "run-1") => {
    inbound();
    return registry.bindRun(binding(runId));
  };
  return {
    registry,
    registration,
    inbound,
    binding,
    bind,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("QQ live acceptance lease", () => {
  it("hashes the exact lease Tool specification with recursively sorted object keys", () => {
    expect(
      canonicalQqLiveToolsSha256([
        {
          name: "ops_status",
          operations: [
            {
              resourceId: "agent-operations",
              inputConstraint: { z: 1, a: [2, 3] },
              action: "ops:status",
            },
          ],
        },
      ]),
    ).toBe("4d93a3f0fd2449068b6579b750e7394ca8dc090283f0f3ac4027c934c35a38e1");
  });

  it("leaves ordinary messages alone and fails closed for marker messages without a lease", () => {
    const registry = new QqLiveLeaseRegistry();
    expect(
      registry.resolveInbound({
        principalId: "owner",
        scope,
        messageId: "ordinary",
        text: "Please check status. GLASSBOX_ACCEPTANCE_V1 appears later.",
      }),
    ).toEqual({ kind: "ordinary" });
    expect(
      registry.resolveInbound({ principalId: "owner", scope, messageId: "tagged", text }),
    ).toEqual({ kind: "denied", reason: "lease_unavailable" });
    expect(
      registry.resolveInbound({
        principalId: "owner",
        scope,
        messageId: "malformed",
        text: "GLASSBOX_ACCEPTANCE_V1 nope\nrequest",
      }),
    ).toEqual({ kind: "denied", reason: "lease_unavailable" });
  });

  it("requires the exact principal, full channel location and canonical text hash", () => {
    const f = fixture();
    expect(
      f.registry.resolveInbound({ principalId: "visitor", scope, messageId: "message-1", text }),
    ).toEqual({ kind: "denied", reason: "binding_mismatch" });
    expect(
      f.registry.resolveInbound({
        principalId: "owner",
        scope: { ...scope, connectionId: "other-connection" },
        messageId: "message-1",
        text,
      }),
    ).toEqual({ kind: "denied", reason: "binding_mismatch" });
    expect(
      f.registry.resolveInbound({
        principalId: "owner",
        scope: { ...scope, threadId: "thread-2" },
        messageId: "message-1",
        text,
      }),
    ).toEqual({ kind: "denied", reason: "binding_mismatch" });
    expect(
      f.registry.resolveInbound({
        principalId: "owner",
        scope,
        messageId: "message-1",
        text: `${text}\nextra`,
      }),
    ).toEqual({ kind: "denied", reason: "binding_mismatch" });
    expect(f.inbound()).toMatchObject({ kind: "acceptance", leaseId: f.registration.leaseId });
    expect(canonicalQqLiveTextSha256(`${text.replaceAll("\n", "\r\n")}`)).toBe(
      canonicalQqLiveTextSha256(text),
    );
  });

  it("binds one message to one Run and blocks message or Run substitution", () => {
    const f = fixture();
    expect(f.bind()).toBe(true);
    expect(f.bind()).toBe(true);
    expect(
      f.registry.resolveInbound({ principalId: "owner", scope, messageId: "message-2", text }),
    ).toEqual({ kind: "denied", reason: "binding_mismatch" });
    expect(f.registry.bindRun({ ...f.binding("run-2"), messageId: "message-1" })).toBe(false);
    expect(
      f.registry.filterToolNames({
        ...f.binding("run-2"),
        availableToolNames: ["qq_group_members"],
      }),
    ).toEqual([]);
  });

  it("keeps a marker cancellation when cleanup arrives before delayed registration", () => {
    const registry = new QqLiveLeaseRegistry();
    expect(registry.revokeMarker(marker)).toEqual({ revoked: false });
    expect(() =>
      registry.register({
        principalId: "owner",
        scope,
        marker,
        textSha256: canonicalQqLiveTextSha256(text),
        ttlMs: 10_000,
        expiresAt: 110_000,
        tools,
      }),
    ).toThrow("lease_capacity_or_marker_conflict");
    expect(
      registry.resolveInbound({ principalId: "owner", scope, messageId: "late", text }),
    ).toEqual({
      kind: "denied",
      reason: "lease_unavailable",
    });
  });

  it("uses fixed registration deadlines and reopens after bounded tombstones expire", () => {
    let now = 100_000;
    const registry = new QqLiveLeaseRegistry({ now: () => now });
    for (let index = 0; index < QQ_LIVE_ACCEPTANCE_MAX_TOMBSTONES; index++)
      expect(registry.revokeMarker(index.toString(16).padStart(32, "0"))).toEqual({
        revoked: false,
      });
    expect(() =>
      registry.register({
        principalId: "owner",
        scope,
        marker: "ffffffffffffffffffffffffffffffff",
        textSha256: canonicalQqLiveTextSha256(text),
        ttlMs: 20_000,
        expiresAt: now + 20_000,
        tools: [],
      }),
    ).toThrow("lease_capacity_or_marker_conflict");
    now += QQ_LIVE_ACCEPTANCE_MAX_TTL_MS + 1;
    expect(() =>
      registry.register({
        principalId: "owner",
        scope,
        marker: "ffffffffffffffffffffffffffffffff",
        textSha256: canonicalQqLiveTextSha256(text),
        ttlMs: 20_000,
        expiresAt: 100_000 + 20_000,
        tools: [],
      }),
    ).toThrow("lease_capacity_or_marker_conflict");
    const freshMarker = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const freshText = `GLASSBOX_ACCEPTANCE_V1 ${freshMarker}`;
    expect(
      registry.register({
        principalId: "owner",
        scope,
        marker: freshMarker,
        textSha256: canonicalQqLiveTextSha256(freshText),
        ttlMs: 20_000,
        expiresAt: now + 20_000,
        tools: [],
      }).expiresAt,
    ).toBe(now + 20_000);
  });

  it("keeps model-visible tool names within both the available set and lease allowlist", () => {
    const f = fixture();
    expect(f.bind()).toBe(true);
    expect(
      f.registry.filterToolNames({
        ...f.binding(),
        availableToolNames: ["qq_group_members", "qq_group_history", "qq_group_members"],
      }),
    ).toEqual(["qq_group_members"]);
    const empty = f.registry.register({
      principalId: "owner",
      scope,
      marker: "11223344556677889900aabbccddeeff",
      textSha256: canonicalQqLiveTextSha256(
        "GLASSBOX_ACCEPTANCE_V1 11223344556677889900aabbccddeeff",
      ),
      ttlMs: 1_000,
      expiresAt: 101_000,
      tools: [],
    });
    const emptyText = "GLASSBOX_ACCEPTANCE_V1 11223344556677889900aabbccddeeff";
    f.registry.resolveInbound({
      principalId: "owner",
      scope,
      messageId: "empty-message",
      text: emptyText,
    });
    expect(
      f.registry.bindRun({
        leaseId: empty.leaseId,
        principalId: "owner",
        scope,
        messageId: "empty-message",
        runId: "empty-run",
      }),
    ).toBe(true);
    expect(
      f.registry.filterToolNames({
        leaseId: empty.leaseId,
        principalId: "owner",
        scope,
        messageId: "empty-message",
        runId: "empty-run",
        availableToolNames: ["qq_group_members"],
      }),
    ).toEqual([]);
  });

  it("limits calls to listed tool operations and subset-shaped JSON input", () => {
    const f = fixture();
    f.bind();
    const base = {
      ...f.binding(),
      toolName: "qq_group_members",
      action: "qq:group:members:read",
      resourceId: "group:12345",
    };
    expect(
      f.registry.checkToolCall({
        ...base,
        toolInput: { groupId: "12345", filter: { role: "owner", extra: true }, page: 3 },
      }),
    ).toEqual({ allowed: true, reason: "allowed_by_lease" });
    expect(
      f.registry.checkToolCall({ ...base, toolName: "qq_group_history", toolInput: {} }),
    ).toEqual({ allowed: false, reason: "capability_mismatch" });
    expect(
      f.registry.checkToolCall({ ...base, action: "qq:group:members:write", toolInput: {} }),
    ).toEqual({ allowed: false, reason: "capability_mismatch" });
    expect(f.registry.checkToolCall({ ...base, resourceId: "group:other", toolInput: {} })).toEqual(
      { allowed: false, reason: "capability_mismatch" },
    );
    expect(
      f.registry.checkToolCall({
        ...base,
        toolInput: { groupId: "12345", filter: { role: "member" } },
      }),
    ).toEqual({ allowed: false, reason: "capability_mismatch" });
    expect(
      f.registry.checkToolCall({
        ...base,
        toolInput: { groupId: "12345", filter: { role: "owner" } },
      }),
    ).toEqual({ allowed: true, reason: "allowed_by_lease" });
  });

  it("matches arrays exactly inside an input constraint", () => {
    const arrayMarker = "00112233445566778899aabbccddeeff";
    const arrayText = `GLASSBOX_ACCEPTANCE_V1 ${arrayMarker}`;
    const now = Date.now();
    const registry = new QqLiveLeaseRegistry();
    const lease = registry.register({
      principalId: "owner",
      scope,
      marker: arrayMarker,
      textSha256: canonicalQqLiveTextSha256(arrayText),
      ttlMs: 1_000,
      expiresAt: now + 1_000,
      tools: [
        {
          name: "list_tool",
          operations: [
            {
              action: "list:read",
              resourceId: "list",
              inputConstraint: { fields: ["name", "status"], filters: [{ role: "owner" }] },
            },
          ],
        },
      ],
    });
    registry.resolveInbound({
      principalId: "owner",
      scope,
      messageId: "array-message",
      text: arrayText,
    });
    const binding = {
      leaseId: lease.leaseId,
      principalId: "owner",
      scope,
      messageId: "array-message",
      runId: "array-run",
    };
    expect(registry.bindRun(binding)).toBe(true);
    const call = { ...binding, toolName: "list_tool", action: "list:read", resourceId: "list" };
    expect(
      registry.checkToolCall({
        ...call,
        toolInput: { fields: ["name", "status"], filters: [{ role: "owner" }] },
      }).allowed,
    ).toBe(true);
    expect(registry.checkToolCall({ ...call, toolInput: { fields: ["name"] } }).allowed).toBe(
      false,
    );
    expect(
      registry.checkToolCall({
        ...call,
        toolInput: { fields: ["name", "status"], filters: [{ role: "owner", extra: true }] },
      }).allowed,
    ).toBe(false);
  });

  it("keeps registered constraints detached from caller-owned and returned objects", () => {
    const sourceTools = structuredClone(tools);
    const f = fixtureWithTools(sourceTools);
    sourceTools[0]!.name = "changed_after_register";
    f.bind();
    const visibleNames = f.registry.filterToolNames({
      ...f.binding(),
      availableToolNames: ["qq_group_members"],
    });
    visibleNames[0] = "changed_after_read";
    expect(
      f.registry.checkToolCall({
        ...f.binding(),
        toolName: "qq_group_members",
        action: "qq:group:members:read",
        resourceId: "group:12345",
        toolInput: { groupId: "12345", filter: { role: "owner" } },
      }).allowed,
    ).toBe(true);
  });

  it("rejects prototype-bearing constraints and treats input JSON as data", () => {
    const f = fixture();
    expect(() =>
      f.registry.register({
        principalId: "owner",
        scope,
        marker: "ffeeddccbbaa00998877665544332211",
        textSha256: canonicalQqLiveTextSha256("x"),
        ttlMs: 100,
        expiresAt: 100_100,
        tools: [
          {
            name: "safe_tool",
            operations: [
              {
                action: "record:read",
                resourceId: "record-1",
                inputConstraint: JSON.parse('{"__proto__":{"polluted":true}}'),
              },
            ],
          },
        ],
      }),
    ).toThrow("invalid_lease_constraint");
    f.bind();
    expect(
      f.registry.checkToolCall({
        ...f.binding(),
        toolName: "qq_group_members",
        action: "qq:group:members:read",
        resourceId: "group:12345",
        toolInput: JSON.parse('{"groupId":"12345","filter":{"role":"owner","__proto__":{"x":1}}}'),
      }).allowed,
    ).toBe(true);
  });

  it("expires while a Run is active and supports explicit revocation", () => {
    const f = fixture(100);
    f.bind();
    f.advance(100);
    expect(
      f.registry.checkToolCall({
        ...f.binding(),
        toolName: "qq_group_members",
        action: "qq:group:members:read",
        resourceId: "group:12345",
        toolInput: {},
      }),
    ).toEqual({ allowed: false, reason: "lease_expired" });
    expect(
      f.registry.resolveInbound({ principalId: "owner", scope, messageId: "m2", text }),
    ).toEqual({
      kind: "denied",
      reason: "lease_expired",
    });
    const revoked = fixture();
    revoked.bind();
    expect(revoked.registry.revoke(revoked.registration.leaseId)).toBe(true);
    expect(revoked.registry.revoke(revoked.registration.leaseId)).toBe(false);
    expect(
      revoked.registry.filterToolNames({
        ...revoked.binding(),
        availableToolNames: ["qq_group_members"],
      }),
    ).toEqual([]);
  });

  it("enforces lease TTL and registry capacity limits", () => {
    expect(() =>
      new QqLiveLeaseRegistry().register({
        principalId: "owner",
        scope,
        marker,
        textSha256: canonicalQqLiveTextSha256(text),
        ttlMs: QQ_LIVE_ACCEPTANCE_MAX_TTL_MS + 1,
        expiresAt: 100_000 + QQ_LIVE_ACCEPTANCE_MAX_TTL_MS + 1,
        tools,
      }),
    ).toThrow("invalid_lease");
    const f = fixture();
    for (let index = 1; index < QQ_LIVE_ACCEPTANCE_MAX_LEASES; index++) {
      const currentMarker = index.toString(16).padStart(32, "0");
      const currentText = `GLASSBOX_ACCEPTANCE_V1 ${currentMarker}`;
      f.registry.register({
        principalId: "owner",
        scope,
        marker: currentMarker,
        textSha256: canonicalQqLiveTextSha256(currentText),
        ttlMs: 100,
        expiresAt: 100_100,
        tools: [],
      });
    }
    expect(() =>
      f.registry.register({
        principalId: "owner",
        scope,
        marker: "ffffffffffffffffffffffffffffffff",
        textSha256: canonicalQqLiveTextSha256("different"),
        ttlMs: 100,
        expiresAt: 100_100,
        tools: [],
      }),
    ).toThrow("lease_capacity_or_marker_conflict");
  });
});

function fixtureWithTools(customTools: QqLiveLeaseTool[]) {
  let now = 100_000;
  const registry = new QqLiveLeaseRegistry({ now: () => now });
  const registration = registry.register({
    principalId: "owner",
    scope,
    marker,
    textSha256: canonicalQqLiveTextSha256(text),
    ttlMs: 10_000,
    expiresAt: 110_000,
    tools: customTools,
  });
  const binding = (runId = "run-1") => ({
    leaseId: registration.leaseId,
    principalId: "owner",
    scope,
    messageId: "message-1",
    runId,
  });
  return {
    registry,
    bind() {
      registry.resolveInbound({ principalId: "owner", scope, messageId: "message-1", text });
      return registry.bindRun(binding());
    },
    binding,
  };
}
