import type { ClaudeExecutorSettings, PublicExecutor } from "@glassbox/contracts";
import { ManagementApiError } from "./errors";
import { recordsObject, recordText, recordTime } from "./records-schema";

export interface ExecutorDraft {
  credentialSource: ClaudeExecutorSettings["credentialSource"];
  modelProfileId: string;
  model: string;
}
function invalid(): never {
  throw new ManagementApiError("INVALID_RESPONSE");
}
export function decodeExecutor(value: unknown): PublicExecutor {
  const input = recordsObject(value);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "id",
          "credentialSource",
          "modelProfileId",
          "model",
          "executableDetected",
          "groupSupported",
          "checking",
          "tools",
          "lastCheck",
        ].includes(key),
    ) ||
    input.id !== "claude-code" ||
    !["local-claude", "model-profile"].includes(String(input.credentialSource)) ||
    typeof input.executableDetected !== "boolean" ||
    typeof input.groupSupported !== "boolean" ||
    typeof input.checking !== "boolean" ||
    input.tools !== "none"
  )
    return invalid();
  let modelProfileId: string | null = null;
  if (input.credentialSource === "model-profile") {
    modelProfileId = recordText(input.modelProfileId, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(modelProfileId)) return invalid();
  } else if (input.modelProfileId !== null) return invalid();
  const model = input.model === null ? null : recordText(input.model, 256);
  let lastCheck: PublicExecutor["lastCheck"] = null;
  if (input.lastCheck !== null) {
    const check = recordsObject(input.lastCheck);
    if (
      Object.keys(check).some((key) => !["status", "checkedAt", "code"].includes(key)) ||
      (check.status !== "passed" && check.status !== "failed")
    )
      return invalid();
    if (
      check.code !== undefined &&
      (typeof check.code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/u.test(check.code))
    )
      return invalid();
    lastCheck = {
      status: check.status,
      checkedAt: recordTime(check.checkedAt),
      ...(typeof check.code === "string" ? { code: check.code } : {}),
    };
  }
  return {
    id: "claude-code",
    credentialSource: input.credentialSource as ClaudeExecutorSettings["credentialSource"],
    modelProfileId,
    model,
    executableDetected: input.executableDetected,
    groupSupported: input.groupSupported,
    checking: input.checking,
    tools: "none",
    lastCheck,
  };
}
export function decodeExecutorList(value: unknown): PublicExecutor[] {
  const input = recordsObject(value);
  if (
    Object.keys(input).some((key) => key !== "executors") ||
    !Array.isArray(input.executors) ||
    input.executors.length > 1
  )
    return invalid();
  return input.executors.map(decodeExecutor);
}
export function decodeExecutorResult(value: unknown): PublicExecutor {
  const input = recordsObject(value);
  if (Object.keys(input).some((key) => key !== "executor")) return invalid();
  return decodeExecutor(input.executor);
}
export function executorDraftFor(executor: PublicExecutor): ExecutorDraft {
  return {
    credentialSource: executor.credentialSource,
    modelProfileId: executor.modelProfileId ?? "",
    model: executor.model ?? "",
  };
}
export function buildExecutorSave(draft: ExecutorDraft): ClaudeExecutorSettings {
  try {
    const {
      executableDetected: _executableDetected,
      groupSupported: _groupSupported,
      checking: _checking,
      tools: _tools,
      lastCheck: _lastCheck,
      ...settings
    } = decodeExecutor({
      id: "claude-code",
      credentialSource: draft.credentialSource,
      modelProfileId: draft.credentialSource === "model-profile" ? draft.modelProfileId : null,
      model: draft.model.trim() || null,
      executableDetected: false,
      groupSupported: false,
      checking: false,
      tools: "none",
      lastCheck: null,
    });
    return settings;
  } catch {
    throw new ManagementApiError("INVALID_EXECUTOR");
  }
}
