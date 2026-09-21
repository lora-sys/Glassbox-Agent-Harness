import { expect, it } from "vite-plus/test";
import { matchCapabilityEntries, type CapabilitySearchEntry } from "./capability-search.js";

const entries: CapabilitySearchEntry[] = [
  {
    tool: "qq_group_history",
    description: "Read a managed group's live message history page.",
    category: "group.history",
    readOnly: true,
    groupIds: ["100", "200"],
  },
  {
    tool: "qq_group_members",
    description: "Read a managed group's member list or one member's profile.",
    category: "group.members",
    readOnly: true,
    groupIds: ["100"],
  },
  {
    tool: "qq_group_moderation",
    description: "Moderate a managed group: mute, kick or set whole-group mute.",
    category: "group.moderate",
    readOnly: false,
    groupIds: ["200"],
  },
];

it("returns the whole authorized set when no query is given", () => {
  expect(matchCapabilityEntries(entries, undefined)).toEqual(entries);
  expect(matchCapabilityEntries(entries, "")).toEqual(entries);
  expect(matchCapabilityEntries(entries, "   ")).toEqual(entries);
});

it("matches on the Tool name, the category and the description, preserving order", () => {
  // A Tool name is matchable on its own.
  expect(matchCapabilityEntries(entries, "members").map((entry) => entry.tool)).toEqual([
    "qq_group_members",
  ]);
  // The category is part of the searchable surface.
  expect(matchCapabilityEntries(entries, "group.moderate").map((entry) => entry.tool)).toEqual([
    "qq_group_moderation",
  ]);
  // A description word matches, and the incoming order is preserved.
  expect(matchCapabilityEntries(entries, "read").map((entry) => entry.tool)).toEqual([
    "qq_group_history",
    "qq_group_members",
  ]);
});

it("requires every query token, so a narrower query is never a broader match", () => {
  expect(matchCapabilityEntries(entries, "group").map((entry) => entry.tool)).toEqual([
    "qq_group_history",
    "qq_group_members",
    "qq_group_moderation",
  ]);
  expect(matchCapabilityEntries(entries, "group member").map((entry) => entry.tool)).toEqual([
    "qq_group_members",
  ]);
  expect(matchCapabilityEntries(entries, "group kick").map((entry) => entry.tool)).toEqual([
    "qq_group_moderation",
  ]);
});

it("reports a query that matched nothing as nothing, never as everything", () => {
  expect(matchCapabilityEntries(entries, "zzz-nonexistent")).toEqual([]);
  // Registry metadata is English, so a Han-only query matches no entry. That is an honest
  // empty result rather than a fallback to the whole set.
  expect(matchCapabilityEntries(entries, "群成员")).toEqual([]);
});

it("matches case-insensitively and treats punctuation as a separator", () => {
  expect(matchCapabilityEntries(entries, "HISTORY").map((entry) => entry.tool)).toEqual([
    "qq_group_history",
  ]);
  expect(matchCapabilityEntries(entries, "kick,").map((entry) => entry.tool)).toEqual([
    "qq_group_moderation",
  ]);
});

it("does not mutate the entries it was given", () => {
  const input: CapabilitySearchEntry[] = [
    { tool: "a", description: "b", category: "group.read", readOnly: true, groupIds: ["1"] },
  ];
  const result = matchCapabilityEntries(input, undefined);
  expect(result).not.toBe(input);
  expect(result).toEqual(input);
});
