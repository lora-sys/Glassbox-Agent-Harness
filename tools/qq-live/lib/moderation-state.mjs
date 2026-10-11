import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { openReadOnlyDatabase } from "./read-only-database.mjs";
import { fail } from "./core.mjs";
import { MODERATION_GROUP_B_ID } from "./moderation-scenario.mjs";

function invalid() {
  fail("MODERATION_POLICY_STATE", "群 B 的禁言策略或授权状态无法独立核验。", "INCONCLUSIVE");
}

/** Read only the fixed B policy and the Owner-private moderation grant binding. */
export function readModerationPolicyState(config) {
  const runtime = config?.runtime;
  if (
    !runtime?.dataDirectory ||
    !runtime.connectionId ||
    config.groups?.find((g) => g.alias === "B")?.id !== MODERATION_GROUP_B_ID
  )
    invalid();
  const db = openReadOnlyDatabase(join(runtime.dataDirectory, "glassbox.db"));
  try {
    const owners = db
      .prepare(
        "SELECT p.id FROM channel_identities ci JOIN principals p ON p.id=ci.principal_id WHERE ci.identity_key=? AND p.kind='owner'",
      )
      .all(JSON.stringify([runtime.connectionId, config.bot.qq, config.driver.qq]));
    if (owners.length !== 1 || typeof owners[0].id !== "string") invalid();
    const principalId = owners[0].id;
    const policyRow = db
      .prepare(
        "SELECT policy_json,version,updated_at FROM group_capability_policies WHERE connection_id=? AND group_id=?",
      )
      .get(runtime.connectionId, MODERATION_GROUP_B_ID);
    if (
      !policyRow ||
      typeof policyRow.policy_json !== "string" ||
      !Number.isSafeInteger(policyRow.version)
    )
      invalid();
    const policy = JSON.parse(policyRow.policy_json);
    if (
      !policy ||
      typeof policy !== "object" ||
      Array.isArray(policy) ||
      !policy.categories ||
      typeof policy.categories !== "object"
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
    const grants = db
      .prepare(
        "SELECT id,principal_id,resource_id,action,scope_key,effect,revoked_at,created_at FROM grants WHERE resource_id=? AND principal_id=? AND action='group:moderate' AND scope_key=? ORDER BY id",
      )
      .all(`group:${MODERATION_GROUP_B_ID}`, principalId, scopeKey);
    if (
      grants.length !== 1 ||
      grants[0].effect !== "allow" ||
      grants[0].revoked_at !== null ||
      grants[0].scope_key !== scopeKey
    )
      invalid();
    return structuredClone({
      connectionId: runtime.connectionId,
      groupId: MODERATION_GROUP_B_ID,
      principalId,
      scopeKey,
      policyVersion: policyRow.version,
      policyUpdatedAt: policyRow.updated_at,
      moderationEnabled: policy.categories["group.moderate"] === true,
      grantId: grants[0].id,
      grantCreatedAt: grants[0].created_at,
    });
  } catch {
    invalid();
  } finally {
    db.close();
  }
}

export function verifyModerationPolicyUnchanged(before, after) {
  if (
    !isDeepStrictEqual(before, after) ||
    before?.groupId !== MODERATION_GROUP_B_ID ||
    before?.moderationEnabled !== true ||
    !before.grantId
  )
    invalid();
  return { status: "MODERATION_POLICY_AND_GRANT_VERIFIED", policyVersion: before.policyVersion };
}
