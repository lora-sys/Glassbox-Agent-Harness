import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyLeaseCleanupEvidence } from "../lib/lease-cleanup-evidence.mjs";

const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-lease-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const leaseId = randomUUID();
  const prompt = "GLASSBOX_ACCEPTANCE_V1 0123456789abcdef0123456789abcdef\r\nCheck marker";
  const scope = {
    connectionId: "connection-1",
    botId: "10001",
    chatType: "group",
    chatId: "20001",
    senderId: "30001",
    threadId: "thread-1",
  };
  const principalId = "principal-owner-1";
  const runId = "run_01HZXCVBNM123456789";
  const caseRecord = {
    token: "0123456789abcdef0123456789abcdef",
    startedAt: new Date(now - 10_000).toISOString(),
    prompt,
    leaseRevoked: true,
    inputBinding: { botMessageId: "90001" },
    acceptanceLease: {
      leaseId,
      expiresAt: now + 600_000,
      toolsSha256: hash("tools"),
    },
  };
  const scopeSha256 = hash(
    JSON.stringify([
      scope.connectionId,
      scope.botId,
      scope.chatType,
      scope.chatId,
      scope.senderId,
      scope.threadId,
    ]),
  );
  const registration = {
    at: new Date(now - 9_000).toISOString(),
    event: "lease_registered",
    leaseId,
    principalId,
    marker: caseRecord.token,
    expiresAt: caseRecord.acceptanceLease.expiresAt,
    toolsSha256: caseRecord.acceptanceLease.toolsSha256,
    scopeSha256,
  };
  const binding = {
    at: new Date(now - 8_000).toISOString(),
    event: "run_bound",
    leaseId,
    principalId,
    marker: caseRecord.token,
    runId,
    messageId: caseRecord.inputBinding.botMessageId,
    textSha256: hash(prompt.replace(/\r\n?/gu, "\n")),
    toolsSha256: caseRecord.acceptanceLease.toolsSha256,
    scopeSha256,
  };
  const revocation = {
    at: new Date(now - 7_000).toISOString(),
    event: "lease_revoked",
    leaseId,
    principalId,
    marker: caseRecord.token,
    scopeSha256,
  };
  const auditPath = join(directory, "qq-live-acceptance-audit.jsonl");
  const writeRows = async (rows) =>
    writeFile(auditPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const input = {
    dataDirectory: directory,
    caseRecord,
    runId,
    scope,
    principalId,
  };
  const expectInconclusive = async (args = input) => {
    await assert.rejects(verifyLeaseCleanupEvidence(args), (error) => {
      assert.equal(error.code, "LEASE_CLEANUP_EVIDENCE");
      assert.equal(error.status, "INCONCLUSIVE");
      assert.equal(error.message.includes(directory), false);
      assert.equal(error.message.includes(caseRecord.prompt), false);
      return true;
    });
  };
  await writeRows([registration, binding, revocation]);
  return {
    directory,
    auditPath,
    input,
    caseRecord,
    registration,
    binding,
    revocation,
    writeRows,
    expectInconclusive,
  };
}

test("lease cleanup verifier accepts terminal and manual revocation audit rows", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await verifyLeaseCleanupEvidence(f.input), {
    status: "PASS",
    leaseId: f.caseRecord.acceptanceLease.leaseId,
    runId: f.input.runId,
    revoked: true,
  });

  f.revocation = { ...f.revocation, marker: undefined, scopeSha256: undefined };
  delete f.revocation.marker;
  delete f.revocation.scopeSha256;
  await f.writeRows([f.registration, f.binding, f.revocation]);
  assert.deepEqual(await verifyLeaseCleanupEvidence(f.input), {
    status: "PASS",
    leaseId: f.input.caseRecord.acceptanceLease.leaseId,
    runId: f.input.runId,
    revoked: true,
  });
});

test("lease cleanup verifier rejects missing or malformed audit evidence", async (t) => {
  const f = await fixture(t);
  await rm(f.auditPath);
  await f.expectInconclusive();
  await f.writeRows([f.registration, f.binding]);
  await f.expectInconclusive();

  for (const mutate of [
    (r) => ({ ...r, scopeSha256: hash("wrong-scope") }),
    (r) => ({ ...r, principalId: "other-principal" }),
    (r) => ({ ...r, toolsSha256: hash("wrong-tools") }),
    (r) => ({ ...r, marker: "f".repeat(32) }),
    (r) => ({ ...r, runId: "foreign-run" }),
    (r) => ({ ...r, messageId: "90002" }),
    (r) => ({ ...r, textSha256: hash("different prompt") }),
    (r) => ({ ...r, at: new Date(Date.now() + 60_000).toISOString() }),
  ]) {
    await f.writeRows([f.registration, mutate(f.binding), f.revocation]);
    await f.expectInconclusive();
  }
  await f.writeRows([f.registration, f.binding, f.revocation]);
  await f.expectInconclusive({
    ...f.input,
    caseRecord: { ...f.caseRecord, leaseRevoked: false },
  });
  await f.expectInconclusive({
    ...f.input,
    caseRecord: { ...f.caseRecord, prompt: [] },
  });
  await f.writeRows([
    { ...f.registration, expiresAt: Date.parse(f.binding.at) - 1 },
    f.binding,
    f.revocation,
  ]);
  await f.expectInconclusive();
  await f.writeRows([f.registration, f.binding, { ...f.revocation, at: f.registration.at }]);
  await f.expectInconclusive();
  await f.writeRows([f.registration, f.binding, f.revocation, f.revocation]);
  await f.expectInconclusive();
  await f.writeRows([f.registration, f.registration, f.binding, f.revocation]);
  await f.expectInconclusive();
  await f.writeRows([f.registration, f.binding, f.revocation].reverse());
  await f.expectInconclusive();
});

test("lease cleanup verifier rejects malformed, incomplete and oversized JSONL", async (t) => {
  const f = await fixture(t);
  await writeFile(f.auditPath, '{"event":"lease_registered"}\n{"broken"\n', "utf8");
  await f.expectInconclusive();
  await writeFile(f.auditPath, JSON.stringify(f.registration), "utf8");
  await f.expectInconclusive();
  await writeFile(f.auditPath, `${JSON.stringify(f.registration)}\n${"x".repeat(32 * 1024 + 1)}\n`);
  await f.expectInconclusive();

  await truncate(f.auditPath, 32 * 1024 * 1024 + 1);
  await f.expectInconclusive();
  await f.writeRows(Array.from({ length: 201 }, () => ({ ...f.registration, event: "other" })));
  await f.expectInconclusive();
});

test("lease cleanup verifier rejects a symlink audit file", async (t) => {
  const f = await fixture(t);
  const target = join(f.directory, "audit-target.jsonl");
  await writeFile(
    target,
    `${JSON.stringify(f.registration)}\n${JSON.stringify(f.binding)}\n${JSON.stringify(f.revocation)}\n`,
  );
  await rm(f.auditPath);
  await symlink(target, f.auditPath);
  await f.expectInconclusive();
});
