import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { historyInputDigest, verifyHistoryInputEvidence } from "../lib/history-input-evidence.mjs";

test("canonical history input witness matches fixed JSON bytes while preserving redaction", () => {
  const expected = '{"groupIds":["123"],"limit":1,"query":"检索编号"}';
  const input = { query: "检索编号", groupIds: ["123"], limit: 1 };
  const witness = historyInputDigest(input);
  assert.deepEqual(witness, {
    inputSha256: createHash("sha256").update(expected, "utf8").digest("hex"),
    inputBytes: Buffer.byteLength(expected, "utf8"),
  });
  assert.deepEqual(historyInputDigest({ limit: 1, groupIds: ["123"], query: "检索编号" }), witness);
  assert.deepEqual(Object.keys(witness).sort(), ["inputBytes", "inputSha256"]);
  assert.doesNotThrow(() => verifyHistoryInputEvidence({ data: witness }, input));
});

test("missing or changed witnesses and raw arguments cannot satisfy a protected-history call", () => {
  const input = { query: "a".repeat(32), groupIds: ["123"], limit: 1 };
  const witness = historyInputDigest(input);
  for (const data of [
    {},
    { ...witness, inputBytes: witness.inputBytes + 1 },
    { ...witness, inputSha256: "b".repeat(64) },
    { ...witness, input },
    historyInputDigest({ ...input, groupIds: ["456"] }),
    historyInputDigest({ ...input, limit: 2 }),
  ])
    assert.throws(() => verifyHistoryInputEvidence({ data }, input));
});

test("numeric object keys follow lexical canonical ordering without changing array order", () => {
  const expected = '{"nested":{"10":"ten","2":"two"},"values":[2,1]}';
  assert.deepEqual(historyInputDigest({ values: [2, 1], nested: { 2: "two", 10: "ten" } }), {
    inputSha256: createHash("sha256").update(expected, "utf8").digest("hex"),
    inputBytes: Buffer.byteLength(expected, "utf8"),
  });
});

test("bounded input witnesses reject invalid, cyclic, deep, and oversized recipes", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  let nested = { leaf: true };
  for (let i = 0; i < 18; i++) nested = { nested };
  for (const input of [null, [], "query", cyclic, nested, { query: "x".repeat(65536) }])
    assert.throws(() => historyInputDigest(input));
});
