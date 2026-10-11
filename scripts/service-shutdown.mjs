const validStatus = (status) => ["running", "stopped", "unknown"].includes(status);

/** Stop only a freshly verified process; transient post-signal uncertainty is bounded. */
export async function stopVerifiedProcess({
  getStatus,
  signal,
  force,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  gracefulMs = 5_000,
  forcedMs = 5_000,
  pollMs = 100,
} = {}) {
  if (
    typeof getStatus !== "function" ||
    typeof signal !== "function" ||
    typeof force !== "function" ||
    typeof delay !== "function" ||
    typeof now !== "function" ||
    !Number.isSafeInteger(gracefulMs) ||
    gracefulMs < 0 ||
    gracefulMs > 60_000 ||
    !Number.isSafeInteger(forcedMs) ||
    forcedMs < 0 ||
    forcedMs > 60_000 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 1_000
  )
    throw new Error("Invalid verified process shutdown configuration");

  const initial = await getStatus();
  if (!validStatus(initial))
    throw new Error("Process status is invalid; service state was preserved.");
  if (initial === "stopped") return { status: "stopped", signalSent: false };
  if (initial !== "running")
    throw new Error("Cannot verify the saved process identity; service state was preserved.");

  await signal("SIGTERM");
  const gracefulDeadline = now() + gracefulMs;
  while (now() < gracefulDeadline) {
    const status = await getStatus();
    if (!validStatus(status))
      throw new Error("Process status is invalid; service state was preserved.");
    if (status === "stopped") return { status: "stopped", signalSent: true };
    await delay(Math.min(pollMs, Math.max(1, gracefulDeadline - now())));
  }

  const beforeForce = await getStatus();
  if (!validStatus(beforeForce))
    throw new Error("Process status is invalid; service state was preserved.");
  if (beforeForce === "stopped") return { status: "stopped", signalSent: true };
  if (beforeForce !== "running")
    throw new Error(
      "Cannot reverify the same process before forced shutdown; service state was preserved.",
    );

  await force("SIGKILL");
  const forcedDeadline = now() + forcedMs;
  while (now() < forcedDeadline) {
    const status = await getStatus();
    if (!validStatus(status))
      throw new Error("Process status is invalid; service state was preserved.");
    if (status === "stopped") return { status: "stopped", signalSent: true, forced: true };
    await delay(Math.min(pollMs, Math.max(1, forcedDeadline - now())));
  }

  const finalStatus = await getStatus();
  if (!validStatus(finalStatus))
    throw new Error("Process status is invalid; service state was preserved.");
  if (finalStatus === "stopped") return { status: "stopped", signalSent: true, forced: true };
  if (finalStatus === "unknown")
    throw new Error("Cannot verify whether the process stopped; service state was preserved.");
  throw new Error("Verified process did not stop; service state was preserved.");
}
