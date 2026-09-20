/**
 * QQ Capability Registry.
 *
 * Glassbox does not vendor or reimplement QQ actions. NapCat remains the QQ runtime;
 * this registry adds only the Glassbox layer on top of NapCat's public OneBot action
 * contract: category, risk, protected Action, Resource binding and Tool name.
 *
 * Provenance: `NapNeko/NapCatQQ` (Limited Redistribution License). No NapCat source is
 * copied. See `upstream/napcat/SOURCES.md`.
 */

import { createHash } from "node:crypto";

export const QQ_CAPABILITY_CATEGORIES = [
  "group.read",
  "group.members",
  "group.history",
  "group.content",
  "group.files.read",
  "group.files.write",
  "group.moderate",
  "group.settings",
  "message.manage",
  "memory.source",
] as const;

export type QqCapabilityCategory = (typeof QQ_CAPABILITY_CATEGORIES)[number];

export type QqCapabilityRisk = "read" | "write" | "moderate";

/** Which protected Resource a capability binds. The model never chooses the Resource id. */
export type QqCapabilityResource = "group" | "account";

/**
 * One allowlisted provider action, with the only parameter names Glassbox will forward.
 *
 * For a group-scoped capability every operation carries `group_id`, so the authorization
 * Resource and the provider target are always the same value.
 */
export interface QqOperation {
  action: string;
  params: readonly string[];
  required: readonly string[];
}

export interface QqCapability {
  /** Glassbox domain Tool name exposed to Pi. */
  tool: string;
  category: QqCapabilityCategory;
  risk: QqCapabilityRisk;
  /** Glassbox protected Action checked on the bound Resource immediately before execution. */
  action: string;
  resource: QqCapabilityResource;
  /** Provider actions this capability may issue. Empty for a registry-only Tool. */
  operations: readonly QqOperation[];
  description: string;
}

const group = (
  action: string,
  params: readonly string[],
  required: readonly string[] = ["group_id"],
): QqOperation => ({ action, params, required });

const account = (action: string, params: readonly string[] = []): QqOperation => ({
  action,
  params,
  required: [],
});

