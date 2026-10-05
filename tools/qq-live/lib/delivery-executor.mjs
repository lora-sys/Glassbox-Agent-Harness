import { randomUUID } from "node:crypto";

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function result(status, code, message, details = {}) {
  return {
    status,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...details,
  };
}

function validPrUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && Boolean(url.pathname);
  } catch {
    return false;
  }
}

function remoteHead(remote) {
  return remote?.head ?? remote?.headCommit;
}

function validMergeCommit(remote) {
  return COMMIT.test(remote?.mergeCommit ?? "");
}

function validRemoteForMerge(remote, commit) {
  return (
    remote?.state === "OPEN" &&
    remoteHead(remote) === commit &&
    remote.draft === false &&
    Array.isArray(remote.checks) &&
    remote.checks.length > 0 &&
    remote.checks.every((check) => check?.commit === commit && check.status === "SUCCESS") &&
    remote.review?.commit === commit &&
    remote.review.status === "PASS"
  );
}

function exactAttempt(attempt, { prUrl, commit, acceptanceIdentitySha256 }, suiteSha256) {
  return (
    attempt &&
    typeof attempt === "object" &&
    attempt.prUrl === prUrl &&
    attempt.commit === commit &&
    attempt.acceptanceIdentitySha256 === acceptanceIdentitySha256 &&
    SHA256.test(attempt.suiteSha256 ?? "") &&
    (!suiteSha256 || attempt.suiteSha256 === suiteSha256) &&
    typeof attempt.attemptId === "string" &&
    attempt.attemptId.length > 0 &&
    attempt.status === "ATTEMPTING"
  );
}

async function callDependency(fn, args, name) {
  try {
    return { value: await fn(args) };
  } catch (error) {
    return {
      error: {
        code: typeof error?.code === "string" ? error.code : `${name.toUpperCase()}_FAILED`,
        message: `${name} could not be confirmed.`,
      },
    };
  }
}

async function checkReadiness(input, deps, expectedSuiteSha256, requireMergeAuthorization = false) {
  const gateCall = await callDependency(deps.evaluateGate, input, "evaluate_gate");
  if (gateCall.error) return { error: gateCall.error };
  const gate = gateCall.value;
  if (
    gate?.status !== "PASS" ||
    gate.commit !== input.commit ||
    !SHA256.test(gate.suiteSha256 ?? "") ||
    !COMMIT.test(gate.remoteHead ?? "") ||
    gate.remoteHead !== input.commit ||
    (requireMergeAuthorization && gate.mergeAuthorized !== true) ||
    (expectedSuiteSha256 && gate.suiteSha256 !== expectedSuiteSha256)
  )
    return {
      error: {
        code: "DELIVERY_GATE",
        message: "The gate did not confirm this exact commit and suite.",
      },
    };

  const localCall = await callDependency(deps.readLocalHead, undefined, "read_local_head");
  if (localCall.error) return { error: localCall.error };
  if (localCall.value?.commit !== input.commit || localCall.value.clean !== true)
    return {
      error: {
        code: "LOCAL_HEAD_CHANGED",
        message: "The local checkout is not clean at the approved commit.",
      },
    };

  const remoteCall = await callDependency(deps.readRemote, { prUrl: input.prUrl }, "read_remote");
  if (remoteCall.error) return { error: remoteCall.error };
  if (
    !validRemoteForMerge(remoteCall.value, input.commit) ||
    remoteHead(remoteCall.value) !== gate.remoteHead
  )
    return {
      error: {
        code: "REMOTE_HEAD_CHANGED",
        message: "The remote pull request is not ready at the approved head.",
      },
    };

  return { gate, remote: remoteCall.value };
}

async function writeOutcome(deps, outcome) {
  const written = await callDependency(deps.writeOutcome, outcome, "write_outcome");
  if (written.error) return written.error;
  if (written.value === false || written.value?.durable === false)
    return {
      code: "OUTCOME_NOT_DURABLE",
      message: "The delivery outcome was not durably confirmed.",
    };
  return null;
}

