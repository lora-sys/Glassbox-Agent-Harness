import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fail } from "./core.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u;
const GROUP = /^[1-9]\d{0,15}$/u;
const MAX_GRANTS = 4096;
// Only independently read, unchanged in-process snapshots may establish state evidence.
// Serialized checkpoint data must be revalidated by its separate evidence protocol.
const captured = new WeakMap();

function invalid(code = "GROUP_POLICY_STATE") {
  fail(code, "群策略、当前权限或恢复证据缺失或不一致。", "INCONCLUSIVE");
}
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function same(a, b) {
  return canonical(a) === canonical(b);
}
function time(value) {
  const stamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(stamp) && new Date(stamp).toISOString() === value;
}
function policyValid(value) {
  if (
    !record(value) ||
    !record(value.categories) ||
    !record(value.memorySources) ||
    Object.keys(value).some((k) => !["categories", "memorySources", "webCapabilities"].includes(k))
  )
    return false;
  for (const name of ["categories", "memorySources", "webCapabilities"]) {
    const map = value[name] ?? {};
    if (
      !record(map) ||
      Object.keys(map).length > 64 ||
      Object.entries(map).some(
        ([k, v]) =>
          !/^[a-z][a-z.]{0,63}$/u.test(k) ||
          ["constructor", "prototype"].includes(k) ||
          typeof v !== "boolean",
      )
    )
      return false;
  }
  return true;
}
function bindings(config) {
  const groups = config?.groups;
  const runtime = config?.runtime;
  if (
    !Array.isArray(groups) ||
    groups.length !== 2 ||
    !ID.test(runtime?.connectionId ?? "") ||
    !GROUP.test(config?.bot?.qq ?? "") ||
    !GROUP.test(config?.driver?.qq ?? "") ||
    config.bot.qq === config.driver.qq ||
    (runtime.threadId != null && !ID.test(runtime.threadId))
  )
    invalid();
  const A = groups.filter((g) => g?.alias === "A");
  const B = groups.filter((g) => g?.alias === "B");
  if (
    A.length !== 1 ||
    B.length !== 1 ||
    !GROUP.test(A[0].id ?? "") ||
    !GROUP.test(B[0].id ?? "") ||
    A[0].id === B[0].id
  )
    invalid();
  const scopeKey = JSON.stringify([
    runtime.connectionId,
    config.bot.qq,
    "private",
    config.driver.qq,
    config.driver.qq,
    runtime.threadId ?? null,
  ]);
  return {
    connectionId: runtime.connectionId,
    A: A[0].id,
    B: B[0].id,
    scopeKey,
  };
}
function grantValid(g) {
  return (
    record(g) &&
    ID.test(g.id ?? "") &&
    ID.test(g.principal_id ?? "") &&
    ID.test(g.resource_id ?? "") &&
    ID.test(g.action ?? "") &&
    typeof g.scope_key === "string" &&
    g.scope_key.length <= 2048 &&
    ["allow", "approval"].includes(g.effect) &&
    time(g.created_at) &&
    (g.revoked_at === null || time(g.revoked_at))
  );
}
function grantProjection(g) {
  return {
    id: g.id,
    principalId: g.principal_id,
    resourceId: g.resource_id,
    action: g.action,
    scopeKey: g.scope_key,
    effect: g.effect,
    createdAt: g.created_at,
  };
}
function semanticGrant(g) {
  const { id, createdAt, ...authority } = g;
  return authority;
}
function historyGrantValid(g, state, groupId) {
  return (
    record(g) &&
    Object.keys(g).sort().join(",") ===
      "action,createdAt,effect,id,principalId,resourceId,scopeKey" &&
    ID.test(g.id ?? "") &&
    g.principalId === state.principalId &&
    g.resourceId === `group:${groupId}` &&
    g.action === "history:read" &&
    g.scopeKey === state.scopeKey &&
    g.effect === "allow" &&
    time(g.createdAt)
  );
}
function groupState(db, binding, alias, principalId, originalId) {
  const groupId = binding[alias];
  const row = db
    .prepare(
      "SELECT policy_json,version,updated_by_principal_id,updated_at FROM group_capability_policies WHERE connection_id=? AND group_id=?",
    )
    .get(binding.connectionId, groupId);
  if (
    !row ||
    typeof row.policy_json !== "string" ||
    Buffer.byteLength(row.policy_json) > 65536 ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !ID.test(row.updated_by_principal_id ?? "") ||
    !time(row.updated_at)
  )
    invalid();
  const policy = JSON.parse(row.policy_json);
  if (!policyValid(policy)) invalid();
  // Match CapabilityPolicyStore.read for legacy rows without this optional map.
  // Keep recordSha256 bound to the untouched persisted row.
  if (!Object.hasOwn(policy, "webCapabilities")) policy.webCapabilities = {};
  const resourceId = `group:${groupId}`;
  const grants = db
    .prepare(
      "SELECT id,principal_id,resource_id,action,scope_key,effect,revoked_at,created_at FROM grants WHERE resource_id=? AND revoked_at IS NULL ORDER BY id LIMIT ?",
    )
    .all(resourceId, MAX_GRANTS + 1);
  if (grants.length > MAX_GRANTS || grants.some((g) => !grantValid(g))) invalid();
  const isHistory = (g) =>
    g.principal_id === principalId &&
    g.scope_key === binding.scopeKey &&
    g.action === "history:read";
  const history = grants.filter(isHistory);
  const unrelated = grants.filter((g) => !isHistory(g));
  const original = originalId
    ? db
        .prepare(
          "SELECT id,principal_id,resource_id,action,scope_key,effect,revoked_at,created_at FROM grants WHERE id=? AND resource_id=? AND principal_id=? AND scope_key=? AND action='history:read'",
        )
        .get(originalId, resourceId, principalId, binding.scopeKey)
    : undefined;
  if (original && !grantValid(original)) invalid();
  return {
    groupId,
    version: row.version,
    updatedByPrincipalId: row.updated_by_principal_id,
    updatedAt: row.updated_at,
    policy,
    policySha256: hash(policy),
    recordSha256: hash(row),
    grantsSha256: hash(grants),
    unrelatedGrantsSha256: hash(unrelated),
    historyGrants: history.map(grantProjection),
    originalHistoryGrant: original
      ? { ...grantProjection(original), revokedAt: original.revoked_at }
      : null,
  };
}

