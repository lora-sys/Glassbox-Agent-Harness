import { describe, expect, it } from "vitest";
import {
  READ_ACCEPTANCE_PATHS,
  probeReadCapabilities,
  safeResultShape,
  type CapabilityProbeObservation,
  type ProbeDecision,
  type ReadAcceptancePath,
} from "./capability-probe.js";
import { QQ_CAPABILITIES, isAllowedNapCatAction } from "./capabilities.js";
import type { OneBotCapabilityResult } from "./adapter.js";

const GROUP = "1126022432";

function ok(data: unknown): OneBotCapabilityResult {
  return { status: "ok", data };
}

/** Runs the probe over a fixed answer per action, collecting the evidence it recorded. */
async function probe(
  answer: (action: string) => Promise<OneBotCapabilityResult> | OneBotCapabilityResult,
  listing: () => Promise<unknown> = async () => [{ groupId: GROUP, managed: true }],
  decide: (path: ReadAcceptancePath, groupId: string | null) => Promise<ProbeDecision> = async () =>
    "allowed",
) {
  const recorded: CapabilityProbeObservation[] = [];
  const actions: string[] = [];
  const report = await probeReadCapabilities({
    groupId: GROUP,
    decide,
    invoke: async ({ action }) => {
      actions.push(action);
      return answer(action);
    },
    projectManagedGroups: listing,
    record: async (observation) => {
      recorded.push(observation);
    },
    now: () => new Date("2026-09-21T10:00:00.000Z"),
  });
  return { report, recorded, actions };
}

describe("the read paths this acceptance covers", () => {
  it("covers every provider-backed read domain the issue names", () => {
    const covered = new Set(READ_ACCEPTANCE_PATHS.map((path) => path.tool));
    expect([...covered].sort()).toEqual([
      "qq_group_content",
      "qq_group_files",
      "qq_group_history",
      "qq_group_members",
      "qq_groups",
    ]);
  });

  it("covers the managed listing alongside a real provider metadata read", () => {
    const listing = READ_ACCEPTANCE_PATHS.filter((path) => path.tool === "qq_groups");
    expect(listing.filter((path) => path.operation === null)).toHaveLength(1);
    expect(listing.filter((path) => path.operation === "get_group_info")).toHaveLength(1);
  });

  it("names only operations the registry really allows", () => {
    for (const path of READ_ACCEPTANCE_PATHS) {
      if (path.operation === null) continue;
      const capability = QQ_CAPABILITIES.find((entry) => entry.tool === path.tool);
      expect(capability, path.tool).toBeDefined();
      expect(
        capability!.operations.some((operation) => operation.action === path.operation),
        `${path.tool}.${path.operation}`,
      ).toBe(true);
      // The acceptance must not be able to prove anything a model could not call.
      expect(isAllowedNapCatAction(path.operation), path.operation).toBe(true);
    }
  });

  it("is read-only, so running it can never change a group", () => {
    for (const path of READ_ACCEPTANCE_PATHS) {
      const capability = QQ_CAPABILITIES.find((entry) => entry.tool === path.tool);
      expect(capability!.risk, path.tool).toBe("read");
    }
  });

  it("carries the Action, Resource and category the registry declares for the path", () => {
    // The authorization question is asked from these fields, so a path that carried facts the
    // registry does not declare would ask about an operation the Tool never performs — and an
    // acceptance is only evidence if it measures the path a Run would really take.
    for (const path of READ_ACCEPTANCE_PATHS) {
      const capability = QQ_CAPABILITIES.find((entry) => entry.tool === path.tool);
      expect(capability, path.tool).toBeDefined();
      expect(path.action, path.tool).toBe(capability!.action);
      expect(path.resource, path.tool).toBe(capability!.resource);
      expect(path.category, path.tool).toBe(capability!.category);
      // The provider-free managed listing is the only path that reaches no provider.
      expect(path.listing, `${path.tool}.${path.operation ?? "listing"}`).toBe(
        path.operation === null,
      );
    }
  });
});

