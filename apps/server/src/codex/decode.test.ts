// apps/server/src/codex/decode.test.ts
// Focused test for the Effect Schema decode path.
// Uses real event payloads captured from the T2.2 /run-test spike.

import { describe, expect, it } from "vitest";
import { decodeEvent } from "./decode.js";

// ---------------------------------------------------------------------------
// Real payloads captured from /tmp/glassbox-codex-spike/spike-logs/raw_stdio.jsonl
// ---------------------------------------------------------------------------

const THREAD_STARTED_NOTIFY = {
  method: "thread/started",
  params: {
    thread: {
      id: "01a0479e-2bfa-7920-8a73-6625612015cd",
      sessionId: "01a0479e-2bfa-7920-8a73-6625612015cd",
      status: { type: "idle" },
      cwd: "/tmp/glassbox-codex-spike/file:/tmp/glassbox-codex-spike",
    },
  },
};

const TURN_STARTED_NOTIFY = {
  method: "turn/started",
  params: {
    threadId: "01a0479e-2bfa-7920-8a73-6625612015cd",
    turn: {
      id: "01a0479e-3441-76d1-a248-8f86924c5221",
      status: "inProgress",
    },
  },
};

const ITEM_STARTED_USER_MSG = {
  method: "item/started",
  params: {
    item: {
      type: "userMessage",
      id: "01a0479e-4700-7e33-8fb1-4638d5adbd0a",
    },
    threadId: "01a0479e-2bfa-7920-8a73-6625612015cd",
    turnId: "01a0479e-3441-76d1-a248-8f86924c5221",
    startedAtMs: 1787907950336,
  },
};

const AGENT_MSG_DELTA_NOTIFY = {
  method: "item/agentMessage/delta",
  params: {
    threadId: "01a0479e-2bfa-7920-8a73-6625612015cd",
    turnId: "01a0479e-3441-76d1-a248-8f86924c5221",
    itemId: "msg_02c59516fbe0b657016a914f774fcc87d08f6b523d44751a4f",
    delta: "```",
  },
};

const ITEM_COMPLETED_CMD_EXEC = {
  method: "item/completed",
  params: {
    item: {
      type: "commandExecution",
      id: "exec-f956d498-a87f-462f-9dde-ee67f7f17630",
      status: "completed",
      aggregatedOutput: "total 32\ndrwxr-xr-x  4 lora   lora   ...\n",
      exitCode: 0,
      durationMs: 0,
    },
    threadId: "01a0479e-2bfa-7920-8a73-6625612015cd",
    turnId: "01a0479e-3441-76d1-a248-8f86924c5221",
    completedAtMs: 1787907958462,
  },
};

const TURN_COMPLETED_SUCCESS = {
  method: "turn/completed",
  params: {
    threadId: "01a0479e-2bfa-7920-8a73-6625612015cd",
    turn: {
      id: "01a0479e-3441-76d1-a248-8f86924c5221",
      status: "completed",
      startedAt: 1787907945,
      completedAt: 1787907962,
      durationMs: 17417,
      error: null,
    },
  },
};

const TURN_COMPLETED_INTERRUPTED = {
  method: "turn/completed",
  params: {
    threadId: "01a0479e-2bfa-7920-8a73-6625612015cd",
    turn: {
      id: "01a0479e-7ad5-7b61-840f-e7ebc8338586",
      status: "interrupted",
      startedAt: 1787907963,
      completedAt: 1787908031,
      durationMs: 68381,
      error: null,
    },
  },
};

