import { describe, expect, it } from "vitest";
import { createLearningId, internalLearningId, publicLearningId } from "./ids.js";

describe("learning governance identifiers", () => {
  it("creates public handles that do not match the internal UUID delivery rule", () => {
    expect(createLearningId("memory")).toMatch(/^memory_[0-9a-f]{32}$/u);
    expect(createLearningId("candidate")).toMatch(/^candidate_[0-9a-f]{32}$/u);
  });

  it("projects legacy UUIDs to reversible public handles", () => {
    const internal = "dbb93387-f95a-4e73-adbc-b37dadb9d2e2";
    const visible = publicLearningId("memory", internal);
    expect(visible).toBe("memory_legacy_dbb93387f95a4e73adbcb37dadb9d2e2");
    expect(internalLearningId("memory", visible)).toBe(internal);
  });
});