export const QQ_CAPABILITIES: readonly QqCapability[] = [
  {
    tool: "qq_capability_search",
    category: "group.read",
    risk: "read",
    action: "qq:capability:read",
    resource: "account",
    operations: [],
    description:
      "Search the Glassbox QQ capability registry: the Owner's managed groups and which categories and Tools each one enables.",
  },
  {
    tool: "qq_groups",
    category: "group.read",
    risk: "read",
    action: "group:read",
    resource: "group",
    // Deliberately no `get_group_list`: the Owner's groups are the managed allowlist,
    // never every group the bot happens to have joined.
    operations: [group("get_group_info", ["group_id"])],
    description: "Read one managed QQ group's provider metadata.",
  },
  {
    tool: "qq_group_members",
    category: "group.members",
    risk: "read",
    action: "group:members:read",
    resource: "group",
    operations: [
      group("get_group_member_list", ["group_id"]),
      group("get_group_member_info", ["group_id", "user_id", "no_cache"], ["group_id", "user_id"]),
    ],
    description: "Read a managed group's member list or one member's profile.",
  },
  {
    tool: "qq_group_history",
    category: "group.history",
    risk: "read",
    action: "history:read",
    resource: "group",
    operations: [group("get_group_msg_history", ["group_id", "count", "message_seq"])],
    description: "Read a managed group's live message history page.",
  },
  {
    tool: "qq_group_content",
    category: "group.content",
    risk: "read",
    action: "group:content:read",
    resource: "group",
    // The provider's notice reader is `_get_group_notice` (GoCQHTTP_GetGroupNotice), not
    // `get_group_notice`; a wrong name would be refused by NapCat rather than by Glassbox.
    operations: [
      group("_get_group_notice", ["group_id"]),
      group("get_essence_msg_list", ["group_id"]),
    ],
    description: "Read a managed group's notices and essence messages.",
  },
  {
    tool: "qq_group_files",
    category: "group.files.read",
    risk: "read",
    action: "group:files:read",
    resource: "group",
    operations: [
      group("get_group_root_files", ["group_id"]),
      group("get_group_files_by_folder", ["group_id", "folder_id"], ["group_id", "folder_id"]),
      group("get_group_file_url", ["group_id", "file_id"], ["group_id", "file_id"]),
    ],
    description: "List a managed group's files and folders, or resolve a file download URL.",
  },
  {
    tool: "qq_group_file_ops",
    category: "group.files.write",
    risk: "write",
    action: "group:files:write",
    resource: "group",
    // Deliberately no `upload_group_file`: its `file` parameter is a local server path, and
    // P4B has no Asset or file Resource to authorize it against. See
    // `SERVER_ONLY_NAPCAT_ACTIONS` and `upstream/napcat/SOURCES.md`.
    operations: [
      group("delete_group_file", ["group_id", "file_id"], ["group_id", "file_id"]),
      group("create_group_file_folder", ["group_id", "name"], ["group_id", "name"]),
    ],
    description: "Change a managed group's files or folders.",
  },
  {
    tool: "qq_group_moderation",
    category: "group.moderate",
    risk: "moderate",
    action: "group:moderate",
    resource: "group",
    operations: [
      group(
        "set_group_ban",
        ["group_id", "user_id", "duration"],
        ["group_id", "user_id", "duration"],
      ),
      group(
        "set_group_kick",
        ["group_id", "user_id", "reject_add_request"],
        ["group_id", "user_id"],
      ),
      group("set_group_whole_ban", ["group_id", "enable"], ["group_id", "enable"]),
    ],
    description: "Moderate a managed group: mute, kick or set whole-group mute.",
  },
  {
    tool: "qq_group_settings",
    category: "group.settings",
    risk: "write",
    action: "group:settings:write",
    resource: "group",
    operations: [
      group("set_group_name", ["group_id", "group_name"], ["group_id", "group_name"]),
      group("set_group_card", ["group_id", "user_id", "card"], ["group_id", "user_id"]),
      group(
        "set_group_admin",
        ["group_id", "user_id", "enable"],
        ["group_id", "user_id", "enable"],
      ),
    ],
    description: "Change a managed group's name, a member's card or a member's admin flag.",
  },
  {
    tool: "qq_account_status",
    category: "group.read",
    risk: "read",
    action: "account:status:read",
    resource: "account",
    operations: [account("get_login_info"), account("get_version_info"), account("get_status")],
    description: "Read the bot account's login, version and online status.",
  },
];

/**
 * Provider actions that stay server-only in P4. These are never allowlisted, never
 * mapped to a Tool, and never reachable from model-visible Context.
 *
 * Raw send actions are listed here for the same reason: Glassbox Delivery must remain
 * the only outbound message path. Service-restart and cache-maintenance actions are here
 * because they change the runtime itself rather than QQ data.
 *
 * `upload_group_file` is here for a different reason and is deliberately *deferred* rather
 * than forbidden: it is a real group file mutation, but its `file` parameter is a local
 * server filesystem path. Glassbox has no Asset or file Resource authorization and no
 * approved upload staging boundary, so a remote Owner message naming a path would be an
 * authorization gap. It becomes allowlistable only once an Asset-mediated upload path
 * exists; until then the model is never told it can upload. Its sibling group file
 * mutations (`delete_group_file`, `create_group_file_folder`) take only group-scoped ids
 * and stay allowlisted.
 *
 * Every name is the provider's real OneBot action string at the pinned commit. The
 * credential action is `get_csrf_token` (not `get_csrf`) and the rkey pair is
 * `get_rkey` / `nc_get_rkey`; a wrong name here would silently fail to classify the real
 * action, so `checkNapCatContract` reports it as unclassified drift instead.
 */
export const SERVER_ONLY_NAPCAT_ACTIONS: readonly string[] = [
  "get_credentials",
  "get_cookies",
  "get_csrf_token",
  "get_clientkey",
  "get_rkey",
  "nc_get_rkey",
  "get_rkey_server",
  "send_packet",
  "bot_exit",
  "set_restart",
  "clean_cache",
  "send_group_msg",
  "send_private_msg",
  "send_msg",
  "send_group_forward_msg",
  "send_private_forward_msg",
  "upload_group_file",
];

/** The only provider actions Glassbox may issue on behalf of a capability Tool. */
export const QQ_ALLOWED_NAPCAT_ACTIONS: readonly string[] = Object.freeze([
  ...new Set(QQ_CAPABILITIES.flatMap((capability) => capability.operations.map((op) => op.action))),
]);