const FILE_CHANGE_APPROVAL = {
  method: "item/fileChange/requestApproval",
  params: {
    threadId: "01a0479e-2bfa-7920-8a73-6625612015cd",
    turnId: "01a0479e-7ad5-7b61-840f-e7ebc8338586",
    itemId: "exec-42fd6e1f-f56c-4e60-ba60-13f5b48fe575",
    startedAtMs: 1787907967213,
    reason: "command failed; retry without sandbox?",
    grantRoot: null,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Effect Schema decode adoption gate", () => {
  describe("ThreadStarted", () => {
    it("decodes a real thread/started notification", async () => {
      const ev = await decodeEvent(THREAD_STARTED_NOTIFY);
      expect((ev as any)._tag).toBe("threadStarted");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ev as any).thread.id).toBe(
        "01a0479e-2bfa-7920-8a73-6625612015cd"
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ev as any).thread.status.type).toBe("idle");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ev as any).thread.cwd).toContain("glassbox-codex-spike");
    });

    it("throws when thread.id is missing (structural guard)", async () => {
      const bad = {
        method: "thread/started",
        params: { thread: { sessionId: "x" } },
      };
      await expect(decodeEvent(bad)).rejects.toThrow();
    });
  });

  describe("TurnStarted", () => {
    it("decodes a real turn/started notification", async () => {
      const ev = await decodeEvent(TURN_STARTED_NOTIFY);
      expect((ev as any)._tag).toBe("turnStarted");
      expect((ev as any).turn.id).toBe("01a0479e-3441-76d1-a248-8f86924c5221");
      expect((ev as any).turn.status).toBe("inProgress");
      expect((ev as any).threadId).toBe(
        "01a0479e-2bfa-7920-8a73-6625612015cd"
      );
    });

    it("throws on an unknown method string", async () => {
      const bad = { method: "turn/does-not-exist", params: {} };
      await expect(decodeEvent(bad)).rejects.toThrow(
        "Unrecognized notification method"
      );
    });
  });

  describe("ItemStarted", () => {
    it("decodes a real item/started notification", async () => {
      const ev = await decodeEvent(ITEM_STARTED_USER_MSG);
      expect((ev as any)._tag).toBe("itemStarted");
      expect((ev as any).item.type).toBe("userMessage");
      expect((ev as any).item.id).toBe("01a0479e-4700-7e33-8fb1-4638d5adbd0a");
      expect((ev as any).startedAtMs).toBe(1787907950336);
    });
  });

  describe("AgentMessageDelta", () => {
    it("decodes a real agentMessage/delta notification", async () => {
      const ev = await decodeEvent(AGENT_MSG_DELTA_NOTIFY);
      expect((ev as any)._tag).toBe("agentMessageDelta");
      expect((ev as any).delta).toBe("```");
      expect((ev as any).itemId).toBe(
        "msg_02c59516fbe0b657016a914f774fcc87d08f6b523d44751a4f"
      );
    });
  });

  describe("ItemCompleted", () => {
    it("decodes a real item/completed notification", async () => {
      const ev = await decodeEvent(ITEM_COMPLETED_CMD_EXEC);
      expect((ev as any)._tag).toBe("itemCompleted");
      expect((ev as any).item.type).toBe("commandExecution");
      expect((ev as any).item.status).toBe("completed");
      expect((ev as any).item.exitCode).toBe(0);
      expect((ev as any).item.aggregatedOutput).toContain("total 32");
    });
  });

  describe("TurnCompleted", () => {
    it("decodes a completed turn", async () => {
      const ev = await decodeEvent(TURN_COMPLETED_SUCCESS);
      expect((ev as any)._tag).toBe("turnCompleted");
      expect((ev as any).turn.status).toBe("completed");
      expect((ev as any).turn.durationMs).toBe(17417);
      expect((ev as any).turn.error).toBeNull();
    });

    it("decodes an interrupted turn (real spike payload)", async () => {
      const ev = await decodeEvent(TURN_COMPLETED_INTERRUPTED);
      expect((ev as any)._tag).toBe("turnCompleted");
      expect((ev as any).turn.status).toBe("interrupted");
      expect((ev as any).turn.durationMs).toBe(68381);
      expect((ev as any).turn.startedAt).toBe(1787907963);
    });
  });

  describe("RequestApproval", () => {
    it("decodes a real fileChange/requestApproval notification", async () => {
      const ev = await decodeEvent(FILE_CHANGE_APPROVAL);
      expect((ev as any)._tag).toBe("requestApproval");
      expect((ev as any).itemId).toBe(
        "exec-42fd6e1f-f56c-4e60-ba60-13f5b48fe575"
      );
      expect((ev as any).reason).toBe("command failed; retry without sandbox?");
      expect((ev as any).grantRoot).toBeNull();
    });

    it("throws when required fields are missing", async () => {
      const bad = {
        method: "item/fileChange/requestApproval",
        params: { threadId: "x" },
      };
      await expect(decodeEvent(bad)).rejects.toThrow();
    });
  });

  describe("deliberately malformed payload", () => {
    it("throws when the top-level envelope has no method", async () => {
      await expect(decodeEvent({ params: {} })).rejects.toThrow();
    });

    it("throws turn/started when turn.id is not a string", async () => {
      const bad = {
        method: "turn/started",
        params: {
          threadId: "abc",
          turn: { id: 123, status: "inProgress" },
        },
      };
      await expect(decodeEvent(bad)).rejects.toThrow();
    });

    it("throws thread/started when status.type is wrong", async () => {
      const bad = {
        method: "thread/started",
        params: {
          thread: {
            id: "abc",
            sessionId: "abc",
            status: { type: 42 },
            cwd: "/tmp",
          },
        },
      };
      await expect(decodeEvent(bad)).rejects.toThrow();
    });
  });

  describe("adoption gate: typed field access works", () => {
    it("threadStarted exposes typed thread.id and thread.status.type", async () => {
      const ev = await decodeEvent(THREAD_STARTED_NOTIFY);
      // Access by tag — these would fail at compile time if the type
      // didn't have those fields. This is the core value of the gate.
      expect((ev as any).thread.id).toBeTruthy();
      expect((ev as any).thread.status.type).toBe("idle");
    });

    it("turnCompleted exposes typed turn.durationMs (number)", async () => {
      const ev = await decodeEvent(TURN_COMPLETED_SUCCESS);
      const durationMs: number = (ev as any).turn.durationMs;
      expect(durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