describe("the shape one result is recorded as", () => {
  it("describes an array without carrying any of its values", () => {
    expect(safeResultShape([{ user_id: 10004, nickname: "秘密昵称" }, { user_id: 10005 }])).toEqual(
      {
        kind: "array",
        count: 2,
        elementFields: ["nickname", "user_id"],
      },
    );
  });

  it("describes an object by its field names", () => {
    expect(safeResultShape({ group_id: 1126022432, group_name: "验收群" })).toEqual({
      kind: "object",
      fields: ["group_id", "group_name"],
    });
  });

  it("keeps a short page a shape rather than an absence", () => {
    // Empty valid data is still a successful provider call, so the shape must say "empty
    // array" and not collapse to the same thing as a missing field.
    expect(safeResultShape([])).toEqual({ kind: "array", count: 0 });
  });

  it("names a scalar's kind without repeating the scalar", () => {
    expect(safeResultShape("secret-token")).toEqual({ kind: "string" });
    expect(safeResultShape(7)).toEqual({ kind: "number" });
    expect(safeResultShape(null)).toEqual({ kind: "null" });
  });

  it("withholds a field name that looks like content rather than a schema name", () => {
    // A provider that puts a message where a field name belongs must not have that message
    // copied into evidence. The shape says a field was withheld, never what it said.
    const shape = safeResultShape({ 有人的原话在这里: 1, ok: true });
    expect(shape).toEqual({ kind: "object", fields: ["ok"], fieldsRedacted: true });
    expect(JSON.stringify(shape)).not.toContain("原话");
  });

  it("bounds how many field names one shape may carry", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`field_${index}`, index]),
    );
    expect(safeResultShape(wide).fields).toHaveLength(32);
  });

  it("never recurses into a nested value", () => {
    const shape = safeResultShape({ msg: [{ text: "不该出现在证据里" }] });
    expect(JSON.stringify(shape)).not.toContain("不该出现在证据里");
  });
});

describe("running the acceptance", () => {
  it("records one observation per path with the group it targeted", async () => {
    const { report, recorded } = await probe(() => ok({ group_id: Number(GROUP) }));
    expect(recorded).toHaveLength(READ_ACCEPTANCE_PATHS.length);
    expect(report.observations).toHaveLength(READ_ACCEPTANCE_PATHS.length);
    for (const observation of recorded) {
      // The listing is not group-scoped, so it names no group rather than borrowing one.
      expect(observation.groupId).toBe(observation.providerBacked ? GROUP : null);
      expect(observation.observedAt).toBe("2026-09-21T10:00:00.000Z");
    }
  });

  it("calls the provider once per provider-backed path, with the group bound", async () => {
    const { actions } = await probe(() => ok({}));
    expect(actions.sort()).toEqual([
      "_get_group_notice",
      "get_essence_msg_list",
      "get_group_info",
      "get_group_member_list",
      "get_group_msg_history",
      "get_group_root_files",
    ]);
  });

  it("reports a path that succeeded as succeeded, with the shape it returned", async () => {
    const { report } = await probe((action) =>
      ok(action === "get_group_member_list" ? [{ user_id: 10004 }] : { group_id: Number(GROUP) }),
    );
    const members = report.observations.find(
      (entry) => entry.operation === "get_group_member_list",
    )!;
    expect(members.outcome).toBe("success");
    expect(members.providerBacked).toBe(true);
    expect(members.resultShape).toEqual({ kind: "array", count: 1, elementFields: ["user_id"] });
    expect(report.complete).toBe(true);
  });

  it("keeps a provider-free listing from being read as provider health", async () => {
    // The managed listing never reaches the bridge, so its success says nothing about whether
    // the bridge works. Counting it as one would make the report claim a verified provider.
    const { report } = await probe((action) =>
      action === "get_group_info"
        ? { status: "failed", code: "not_connected" }
        : ok({ group_id: Number(GROUP) }),
    );
    const listing = report.observations.find((entry) => entry.operation === null)!;
    expect(listing.outcome).toBe("success");
    expect(listing.providerBacked).toBe(false);
    // Six paths answered and five of them reached the bridge, so the provider count is five:
    // the listing's own success is in the report and not in the provider's verdict.
    expect(report.observations.filter((entry) => entry.outcome === "success")).toHaveLength(6);
    expect(report.summary.providerBackedSucceeded).toBe(5);
    expect(report.complete).toBe(false);
  });

  it("classifies a refused, disconnected or broken call apart from each other", async () => {
    const { report } = await probe((action) => {
      if (action === "get_group_info")
        return { status: "rejected", code: "action_not_allowlisted" };
      if (action === "get_group_msg_history") return { status: "failed", code: "not_connected" };
      if (action === "get_group_root_files") return { status: "failed", code: "api_rejected" };
      if (action === "_get_group_notice") return { status: "unknown", code: "invalid_response" };
      return ok({});
    });
    const outcome = (operation: string) =>
      report.observations.find((entry) => entry.operation === operation)!.outcome;
    expect(outcome("get_group_info")).toBe("denied");
    expect(outcome("get_group_msg_history")).toBe("provider_unavailable");
    expect(outcome("get_group_root_files")).toBe("provider_failed");
    expect(outcome("_get_group_notice")).toBe("unknown");
    expect(report.summary.denied).toBe(1);
    expect(report.summary.providerUnavailable).toBe(1);
    expect(report.summary.providerFailed).toBe(1);
    expect(report.summary.unknown).toBe(1);
  });

  it("keeps probing after a failure, so one broken path does not hide the rest", async () => {
    const { report, actions } = await probe((action) =>
      action === "get_group_info" ? { status: "failed", code: "not_connected" } : ok({}),
    );
    expect(actions).toHaveLength(6);
    expect(report.observations.filter((entry) => entry.outcome === "success")).toHaveLength(6);
  });

  it("records the failure without the provider's own error text or parameters", async () => {
    const { recorded } = await probe(() => ({
      status: "failed",
      code: "api_rejected",
      retcode: 1400,
    }));
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain("1400");
    expect(serialized).not.toContain("retcode");
  });

  it("carries no result value into the recorded evidence", async () => {
    const { recorded } = await probe(() =>
      ok({ group_name: "验收群", notice: "有人的原话在这里", member_list: [{ nickname: "某人" }] }),
    );
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain("验收群");
    expect(serialized).not.toContain("有人的原话在这里");
    expect(serialized).not.toContain("某人");
  });

  it("fails closed when the provider-free listing throws", async () => {
    const { report } = await probe(
      () => ok({}),
      async () => {
        throw new Error("inventory unavailable");
      },
    );
    const listing = report.observations.find((entry) => entry.operation === null)!;
    expect(listing.outcome).toBe("unknown");
    expect(listing.resultShape).toBeNull();
    // A local projection failure is not a provider failure, and the report must not say it is.
    expect(report.summary.providerFailed).toBe(0);
    expect(report.complete).toBe(true);
  });
});

