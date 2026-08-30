#!/usr/bin/env node
// apps/server/src/scripts/gen-synthetic-trace.mjs
//
// Generates a synthetic Glassbox session trace with 1200+ events across 12+ turns
// directly into .glassbox/sessions/<sessionId>/trace.jsonl.
//
// Events use the exact method/params shapes the reducer understands:
//   session.config, thread/started, turn/started, item/started,
//   item/agentMessage/delta, item/completed, item/fileChange,
//   turn/diff/updated, turn/completed, action.send, action.steer, action.pause
//
// The trace is replayable via replayTrace() and the existing GET /state/:id endpoint.
//
// Usage:
//   node apps/server/src/scripts/gen-synthetic-trace.mjs [sessionId]

import { mkdirSync, writeFileSync } from "node:fs";

// ── Config ──────────────────────────────────────────────────────────────────

const TURNS = 12;
const ITEMS_PER_TURN = 15;
const BASE_TS = Date.now() - TURNS * 125_000;

const FILES = [
  "src/utils/helpers.ts", "src/utils/parser.ts", "src/utils/validator.ts",
  "src/core/engine.ts", "src/core/processor.ts", "src/core/analyzer.ts",
  "src/api/routes.ts", "src/api/middleware.ts", "src/api/handlers.ts",
  "src/models/user.ts", "src/models/session.ts", "src/models/config.ts",
  "tests/unit/utils.test.ts", "tests/unit/core.test.ts", "tests/unit/api.test.ts",
  "tests/e2e/flow.test.ts", "docs/api.md", "docs/setup.md", "README.md",
];

