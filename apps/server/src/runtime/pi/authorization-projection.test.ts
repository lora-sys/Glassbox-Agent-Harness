import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
  authorizationProjectionResult,
  projectionInputEvidence,
  unwrapAuthorizationProjection,
} from "./authorization-projection.js";

describe("trusted authorization projection envelopes", () => {
  it("hashes canonical validated arguments without storing their text", () => {
    expect(projectionInputEvidence({ z: 1, a: "private" })).toEqual(
      projectionInputEvidence({ a: "private", z: 1 }),
    );
    expect(projectionInputEvidence({ a: "private" }).inputSha256).toBe(
      createHash("sha256").update('{"a":"private"}', "utf8").digest("hex"),
    );
  });

  it("unwraps only the server-branded projection result", () => {
    const record = async () => undefined;
    const envelope = authorizationProjectionResult(
      { groups: [] },
      {
        kind: "managed_group_inventory",
        purpose: "managed_group_category_availability",
        decisions: [],
        input: {},
        record,
      },
    );
    expect(unwrapAuthorizationProjection(envelope)?.result).toEqual({ groups: [] });
    expect(
      unwrapAuthorizationProjection({ ...envelope, result: { leaked: true } }),
    ).toBeUndefined();
    expect(unwrapAuthorizationProjection({ result: {}, decisions: [] })).toBeUndefined();
  });
});
