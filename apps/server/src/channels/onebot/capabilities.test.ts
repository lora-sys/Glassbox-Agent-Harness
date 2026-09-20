import { describe, expect, it } from "vite-plus/test";
import {
  NAPCAT_ALLOWLISTED_CONTRACTS,
  NAPCAT_CONTRACT_SNAPSHOT,
  NAPCAT_PROVIDER_SCHEMAS,
  QQ_ALLOWED_NAPCAT_ACTIONS,
  QQ_CAPABILITIES,
  QQ_CAPABILITY_CATEGORIES,
  SERVER_ONLY_NAPCAT_ACTIONS,
  checkNapCatContract,
  isAllowedNapCatAction,
  napCatContractDigest,
  napCatProviderSchemaDigest,
  qqCapabilitiesForCategory,
  qqCapability,
  resolveQqOperation,
  unsupportedNapCatContract,
} from "./capabilities.ts";

describe("QQ capability registry", () => {
  it("exposes a small stable domain Tool surface mapped to allowlisted NapCat actions", () => {
    const tools = QQ_CAPABILITIES.map((capability) => capability.tool);
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools.length).toBeGreaterThanOrEqual(8);
    expect(tools.length).toBeLessThanOrEqual(12);
    for (const capability of QQ_CAPABILITIES) {
      expect(QQ_CAPABILITY_CATEGORIES).toContain(capability.category);
      for (const operation of capability.operations) {
        // NapCat's own action names may carry a leading underscore (`_get_group_notice`).
        expect(operation.action).toMatch(/^_?[a-z][a-z0-9_]*$/u);
        // A required parameter must also be declared, and a group-scoped capability must
        // carry group_id so the authorization Resource and the provider target agree.
        for (const required of operation.required) expect(operation.params).toContain(required);
        if (capability.resource === "group") expect(operation.params).toContain("group_id");
      }
    }
    // Only the registry-query Tool is provider-free; every other capability issues at
    // least one concrete allowlisted NapCat action.
    const withProviderActions = QQ_CAPABILITIES.filter((c) => c.operations.length > 0);
    expect(withProviderActions.length).toBeGreaterThanOrEqual(8);
  });

  it("keeps credential, packet, transport, restart and raw-send primitives server-only", () => {
    // Real provider action names at the pinned commit: `get_csrf_token` (not `get_csrf`),
    // `nc_get_rkey` (not `get_rkey_ex`), and `get_rkey_server`. `call_action` is not a
    // NapCat action at all, so listing it would be dead weight rather than protection.
    const forbidden = [
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
    ];
    for (const action of forbidden) {
      expect(SERVER_ONLY_NAPCAT_ACTIONS).toContain(action);
      expect(isAllowedNapCatAction(action)).toBe(false);
    }
    for (const capability of QQ_CAPABILITIES) {
      for (const operation of capability.operations) {
        expect(forbidden).not.toContain(operation.action);
      }
    }
  });

  it("names the provider's real actions for notices, essence and group files", () => {
    // Verified against the pinned checkout: the notice reader is `_get_group_notice`
    // (GoCQHTTP_GetGroupNotice). A wrong name would be refused by NapCat at runtime
    // rather than by Glassbox at authorization time.
    const content = qqCapability("qq_group_content")!;
    expect(content.operations.map((op) => op.action).sort()).toEqual([
      "_get_group_notice",
      "get_essence_msg_list",
    ]);
    expect(content.operations.map((op) => op.action)).not.toContain("get_group_notice");

    const files = qqCapability("qq_group_files")!;
    // `busid` does not exist in the provider's `get_group_file_url` payload schema.
    expect(files.operations.find((op) => op.action === "get_group_file_url")?.params).toEqual([
      "group_id",
      "file_id",
    ]);

    const fileOps = qqCapability("qq_group_file_ops")!;
    expect(fileOps.operations.find((op) => op.action === "delete_group_file")?.params).toEqual([
      "group_id",
      "file_id",
    ]);
    // `parent_id` does not exist in the provider's `create_group_file_folder` payload schema.
    expect(
      fileOps.operations.find((op) => op.action === "create_group_file_folder")?.params,
    ).toEqual(["group_id", "name"]);
    // `get_group_info` declares only `group_id`; `no_cache` is not a provider parameter.
    expect(qqCapability("qq_groups")!.operations[0]!.params).toEqual(["group_id"]);
  });

  it("keeps group file upload off the model surface until an Asset upload path exists", () => {
    // `upload_group_file` takes a local server filesystem path. P4B authorizes the group
    // Resource only, with no Asset or file Resource and no approved upload staging boundary,
    // so a remote Owner message naming a path would be an authorization gap. The action is
    // classified as server-only/deferred rather than silently dropped, so the drift check
    // knows it is a real provider action Glassbox deliberately withholds.
    expect(SERVER_ONLY_NAPCAT_ACTIONS).toContain("upload_group_file");
    expect(isAllowedNapCatAction("upload_group_file")).toBe(false);
    const fileOps = qqCapability("qq_group_file_ops")!;
    expect(fileOps.operations.map((op) => op.action)).not.toContain("upload_group_file");
    // The group file mutations whose parameters are group-scoped ids remain allowlisted.
    expect(fileOps.operations.map((op) => op.action).sort()).toEqual([
      "create_group_file_folder",
      "delete_group_file",
    ]);
  });

  it("derives the allowlist from the registry with no overlap with server-only actions", () => {
    const fromRegistry = new Set(
      QQ_CAPABILITIES.flatMap((capability) =>
        capability.operations.map((operation) => operation.action),
      ),
    );
    expect([...QQ_ALLOWED_NAPCAT_ACTIONS].sort()).toEqual([...fromRegistry].sort());
    for (const action of QQ_ALLOWED_NAPCAT_ACTIONS) {
      expect(SERVER_ONLY_NAPCAT_ACTIONS).not.toContain(action);
    }
  });

  it("maps categories to capabilities and looks capabilities up by tool name", () => {
    expect(qqCapability("qq_group_members")?.category).toBe("group.members");
    expect(qqCapability("not_a_tool")).toBeUndefined();
    expect(qqCapabilitiesForCategory("group.members").map((c) => c.tool)).toEqual([
      "qq_group_members",
    ]);
    // Every policy category has a backing surface: a Tool, the P4A source reader, or a
    // category that is declared for policy but has no Tool in this increment.
    const withoutTool = new Set(["memory.source", "message.manage"]);
    for (const category of QQ_CAPABILITY_CATEGORIES) {
      const backed = qqCapabilitiesForCategory(category).length > 0 || withoutTool.has(category);
      expect(backed).toBe(true);
    }
  });

  it("rejects an operation outside the capability or an undeclared parameter", () => {
    const members = qqCapability("qq_group_members")!;
    expect(resolveQqOperation(members, "get_group_member_list", { group_id: 100 })).toBeDefined();
    // An action from another capability is not reachable through this Tool.
    expect(resolveQqOperation(members, "set_group_kick", { group_id: 100 })).toBeUndefined();
    // A server-only primitive is not reachable through any Tool.
    expect(resolveQqOperation(members, "send_group_msg", { group_id: 100 })).toBeUndefined();
    // An undeclared parameter is refused rather than forwarded.
    expect(
      resolveQqOperation(members, "get_group_member_list", { group_id: 100, user_id: 5 }),
    ).toBeUndefined();
    // A missing required parameter is refused.
    expect(resolveQqOperation(members, "get_group_member_info", { group_id: 100 })).toBeUndefined();
    expect(
      resolveQqOperation(members, "get_group_member_info", { group_id: 100, user_id: "5" }),
    ).toBeDefined();
  });

  it("fails the drift check when the pinned provider contract no longer matches", () => {
    const pinned = [...NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions];
    expect(checkNapCatContract(pinned)).toEqual({ ok: true });

    // A deliberately deferred provider action is classified, so observing it is not drift.
    // It stays off the allowlist, which is what keeps it unreachable from the model.
    expect(checkNapCatContract([...pinned, "upload_group_file"])).toEqual({ ok: true });
    expect(isAllowedNapCatAction("upload_group_file")).toBe(false);

    // A provider release that renames or drops a snapshotted action is drift.
    const missing = pinned.filter((action) => action !== "get_group_member_list");
    const drift = checkNapCatContract(missing);
    expect(drift.ok).toBe(false);
    if (drift.ok) return;
    expect(drift.missing).toEqual(["get_group_member_list"]);

    // A provider action we have not classified is reported, never auto-allowlisted.
    const widened = checkNapCatContract([...pinned, "set_group_special_title"]);
    expect(widened.ok).toBe(false);
    if (widened.ok) return;
    expect(widened.unclassified).toEqual(["set_group_special_title"]);
    expect(isAllowedNapCatAction("set_group_special_title")).toBe(false);
  });

  it("records the pinned upstream provenance for the provider contract", () => {
    expect(NAPCAT_CONTRACT_SNAPSHOT.provider).toBe("NapNeko/NapCatQQ");
    expect(NAPCAT_CONTRACT_SNAPSHOT.license).toBe("Limited Redistribution License for NapCat");
    expect(NAPCAT_CONTRACT_SNAPSHOT.commit).toBe("109d0c1dff755875f3b79795e99cee6115289fbb");
    expect(NAPCAT_CONTRACT_SNAPSHOT.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions.length).toBeGreaterThan(0);
    // The recorded source paths must be the real upstream locations, not a placeholder.
    expect(NAPCAT_CONTRACT_SNAPSHOT.sourcePaths).toContain(
      "packages/napcat-onebot/action/router.ts",
    );
    for (const path of NAPCAT_CONTRACT_SNAPSHOT.sourcePaths) {
      expect(path).toMatch(/^packages\/napcat-onebot\/action\/.+\.ts$/u);
    }
    // No NapCat source is vendored: the snapshot records provenance and digests only.
    expect(NAPCAT_CONTRACT_SNAPSHOT.contractDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(NAPCAT_CONTRACT_SNAPSHOT.providerSchemaDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("computes a deterministic contract digest that changes with the allowlist", () => {
    expect(napCatContractDigest()).toBe(NAPCAT_CONTRACT_SNAPSHOT.contractDigest);
    expect(napCatContractDigest(NAPCAT_ALLOWLISTED_CONTRACTS)).toBe(
      NAPCAT_CONTRACT_SNAPSHOT.contractDigest,
    );
    // Reordering the inputs must not change the digest; a changed parameter must.
    const reversed = [...NAPCAT_ALLOWLISTED_CONTRACTS].reverse();
    expect(napCatContractDigest(reversed)).toBe(NAPCAT_CONTRACT_SNAPSHOT.contractDigest);
    const widened = NAPCAT_ALLOWLISTED_CONTRACTS.map((contract) =>
      contract.action === "get_group_info"
        ? { ...contract, params: [...contract.params, "no_cache"] }
        : contract,
    );
    expect(napCatContractDigest(widened)).not.toBe(NAPCAT_CONTRACT_SNAPSHOT.contractDigest);
  });

  it("computes a deterministic provider-schema digest that changes with the record", () => {
    expect(napCatProviderSchemaDigest()).toBe(NAPCAT_CONTRACT_SNAPSHOT.providerSchemaDigest);
    const changed = {
      ...NAPCAT_PROVIDER_SCHEMAS,
      get_group_info: { payload: ["group_id", "no_cache"], returned: [] },
    };
    expect(napCatProviderSchemaDigest(changed)).not.toBe(
      NAPCAT_CONTRACT_SNAPSHOT.providerSchemaDigest,
    );
  });

  it("fails closed when an allowlisted action or parameter is unsupported by the provider", () => {
    // Every allowlisted parameter is one the provider's payload schema actually declares.
    expect(unsupportedNapCatContract()).toEqual([]);

    // An allowlisted action the provider never declares is unsupported.
    expect(
      unsupportedNapCatContract({
        ...NAPCAT_PROVIDER_SCHEMAS,
        get_group_info: undefined as never,
      }),
    ).toContain("get_group_info:unknown_action");

    // An allowlisted parameter the provider never accepts is unsupported.
    const narrowed = {
      ...NAPCAT_PROVIDER_SCHEMAS,
      get_group_file_url: { payload: ["group_id"], returned: [] },
    };
    expect(unsupportedNapCatContract(narrowed)).toContain("get_group_file_url:file_id");
  });
});