/** Capture policy and authority in one read transaction. No contents, other actors or writes. */
function captureInTransaction(db, config, options = {}) {
  let began = false;
  try {
    const binding = bindings(config);
    if (!record(options) || Object.keys(options).some((key) => key !== "originalHistoryGrantId"))
      invalid();
    const { originalHistoryGrantId } = options;
    if (originalHistoryGrantId !== undefined && !ID.test(originalHistoryGrantId)) invalid();
    db.exec("BEGIN");
    began = true;
    const identities = db
      .prepare(
        "SELECT p.id FROM channel_identities ci JOIN principals p ON p.id=ci.principal_id WHERE ci.identity_key=? AND p.kind='owner'",
      )
      .all(JSON.stringify([config.runtime.connectionId, config.bot.qq, config.driver.qq]));
    if (identities.length !== 1 || !ID.test(identities[0].id ?? "")) invalid();
    const principalId = identities[0].id;
    for (const resourceId of ["owner-control", `group:${binding.A}`, `group:${binding.B}`]) {
      if (
        !db.prepare("SELECT 1 FROM resources WHERE id=?").get(resourceId) ||
        !db
          .prepare(
            "SELECT 1 FROM grants WHERE resource_id=? AND principal_id=? AND action='group:manage' AND scope_key=? AND effect='allow' AND revoked_at IS NULL LIMIT 1",
          )
          .get(resourceId, principalId, binding.scopeKey)
      )
        invalid();
    }
    const A = groupState(db, binding, "A", principalId);
    const B = groupState(db, binding, "B", principalId, originalHistoryGrantId);
    if (B.historyGrants.length > 1 || B.historyGrants.some((g) => g.effect !== "allow")) invalid();
    if (
      originalHistoryGrantId === undefined &&
      (B.historyGrants.length !== 1 ||
        B.policy.categories["group.history"] !== true ||
        B.policy.memorySources.history !== true ||
        !record(B.policy.webCapabilities) ||
        B.version > Number.MAX_SAFE_INTEGER - 2)
    )
      invalid();
    return {
      schemaVersion: 1,
      kind: "group-policy-state",
      connectionId: binding.connectionId,
      scopeKey: binding.scopeKey,
      principalId,
      A,
      B,
    };
  } catch {
    invalid();
  } finally {
    if (began) db.exec("ROLLBACK");
  }
}

export function captureGroupPolicyState(db, config, options) {
  try {
    const state = captureInTransaction(db, config, options);
    captured.set(state, hash(state));
    return state;
  } catch {
    invalid();
  }
}

export function readGroupPolicyState(config, options) {
  if (typeof config?.runtime?.dataDirectory !== "string" || !config.runtime.dataDirectory)
    invalid();
  let db;
  try {
    db = openReadOnlyDatabase(join(resolve(config.runtime.dataDirectory), "glassbox.db"));
    return captureGroupPolicyState(db, config, options);
  } catch {
    invalid();
  } finally {
    try {
      db?.close();
    } catch {
      invalid();
    }
  }
}

