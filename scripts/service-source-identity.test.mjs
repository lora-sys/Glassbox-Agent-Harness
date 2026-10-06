import test from "node:test";
import assert from "node:assert/strict";
import { serviceSourceIdentity } from "./service-source-identity.mjs";

test("launch evidence records clean commit, dirty checkout and unavailable Git distinctly", () => {
  const commit = "a".repeat(40);
  assert.deepEqual(
    serviceSourceIdentity(".", (_c, args) => (args[0] === "rev-parse" ? commit : "")),
    { launchCommit: commit, launchClean: true },
  );
  assert.deepEqual(
    serviceSourceIdentity(".", (_c, args) => (args[0] === "rev-parse" ? commit : " M source.ts")),
    { launchCommit: commit, launchClean: false },
  );
  assert.equal(
    serviceSourceIdentity(".", () => {
      throw new Error("unavailable");
    }),
    undefined,
  );
});
