import { describe, expect, it } from "vitest";
import { Type, type TSchema } from "typebox";
import { toolSchemaEvidence } from "./tool-schema-evidence.js";

const tool = (parameters: TSchema, description = "Read status") => ({
  name: "qq_account",
  description,
  parameters,
});

describe("selected Tool schema evidence", () => {
  it("records constrained definitions without retaining protected schema literals", () => {
    const result = toolSchemaEvidence([
      tool(
        Type.Object({ operation: Type.Literal("get_status"), groupId: Type.Literal("1121579672") }),
      ),
    ]);
    expect(result.source).toBe("pi-selected-custom-tools");
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.tools[0]?.name).toBe("qq_account");
    expect(JSON.stringify(result)).not.toContain("1121579672");
    expect(JSON.stringify(result)).not.toContain("get_status");
  });
  it("detects changed parameters and descriptions", () => {
    const status = tool(Type.Object({ operation: Type.Literal("get_status") }));
    const login = tool(Type.Object({ operation: Type.Literal("get_login_info") }));
    expect(toolSchemaEvidence([status]).sha256).not.toBe(toolSchemaEvidence([login]).sha256);
    expect(toolSchemaEvidence([status]).sha256).not.toBe(
      toolSchemaEvidence([{ ...status, description: "Other" }]).sha256,
    );
  });
  it("ignores object key insertion order while preserving branch and Tool order", () => {
    const original = Type.Object({ a: Type.String(), b: Type.Number() });
    const reordered = {
      ...original,
      properties: { b: original.properties.b, a: original.properties.a },
    };
    expect(toolSchemaEvidence([tool(original)]).sha256).toBe(
      toolSchemaEvidence([tool(reordered)]).sha256,
    );
    const first = tool(original);
    const second = { ...tool(original), name: "other" };
    expect(toolSchemaEvidence([first, second]).sha256).not.toBe(
      toolSchemaEvidence([second, first]).sha256,
    );
    expect(toolSchemaEvidence([]).tools).toEqual([]);
  });
});
