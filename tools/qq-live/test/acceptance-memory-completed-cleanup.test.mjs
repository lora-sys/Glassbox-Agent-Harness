import test from "node:test";
import assert from "node:assert/strict";
import {
  matchAcceptanceMemoryCleanupHistory,
  acceptanceMemoryCleanupScopeObject,
  validateAcceptanceMemoryCleanupFailedAttempt,
  validateAcceptanceMemoryCleanupInputProjection,
  verifyAcceptanceMemoryCompletedCleanupReceipt,
} from "../lib/acceptance-memory-completed-cleanup.mjs";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HASH_IN = "a".repeat(64);
const HASH_OUT = "b".repeat(64);

function row(overrides = {}) {
  return {
    messageId: "855684704",
    selfId: "3526039967",
    senderId: "3526039967",
    userId: "3394947361",
    messageType: "private",
    time: 1791376248,
    realSequence: "615",
    textBytes: 572,
    textSha256: HASH_IN,
    segmentTypes: ["text"],
    ...overrides,
  };
}

function history(
  messages = [
    row(),
    row({
      messageId: "489880137",
      senderId: "3394947361",
      userId: "3526039967",
      time: 1791376277,
      realSequence: "616",
      textBytes: 852,
      textSha256: HASH_OUT,
    }),
  ],
) {
  return { accountIdentity: "3526039967", peerId: "3394947361", messages };
}

const expected = {
  driverId: "3526039967",
  botId: "3394947361",
  inputSha256: HASH_IN,
  inputBytes: 572,
  replySha256: HASH_OUT,
  replyBytes: 852,
};

function failedAttempt(overrides = {}) {
  const planSha256 = "c".repeat(64);
  const token = "d".repeat(32);
  const lease = {
    leaseId: "11111111-1111-4111-8111-111111111111",
    expiresAt: 1791376367939,
    toolsSha256: "e".repeat(64),
  };
  const at = "2026-10-07T12:30:47.556Z";
  const report = {
    schemaVersion: 1,
    kind: "acceptance-memory-cleanup",
    status: "INCONCLUSIVE",
    cleanupOnly: true,
    featurePass: false,
    planSha256,
    principalId: "owner-principal",
    origin: {
      reportSha256: "a".repeat(64),
      guardSha256: "b".repeat(64),
      sourceAuditSha256: "f".repeat(64),
    },
    runtime: {},
    startedAt: "2026-10-07T12:30:47.549Z",
    finishedAt: "2026-10-07T12:32:19.490Z",
    errorCode: "CLEANUP_REPLY_UNCONFIRMED",
    case: {
      id: "acceptance-memory-cleanup",
      status: "INCONCLUSIVE",
      code: "INPUT_NOT_OBSERVED",
      sendAttempted: true,
      inputObserved: false,
      leaseRegistrationAttempted: true,
      leaseRevoked: true,
      anomalies: [],
      token,
      route: "private",
      startedAt: at,
      promptSha256: "9".repeat(64),
      acceptanceLease: lease,
    },
  };
  const intent = {
    schemaVersion: 1,
    kind: "acceptance-memory-cleanup-send-intent",
    status: "SEND_MAY_HAVE_STARTED",
    planSha256,
    token,
    route: "private",
    startedAt: at,
    promptSha256: "9".repeat(64),
    leaseRegistrationAttempted: true,
    acceptanceLease: lease,
  };
  return {
    report: { ...report, ...overrides.report },
    intent: { ...intent, ...overrides.intent },
    planSha256,
  };
}

test("matches exactly one fixed Owner input and Bot reply from bounded private history", () => {
  const found = matchAcceptanceMemoryCleanupHistory(history(), expected);
  assert.equal(found.input.messageId, "855684704");
  assert.equal(found.reply.messageId, "489880137");
  assert.equal(found.input.realSequence, "615");
  assert.equal(found.reply.realSequence, "616");
  assert.equal("text" in found.input, false);
  assert.equal("text" in found.reply, false);
});

test("rejects missing, duplicate, altered, or out-of-order copies", () => {
  assert.throws(() => matchAcceptanceMemoryCleanupHistory(history([row()]), expected));
  assert.throws(() =>
    matchAcceptanceMemoryCleanupHistory(
      history([row(), row({ messageId: "855684705" }), history().messages[1]]),
      expected,
    ),
  );
  assert.throws(() =>
    matchAcceptanceMemoryCleanupHistory(
      history([row({ textSha256: "c".repeat(64) }), history().messages[1]]),
      expected,
    ),
  );
  assert.throws(() =>
    matchAcceptanceMemoryCleanupHistory(
      history([
        row(),
        history().messages[1],
        row({
          messageId: "855684706",
          textSha256: HASH_OUT,
          textBytes: 852,
          senderId: "3394947361",
          time: 1791376240,
          realSequence: "614",
        }),
      ]),
      expected,
    ),
  );
});

