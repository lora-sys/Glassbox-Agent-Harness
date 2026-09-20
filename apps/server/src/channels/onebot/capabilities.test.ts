import { describe, expect, it } from "vite-plus/test";
import {
  NAPCAT_CONTRACT_SNAPSHOT,
  QQ_ALLOWED_NAPCAT_ACTIONS,
  QQ_CAPABILITIES,
  QQ_CAPABILITY_CATEGORIES,
  SERVER_ONLY_NAPCAT_ACTIONS,
  checkNapCatContract,
  isAllowedNapCatAction,
  qqCapabilitiesForCategory,
  qqCapability,
  resolveQqOperation,
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
        expect(operation.action).toMatch(/^[a-z][a-z0-9_]*$/u);
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

  it("keeps credential, packet, transport and raw-send primitives server-only", () => {
    // The provider surface these belong to must never reach a model-visible Tool.
    const forbidden = [
      "get_credentials",
      "get_cookies",
      "get_csrf",
      "get_clientkey",
      "get_rkey",
      "get_rkey_ex",
      "send_packet",
      "bot_exit",
      "send_group_msg",
      "send_private_msg",
      "send_msg",
      "call_action",
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
    expect(NAPCAT_CONTRACT_SNAPSHOT.license).toMatch(/Limited Redistribution/u);
    expect(NAPCAT_CONTRACT_SNAPSHOT.sourcePath).toContain("napcat-onebot/action");
    expect(NAPCAT_CONTRACT_SNAPSHOT.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions.length).toBeGreaterThan(0);
  });
});
