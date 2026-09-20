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
    operations: [group("get_group_info", ["group_id", "no_cache"])],
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
    operations: [
      group("get_group_notice", ["group_id"]),
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
      group("get_group_file_url", ["group_id", "file_id", "busid"], ["group_id", "file_id"]),
    ],
    description: "List a managed group's files and folders, or resolve a file download URL.",
  },
  {
    tool: "qq_group_file_ops",
    category: "group.files.write",
    risk: "write",
    action: "group:files:write",
    resource: "group",
    operations: [
      group(
        "upload_group_file",
        ["group_id", "file", "name", "folder_id"],
        ["group_id", "file", "name"],
      ),
      group("delete_group_file", ["group_id", "file_id", "busid"], ["group_id", "file_id"]),
      group("create_group_file_folder", ["group_id", "name", "parent_id"], ["group_id", "name"]),
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
 * Provider primitives that stay server-only in P4. These are never allowlisted, never
 * mapped to a Tool, and never reachable from model-visible Context.
 *
 * Raw send actions are listed here for the same reason: Glassbox Delivery must remain
 * the only outbound message path.
 */
export const SERVER_ONLY_NAPCAT_ACTIONS: readonly string[] = [
  "get_credentials",
  "get_cookies",
  "get_csrf",
  "get_clientkey",
  "get_rkey",
  "get_rkey_ex",
  "send_packet",
  "bot_exit",
  "call_action",
  "send_group_msg",
  "send_private_msg",
  "send_msg",
  "send_group_forward_msg",
  "send_private_forward_msg",
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

export interface NapCatContractSnapshot {
  provider: string;
  contract: string;
  /** Glassbox capability-contract snapshot revision. */
  version: string;
  license: string;
  sourcePath: string;
  allowlistedActions: readonly string[];
}

/**
 * Pinned view of the NapCat public action contract that Glassbox allowlists.
 *
 * The provider release is pinned during real-device verification; until then this
 * snapshot is the reference the drift check compares against.
 */
export const NAPCAT_CONTRACT_SNAPSHOT: NapCatContractSnapshot = Object.freeze({
  provider: "NapNeko/NapCatQQ",
  contract: "onebot11",
  version: "1.0.0",
  license: "Limited Redistribution License",
  sourcePath: "packages/napcat-onebot/action/index.ts",
  allowlistedActions: QQ_ALLOWED_NAPCAT_ACTIONS,
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
    ...SERVER_ONLY_NAPCAT_ACTIONS,
  ]);
  const missing = NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions.filter(
    (action) => !present.has(action),
  );
  const unclassified = observed.filter((action) => !known.has(action));
  if (missing.length === 0 && unclassified.length === 0) return { ok: true };
  return { ok: false, missing, unclassified };
}
