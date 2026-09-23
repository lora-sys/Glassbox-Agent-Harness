import { toolOutcomeFromFailure, type ToolExecutionOutcome } from "../runtime/pi/tool-plane.js";
import type { TraceEntry } from "../trace/store.js";

export const TOOL_PLANE_DIAGNOSTIC_RECORD_CAP = 200;
const TOOL_NAME_LIMIT = 100;
const PROVIDER_NAME_LIMIT = 100;

type ToolSurfaceEntry = {
  name: string;
  provider: string;
  providerReadiness: "ready" | "unavailable" | "unknown";
};

type SurfaceSnapshot = {
  generatedAt: string;
  profileName: string;
  selected: ToolSurfaceEntry[];
  excluded: Array<ToolSurfaceEntry & { reason: string }>;
  undescribedCount: number;
};

type ExecutionObservation = {
  name: string;
  calledAt: string;
  outcome: ToolExecutionOutcome;
  completedAt?: string;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeText(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function surfaceEntry(value: unknown): ToolSurfaceEntry | undefined {
  const entry = object(value);
  const name = safeText(entry?.name, TOOL_NAME_LIMIT);
  const provider = safeText(entry?.provider, PROVIDER_NAME_LIMIT);
  if (!name || !provider) return undefined;
  const providerReadiness =
    entry?.providerReadiness === "ready" || entry?.providerReadiness === "unavailable"
      ? entry.providerReadiness
      : "unknown";
  return { name, provider, providerReadiness };
}

function readSurface(value: unknown, generatedAt: string): SurfaceSnapshot | undefined {
  const surface = object(value);
  const profileName = safeText(surface?.profileName, 80);
  if (!surface || !profileName) return undefined;
  const selected = Array.isArray(surface.selected)
    ? surface.selected.slice(0, TOOL_NAME_LIMIT).flatMap((entry) => {
        const safe = surfaceEntry(entry);
        return safe ? [safe] : [];
      })
    : [];
  const excluded = Array.isArray(surface.excluded)
    ? surface.excluded.slice(0, TOOL_NAME_LIMIT).flatMap((entry) => {
        const safe = surfaceEntry(entry);
        const reason = safeText(object(entry)?.reason, 80);
        return safe && reason ? [{ ...safe, reason }] : [];
      })
    : [];
  const reportedAt = safeText(surface.generatedAt, 64) ?? generatedAt;
  const undescribedCount = Array.isArray(surface.undescribed)
    ? Math.min(surface.undescribed.length, TOOL_NAME_LIMIT)
    : 0;
  return { generatedAt: reportedAt, profileName, selected, excluded, undescribedCount };
}

function eventType(entry: TraceEntry<unknown>): {
  type?: string;
  timestamp: string;
  data?: Record<string, unknown>;
} {
  const event = object(entry.event);
  return {
    ...(typeof event?.type === "string" ? { type: event.type } : {}),
    timestamp: safeText(event?.timestamp, 64) ?? entry.ts,
    data: object(event?.data),
  };
}

/**
 * Projects one bounded Raw Trace slice into Owner diagnostics.
 * Inputs, tool results, arbitrary runtime metadata and secret-bearing fields are never copied.
 */
export function projectToolPlaneDiagnostics(input: {
  runId: string;
  records: readonly TraceEntry<unknown>[];
  complete: boolean;
}): {
  runId: string;
  trace: { complete: boolean; recordsRead: number; recordCap: number };
  surface: {
    observed: boolean;
    generatedAt?: string;
    profileName?: string;
    selectedCount: number;
    excludedCount: number;
    undescribedCount: number;
    tools: Array<{
      name: string;
      provider: string;
      providerReadiness: ToolSurfaceEntry["providerReadiness"];
      exclusionReason?: string;
      lastExecution: null | {
        outcome: ToolExecutionOutcome;
        calledAt?: string;
        completedAt?: string;
      };
    }>;
  };
} {
  const observations: ExecutionObservation[] = [];
  const calls = new Map<string, ExecutionObservation>();
  let surface: SurfaceSnapshot | undefined;

  for (const record of input.records.slice(0, TOOL_PLANE_DIAGNOSTIC_RECORD_CAP)) {
    const event = eventType(record);
    if (event.type === "session_start") {
      const next = readSurface(event.data?.toolSurface, event.timestamp);
      if (next) surface = next;
      continue;
    }
    if (event.type === "tool_call") {
      const name = safeText(event.data?.name, TOOL_NAME_LIMIT);
      const callId = safeText(event.data?.toolCallId, 128);
      if (!name || !callId) continue;
      const observation: ExecutionObservation = {
        name,
        calledAt: event.timestamp,
        outcome: "unknown",
      };
      calls.set(callId, observation);
      continue;
    }
    if (event.type === "tool_result") {
      const callId = safeText(event.data?.toolCallId, 128);
      if (!callId) continue;
      const call = calls.get(callId);
      if (!call) continue;
      const isError = event.data?.isError;
      call.outcome =
        isError === false
          ? "success"
          : isError === true && typeof event.data?.failureCode === "string"
            ? toolOutcomeFromFailure(event.data.failureCode)
            : "unknown";
      call.completedAt = event.timestamp;
      observations.push(call);
    }
  }

  const toolEntries = [
    ...(surface?.selected.map((entry) => ({ ...entry, exclusionReason: undefined })) ?? []),
    ...(surface?.excluded.map((entry) => ({ ...entry, exclusionReason: entry.reason })) ?? []),
  ];
  const tools = toolEntries.map((entry) => {
    const last = observations.filter((observation) => observation.name === entry.name).at(-1);
    const unfinished = [...calls.values()]
      .filter((observation) => observation.name === entry.name)
      .at(-1);
    const execution = last ?? unfinished;
    return {
      name: entry.name,
      provider: entry.provider,
      providerReadiness: entry.providerReadiness,
      ...(entry.exclusionReason ? { exclusionReason: entry.exclusionReason } : {}),
      lastExecution: execution
        ? {
            outcome: execution.outcome,
            calledAt: execution.calledAt,
            ...(execution.completedAt ? { completedAt: execution.completedAt } : {}),
          }
        : input.complete
          ? { outcome: "not_called" as const }
          : null,
    };
  });

  return {
    runId: input.runId,
    trace: {
      complete: input.complete,
      recordsRead: Math.min(input.records.length, TOOL_PLANE_DIAGNOSTIC_RECORD_CAP),
      recordCap: TOOL_PLANE_DIAGNOSTIC_RECORD_CAP,
    },
    surface: {
      observed: surface !== undefined,
      ...(surface ? { generatedAt: surface.generatedAt, profileName: surface.profileName } : {}),
      selectedCount: surface?.selected.length ?? 0,
      excludedCount: surface?.excluded.length ?? 0,
      undescribedCount: surface?.undescribedCount ?? 0,
      tools,
    },
  };
}
