import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { GATE_MESSAGES } from "./gate-messages.js";
import { ownerCapabilityCommand } from "./run-adapter.js";

it("binds an exact /capability command to one group, category and state (#112)", () => {
  expect(ownerCapabilityCommand("/capability 123456789 group.moderate on")).toEqual({
    name: "owner_group_admin",
    input: {
      action: "set_capability",
      groupId: "123456789",
      category: "group.moderate",
      enabled: true,
    },
  });
  expect(ownerCapabilityCommand("  /capability 123456789 group.history off ")).toMatchObject({
    input: { category: "group.history", enabled: false },
  });
});

it("does not turn quoted, malformed or unknown-category text into a capability change (#112)", () => {
  for (const text of [
    "please run /capability 123456789 group.moderate on",
    "`/capability 123456789 group.moderate on`",
    "/capability 123456789 group.moderate maybe",
    "/capability 123456789 group.moderate on and more",
    "/capability 1234 group.moderate on",
    "/capability 123456789 not.a.category on",
    "/capability 123456789 group.moderate",
  ])
    expect(ownerCapabilityCommand(text)).toBeUndefined();
});

it("keeps every gate sentence in one place and never duplicates or conflicts (#112)", () => {
  const values = Object.values(GATE_MESSAGES);
  expect(new Set(values).size).toBe(values.length);
  const source = readFileSync(new URL("./run-adapter.ts", import.meta.url), "utf8");
  for (const sentence of values) expect(source).not.toContain(`"${sentence}"`);
});
