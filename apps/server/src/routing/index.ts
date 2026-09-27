export type TaskRisk = "low" | "medium" | "high";

export type ModelCapability = "text" | "tools" | "vision" | "thinking";

export type RuntimeHealthState = "healthy" | "degraded" | "unavailable" | "unknown";

/** Runtime observations use null when the provider did not report a value. */
export interface RuntimeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  concurrentRuns: number | null;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
}

/** A missing provider limit stays unknown. Configured request budgets are not provider quotas. */
export interface RuntimeLimits {
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  maxConcurrentRuns: number | null;
  requestsPerMinute: number | null;
  tokensPerMinute: number | null;
}

export interface RuntimeHealth {
  state: RuntimeHealthState;
  checkedAt: string | null;
  latencyMs: number | null;
  reasonCode: string | null;
}

export interface ModelCapacity {
  profileId: string;
  executionRef: string;
  configured: boolean;
  capabilities: readonly ModelCapability[];
  /** Capability level is an operator-owned classification, not a benchmark result. */
  capabilityRank: number | null;
  supportsThinking: boolean | null;
  usage: RuntimeUsage;
  limits: RuntimeLimits;
  health: RuntimeHealth;
}

export interface RoutingInput {
  task: {
    risk: TaskRisk;
    requiredCapabilities: readonly ModelCapability[];
    requiredContextTokens: number | null;
    requiredOutputTokens: number | null;
    thinking: "required" | "preferred" | "disabled";
  };
  candidates: readonly ModelCapacity[];
  options: {
    /** Routing is inactive unless an operator explicitly enables it. */
    enabled: boolean;
    /** Every selectable model must appear here as an explicit opt-in. */
    allowedProfileIds: readonly string[];
    /** Stable, operator-configured order. Earlier eligible entries win. */
    routeOrder: readonly string[];
    /** The pre-router execution reference, used when disabled or no candidate qualifies. */
    defaultExecutionRef: string;
    /** Capability floors are configured per task risk. */
    capabilityFloorByRisk: Readonly<Record<TaskRisk, number>>;
    allowUnknownHealth: boolean;
    allowUnknownCapacity: boolean;
  };
}

export type RoutingRejectionReason =
  | "not_configured"
  | "not_opted_in"
  | "health_unavailable"
  | "health_unknown"
  | "missing_capability"
  | "thinking_unsupported"
  | "thinking_unknown"
  | "capability_below_floor"
  | "capability_unknown"
  | "context_limit"
  | "context_unknown"
  | "output_limit"
  | "output_unknown"
  | "concurrency_limit";

export interface RoutingCandidateDecision {
  profileId: string;
  eligible: boolean;
  reason: RoutingRejectionReason | "eligible";
}

export interface RoutingDecision {
  executionRef: string | null;
  selectedProfileId: string | null;
  reason: "routing_disabled" | "selected" | "default_fallback" | "no_route";
  usedFallback: boolean;
  candidates: readonly RoutingCandidateDecision[];
}

/** Safe append-only evidence shape. It deliberately excludes prompts, credentials, endpoints and outputs. */
export interface RoutingEvidenceDto {
  schema: "glassbox.routing-decision.v1";
  selectedProfileId: string | null;
  executionRef: string | null;
  taskRisk: TaskRisk;
  reason: RoutingDecision["reason"];
  usedFallback: boolean;
  candidates: readonly RoutingCandidateDecision[];
  observedHealth: RuntimeHealthState | null;
  usage: RuntimeUsage | null;
  limits: RuntimeLimits | null;
}

