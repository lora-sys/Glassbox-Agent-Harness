/** Runs in a disposable child process so Windows native database handles close at exit. */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { openDomainStore } from "../persistence/index.js";
import { RunTraceStore } from "../trace/run-store.js";
import { createRunEvaluator } from "./index.js";
import { evalOwner, openEvalFixture } from "./fixture.js";

const [stage, directory, runId, evalId] = process.argv.slice(2);
if ((stage !== "write" && stage !== "read") || !directory)
  throw new Error("Invalid Eval fixture arguments");
const databasePath = join(directory, "eval.db");
if (stage === "write") {
  const fixture = await openEvalFixture(directory, { databasePath });
  try {
    const id = await fixture.run();
    const result = await createRunEvaluator(fixture).evaluate(evalOwner, id);
    assert.equal(result.assessment?.verdict, "pass");
    process.stdout.write(JSON.stringify({ runId: id, evalId: result.id }));
  } finally {
    await fixture.close();
  }
} else {
  assert.ok(runId && evalId);
  const store = await openDomainStore({ databasePath });
  try {
    const evaluator = createRunEvaluator({ store, trace: new RunTraceStore(directory) });
    const page = await evaluator.list(evalOwner, runId);
    assert.equal(page.items[0]?.id, evalId);
    assert.equal(page.items[0]?.assessment?.verdict, "pass");
    assert.equal(page.items[0]?.assessment?.acceptance, "not-assessed");
    assert.equal(page.items[0]?.inputTokens, null);
    const second = await evaluator.evaluate(evalOwner, runId);
    assert.notEqual(second.id, evalId);
    assert.equal(second.assessment?.verdict, "pass");
    assert.deepEqual(second.assessment?.trace, page.items[0]?.assessment?.trace);
  } finally {
    await store.close();
  }
}
