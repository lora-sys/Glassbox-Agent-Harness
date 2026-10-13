import assert from "node:assert/strict";
import test from "node:test";
import { stopVerifiedProcess } from "../service-shutdown.mjs";

function fixture(statuses) {
  let now = 0;
  let last = statuses.at(-1) ?? "unknown";
  const calls = [];
  return {
    calls,
    options: {
      getStatus() {
        const next = statuses.shift();
        if (next !== undefined) last = next;
        calls.push(`status:${last}`);
        return last;
      },
      signal(name) {
        calls.push(name);
      },
      force(name) {
        calls.push(name);
      },
      delay(milliseconds) {
        now += milliseconds;
      },
      now: () => now,
      gracefulMs: 3,
      forcedMs: 3,
      pollMs: 1,
    },
  };
}

test("already stopped and initially unknown processes are never signaled", async () => {
  const stopped = fixture(["stopped"]);
  assert.deepEqual(await stopVerifiedProcess(stopped.options), {
    status: "stopped",
    signalSent: false,
  });
  assert.deepEqual(stopped.calls, ["status:stopped"]);

  const unknown = fixture(["unknown"]);
  await assert.rejects(stopVerifiedProcess(unknown.options), /identity.*preserved/u);
  assert.deepEqual(unknown.calls, ["status:unknown"]);
});

test("transient unknown status after SIGTERM is tolerated until the same process stops", async () => {
  const f = fixture(["running", "unknown", "running", "stopped"]);
  assert.deepEqual(await stopVerifiedProcess(f.options), {
    status: "stopped",
    signalSent: true,
  });
  assert.deepEqual(
    f.calls.filter(
      (call) => call !== "status:running" && call !== "status:unknown" && call !== "status:stopped",
    ),
    ["SIGTERM"],
  );
});

test("an exited or reused PID after SIGTERM is left untouched without SIGKILL", async () => {
  const f = fixture(["running", "stopped"]);
  assert.deepEqual(await stopVerifiedProcess(f.options), {
    status: "stopped",
    signalSent: true,
  });
  assert.equal(f.calls.includes("SIGKILL"), false);
});

test("forced shutdown requires a fresh running identity and waits for verified exit", async () => {
  const f = fixture([
    "running",
    "running",
    "running",
    "running",
    "running", // fresh identity check immediately before SIGKILL
    "unknown",
    "unknown",
    "stopped",
  ]);
  assert.deepEqual(await stopVerifiedProcess(f.options), {
    status: "stopped",
    signalSent: true,
    forced: true,
  });
  assert.equal(f.calls.filter((call) => call === "SIGTERM").length, 1);
  assert.equal(f.calls.filter((call) => call === "SIGKILL").length, 1);
});

test("unknown or reused process identity at the force boundary is never killed", async () => {
  const unknown = fixture(["running", "unknown", "unknown", "unknown", "unknown"]);
  await assert.rejects(stopVerifiedProcess(unknown.options), /Cannot reverify.*preserved/u);
  assert.equal(unknown.calls.includes("SIGKILL"), false);

  const stopped = fixture(["running", "running", "running", "running", "stopped"]);
  assert.deepEqual(await stopVerifiedProcess(stopped.options), {
    status: "stopped",
    signalSent: true,
  });
  assert.equal(stopped.calls.includes("SIGKILL"), false);
});

test("persistent uncertainty after forced shutdown preserves service state", async () => {
  const f = fixture([
    "running",
    "running",
    "running",
    "running",
    "running",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
  ]);
  await assert.rejects(
    stopVerifiedProcess(f.options),
    /Cannot verify whether the process stopped/u,
  );
  assert.equal(f.calls.filter((call) => call === "SIGKILL").length, 1);
});