function assessCandidate(input: RoutingInput, candidate: ModelCapacity): RoutingCandidateDecision {
  const { task, options } = input;
  const rejection = (reason: RoutingRejectionReason): RoutingCandidateDecision => ({
    profileId: candidate.profileId,
    eligible: false,
    reason,
  });
  if (!candidate.configured) return rejection("not_configured");
  if (!options.allowedProfileIds.includes(candidate.profileId)) return rejection("not_opted_in");
  if (candidate.health.state === "unavailable") return rejection("health_unavailable");
  if (candidate.health.state === "unknown" && !options.allowUnknownHealth)
    return rejection("health_unknown");
  if (task.requiredCapabilities.some((capability) => !candidate.capabilities.includes(capability)))
    return rejection("missing_capability");
  if (task.thinking === "required" && candidate.supportsThinking !== true)
    return rejection(
      candidate.supportsThinking === null ? "thinking_unknown" : "thinking_unsupported",
    );
  const capabilityFloor = options.capabilityFloorByRisk[task.risk];
  if (candidate.capabilityRank === null && capabilityFloor > 0)
    return rejection("capability_unknown");
  if (candidate.capabilityRank !== null && candidate.capabilityRank < capabilityFloor)
    return rejection("capability_below_floor");
  if (task.requiredContextTokens !== null) {
    if (candidate.limits.contextWindowTokens === null && !options.allowUnknownCapacity)
      return rejection("context_unknown");
    if (
      candidate.limits.contextWindowTokens !== null &&
      task.requiredContextTokens > candidate.limits.contextWindowTokens
    )
      return rejection("context_limit");
  }
  if (task.requiredOutputTokens !== null) {
    if (candidate.limits.maxOutputTokens === null && !options.allowUnknownCapacity)
      return rejection("output_unknown");
    if (
      candidate.limits.maxOutputTokens !== null &&
      task.requiredOutputTokens > candidate.limits.maxOutputTokens
    )
      return rejection("output_limit");
  }
  if (
    candidate.usage.concurrentRuns !== null &&
    candidate.limits.maxConcurrentRuns !== null &&
    candidate.usage.concurrentRuns >= candidate.limits.maxConcurrentRuns
  )
    return rejection("concurrency_limit");
  return { profileId: candidate.profileId, eligible: true, reason: "eligible" };
}

/** Pure deterministic selector. It never infers operator preference from provider data. */
export function selectRoute(input: RoutingInput): RoutingDecision {
  if (!input.options.enabled) {
    return {
      executionRef: input.options.defaultExecutionRef,
      selectedProfileId: null,
      reason: "routing_disabled",
      usedFallback: true,
      candidates: [],
    };
  }

  const byId = new Map(input.candidates.map((candidate) => [candidate.profileId, candidate]));
  const orderedProfiles = [...input.options.routeOrder];
  if (input.task.thinking === "preferred") {
    const thinkingSupported = new Set(
      input.candidates
        .filter((candidate) => candidate.supportsThinking === true)
        .map((candidate) => candidate.profileId),
    );
    orderedProfiles.sort((left, right) => {
      const leftRank = thinkingSupported.has(left) ? 0 : 1;
      const rightRank = thinkingSupported.has(right) ? 0 : 1;
      return leftRank - rightRank;
    });
  }
  const candidateDecisions: RoutingCandidateDecision[] = [];
  for (const profileId of orderedProfiles) {
    const candidate = byId.get(profileId);
    if (!candidate) {
      candidateDecisions.push({ profileId, eligible: false, reason: "not_configured" });
      continue;
    }
    const decision = assessCandidate(input, candidate);
    candidateDecisions.push(decision);
    if (decision.eligible) {
      return {
        executionRef: candidate.executionRef,
        selectedProfileId: candidate.profileId,
        reason: "selected",
        usedFallback: false,
        candidates: candidateDecisions,
      };
    }
  }
  const defaultCandidate = input.candidates.find(
    (candidate) => candidate.executionRef === input.options.defaultExecutionRef,
  );
  if (defaultCandidate) {
    const alreadyAssessed = candidateDecisions.some(
      (candidate) => candidate.profileId === defaultCandidate.profileId,
    );
    const defaultDecision = alreadyAssessed
      ? candidateDecisions.find((candidate) => candidate.profileId === defaultCandidate.profileId)!
      : assessCandidate(input, defaultCandidate);
    if (!alreadyAssessed) candidateDecisions.push(defaultDecision);
    if (defaultDecision.eligible) {
      return {
        executionRef: defaultCandidate.executionRef,
        selectedProfileId: defaultCandidate.profileId,
        reason: "default_fallback",
        usedFallback: true,
        candidates: candidateDecisions,
      };
    }
  }
  return {
    executionRef: null,
    selectedProfileId: null,
    reason: "no_route",
    usedFallback: false,
    candidates: candidateDecisions,
  };
}

export function toRoutingEvidence(
  input: RoutingInput,
  decision: RoutingDecision,
): RoutingEvidenceDto {
  const selected = decision.selectedProfileId
    ? input.candidates.find((candidate) => candidate.profileId === decision.selectedProfileId)
    : undefined;
  return {
    schema: "glassbox.routing-decision.v1",
    selectedProfileId: decision.selectedProfileId,
    executionRef: decision.executionRef,
    taskRisk: input.task.risk,
    reason: decision.reason,
    usedFallback: decision.usedFallback,
    candidates: decision.candidates,
    observedHealth: selected?.health.state ?? null,
    usage: selected ? { ...selected.usage } : null,
    limits: selected ? { ...selected.limits } : null,
  };
}
