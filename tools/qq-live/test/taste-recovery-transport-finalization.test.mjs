import test from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../lib/runner.mjs";
import { finalizeTasteRecoveryTransport } from "../lib/taste-recovery-cli.mjs";

const config = {
  driver: { qq: "10001" },
  bot: { qq: "10002" },
};

function replyEvent(token, messageId, expected = "done") {
  return {
    self_id: Number(config.driver.qq),
    post_type: "message",
    message_type: "private",
    user_id: Number(config.bot.qq),
    time: Math.floor(Date.now() / 1000),
    message_id: messageId,
    message: [{ type: "text", data: { text: `${token} ${expected}` } }],
  };
}

function completedCase(recorder, id, token, messageId) {
  const current = recorder.begin(id, "private", "prompt {{nonce}}", ["done"], token);
  recorder.ingest("driver", replyEvent(token, messageId));
  assert.equal(current.replies.length, 1);
  recorder.finish(current, "PASS", "PASS", "reply observed");
  return current;
}

test("late duplicate from an earlier action prevents Taste cleanup finalization", () => {
  const recorder = new Recorder(config);
  const first = completedCase(recorder, "reject-correction", "a".repeat(32), "101");
  completedCase(recorder, "expire-original", "b".repeat(32), "201");

  recorder.ingest("driver", replyEvent(first.token, "102"));
  assert.equal(first.replies.length, 2);
  const report = {
    status: "INCONCLUSIVE",
    result: { status: "CLEANED", requiresReconciliation: false, cleanupRunIds: ["run-a", "run-b"] },
  };
  finalizeTasteRecoveryTransport(report, recorder);
  assert.equal(report.status, "INCONCLUSIVE");
  assert.equal(report.result.status, "INCONCLUSIVE");
  assert.equal(report.result.requiresReconciliation, true);
  assert.equal(report.result.error.code, "TASTE_RECOVERY_LATE_TRANSPORT_ANOMALY");
});

test("two independently completed cleanup actions preserve CLEANED finalization", () => {
  const recorder = new Recorder(config);
  completedCase(recorder, "reject-correction", "c".repeat(32), "301");
  completedCase(recorder, "expire-original", "d".repeat(32), "401");
  const report = {
    status: "INCONCLUSIVE",
    result: { status: "CLEANED", requiresReconciliation: false, cleanupRunIds: ["run-c", "run-d"] },
  };
  finalizeTasteRecoveryTransport(report, recorder);
  assert.equal(report.status, "CLEANED");
  assert.equal(report.result.status, "CLEANED");
  assert.equal(report.result.cleanupRunIds.length, 2);
  assert.equal(recorder.finalize(), "PASS");
});
