import { describe, expect, it } from "vite-plus/test";
import type { CallerContext } from "../../identity/scope.js";
import { kitProfileSkillVisibility, resolveSkillVisibility } from "./skill-visibility.js";

const ownerPrivate: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "qq",
    botId: "bot",
    chatType: "private",
    chatId: "owner",
    senderId: "owner",
  },
};

const ownerInGroup: CallerContext = {
  principalId: "owner",
  scope: {
    connectionId: "qq",
    botId: "bot",
    chatType: "group",
    chatId: "group-1",
    senderId: "owner",
  },
};

const visitorInGroup: CallerContext = {
  principalId: "visitor",
  scope: {
    connectionId: "qq",
    botId: "bot",
    chatType: "group",
    chatId: "group-1",
    senderId: "visitor",
  },
};

const profile = { name: "main-agent", enabledSkills: ["github-gem-seeker", "unslop"] };

describe("P5 Skill authority and visibility", () => {
  it("authorizes nothing without a resolved Principal, and shows nothing either", () => {
    const visibility = resolveSkillVisibility({
      caller: null,
      isOwner: false,
      profile,
      group: null,
      availableSkills: ["unslop"],
    });

    expect(visibility.names).toEqual([]);
    expect(visibility.modelVisibleNames).toEqual([]);
    expect(visibility.policy).toEqual({ source: "no-caller" });
  });

  it("shows an Owner-private Run the catalog it may read, so skill_read is usable", () => {
    const visibility = resolveSkillVisibility({
      caller: ownerPrivate,
      isOwner: true,
      profile,
      group: null,
      availableSkills: ["github-gem-seeker", "unslop"],
    });

    // The defect this replaces: `skill_read` authorized, catalog hidden, model unable to learn
    // a single name to call it on.
    expect(visibility.names).toEqual(["github-gem-seeker", "unslop"]);
    expect(visibility.modelVisibleNames).toEqual(["github-gem-seeker", "unslop"]);
    expect(visibility.policy).toEqual({ source: "owner-profile", profile: "main-agent" });
  });

  it("does not widen authority to the Kit catalog for a non-Owner private Run", () => {
    const visibility = resolveSkillVisibility({
      caller: { ...ownerPrivate, principalId: "stranger" },
      isOwner: false,
      profile,
      group: null,
      availableSkills: ["github-gem-seeker", "unslop"],
    });

    // A non-Owner private Run is still bounded by the Kit profile. The difference from an
    // Owner Run is the recorded policy source, not the surface.
    expect(visibility.names).toEqual(profile.enabledSkills);
    expect(visibility.policy).toEqual({ source: "kit-profile" });
  });

  it("keeps the Owner's private Skill catalog out of a group Run's model view", () => {
    const visibility = resolveSkillVisibility({
      caller: ownerInGroup,
      isOwner: true,
      profile,
      group: { groupId: "group-1", configVersion: 3, enabledSkills: ["unslop"] },
      availableSkills: ["github-gem-seeker", "unslop"],
    });

    expect(visibility.names).toEqual(["github-gem-seeker", "unslop"]);
    // Authorized, but the audience is the group. A catalog the model can see is a catalog it
    // can repeat into a group reply, so it is not shown.
    expect(visibility.modelVisibleNames).toEqual([]);
  });

  it("gives a group Run exactly the Owner-configured whitelist, not the profile catalog", () => {
    const visibility = resolveSkillVisibility({
      caller: visitorInGroup,
      isOwner: false,
      profile,
      group: { groupId: "group-1", configVersion: 3, enabledSkills: ["unslop"] },
      availableSkills: ["github-gem-seeker", "unslop"],
    });

    expect(visibility.names).toEqual(["unslop"]);
    expect(visibility.modelVisibleNames).toEqual(["unslop"]);
    expect(visibility.policy).toEqual({
      source: "group-whitelist",
      groupId: "group-1",
      configVersion: 3,
    });
  });

  it("drops a configured Skill the Kit does not bundle instead of authorizing a name with no Skill", () => {
    const visibility = resolveSkillVisibility({
      caller: visitorInGroup,
      isOwner: false,
      profile,
      group: {
        groupId: "group-1",
        configVersion: 4,
        enabledSkills: ["unslop", "retired-skill"],
      },
      availableSkills: ["unslop"],
    });

    expect(visibility.names).toEqual(["unslop"]);
    expect(visibility.modelVisibleNames).toEqual(["unslop"]);
  });

  it("fails closed for a group Run whose capability configuration could not be read", () => {
    const visibility = resolveSkillVisibility({
      caller: visitorInGroup,
      isOwner: false,
      profile,
      group: null,
      availableSkills: ["unslop"],
    });

    // Falling back to `profile.enabledSkills` here would hand a group Run the Owner's private
    // catalog, which is the widening this branch exists to refuse.
    expect(visibility.names).toEqual([]);
    expect(visibility.modelVisibleNames).toEqual([]);
    expect(visibility.policy).toEqual({ source: "group-unconfigured" });
  });

  it("never shows the model a Skill name the Run is not authorized to read", () => {
    const scopes: CallerContext[] = [ownerPrivate, ownerInGroup, visitorInGroup];
    for (const caller of scopes)
      for (const isOwner of [true, false])
        for (const group of [
          null,
          { groupId: "group-1", configVersion: 1, enabledSkills: ["unslop"] },
        ]) {
          const visibility = resolveSkillVisibility({
            caller,
            isOwner,
            profile,
            group,
            availableSkills: ["unslop"],
          });
          const authorized = new Set(visibility.names);
          // The invariant that makes visibility safe to record as evidence: a name in the
          // model's view is always a name `skill_read` would really allow.
          for (const name of visibility.modelVisibleNames)
            expect(authorized.has(name), `${caller.scope.chatType}/${isOwner}/${name}`).toBe(true);
        }
  });

  it("reports each Skill name once, so a duplicated config cannot double-count authority", () => {
    const visibility = resolveSkillVisibility({
      caller: ownerPrivate,
      isOwner: true,
      profile: { name: "main-agent", enabledSkills: ["unslop", "unslop"] },
      group: null,
      availableSkills: ["unslop"],
    });

    expect(visibility.names).toEqual(["unslop"]);
    expect(visibility.modelVisibleNames).toEqual(["unslop"]);
  });
});

describe("P5 Kit-profile Skill visibility", () => {
  it("lets the Kit profile speak for itself when no channel policy was resolved", () => {
    const visibility = kitProfileSkillVisibility({ name: "qq-group", enabledSkills: ["unslop"] });

    expect(visibility.names).toEqual(["unslop"]);
    expect(visibility.modelVisibleNames).toEqual(["unslop"]);
    expect(visibility.policy).toEqual({ source: "kit-profile" });
  });

  it("agrees with the private-scope branch, so a Run with and without a resolver cannot differ", () => {
    const fromKit = kitProfileSkillVisibility(profile);
    const fromPolicy = resolveSkillVisibility({
      caller: { ...ownerPrivate, principalId: "stranger" },
      isOwner: false,
      profile,
      group: null,
      availableSkills: ["github-gem-seeker", "unslop"],
    });

    // The fallback is the Kit profile's own answer. If it ever diverged from the private-scope
    // policy, a fake runtime and the real one would offer the model different catalogs.
    expect(fromKit.names).toEqual(fromPolicy.names);
    expect(fromKit.modelVisibleNames).toEqual(fromPolicy.modelVisibleNames);
    expect(fromKit.policy).toEqual(fromPolicy.policy);
  });
});