async function finishConfirmedMerge(input, deps, binding, remote, attempt) {
  if (!validMergeCommit(remote))
    return result(
      "INCONCLUSIVE",
      "MERGE_COMMIT_UNCONFIRMED",
      "The remote did not provide the exact merge commit SHA.",
      { ...binding, attemptId: attempt.attemptId, mergeConfirmed: false },
    );
  const mergedBinding = {
    prUrl: binding.prUrl,
    candidateCommit: binding.commit,
    commit: remote.mergeCommit,
    mergeCommit: remote.mergeCommit,
    suiteSha256: binding.suiteSha256,
    acceptanceIdentitySha256: binding.acceptanceIdentitySha256,
  };
  const mergedOutcome = {
    status: "MERGED",
    ...mergedBinding,
    attemptId: attempt.attemptId,
    remoteHead: remoteHead(remote),
    confirmedAt: new Date().toISOString(),
  };
  const persistenceError = await writeOutcome(deps, mergedOutcome);
  if (persistenceError)
    return result("INCONCLUSIVE", persistenceError.code, persistenceError.message, {
      ...mergedBinding,
      attemptId: attempt.attemptId,
      mergeConfirmed: true,
    });

  if (typeof deps.postMergeAccept !== "function")
    return result("MERGED", null, null, {
      ...mergedBinding,
      attemptId: attempt.attemptId,
    });

  const acceptanceCall = await callDependency(
    deps.postMergeAccept,
    { ...mergedBinding, attemptId: attempt.attemptId },
    "post_merge_acceptance",
  );
  const acceptance = acceptanceCall.value;
  if (
    acceptanceCall.error ||
    acceptance?.status !== "PASS" ||
    acceptance.commit !== remote.mergeCommit ||
    acceptance.candidateCommit !== binding.commit ||
    acceptance.prUrl !== binding.prUrl ||
    acceptance.suiteSha256 !== binding.suiteSha256 ||
    acceptance.acceptanceIdentitySha256 !== binding.acceptanceIdentitySha256
  ) {
    const failure = acceptanceCall.error ?? {
      code: "POST_MERGE_ACCEPTANCE",
      message: "Independent post-merge acceptance did not pass for this delivery.",
    };
    const logError = await writeOutcome(deps, {
      status: "INCONCLUSIVE",
      ...mergedBinding,
      attemptId: attempt.attemptId,
      mergeConfirmed: true,
      postMergeAcceptance: failure.code,
    });
    return result(
      "INCONCLUSIVE",
      logError?.code ?? failure.code,
      logError?.message ?? failure.message,
      {
        ...mergedBinding,
        attemptId: attempt.attemptId,
        mergeConfirmed: true,
      },
    );
  }

  const delivered = {
    status: "DELIVERED",
    ...mergedBinding,
    attemptId: attempt.attemptId,
    remoteHead: remoteHead(remote),
    acceptance,
    confirmedAt: new Date().toISOString(),
  };
  const deliveryWriteError = await writeOutcome(deps, delivered);
  if (deliveryWriteError)
    return result("INCONCLUSIVE", deliveryWriteError.code, deliveryWriteError.message, {
      ...mergedBinding,
      attemptId: attempt.attemptId,
      mergeConfirmed: true,
    });
  return result("DELIVERED", null, null, {
    ...mergedBinding,
    attemptId: attempt.attemptId,
  });
}