const TASKS = [
  "Refactor user authentication flow",
  "Add input validation to all API endpoints",
  "Implement session token refresh mechanism",
  "Fix memory leak in event processor loop",
  "Add rate limiting middleware",
  "Migrate configuration to JSON schema",
  "Write comprehensive unit tests for parser",
  "Add error handling to API routes",
  "Implement request logging middleware",
  "Optimize database query layer with batching",
  "Add WebSocket support for live updates",
  "Create migration script for v2 schema",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function hex(len) {
  return Math.random().toString(16).slice(2, 2 + len);
}

function uuid(prefix) {
  return prefix + hex(8) + "-" + hex(4) + "-" + hex(4) + "-" + hex(4) + "-" + hex(12);
}

function t(offsetMs) {
  return new Date(BASE_TS + offsetMs).toISOString();
}

function entry(seq, eventObj) {
  return JSON.stringify({ seq, ts: t(0), event: eventObj, provenance: "codex-app-server" }) + "\n";
}

// ── Generation ───────────────────────────────────────────────────────────────

function generate(sessionId) {
  // Resolve .glassbox path
  const here = new URL(".", import.meta.url).pathname;
  const segments = here.split("/").filter(Boolean);
  const repoRoot = segments.slice(0, segments.lastIndexOf("apps"));
  const base = "/" + repoRoot.join("/") + "/.glassbox/sessions/" + sessionId;
  mkdirSync(base, { recursive: true });

  const path = base + "/trace.jsonl";
  const lines = [];
  let seq = 1;

  // session.config
  lines.push(entry(seq++, {
    method: "session.config",
    params: {
      kind: "session.config",
      provider: "codex",
      permissionMode: "default",
      approvalPolicy: "on-request",
      sandboxPolicy: "read-only",
      repoPath: "/tmp/glassbox-perf-test",
      ts: t(0),
    },
  }));

  const threadId = uuid("thread-");

  // thread/started
  lines.push(entry(seq++, {
    method: "thread/started",
    params: {
      _tag: "threadStarted",
      thread: { id: threadId, sessionId, status: { type: "active" }, cwd: "/tmp/glassbox-perf-test" },
    },
  }));

  for (let turn = 0; turn < TURNS; turn++) {
    const t0 = 5_000 + turn * 125_000;
    const turnId = uuid("turn-");
    const task = TASKS[turn % TASKS.length];

    // turn/started
    lines.push(entry(seq++, {
      method: "turn/started",
      params: {
        _tag: "turnStarted",
        threadId,
        input: [{ type: "text", text: task }],
        turn: { id: turnId, status: "inProgress" },
      },
    }));

    // One userMessage item per turn
    const userItemId = uuid("item-");
    lines.push(entry(seq++, {
      method: "item/started",
      params: {
        _tag: "itemStarted",
        item: { type: "userMessage", id: userItemId, content: [{ type: "text", text: task }] },
        threadId, turnId,
        startedAtMs: BASE_TS + t0 + 200,
      },
    }));
    lines.push(entry(seq++, {
      method: "item/completed",
      params: {
        _tag: "itemCompleted",
        item: { type: "userMessage", id: userItemId, status: "completed", content: [{ type: "text", text: task }] },
        threadId, turnId,
        completedAtMs: BASE_TS + t0 + 400,
      },
    }));

    // Work items per turn
    for (let i = 0; i < ITEMS_PER_TURN; i++) {
      const itemId = uuid("item-");
      const itemStart = t0 + 800 + i * 16_000;
      const isCmd = i === 0;
      const itemType = isCmd ? "commandExecution" : "agentMessage";
      const phase = "running";

      lines.push(entry(seq++, {
        method: "item/started",
        params: {
          _tag: "itemStarted",
          item: { type: itemType, id: itemId, phase, text: task },
          threadId, turnId,
          startedAtMs: BASE_TS + itemStart,
        },
      }));

      // Agent message deltas
      if (itemType === "agentMessage") {
        const frags = fragsFor(task, turn, i);
        for (const f of frags) {
          lines.push(entry(seq++, {
            method: "item/agentMessage/delta",
            params: { _tag: "agentMessageDelta", threadId, turnId, itemId, delta: f },
          }));
        }
      }

      // File changes interleaved
      if (i > 0 && i % 2 === 1) {
        for (let fc = 0; fc < 3; fc++) {
          const filePath = FILES[(turn * ITEMS_PER_TURN + i + fc) % FILES.length];
          const kind = ["write", "modify", "add"][fc % 3];
          lines.push(entry(seq++, {
            method: "item/fileChange",
            params: {
              _tag: "itemFileChange",
              threadId, turnId, itemId,
              changes: [{
                path: filePath, kind,
                diff: "--- a/" + filePath + "\n+++ b/" + filePath + "\n@@ -1,3 +1,4 @@\n line1\n+added by turn " + turnId.slice(0, 8) + "\n",
              }],
            },
          }));
        }
      }

      // item/completed
      const status = i === ITEMS_PER_TURN - 1 ? "completed" : "completed";
      lines.push(entry(seq++, {
        method: "item/completed",
        params: {
          _tag: "itemCompleted",
          item: {
            type: itemType, id: itemId, status,
            aggregatedOutput: isCmd ? "exit 0\n" : null,
            exitCode: isCmd ? 0 : undefined,
            durationMs: 14_000,
          },
          threadId, turnId,
          completedAtMs: BASE_TS + itemStart + 15_000,
        },
      }));
    }

    // turn/diff/updated
    const diffParts = [];
    const diffFiles = FILES.slice(0, 2 + (turn % 5));
    for (const file of diffFiles) {
      diffParts.push("diff --git a/" + file + " b/" + file);
      diffParts.push("--- a/" + file);
      diffParts.push("+++ b/" + file);
      for (let l = 0; l < 3 + (turn % 5); l++) {
        if (l % 3 === 0) {
          diffParts.push("-old version of line " + l);
          diffParts.push("+new version of line " + l + " from turn " + (turn + 1));
        } else {
          diffParts.push(" unchanged line " + l);
        }
      }
      diffParts.push("");
    }
    const diffText = diffParts.join("\n");
    lines.push(entry(seq++, {
      method: "turn/diff/updated",
      params: { _tag: "turnDiffUpdated", threadId, turnId, diff: diffText },
    }));

    // turn/completed
    lines.push(entry(seq++, {
      method: "turn/completed",
      params: {
        _tag: "turnCompleted",
        threadId,
        turn: {
          id: turnId, status: "completed",
          startedAt: BASE_TS + t0,
          completedAt: BASE_TS + t0 + 100_000,
          durationMs: 100_000 + turn * 500,
          error: null,
        },
      },
    }));
  }

  // Write file
  writeFileSync(path, lines.join(""), "utf-8");

  const eventCount = seq - 1;
  console.log("Synthetic session written to: " + path);
  console.log("Session ID: " + sessionId);
  console.log("Events: " + eventCount + " (target: 1200+)");
  console.log("Turns: " + TURNS + " (target: 10+)");
  console.log("File size: " + (Buffer.byteLength(lines.join("")) / 1024).toFixed(1) + " KB");

  return { sessionId, eventCount, path };
}

function fragsFor(task, turnIdx, itemIdx) {
  const words = [
    "Analyzing", task.slice(0, 30), "...",
    "Found", (3 + turnIdx % 5), "files",
    "to", "modify.", "Creating",
    "new", "interfaces", "and",
    "migrating", "implementations.", "Running",
    "test", "suite", "to",
    "verify", "changes.", "All",
    String(30 + turnIdx * 3), "tests", "pass.",
    "Committing", "changes", "now.",
  ];
  const frags = [];
  const chunkSize = 3;
  for (let i = 0; i < words.length; i += chunkSize) {
    frags.push(words.slice(i, i + chunkSize).join(" ") + " ");
  }
  return frags;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const sessionId = process.argv[2] || uuid("perf-");
generate(sessionId);