test("rejects history outside the configured Owner to Bot peer and any non-text rows", () => {
  assert.throws(() =>
    matchAcceptanceMemoryCleanupHistory(
      {
        ...history(),
        peerId: "3394947362",
      },
      expected,
    ),
  );
  assert.throws(() =>
    matchAcceptanceMemoryCleanupHistory(
      history([row({ segmentTypes: ["text", "image"] }), history().messages[1]]),
      expected,
    ),
  );
  assert.throws(() =>
    matchAcceptanceMemoryCleanupHistory(
      history([row({ text: "private payload must not be returned" }), history().messages[1]]),
      expected,
    ),
  );
});

test("rejects history records exceeding the fixed 20-message read bound", () => {
  assert.throws(() =>
    matchAcceptanceMemoryCleanupHistory(
      history([
        ...history().messages,
        ...Array.from({ length: 19 }, (_, i) => row({ messageId: String(855684710 + i) })),
      ]),
      expected,
    ),
  );
});

test("accepts only the exact failed INPUT_NOT_OBSERVED attempt as a recovery candidate", () => {
  const attempt = failedAttempt();
  assert.equal(
    validateAcceptanceMemoryCleanupFailedAttempt(attempt.report, attempt.intent, attempt.planSha256)
      .code,
    "INPUT_NOT_OBSERVED",
  );
});

test("does not convert no-ingress, other failures, or completed reports into recovery candidates", () => {
  const attempt = failedAttempt();
  assert.throws(() =>
    validateAcceptanceMemoryCleanupFailedAttempt(
      {
        ...attempt.report,
        case: { ...attempt.report.case, code: "API_REJECTED" },
      },
      attempt.intent,
      attempt.planSha256,
    ),
  );
  assert.throws(() =>
    validateAcceptanceMemoryCleanupFailedAttempt(
      {
        ...attempt.report,
        case: { ...attempt.report.case, code: "REPLY_TIMEOUT" },
      },
      attempt.intent,
      attempt.planSha256,
    ),
  );
  assert.throws(() =>
    validateAcceptanceMemoryCleanupFailedAttempt(
      {
        ...attempt.report,
        status: "CLEANUP_VERIFIED",
      },
      attempt.intent,
      attempt.planSha256,
    ),
  );
  assert.throws(() =>
    validateAcceptanceMemoryCleanupFailedAttempt(
      {
        ...attempt.report,
        case: { ...attempt.report.case, inputObserved: true },
      },
      attempt.intent,
      attempt.planSha256,
    ),
  );
  assert.throws(() =>
    validateAcceptanceMemoryCleanupFailedAttempt(
      {
        ...attempt.report,
        case: { ...attempt.report.case, unexpected: "raw content" },
      },
      attempt.intent,
      attempt.planSha256,
    ),
  );
});

test("matches the exact producer scope shape for null or configured threads", () => {
  const config = {
    runtime: { connectionId: "p3-qq", threadId: null },
    bot: { qq: "3394947361" },
    driver: { qq: "3526039967" },
  };
  assert.deepEqual(acceptanceMemoryCleanupScopeObject(config), {
    connectionId: "p3-qq",
    botId: "3394947361",
    chatType: "private",
    chatId: "3526039967",
    senderId: "3526039967",
  });
  config.runtime.threadId = "thread-1";
  assert.deepEqual(acceptanceMemoryCleanupScopeObject(config), {
    connectionId: "p3-qq",
    botId: "3394947361",
    chatType: "private",
    chatId: "3526039967",
    senderId: "3526039967",
    threadId: "thread-1",
  });
});

test("accepts only the production-safe reject projection and binds IDs through output and audits", () => {
  assert.deepEqual(validateAcceptanceMemoryCleanupInputProjection({ action: "reject" }), {
    action: "reject",
  });
  assert.throws(() => validateAcceptanceMemoryCleanupInputProjection(undefined));
  assert.throws(() => validateAcceptanceMemoryCleanupInputProjection({ action: "list" }));
  assert.throws(() =>
    validateAcceptanceMemoryCleanupInputProjection({
      action: "reject",
      candidateIds: ["candidate_" + "1".repeat(32)],
    }),
  );
  assert.throws(() =>
    validateAcceptanceMemoryCleanupInputProjection({
      action: "reject",
      extra: true,
    }),
  );
});

test("completed cleanup receipt rejects an open or mismatched schema before any external read", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "completed-cleanup-receipt-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const receiptPath = join(dir, "receipt.json");
  await writeFile(
    receiptPath,
    JSON.stringify({
      schemaVersion: 1,
      kind: "acceptance-memory-completed-cleanup",
      status: "CLEANUP_RECONCILED",
      cleanupOnly: true,
      featurePass: false,
      unexpected: "must be rejected",
    }),
    { mode: 0o600 },
  );
  assert.equal(await verifyAcceptanceMemoryCompletedCleanupReceipt({ receiptPath }), false);
});
