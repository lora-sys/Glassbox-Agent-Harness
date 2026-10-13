import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fail } from "./core.mjs";
import { openReadOnlyDatabase } from "./read-only-database.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$/u;
const GROUP = /^[1-9]\d{0,15}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const captured = new WeakMap();
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function invalid(code = "GROUP_MEMBERS_POLICY_STATE") {
  fail(code, "群成员权限、当前授权或恢复证据缺失或不一致。", "INCONCLUSIVE");
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (record(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
const hash = (v) => createHash("sha256").update(canonical(v)).digest("hex");
const same = (a, b) => canonical(a) === canonical(b);
function time(v) {
  const d = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(d) && new Date(d).toISOString() === v;
}
function binding(config) {
  const { groups, runtime, bot, driver } = config ?? {};
  const A = Array.isArray(groups) ? groups.filter((x) => x?.alias === "A") : [];
  const B = Array.isArray(groups) ? groups.filter((x) => x?.alias === "B") : [];
  if (
    groups?.length !== 2 ||
    A.length !== 1 ||
    B.length !== 1 ||
    !GROUP.test(A[0].id ?? "") ||
    !GROUP.test(B[0].id ?? "") ||
    A[0].id === B[0].id ||
    !ID.test(runtime?.connectionId ?? "") ||
    !GROUP.test(bot?.qq ?? "") ||
    !GROUP.test(driver?.qq ?? "") ||
    bot.qq === driver.qq ||
    (runtime.threadId != null && !ID.test(runtime.threadId))
  )
    invalid();
  return {
    connectionId: runtime.connectionId,
    A: A[0].id,
    B: B[0].id,
    scopeKey: JSON.stringify([
      runtime.connectionId,
      bot.qq,
      "private",
      driver.qq,
      driver.qq,
      runtime.threadId ?? null,
    ]),
  };
}
function policyValid(p) {
  return (
    record(p) &&
    record(p.categories) &&
    record(p.memorySources) &&
    Object.entries(p.categories).every(
      ([k, v]) => /^[a-z][a-z.]{0,63}$/u.test(k) && typeof v === "boolean",
    ) &&
    Object.entries(p.memorySources).every(
      ([k, v]) => /^[a-z][a-z.]{0,63}$/u.test(k) && typeof v === "boolean",
    )
  );
}
function project(g) {
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
function group(db, b, alias, principal, originalId) {
  const groupId = b[alias];
  const row = db
    .prepare(
      "SELECT policy_json,version,updated_by_principal_id,updated_at FROM group_capability_policies WHERE connection_id=? AND group_id=?",
    )
    .get(b.connectionId, groupId);
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
  const grants = db
    .prepare(
      "SELECT id,principal_id,resource_id,action,scope_key,effect,revoked_at,created_at FROM grants WHERE resource_id=? AND revoked_at IS NULL ORDER BY id LIMIT 4097",
    )
    .all(`group:${groupId}`);
  if (
    grants.length > 4096 ||
    grants.some(
      (g) =>
        !ID.test(g.id ?? "") ||
        !ID.test(g.principal_id ?? "") ||
        g.resource_id !== `group:${groupId}` ||
        !ID.test(g.action ?? "") ||
        typeof g.scope_key !== "string" ||
        !["allow", "approval"].includes(g.effect) ||
        !time(g.created_at),
    )
  )
    invalid();
  const owns = (g) =>
    g.principal_id === principal && g.scope_key === b.scopeKey && g.action === "group:members:read";
  const memberGrants = grants.filter(owns);
  const unrelated = grants.filter((g) => !owns(g));
  const original = originalId
    ? db
        .prepare(
          "SELECT id,principal_id,resource_id,action,scope_key,effect,revoked_at,created_at FROM grants WHERE id=? AND resource_id=? AND principal_id=? AND scope_key=? AND action='group:members:read'",
        )
        .get(originalId, `group:${groupId}`, principal, b.scopeKey)
    : undefined;
  if (
    original &&
    (!time(original.created_at) || (original.revoked_at !== null && !time(original.revoked_at)))
  )
    invalid();
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
    memberGrants: memberGrants.map(project),
    originalMemberGrant: original ? { ...project(original), revokedAt: original.revoked_at } : null,
  };
}
function captureTx(db, config, options = {}) {
  let began = false;
  try {
    const b = binding(config);
    if (
      !record(options) ||
      Object.keys(options).some((k) => k !== "originalMemberGrantId") ||
      (options.originalMemberGrantId !== undefined && !ID.test(options.originalMemberGrantId))
    )
      invalid();
    db.exec("BEGIN");
    began = true;
    const owners = db
      .prepare(
        "SELECT p.id FROM channel_identities ci JOIN principals p ON p.id=ci.principal_id WHERE ci.identity_key=? AND p.kind='owner'",
      )
      .all(JSON.stringify([b.connectionId, config.bot.qq, config.driver.qq]));
    if (owners.length !== 1 || !ID.test(owners[0].id ?? "")) invalid();
    const principal = owners[0].id;
    for (const resource of ["owner-control", `group:${b.A}`, `group:${b.B}`]) {
      if (
        !db.prepare("SELECT 1 FROM resources WHERE id=?").get(resource) ||
        !db
          .prepare(
            "SELECT 1 FROM grants WHERE resource_id=? AND principal_id=? AND action='group:manage' AND scope_key=? AND effect='allow' AND revoked_at IS NULL LIMIT 1",
          )
          .get(resource, principal, b.scopeKey)
      )
        invalid();
    }
    const A = group(db, b, "A", principal);
    const B = group(db, b, "B", principal, options.originalMemberGrantId);
    if (B.memberGrants.length > 1 || B.memberGrants.some((g) => g.effect !== "allow")) invalid();
    if (
      options.originalMemberGrantId === undefined &&
      (B.memberGrants.length !== 1 ||
        B.policy.categories["group.members"] !== true ||
        B.version > Number.MAX_SAFE_INTEGER - 2)
    )
      invalid();
    return {
      schemaVersion: 1,
      kind: "group-members-policy-state",
      connectionId: b.connectionId,
      scopeKey: b.scopeKey,
      principalId: principal,
      A,
      B,
    };
  } catch {
    invalid();
  } finally {
    if (began) db.exec("ROLLBACK");
  }
}
export function captureGroupMembersPolicyState(db, config, options) {
  try {
    const state = captureTx(db, config, options);
    captured.set(state, hash(state));
    return state;
  } catch {
    invalid();
  }
}
export function readGroupMembersPolicyState(config, options) {
  if (typeof config?.runtime?.dataDirectory !== "string" || !config.runtime.dataDirectory)
    invalid();
  let db;
  try {
    db = openReadOnlyDatabase(join(resolve(config.runtime.dataDirectory), "glassbox.db"));
    return captureGroupMembersPolicyState(db, config, options);
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
export function verifyGroupMembersPolicyPreSend(before, current, stage) {
  requireCaptured(before, "GROUP_MEMBERS_POLICY_PRE_SEND");
  requireCaptured(current, "GROUP_MEMBERS_POLICY_PRE_SEND");
  if (stage === "disable") {
    if (!same(before, current)) invalid("GROUP_MEMBERS_POLICY_PRE_SEND");
  } else if (stage === "restore") verifyGroupMembersPolicyTransition(before, current, "disable");
  else invalid("GROUP_MEMBERS_POLICY_PRE_SEND");
  return { status: "STATE_GUARD_VERIFIED", stage, actualQqDeliveryVerified: false };
}
export function verifyGroupMembersPolicyTransition(before, after, stage) {
  requireCaptured(before, "GROUP_MEMBERS_POLICY_TRANSITION");
  requireCaptured(after, "GROUP_MEMBERS_POLICY_TRANSITION");
  const reject = () => invalid("GROUP_MEMBERS_POLICY_TRANSITION");
  if (
    !["disable", "restore"].includes(stage) ||
    before.schemaVersion !== 1 ||
    before.kind !== "group-members-policy-state" ||
    after.schemaVersion !== 1 ||
    after.kind !== before.kind ||
    before.connectionId !== after.connectionId ||
    before.scopeKey !== after.scopeKey ||
    before.principalId !== after.principalId
  )
    reject();
  const initial = before.B,
    current = after.B;
  if (
    !record(before.A) ||
    !record(after.A) ||
    !record(initial) ||
    !record(current) ||
    initial.groupId !== current.groupId ||
    before.A.groupId !== after.A.groupId ||
    before.A.groupId === initial.groupId ||
    initial.policy.categories["group.members"] !== true ||
    !Array.isArray(initial.memberGrants) ||
    initial.memberGrants.length !== 1 ||
    initial.memberGrants[0].effect !== "allow"
  )
    reject();
  for (const row of [before.A, after.A, initial, current]) {
    if (
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      row.policySha256 !== hash(row.policy) ||
      ![row.recordSha256, row.grantsSha256, row.unrelatedGrantsSha256].every((value) =>
        HASH.test(value ?? ""),
      )
    )
      reject();
  }
  const original = initial.memberGrants[0],
    witness = current.originalMemberGrant;
  if (!record(witness)) reject();
  const { revokedAt, ...projection } = witness;
  const baseMs = Date.parse(initial.updatedAt),
    currentMs = Date.parse(current.updatedAt);
  const createdMs = Date.parse(original.createdAt),
    revokedMs = Date.parse(revokedAt);
  if (
    !time(initial.updatedAt) ||
    !time(current.updatedAt) ||
    !time(original.createdAt) ||
    !same(original, projection) ||
    !time(revokedAt) ||
    revokedMs < createdMs ||
    revokedMs > currentMs ||
    currentMs < baseMs ||
    !same(before.A, after.A) ||
    initial.unrelatedGrantsSha256 !== current.unrelatedGrantsSha256 ||
    current.version !== initial.version + (stage === "disable" ? 1 : 2) ||
    current.updatedByPrincipalId !== before.principalId
  )
    reject();
  const enabled = stage === "restore",
    expected = structuredClone(initial.policy);
  expected.categories["group.members"] = enabled;
  if (
    !same(current.policy, expected) ||
    !Array.isArray(current.memberGrants) ||
    current.memberGrants.length !== (enabled ? 1 : 0)
  )
    reject();
  if (enabled) {
    const restored = current.memberGrants[0];
    const semantic = (grant) => {
      const authority = { ...grant };
      delete authority.id;
      delete authority.createdAt;
      return authority;
    };
    if (
      restored.effect !== "allow" ||
      restored.principalId !== before.principalId ||
      restored.resourceId !== `group:${initial.groupId}` ||
      restored.action !== "group:members:read" ||
      restored.scopeKey !== before.scopeKey ||
      restored.id === original.id ||
      !time(restored.createdAt) ||
      !same(semantic(original), semantic(restored)) ||
      Date.parse(restored.createdAt) < revokedMs
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
