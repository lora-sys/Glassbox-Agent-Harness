import { describe, expect, it } from "vite-plus/test";
import {
  buildExecutorSave,
  decodeExecutor,
  decodeExecutorList,
  decodeExecutorResult,
  executorDraftFor,
} from "./executor-schema";

const executor = {
  id: "claude-code" as const,
  credentialSource: "local-claude" as const,
  modelProfileId: null,
  model: null,
  executableDetected: true,
  groupSupported: false,
  checking: false,
  tools: "none" as const,
  lastCheck: null,
};

describe("executor configuration projection", () => {
  it("decodes detected executable separately from group support and check evidence", () => {
    expect(decodeExecutorList({ executors: [executor] })).toEqual([executor]);
    expect(
      decodeExecutorResult({
        executor: {
          ...executor,
          executableDetected: false,
          groupSupported: true,
          lastCheck: { status: "passed", checkedAt: "2026-09-12T01:02:03.000Z" },
        },
      }),
    ).toMatchObject({ executableDetected: false, groupSupported: true });
    expect(
      decodeExecutorResult({
        executor: {
          ...executor,
          lastCheck: {
            status: "failed",
            checkedAt: "2026-09-12T01:02:03.000Z",
            code: "EXECUTOR_CHECK_FAILED",
          },
        },
      }).lastCheck?.status,
    ).toBe("failed");
  });
  it("builds a narrow configuration save without applying public state or credentials", () => {
    const draft = executorDraftFor(executor);
    expect(buildExecutorSave(draft)).toEqual({
      id: "claude-code",
      credentialSource: "local-claude",
      modelProfileId: null,
      model: null,
    });
    expect(
      buildExecutorSave({
        ...draft,
        credentialSource: "model-profile",
        modelProfileId: "daily",
        model: " configured-model ",
      }),
    ).toEqual({
      id: "claude-code",
      credentialSource: "model-profile",
      modelProfileId: "daily",
      model: "configured-model",
    });
    expect(buildExecutorSave({ ...draft, modelProfileId: "stale-profile" })).toHaveProperty(
      "modelProfileId",
      null,
    );
  });
  it.each([
    { token: "private" },
    { credentialSlot: "private" },
    { credentials: {} },
    { tools: "bash" },
    { credentialSource: "process-env" },
    { id: "codex" },
    { model: "bad\nmodel" },
    { model: "" },
    { groupSupported: 1 },
    { checking: "yes" },
    { checking: undefined },
    { executableDetected: "yes" },
    { modelProfileId: "unexpected-profile" },
    { lastCheck: { status: "passed", checkedAt: "not-a-date" } },
    {
      lastCheck: {
        status: "failed",
        checkedAt: "2026-09-12T01:02:03.000Z",
        code: "private provider error body",
      },
    },
  ])("rejects unknown, unsafe and credential-bearing response data %j", (change) => {
    expect(() => decodeExecutor({ ...executor, ...change })).toThrow();
  });
  it("rejects incomplete model-profile selections and malformed list/result envelopes", () => {
    expect(() =>
      buildExecutorSave({ credentialSource: "model-profile", modelProfileId: "", model: "" }),
    ).toThrow();
    expect(() =>
      buildExecutorSave({
        credentialSource: "model-profile",
        modelProfileId: "../private",
        model: "",
      }),
    ).toThrow();
    expect(() => decodeExecutorList({ executors: [executor, executor] })).toThrow();
    expect(() => decodeExecutorResult({ executor, credentials: {} })).toThrow();
  });
});
