import type { CallerContext } from "../../identity/scope.js";

/**
 * Which Skill names a Run may use, and which of them the model may see.
 *
 * These are two different questions and the drift this module exists to prevent is answering
 * only the first. `names` is authority: the Skill names `skill_read` will be authorized to
 * open. `modelVisibleNames` is discovery: the names the Run tells the model exist.
 *
 * The failure this replaces was a Run with `skill_read` on its surface and an empty
 * `modelVisibleNames`, so the model held a Tool it had no way to learn how to call. A Tool
 * that is authorized but undiscoverable is the same class of defect as a Tool that is
 * registered but unauthorized — both leave a Run unable to explain its own capabilities.
 *
 * Visibility is always a subset of authority. Showing the model a Skill name it cannot read
 * would invite a call that is guaranteed to be denied, and in a group Run it would let a
 * catalog the group was never granted be repeated into the group reply.
 */
export interface SkillVisibility {
  readonly names: readonly string[];
  readonly modelVisibleNames: readonly string[];
  readonly policy: Record<string, unknown>;
}

export interface GroupSkillConfig {
  readonly groupId: string;
  readonly configVersion: number;
  readonly enabledSkills: readonly string[];
}

export interface SkillVisibilityFacts {
  /** Absent when the Run has no resolved Principal. Nothing is authorized without one. */
  readonly caller: CallerContext | null;
  readonly isOwner: boolean;
  readonly profile: { readonly name: string; readonly enabledSkills: readonly string[] };
  /** The group's Owner-private capability configuration, when the Run's scope is a group. */
  readonly group: GroupSkillConfig | null;
  /** Skill names the Kit really bundles, so a configured name with no Skill behind it is dropped. */
  readonly availableSkills: readonly string[];
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * The visibility a Run gets when no channel policy was resolved at all.
 *
 * This is the Kit profile speaking for itself: the Run may read what the profile enables and
 * the model is told the same names. It is not a fallback for a Run that *has* a Principal and
 * failed to resolve one — that case is `no-caller` above, and it denies.
 */
export function kitProfileSkillVisibility(profile: {
  readonly name: string;
  readonly enabledSkills: readonly string[];
}): SkillVisibility {
  return {
    names: unique(profile.enabledSkills),
    modelVisibleNames: unique(profile.enabledSkills),
    policy: { source: "kit-profile" },
  };
}

/**
 * Resolve Skill authority and visibility for one Run.
 *
 * Every branch returns both answers together, so a caller cannot take authority without also
 * deciding what the model is told about it.
 */
export function resolveSkillVisibility(facts: SkillVisibilityFacts): SkillVisibility {
  const { caller, profile } = facts;

  // No Principal means no authority to resolve. An empty catalog is the only honest answer.
  if (!caller) return { names: [], modelVisibleNames: [], policy: { source: "no-caller" } };

  if (caller.scope.chatType !== "group")
    return {
      names: unique(profile.enabledSkills),
      // A private-scope Run sees the Skills it may use, by name and description only;
      // `skill_read` loads the locked files on demand.
      modelVisibleNames: unique(profile.enabledSkills),
      policy: facts.isOwner
        ? { source: "owner-profile", profile: profile.name }
        : { source: "kit-profile" },
    };

  if (facts.isOwner)
    return {
      names: unique(profile.enabledSkills),
      // An Owner message in a group still has the group as its audience. The Owner's private
      // Skill catalog is authorized for the Run but is not shown, because a catalog the model
      // can see is a catalog it can repeat into a group reply.
      modelVisibleNames: [],
      policy: { source: "owner-profile", profile: profile.name },
    };

  // A group Run gets what the Owner enabled for this group, intersected with what the Kit
  // actually bundles. Fails closed when no configuration could be read, rather than falling
  // back to the profile catalog, which is the Owner's private surface.
  if (!facts.group)
    return { names: [], modelVisibleNames: [], policy: { source: "group-unconfigured" } };

  const available = new Set(facts.availableSkills);
  const enabled = unique(facts.group.enabledSkills).filter((name) => available.has(name));
  return {
    names: enabled,
    modelVisibleNames: enabled,
    policy: {
      source: "group-whitelist",
      groupId: facts.group.groupId,
      configVersion: facts.group.configVersion,
    },
  };
}