describe("authorizing a path before calling it", () => {
  it("asks about the group a path targets, and about none for the listing", async () => {
    const asked: Array<string | null> = [];
    await probe(
      () => ok({}),
      undefined,
      async (_path, groupId) => {
        asked.push(groupId);
        return "allowed";
      },
    );
    // The listing names no group, so there is no group Resource to authorize it on; every other
    // path targets the group the operator named.
    expect(asked).toEqual(
      READ_ACCEPTANCE_PATHS.map((path) => (path.operation === null ? null : GROUP)),
    );
  });

  it("records a denied path as denied and never calls it", async () => {
    const { report, recorded, actions } = await probe(
      () => ok({}),
      undefined,
      async (path) => (path.tool === "qq_group_members" ? "denied" : "allowed"),
    );

    const members = report.observations.find((entry) => entry.tool === "qq_group_members")!;
    expect(members.outcome).toBe("denied");
    // A refusal produced no result, so there is no shape to describe — a shape here would have
    // to come from a call that never happened.
    expect(members.resultShape).toBeNull();
    // The refusal is what stops the call: the provider must never have seen this path.
    expect(actions).not.toContain("get_group_member_list");
    expect(report.summary.denied).toBe(1);
    // A refused path was never measured, so the acceptance did not prove the bridge works.
    expect(report.complete).toBe(false);
    // It is still recorded: "which paths are permitted" is the report's business, and a denial
    // that left no evidence would be indistinguishable from a path nobody probed.
    expect(recorded).toHaveLength(READ_ACCEPTANCE_PATHS.length);
    expect(recorded.filter((entry) => entry.outcome === "denied")).toHaveLength(1);
  });

  it("refuses the provider-free listing without running its projection", async () => {
    let projections = 0;
    const { report } = await probe(
      () => ok({}),
      async () => {
        projections += 1;
        return [{ groupId: GROUP, managed: true }];
      },
      async (path) => (path.listing ? "denied" : "allowed"),
    );

    const listing = report.observations.find((entry) => entry.operation === null)!;
    expect(listing.outcome).toBe("denied");
    expect(projections).toBe(0);
    // A refusal is neither a provider failure nor a local one, and the counts must not
    // double-count it: `localFailed` is for a projection that ran and broke.
    expect(report.summary.denied).toBe(1);
    expect(report.summary.localFailed).toBe(0);
    // The provider verdict is untouched by a provider-free path either way.
    expect(report.summary.providerBackedSucceeded).toBe(6);
    expect(report.complete).toBe(true);
  });

  it("keeps probing after a denial, so one refusal does not hide the rest", async () => {
    const { report, actions } = await probe(
      () => ok({}),
      undefined,
      async (path) => (path.tool === "qq_groups" && !path.listing ? "denied" : "allowed"),
    );

    expect(actions).toHaveLength(5);
    expect(actions).not.toContain("get_group_info");
    expect(report.summary.providerBackedSucceeded).toBe(5);
    expect(report.complete).toBe(false);
  });
});