const BY_TOOL = new Map(QQ_CAPABILITIES.map((capability) => [capability.tool, capability]));
const ALLOWED = new Set(QQ_ALLOWED_NAPCAT_ACTIONS);

/**
 * Allowlisted actions whose target is a group. A dispatch of one of these must name the
 * group explicitly, so a call can never fall back to the runtime's default target.
 */
export const GROUP_SCOPED_NAPCAT_ACTIONS: readonly string[] = Object.freeze([
  ...new Set(
    QQ_CAPABILITIES.filter((capability) => capability.resource === "group").flatMap((capability) =>
      capability.operations.map((operation) => operation.action),
    ),
  ),
]);

export function qqCapability(tool: string): QqCapability | undefined {
  return BY_TOOL.get(tool);
}

export function qqCapabilitiesForCategory(category: QqCapabilityCategory): readonly QqCapability[] {
  return QQ_CAPABILITIES.filter((capability) => capability.category === category);
}

export function isAllowedNapCatAction(action: string): boolean {
  return ALLOWED.has(action);
}

/**
 * Resolves one operation inside a capability and validates the caller-supplied parameters.
 *
 * Returns `undefined` when the operation is not part of this capability, when a parameter
 * was not declared, or when a required parameter is missing. Nothing is forwarded to the
 * provider unless it passed this check.
 */
export function resolveQqOperation(
  capability: QqCapability,
  action: string,
  params: Readonly<Record<string, unknown>>,
): QqOperation | undefined {
  const operation = capability.operations.find((candidate) => candidate.action === action);
  if (!operation) return undefined;
  const allowed = new Set(operation.params);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) return undefined;
    const value = params[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      return undefined;
  }
  for (const key of operation.required) {
    if (params[key] === undefined) return undefined;
  }
  return operation;
}

/** One allowlisted provider action plus the exact parameter names Glassbox may forward. */
export interface NapCatActionContract {
  action: string;
  params: readonly string[];
  required: readonly string[];
}

/**
 * The allowlisted provider contract, in canonical order.
 *
 * This is the reference the drift check and the pinned snapshot digest are computed from.
 * It is derived from the registry so a capability edit cannot leave the snapshot stale.
 */
export const NAPCAT_ALLOWLISTED_CONTRACTS: readonly NapCatActionContract[] = Object.freeze(
  QQ_CAPABILITIES.flatMap((capability) =>
    capability.operations.map((operation) => ({
      action: operation.action,
      params: [...operation.params],
      required: [...operation.required],
    })),
  )
    .filter(
      (contract, index, all) =>
        all.findIndex((candidate) => candidate.action === contract.action) === index,
    )
    .sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0)),
);

/**
 * Deterministic digest of the allowlisted provider contract.
 *
 * Two contract sets produce the same digest only when every action, its parameter
 * allowlist and its required set are identical. A provider upgrade that adds, renames or
 * re-shapes an action therefore changes the digest, which the drift check surfaces
 * instead of silently widening Glassbox authority.
 */