function requireCaptured(state, code) {
  try {
    if (!record(state) || !captured.has(state) || captured.get(state) !== hash(state))
      invalid(code);
  } catch {
    invalid(code);
  }
}

/** A fresh independent read must still match the known state before permission or sending. */
export function verifyGroupPolicyPreSend(before, current, stage) {
  requireCaptured(before, "GROUP_POLICY_PRE_SEND");
  requireCaptured(current, "GROUP_POLICY_PRE_SEND");
  if (stage === "disable") {
    if (!same(before, current)) invalid("GROUP_POLICY_PRE_SEND");
  } else if (stage === "restore") {
    verifyGroupPolicyTransition(before, current, "disable");
  } else invalid("GROUP_POLICY_PRE_SEND");
  return {
    status: "STATE_GUARD_VERIFIED",
    stage,
    actualQqDeliveryVerified: false,
  };
}

/** State proof alone does not establish a QQ request, authorized Tool call or delivery. */
export function verifyGroupPolicyTransition(before, after, stage) {
  requireCaptured(before, "GROUP_POLICY_TRANSITION");
  requireCaptured(after, "GROUP_POLICY_TRANSITION");
  const reject = () => invalid("GROUP_POLICY_TRANSITION");
  if (
    !["disable", "restore"].includes(stage) ||
    before?.schemaVersion !== 1 ||
    before.kind !== "group-policy-state" ||
    after?.schemaVersion !== 1 ||
    after.kind !== before.kind ||
    before.connectionId !== after.connectionId ||
    before.scopeKey !== after.scopeKey ||
    before.principalId !== after.principalId ||
    !ID.test(before.principalId ?? "")
  )
    reject();
  const initial = before.B;
  const current = after.B;
  if (
    !record(before.A) ||
    !record(after.A) ||
    !record(initial) ||
    !record(current) ||
    !policyValid(initial.policy) ||
    !policyValid(current.policy) ||
    initial.groupId !== current.groupId ||
    before.A.groupId !== after.A.groupId ||
    before.A.groupId === initial.groupId ||
    initial.policy.categories["group.history"] !== true ||
    initial.policy.memorySources.history !== true ||
    !Array.isArray(initial.historyGrants) ||
    initial.historyGrants.length !== 1 ||
    initial.historyGrants[0].effect !== "allow"
  )
    reject();
  for (const state of [before.A, after.A, initial, current]) {
    if (
      ![
        state.policySha256,
        state.recordSha256,
        state.grantsSha256,
        state.unrelatedGrantsSha256,
      ].every((value) => HASH.test(value ?? "")) ||
      state.policySha256 !== hash(state.policy) ||
      !Number.isSafeInteger(state.version) ||
      state.version < 1
    )
      reject();
  }
  const original = initial.historyGrants[0];
  const originalWitness = current.originalHistoryGrant;
  if (!record(originalWitness)) reject();
  const { revokedAt, ...originalProjection } = originalWitness;
  if (
    !historyGrantValid(original, before, initial.groupId) ||
    !same(before.A, after.A) ||
    initial.unrelatedGrantsSha256 !== current.unrelatedGrantsSha256 ||
    current.version !== initial.version + (stage === "disable" ? 1 : 2) ||
    current.updatedByPrincipalId !== before.principalId ||
    !time(initial.updatedAt) ||
    !time(current.updatedAt) ||
    Date.parse(current.updatedAt) < Date.parse(initial.updatedAt) ||
    !same(original, originalProjection) ||
    !time(revokedAt) ||
    Date.parse(revokedAt) < Date.parse(original.createdAt)
  )
    reject();
  const expectedPolicy = structuredClone(initial.policy);
  const enabled = stage === "restore";
  expectedPolicy.categories["group.history"] = enabled;
  expectedPolicy.memorySources.history = enabled;
  if (
    !same(current.policy, expectedPolicy) ||
    !Array.isArray(current.historyGrants) ||
    current.historyGrants.length !== (enabled ? 1 : 0)
  )
    reject();
  if (enabled) {
    const restored = current.historyGrants[0];
    if (
      !historyGrantValid(restored, before, initial.groupId) ||
      !same(semanticGrant(original), semanticGrant(restored)) ||
      restored.id === original.id ||
      Date.parse(restored.createdAt) < Date.parse(revokedAt)
    )
      reject();
  }
  return {
    status: "STATE_TRANSITION_VERIFIED",
    stage,
    groupAUnchanged: true,
    unrelatedAuthorityUnchanged: true,
    originalPolicyRestored: enabled,
    originalGrantRevocationRetained: true,
    actualQqDeliveryVerified: false,
  };
}