/** Check a delivery read-only, or merge one exact approved head after explicit live authorization. */
export async function executeDelivery(input, deps) {
  if (
    !input ||
    typeof input !== "object" ||
    !COMMIT.test(input.commit ?? "") ||
    !validPrUrl(input.prUrl) ||
    (input.suiteSha256 !== undefined && !SHA256.test(input.suiteSha256)) ||
    (input.acceptanceIdentitySha256 !== undefined && !SHA256.test(input.acceptanceIdentitySha256))
  )
    return result(
      "BLOCKED",
      "DELIVERY_INPUT",
      "A valid commit and HTTPS pull request URL are required.",
    );
  if (
    !deps ||
    [
      "evaluateGate",
      "readLocalHead",
      "readRemote",
      "readAttempt",
      "writeAttempt",
      "writeOutcome",
    ].some((name) => typeof deps[name] !== "function")
  )
    return result(
      "BLOCKED",
      "DELIVERY_DEPENDENCIES",
      "Delivery requires trusted gate, state, and durable log dependencies.",
    );

  if (input.live !== true) {
    const readiness = await checkReadiness(input, deps, input.suiteSha256);
    if (readiness.error)
      return result("BLOCKED", readiness.error.code, readiness.error.message, {
        commit: input.commit,
      });
    return result("READY", null, null, {
      prUrl: input.prUrl,
      commit: input.commit,
      suiteSha256: readiness.gate.suiteSha256,
      remoteHead: remoteHead(readiness.remote),
      mergeAttempted: false,
    });
  }

  if (!SHA256.test(input.suiteSha256 ?? ""))
    return result("BLOCKED", "SUITE_BINDING", "Live delivery requires the approved suite hash.");

  if (!SHA256.test(input.acceptanceIdentitySha256 ?? ""))
    return result(
      "BLOCKED",
      "ACCEPTANCE_IDENTITY_BINDING",
      "Live delivery requires the approved acceptance identity hash.",
    );

  if (typeof deps.mergeExactHead !== "function")
    return result(
      "BLOCKED",
      "MERGE_DEPENDENCY",
      "Live delivery requires a single exact-head merge operation.",
    );

  const attemptLookup = await callDependency(
    deps.readAttempt,
    {
      prUrl: input.prUrl,
      commit: input.commit,
      suiteSha256: input.suiteSha256,
      acceptanceIdentitySha256: input.acceptanceIdentitySha256,
    },
    "read_attempt",
  );
  if (attemptLookup.error)
    return result("INCONCLUSIVE", attemptLookup.error.code, attemptLookup.error.message, {
      prUrl: input.prUrl,
      commit: input.commit,
    });

  const existing = attemptLookup.value ?? null;
  if (existing !== null && !exactAttempt(existing, input, input.suiteSha256))
    return result(
      "INCONCLUSIVE",
      "ATTEMPT_BINDING",
      "An existing merge attempt has a different or invalid binding.",
      {
        prUrl: input.prUrl,
        commit: input.commit,
      },
    );

  if (existing) {
    const remoteCall = await callDependency(deps.readRemote, { prUrl: input.prUrl }, "read_remote");
    if (remoteCall.error)
      return result("INCONCLUSIVE", remoteCall.error.code, remoteCall.error.message, {
        prUrl: input.prUrl,
        commit: input.commit,
        attemptId: existing.attemptId,
      });
    if (remoteCall.value?.state !== "MERGED" || remoteHead(remoteCall.value) !== input.commit)
      return result(
        "INCONCLUSIVE",
        "MERGE_UNCONFIRMED",
        "An earlier merge attempt exists and the exact merged head is not independently confirmed.",
        {
          prUrl: input.prUrl,
          commit: input.commit,
          suiteSha256: existing.suiteSha256,
          attemptId: existing.attemptId,
        },
      );
    if (input.suiteSha256 && existing.suiteSha256 !== input.suiteSha256)
      return result(
        "INCONCLUSIVE",
        "ATTEMPT_BINDING",
        "The existing attempt belongs to a different approved suite.",
        {
          prUrl: input.prUrl,
          commit: input.commit,
          attemptId: existing.attemptId,
        },
      );
    return finishConfirmedMerge(
      input,
      deps,
      {
        prUrl: input.prUrl,
        commit: input.commit,
        suiteSha256: existing.suiteSha256,
        acceptanceIdentitySha256: existing.acceptanceIdentitySha256,
      },
      remoteCall.value,
      existing,
    );
  }

  const firstReadiness = await checkReadiness(input, deps, input.suiteSha256, true);
  if (firstReadiness.error)
    return result("BLOCKED", firstReadiness.error.code, firstReadiness.error.message, {
      prUrl: input.prUrl,
      commit: input.commit,
    });

  const binding = {
    prUrl: input.prUrl,
    commit: input.commit,
    suiteSha256: firstReadiness.gate.suiteSha256,
    acceptanceIdentitySha256: input.acceptanceIdentitySha256,
  };
  const secondReadiness = await checkReadiness(input, deps, binding.suiteSha256, true);
  if (secondReadiness.error)
    return result("BLOCKED", secondReadiness.error.code, secondReadiness.error.message, binding);

  const attempt = {
    attemptId: randomUUID(),
    ...binding,
    remoteHead: remoteHead(secondReadiness.remote),
    startedAt: new Date().toISOString(),
    status: "ATTEMPTING",
  };
  const attemptWrite = await callDependency(deps.writeAttempt, attempt, "write_attempt");
  if (attemptWrite.error || attemptWrite.value === false || attemptWrite.value?.durable === false)
    return result(
      "INCONCLUSIVE",
      attemptWrite.error?.code ?? "ATTEMPT_NOT_DURABLE",
      attemptWrite.error?.message ??
        "The merge attempt was not durably confirmed; no merge was sent.",
      { ...binding, attemptId: attempt.attemptId, mergeAttempted: false },
    );

  try {
    await deps.mergeExactHead(binding.commit);
  } catch {
    // A transport error leaves the outcome unknown. Never retry the merge call.
  }

  const confirmation = await callDependency(deps.readRemote, { prUrl: input.prUrl }, "read_remote");
  if (confirmation.error)
    return result("INCONCLUSIVE", confirmation.error.code, confirmation.error.message, {
      ...binding,
      attemptId: attempt.attemptId,
      mergeAttempted: true,
    });
  if (confirmation.value?.state !== "MERGED" || remoteHead(confirmation.value) !== input.commit)
    return result(
      "INCONCLUSIVE",
      "MERGE_UNCONFIRMED",
      "The merge call was not followed by confirmation of the exact merged head.",
      {
        ...binding,
        attemptId: attempt.attemptId,
        mergeAttempted: true,
      },
    );

  return finishConfirmedMerge(input, deps, binding, confirmation.value, attempt);
}