export function napCatContractDigest(
  contracts: readonly NapCatActionContract[] = NAPCAT_ALLOWLISTED_CONTRACTS,
): string {
  const canonical = contracts
    .map((contract) => [
      contract.action,
      [...contract.params].sort(),
      [...contract.required].sort(),
    ])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** What the provider declares for one action: its payload parameters and return-schema keys. */
export interface NapCatProviderSchema {
  /** Payload parameter names the provider declares. Glassbox may only forward a subset. */
  payload: readonly string[];
  /** Top-level keys of the declared return schema; empty when the provider returns an opaque schema. */
  returned: readonly string[];
}

/**
 * Provider-declared payload and return schemas at the pinned commit, keyed by action name.
 *
 * Read from each action's `payloadSchema` / `returnSchema` in the pinned checkout. This is
 * what makes "unsupported parameter" detectable without the checkout present: Glassbox may
 * forward a parameter only when the provider declares it. A `returned` of `[]` means the
 * provider returns an opaque, non-object schema (a named schema, `Type.Any`, or `Type.Null`).
 *
 * Keyed by *allowlisted* action: this map and `QQ_ALLOWED_NAPCAT_ACTIONS` always have the
 * same keys, which is what lets the verifier compare a digest derived from the allowlist
 * against the pinned record. A server-only action such as `upload_group_file` is therefore
 * absent here rather than recorded and ignored.
 */
export const NAPCAT_PROVIDER_SCHEMAS: Readonly<Record<string, NapCatProviderSchema>> =
  Object.freeze({
    get_group_info: { payload: ["group_id"], returned: [] },
    get_group_member_list: { payload: ["group_id", "no_cache"], returned: [] },
    get_group_member_info: { payload: ["group_id", "user_id", "no_cache"], returned: [] },
    get_group_msg_history: {
      payload: [
        "group_id",
        "message_seq",
        "count",
        "reverse_order",
        "disable_get_url",
        "parse_mult_msg",
        "quick_reply",
        "reverseOrder",
      ],
      returned: ["messages"],
    },
    _get_group_notice: {
      payload: ["group_id"],
      returned: ["sender_id", "publish_time", "notice_id", "message", "settings", "read_num"],
    },
    get_essence_msg_list: {
      payload: ["group_id"],
      returned: [
        "msg_seq",
        "msg_random",
        "sender_id",
        "sender_nick",
        "operator_id",
        "operator_nick",
        "message_id",
        "operator_time",
        "content",
      ],
    },
    get_group_root_files: { payload: ["group_id", "file_count"], returned: ["files", "folders"] },
    get_group_files_by_folder: {
      payload: ["group_id", "folder_id", "folder", "file_count"],
      returned: ["files", "folders"],
    },
    get_group_file_url: { payload: ["group_id", "file_id"], returned: ["url"] },
    delete_group_file: { payload: ["group_id", "file_id"], returned: [] },
    create_group_file_folder: {
      payload: ["group_id", "folder_name", "name"],
      returned: ["result", "groupItem"],
    },
    set_group_ban: { payload: ["group_id", "user_id", "duration"], returned: [] },
    set_group_kick: { payload: ["group_id", "user_id", "reject_add_request"], returned: [] },
    set_group_whole_ban: { payload: ["group_id", "enable"], returned: [] },
    set_group_name: { payload: ["group_id", "group_name"], returned: [] },
    set_group_card: { payload: ["group_id", "user_id", "card"], returned: [] },
    set_group_admin: { payload: ["group_id", "user_id", "enable"], returned: [] },
    get_login_info: { payload: [], returned: [] },
    get_version_info: { payload: [], returned: ["app_name", "protocol_version", "app_version"] },
    get_status: { payload: [], returned: ["online", "good", "stat"] },
  });

/** Deterministic digest of the recorded provider payload and return schemas. */
export function napCatProviderSchemaDigest(
  schemas: Readonly<Record<string, NapCatProviderSchema>> = NAPCAT_PROVIDER_SCHEMAS,
): string {
  const canonical = Object.keys(schemas)
    .sort()
    .map((action) => [
      action,
      [...schemas[action].payload].sort(),
      [...schemas[action].returned].sort(),
    ]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Allowlist entries that the provider does not actually support.
 *
 * Two shapes: an allowlisted action the provider never declares, and an allowlisted
 * parameter the provider's payload schema never accepts. Both mean Glassbox would issue a
 * request the provider cannot honour, so the verifier fails closed on a non-empty result.
 */
export function unsupportedNapCatContract(
  schemas: Readonly<Record<string, NapCatProviderSchema>> = NAPCAT_PROVIDER_SCHEMAS,
): readonly string[] {
  const violations: string[] = [];
  for (const contract of NAPCAT_ALLOWLISTED_CONTRACTS) {
    const provider = schemas[contract.action];
    if (!provider) {
      violations.push(`${contract.action}:unknown_action`);
      continue;
    }
    const declared = new Set(provider.payload);
    for (const param of contract.params) {
      if (!declared.has(param)) violations.push(`${contract.action}:${param}`);
    }
  }
  return violations;
}

export interface NapCatContractSnapshot {
  provider: string;
  contract: string;
  /** Pinned provider commit this contract was read from. */
  commit: string;
  /** Provider package version at that commit. */
  version: string;
  license: string;
  /** Original upstream paths the contract was read from. No provider source is vendored. */
  sourcePaths: readonly string[];
  /** Digest of the Glassbox allowlisted provider contract. */
  contractDigest: string;
  /** Provider-declared payload and return schemas at the pinned commit. */
  providerSchemas: Readonly<Record<string, NapCatProviderSchema>>;
  /** Digest of `providerSchemas`. */
  providerSchemaDigest: string;
  allowlistedActions: readonly string[];
  serverOnlyActions: readonly string[];
}

/**
 * Pinned view of the NapCat public action contract that Glassbox allowlists.
 *
 * Verified against the pinned checkout rather than assumed. `scripts/verify-napcat-contract.mts`
 * re-derives every action name and parameter allowlist from that checkout and fails closed
 * when the snapshot and the provider disagree.
 */
export const NAPCAT_CONTRACT_SNAPSHOT: NapCatContractSnapshot = Object.freeze({
  provider: "NapNeko/NapCatQQ",
  contract: "onebot11",
  commit: "109d0c1dff755875f3b79795e99cee6115289fbb",
  version: "0.0.1",
  license: "Limited Redistribution License for NapCat",
  sourcePaths: Object.freeze([
    "packages/napcat-onebot/action/router.ts",
    "packages/napcat-onebot/action/OneBotAction.ts",
    "packages/napcat-onebot/action/schemas.ts",
    "packages/napcat-onebot/action/group/GetGroupInfo.ts",
    "packages/napcat-onebot/action/group/GetGroupMemberList.ts",
    "packages/napcat-onebot/action/group/GetGroupMemberInfo.ts",
    "packages/napcat-onebot/action/group/GetGroupNotice.ts",
    "packages/napcat-onebot/action/group/GetGroupEssence.ts",
    "packages/napcat-onebot/action/group/SetGroupBan.ts",
    "packages/napcat-onebot/action/group/SetGroupKick.ts",
    "packages/napcat-onebot/action/group/SetGroupWholeBan.ts",
    "packages/napcat-onebot/action/group/SetGroupName.ts",
    "packages/napcat-onebot/action/group/SetGroupCard.ts",
    "packages/napcat-onebot/action/group/SetGroupAdmin.ts",
    "packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts",
    "packages/napcat-onebot/action/go-cqhttp/GetGroupRootFiles.ts",
    "packages/napcat-onebot/action/go-cqhttp/GetGroupFilesByFolder.ts",
    "packages/napcat-onebot/action/go-cqhttp/DeleteGroupFile.ts",
    "packages/napcat-onebot/action/go-cqhttp/CreateGroupFileFolder.ts",
    "packages/napcat-onebot/action/file/GetGroupFileUrl.ts",
    "packages/napcat-onebot/action/system/GetLoginInfo.ts",
    "packages/napcat-onebot/action/system/GetVersionInfo.ts",
    "packages/napcat-onebot/action/system/GetStatus.ts",
  ]),
  contractDigest: napCatContractDigest(),
  providerSchemas: NAPCAT_PROVIDER_SCHEMAS,
  providerSchemaDigest: napCatProviderSchemaDigest(),
  allowlistedActions: QQ_ALLOWED_NAPCAT_ACTIONS,
  serverOnlyActions: Object.freeze([...SERVER_ONLY_NAPCAT_ACTIONS]),
});

export type NapCatContractDrift =
  | { ok: true }
  | { ok: false; missing: readonly string[]; unclassified: readonly string[] };

/**
 * Compares a runtime's observed action set against the pinned snapshot.
 *
 * A missing action means the provider moved and Glassbox's allowlist is stale. An
 * unclassified action is reported but never auto-allowlisted: widening authority is an
 * explicit Owner-reviewed change, not a side effect of a provider upgrade.
 */
export function checkNapCatContract(observed: readonly string[]): NapCatContractDrift {
  const present = new Set(observed);
  const known = new Set<string>([
    ...NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions,
    ...NAPCAT_CONTRACT_SNAPSHOT.serverOnlyActions,
  ]);
  const missing = NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions.filter(
    (action) => !present.has(action),
  );
  const unclassified = observed.filter((action) => !known.has(action));
  if (missing.length === 0 && unclassified.length === 0) return { ok: true };
  return { ok: false, missing, unclassified };
}
