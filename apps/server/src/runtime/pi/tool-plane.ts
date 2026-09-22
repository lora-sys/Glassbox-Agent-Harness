/**
 * The Glassbox Tool plane: one origin-neutral contract for every capability that can reach
 * a Run's model-visible Tool surface.
 *
 * Glassbox composes its surface from four sources that used to be described in four
 * different ways — the Glassbox server's own domain Tools, Pi's built-ins, Lora PI Kit
 * Extensions/MCP servers, and delegated Worker Tools. Each source knew its own shape, and
 * nothing could answer the question that matters at Run time:
 *
 *     what could this Run really call, and what does a claim that it called something rest on?
 *
 * This module is that answer. It is a *description* layer: it never authorizes, never
 * executes, and never widens a surface. Authority still comes from the live Gate-3 check in
 * `protected-tools.ts`, and a Tool's presence here is never evidence that it ran.
 *
 * Two separations are load-bearing:
 *
 *  - Origin is provenance, not permission. `pi_builtin` and `glassbox_domain` describe where
 *    a capability came from. A host-only built-in carries no Glassbox Action at all, so it
 *    cannot be authorized by accident just because a Kit profile listed it.
 *  - A descriptor is a definition. `toolOperationalState` is what a caller asks when it
 *    wants to know whether a Tool actually worked, and it will not answer `succeeded` unless
 *    a concrete call really completed.
 *
 * Where a registry already exists, descriptors are derived from it rather than restated:
 * the QQ capability Tools read their protected Action, Resource kind and risk straight out
 * of `QQ_CAPABILITIES`. Where no registry exists yet, the descriptor is declared here, and
 * `run-adapter.test.ts` builds the real Tool surface through the real application and
 * asserts the two agree — so a Tool added without a descriptor, or a descriptor left behind
 * by a removed Tool, fails the suite instead of drifting.
 */

import { createHash } from "node:crypto";
import { QQ_CAPABILITIES, type QqCapabilityRisk } from "../../channels/onebot/capabilities.js";
import { GROUP_HISTORY_SEARCH_TOOL, OWNER_HISTORY_SEARCH_TOOL } from "./history-tools.js";
import { OWNER_MEMORY_ADMIN_TOOL } from "./owner-memory-tools.js";
import { OWNER_GROUP_ADMIN_TOOL } from "./owner-tools.js";
import { OPS_TOOL_NAMES } from "./ops-tools.js";
import { SKILL_READ_TOOL } from "./skill-tools.js";
import {
  MEMORY_GOVERN_ACTION,
  MEMORY_READ_ACTION,
  MEMORY_WRITE_ACTION,
  OWNER_MEMORY_RESOURCE,
} from "../../learning/store.js";
import type { PiRuntimeProfileName } from "./types.js";

/** Where a capability comes from. Provenance only — never authority. */
export type ToolOrigin = "glassbox_domain" | "pi_builtin" | "kit_extension" | "mcp" | "worker";

/** How much damage a call could do, which is what decides how narrowly it is offered. */
export type ToolRiskClass = "read" | "write" | "moderate" | "host";

/**
 * The P5A Context budget class a Tool's schema and result belong to.
 *
 * Named here so P5A can bound schema cost from the effective surface rather than from a
 * global registry, without this module having to know anything about token accounting.
 */
export type ToolBudgetClass =
  | "core"
  | "domain_read"
  | "domain_write"
  | "host"
  | "integration"
  | "worker";

/** How a Tool's result may enter model-visible Context. */
export type ToolResultProjection = "verbatim" | "projected" | "metadata_only";

/** What a readiness claim rests on, so "ready" is never read as "it worked". */
export type ToolAvailabilitySource = "provider_probe" | "connection_state" | "none";

/** The product rule that decides whether a Tool may ever reach a model. */
export type ToolDiscoveryPolicy = "owner_private" | "group_policy" | "product_grant" | "host_only";

/**
 * What class of evidence a Tool's result is, which decides how strong a claim may rest on it.
 *
 * This is the field that keeps `known from Conversation` apart from `observed from Tool
 * result`. A `direct_observation` supports "the provider said X"; a `derived_retrieval` only
 * supports "the search I ran covered C and returned these"; a `delegated_worker` result is
 * Worker evidence and never Task acceptance. Two Tools with the same risk class can differ
 * here, and a caller that ignores it will over-claim.
 */
export type ToolGroundingClass =
  | "direct_observation"
  | "derived_retrieval"
  | "local_computation"
  | "delegated_worker"
  | "host_resource"
  | "integration";

/**
 * The protected Action and Resource kind a call is re-authorized against.
 *
 * `resource` is a *kind*, not an instance id: a concrete call binds one, such as
 * `task-<id>`. The kind is what a descriptor can state without inventing a target, and it is
 * enough to see that a Tool reaches the same Resource family its Action belongs to.
 */
export interface ToolAuthorizationBinding {
  action: string | readonly string[];
  resource: string;
}

export interface ToolDescriptor {
  name: string;
  origin: ToolOrigin;
  /** A digest of the shape this Tool's calls are validated against, not a decoration. */
  schemaVersion: string;
  riskClass: ToolRiskClass;
  /** The implementation that would carry the call out. Not a claim that it is reachable. */
  provider: string;
  discovery: ToolDiscoveryPolicy;
  /** `null` for a Tool Glassbox does not authorize, such as a host built-in. */
  authorization: ToolAuthorizationBinding | null;
  availability: ToolAvailabilitySource;
  resultProjection: ToolResultProjection;
  /** What class of evidence a result from this Tool is. */
  grounding: ToolGroundingClass;
  budgetClass: ToolBudgetClass;
}

/**
 * The Pi built-ins the Glassbox host refuses to activate in any Run.
 *
 * This list is the safety boundary that keeps a remote QQ Principal from inheriting host
 * filesystem and shell. It is exported so the session builder and the drift check read the
 * same value: a second copy would let the boundary and its own report disagree.
 */
export const GLASSBOX_HOST_EXCLUDED_PI_TOOLS: readonly string[] = Object.freeze([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "powershell",
]);

/**
 * The Pi built-ins a profile may declare.
 *
 * A Kit profile that lists one of these is not wrong — it is describing the Pi distribution,
 * not the Glassbox surface. It is reported as `disabled_by_host` rather than silently
 * dropped, which is the whole point of the drift check.
 */
export const PI_BUILTIN_TOOLS: readonly string[] = GLASSBOX_HOST_EXCLUDED_PI_TOOLS;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The shape one QQ capability validates its calls against, as a stable digest. */
function qqSchemaDigest(tool: string, action: string, resource: string): string {
  const capability = QQ_CAPABILITIES.find((entry) => entry.tool === tool);
  return digest([
    tool,
    action,
    resource,
    (capability?.operations ?? [])
      .map((operation) => [
        operation.action,
        [...operation.params].sort(),
        [...operation.required].sort(),
      ])
      .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
  ]).slice(0, 32);
}

function qqRisk(risk: QqCapabilityRisk): ToolRiskClass {
  return risk;
}

function qqBudget(capability: { risk: QqCapabilityRisk; tool: string }): ToolBudgetClass {
  if (capability.tool === "qq_capability_search" || capability.tool === "qq_groups") return "core";
  return capability.risk === "read" ? "domain_read" : "domain_write";
}

/**
 * The Glassbox domain Tools that are not QQ capabilities.
 *
 * Declared rather than derived because each one is built inside its own module. The test
 * that builds the real surface keeps this honest.
 */
/**
 * The Agent Ops Tools, with the Action and Resource kind each one is really authorized against.
 *
 * Declared rather than inferred from the Tool name. A name-shaped guess (`task_get` →
 * `task:get`) happens to hold today and would silently produce a wrong Action the first time
 * a Tool's Action stops matching its name — which is the failure mode this module exists to
 * remove. `ops-tools.test.ts` builds these Tools for real and asserts each binding matches
 * the authorization check the Tool actually performs.
 */
const OPS_TOOL_BINDINGS: Record<
  (typeof OPS_TOOL_NAMES)[number],
  {
    action: string;
    resource: string;
    riskClass: ToolRiskClass;
    budgetClass: ToolBudgetClass;
    grounding: ToolGroundingClass;
  }
> = {
  ops_status: {
    action: "ops:status",
    resource: "agent-operations",
    riskClass: "read",
    budgetClass: "core",
    grounding: "local_computation",
  },
  task_list: {
    action: "task:list",
    resource: "agent-operations",
    riskClass: "read",
    budgetClass: "core",
    grounding: "local_computation",
  },
  task_get: {
    action: "task:read",
    resource: "task",
    riskClass: "read",
    budgetClass: "core",
    grounding: "local_computation",
  },
  task_create: {
    action: "task:create",
    resource: "agent-operations",
    riskClass: "write",
    budgetClass: "core",
    grounding: "local_computation",
  },
  // A Worker's reported state is evidence about the Worker, never Task acceptance.
  worker_status: {
    action: "worker:status",
    resource: "task",
    riskClass: "read",
    budgetClass: "worker",
    grounding: "delegated_worker",
  },
  task_delegate: {
    action: "task:delegate",
    resource: "task",
    riskClass: "write",
    budgetClass: "core",
    grounding: "delegated_worker",
  },
  worker_read: {
    action: "worker:read",
    resource: "task",
    riskClass: "read",
    budgetClass: "worker",
    grounding: "delegated_worker",
  },
  worker_prompt: {
    action: "worker:prompt",
    resource: "task",
    riskClass: "write",
    budgetClass: "worker",
    grounding: "delegated_worker",
  },
  task_accept: {
    action: "task:accept",
    resource: "task",
    riskClass: "write",
    budgetClass: "core",
    grounding: "local_computation",
  },
  task_rework: {
    action: "task:rework",
    resource: "task",
    riskClass: "write",
    budgetClass: "core",
    grounding: "local_computation",
  },
  task_cancel: {
    action: "task:cancel",
    resource: "task",
    riskClass: "write",
    budgetClass: "core",
    grounding: "local_computation",
  },
};

const OPS_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = Object.freeze(
  OPS_TOOL_NAMES.map((name): ToolDescriptor => {
    const binding = OPS_TOOL_BINDINGS[name];
    return {
      name,
      origin: "glassbox_domain",
      schemaVersion: "ops-v1",
      riskClass: binding.riskClass,
      provider: "glassbox-agent-operations",
      discovery: "owner_private",
      authorization: { action: binding.action, resource: binding.resource },
      availability: "connection_state",
      resultProjection: "projected",
      grounding: binding.grounding,
      budgetClass: binding.budgetClass,
    };
  }),
);

const DOMAIN_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = Object.freeze([
  {
    name: GROUP_HISTORY_SEARCH_TOOL,
    origin: "glassbox_domain",
    schemaVersion: "history-search-v1",
    riskClass: "read",
    provider: "glassbox-retrieval",
    discovery: "group_policy",
    authorization: { action: "history:read", resource: "group" },
    availability: "connection_state",
    resultProjection: "projected",
    // A search result supports a claim about what the search covered, not about the world.
    grounding: "derived_retrieval",
    budgetClass: "domain_read",
  },
  {
    name: OWNER_HISTORY_SEARCH_TOOL,
    origin: "glassbox_domain",
    schemaVersion: "history-search-v1",
    riskClass: "read",
    provider: "glassbox-retrieval",
    discovery: "owner_private",
    authorization: { action: "history:search", resource: "owner-history" },
    availability: "connection_state",
    resultProjection: "projected",
    grounding: "derived_retrieval",
    budgetClass: "domain_read",
  },
  {
    name: OWNER_GROUP_ADMIN_TOOL,
    origin: "glassbox_domain",
    schemaVersion: "owner-group-admin-v1",
    riskClass: "write",
    provider: "glassbox-management",
    discovery: "owner_private",
    authorization: { action: "group:manage", resource: "owner-control" },
    availability: "none",
    resultProjection: "projected",
    grounding: "direct_observation",
    budgetClass: "core",
  },
  {
    name: OWNER_MEMORY_ADMIN_TOOL,
    origin: "glassbox_domain",
    schemaVersion: "owner-memory-admin-v1",
    riskClass: "write",
    provider: "glassbox-learning",
    discovery: "owner_private",
    authorization: {
      action: [MEMORY_READ_ACTION, MEMORY_WRITE_ACTION, MEMORY_GOVERN_ACTION],
      resource: OWNER_MEMORY_RESOURCE,
    },
    availability: "none",
    resultProjection: "projected",
    grounding: "local_computation",
    budgetClass: "core",
  },
  {
    name: SKILL_READ_TOOL,
    origin: "glassbox_domain",
    schemaVersion: "skill-read-v1",
    riskClass: "read",
    provider: "lora-pi-kit",
    discovery: "product_grant",
    authorization: { action: "skill:read", resource: "skill-catalog" },
    availability: "none",
    resultProjection: "verbatim",
    grounding: "local_computation",
    budgetClass: "core",
  },
  ...OPS_TOOL_DESCRIPTORS,
]);

const PI_BUILTIN_DESCRIPTORS: readonly ToolDescriptor[] = Object.freeze(
  PI_BUILTIN_TOOLS.map((name): ToolDescriptor => ({
    name,
    origin: "pi_builtin",
    schemaVersion: `pi-builtin-${name}-v1`,
    riskClass: "host",
    provider: "pi",
    discovery: "host_only",
    // A host built-in has no Glassbox Action. Leaving this null is what stops it from
    // looking like a product capability that a grant could switch on.
    authorization: null,
    availability: "none",
    resultProjection: "verbatim",
    grounding: "host_resource",
    budgetClass: "host",
  })),
);

/**
 * Every Tool Glassbox knows how to describe.
 *
 * QQ entries are derived from `QQ_CAPABILITIES`; the rest are declared above. The union is
 * the complete answer to "what could ever be on a surface", and nothing outside it can be.
 */
export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = Object.freeze([
  ...QQ_CAPABILITIES.map((capability): ToolDescriptor => ({
    name: capability.tool,
    origin: "glassbox_domain",
    schemaVersion: qqSchemaDigest(capability.tool, capability.action, capability.resource),
    riskClass: qqRisk(capability.risk),
    provider: "qq-napcat",
    discovery: capability.tool === "qq_capability_search" ? "owner_private" : "group_policy",
    authorization: { action: capability.action, resource: capability.resource },
    availability: "connection_state",
    resultProjection: "projected",
    // A capability result is the provider's own answer about current state, so it grounds a
    // direct claim. It is not retrieval and carries no coverage or truncation semantics.
    grounding: "direct_observation",
    budgetClass: qqBudget(capability),
  })),
  ...DOMAIN_TOOL_DESCRIPTORS,
  ...PI_BUILTIN_DESCRIPTORS,
]);

const DESCRIPTORS_BY_NAME = new Map(TOOL_DESCRIPTORS.map((entry) => [entry.name, entry]));

/** The descriptor for one Tool name, or `undefined` when Glassbox does not describe it. */
export function toolDescriptor(name: string): ToolDescriptor | undefined {
  return DESCRIPTORS_BY_NAME.get(name);
}

/* ------------------------------------------------------------------ *
 * Profile / host drift
 * ------------------------------------------------------------------ */

export interface ToolDriftReport {
  profileName: PiRuntimeProfileName;
  /** The Kit profile's own declaration, verbatim. */
  declared: readonly string[];
  /** Declared Tools the Glassbox host never activates. Intended, and now visible. */
  disabledByHost: readonly string[];
  /** Declared Tools nobody provides. Unintended, so the profile is incompatible. */
  unknownTools: readonly string[];
  compatible: boolean;
  details: Record<string, unknown>;
}

/**
 * Reconciles a Kit profile's Tool declaration with what the Glassbox host can activate.
 *
 * A Kit profile describes a Pi distribution; it does not know Glassbox's safety boundary. So
 * a declared host built-in is classified `disabled_by_host` rather than treated as an error —
 * but it is *reported*, because "the profile says read exists and the host silently removed
 * it" is exactly the drift that let a model believe it had a capability it never had.
 *
 * A declared name that is neither a host built-in nor a Glassbox domain Tool is a different
 * thing entirely: nothing will ever provide it. That is a typo or a stale profile, and
 * guessing which is not this function's job, so the profile is reported incompatible.
 */
export function describeToolDrift(input: {
  profileName: PiRuntimeProfileName;
  profileActiveTools: readonly string[];
}): ToolDriftReport {
  const disabledByHost: string[] = [];
  const unknownTools: string[] = [];
  for (const name of input.profileActiveTools) {
    if (PI_BUILTIN_TOOLS.includes(name)) disabledByHost.push(name);
    else if (!DESCRIPTORS_BY_NAME.has(name)) unknownTools.push(name);
  }
  return {
    profileName: input.profileName,
    declared: [...input.profileActiveTools],
    disabledByHost,
    unknownTools,
    compatible: unknownTools.length === 0,
    details: {
      declared: [...input.profileActiveTools],
      hostExcluded: [...GLASSBOX_HOST_EXCLUDED_PI_TOOLS],
    },
  };
}

/* ------------------------------------------------------------------ *
 * Profile selection ledger
 * ------------------------------------------------------------------ */

export interface ProfileSelectionDecision {
  profileName: PiRuntimeProfileName;
  /** The production caller that selects this profile, or `null` when nothing does. */
  selectedBy: string | null;
  retired?: { reason: string };
}

/**
 * Which production caller selects each Kit profile.
 *
 * Runtime profile selection used to be a two-branch expression, which meant a Kit profile
 * could sit in the distribution looking like a real Tool policy while no Run ever selected
 * it. `owner-direct` did exactly that. The ledger makes the decision explicit: a profile is
 * either selected by a named caller, or retired with a reason, and a new Kit profile with no
 * entry fails `assertProfileSelectionComplete` instead of joining the distribution unnoticed.
 */
export const PROFILE_SELECTION: readonly ProfileSelectionDecision[] = Object.freeze([
  {
    profileName: "main-agent",
    selectedBy: "piProfileName: private scope (Owner and Visitor)",
  },
  { profileName: "qq-group", selectedBy: "piProfileName: group scope, non-Owner" },
  { profileName: "local-coding", selectedBy: null, retired: { reason: "no production caller" } },
  {
    profileName: "owner-direct",
    selectedBy: null,
    retired: {
      reason:
        "never selected: piProfileName routes every Owner-private Run to main-agent, whose Owner Tool surface is the superset this profile would narrow",
    },
  },
  { profileName: "herdr-worker", selectedBy: null, retired: { reason: "no production caller" } },
  {
    profileName: "test",
    selectedBy: null,
    retired: { reason: "test fixture only; no production Run selects it" },
  },
]);

const SELECTION_BY_NAME = new Map(PROFILE_SELECTION.map((entry) => [entry.profileName, entry]));

/**
 * Fails when a Kit profile has no recorded selection decision.
 *
 * Called with the profile names the Kit distribution actually contains, so adding a profile
 * upstream surfaces here rather than becoming another silently unused Tool policy.
 */
export function assertProfileSelectionComplete(names: readonly string[]): void {
  const missing = names.filter((name) => !SELECTION_BY_NAME.has(name as PiRuntimeProfileName));
  if (missing.length > 0)
    throw new Error(`Kit profiles have no selection decision: ${missing.join(", ")}`);
}

/** The recorded decision for one profile, or `undefined` when it has none. */
export function profileSelection(name: PiRuntimeProfileName): ProfileSelectionDecision | undefined {
  return SELECTION_BY_NAME.get(name);
}

/* ------------------------------------------------------------------ *
 * Effective Tool surface
 * ------------------------------------------------------------------ */

/**
 * Why a Tool is not on this Run's surface.
 *
 * A bare "excluded" list cannot distinguish a safety boundary from a policy choice from a
 * denial, and a caller that cannot tell them apart cannot explain the surface to an Owner.
 */
export type ToolExclusionReason =
  | "disabled_by_host"
  | "scope_not_permitted"
  | "policy_disabled"
  | "discovery_denied"
  | "no_caller_context"
  /**
   * Glassbox registers this Tool but no discovery rule classified it.
   *
   * This is a wiring bug, not a policy outcome, and it is deliberately distinct so it cannot
   * be mistaken for a deliberate exclusion. `application.test.ts` asserts no real Run ever
   * produces it, which is what makes adding a Tool without wiring discovery fail the suite.
   */
  | "unclassified";

/**
 * The discovery policy revision recorded on every surface.
 *
 * Bump this when the rules that decide what reaches a model change — a new gate, a changed
 * scope rule, a new exclusion reason. Surfaces written under different revisions stay
 * readable, so an old Run's evidence is never reinterpreted through newer rules.
 */
export const TOOL_SURFACE_POLICY_VERSION = "tool-surface-policy-v1";

export interface ToolSurfaceEntry {
  name: string;
  origin: ToolOrigin;
  riskClass: ToolRiskClass;
  budgetClass: ToolBudgetClass;
  grounding: ToolGroundingClass;
  provider: string;
  schemaVersion: string;
  /** What is known about the provider right now, so "on the surface" is never read as "works". */
  providerReadiness: "ready" | "unavailable" | "unknown";
}

export interface ExcludedToolSurfaceEntry extends ToolSurfaceEntry {
  reason: ToolExclusionReason;
}

export interface EffectiveToolSurface {
  profileName: PiRuntimeProfileName;
  /** The Kit profile's Tool declaration, verbatim, so drift stays visible after the fact. */
  profileTools: readonly string[];
  /** The Kit profile version this surface was computed against, so old evidence stays readable. */
  profileVersion: string;
  /**
   * Which discovery policy produced this surface.
   *
   * Recorded because a surface is only interpretable against the rules that built it: without
   * it, later evidence cannot tell a scope boundary from a policy change from a bug.
   */
  policyVersion: string;
  selected: ToolSurfaceEntry[];
  excluded: ExcludedToolSurfaceEntry[];
  /** Kit-declared Tools the host never activates. */
  disabledByHost: readonly string[];
  /**
   * Discovered names Glassbox has no descriptor for.
   *
   * These are never selected — a Tool nothing can describe must not reach a model. They are
   * reported rather than dropped, because a surface that quietly loses an entry is exactly
   * the drift this module exists to make visible.
   */
  undescribed: string[];
  generatedAt: string;
}

export interface ToolSurfaceCandidate {
  name: string;
  /** `null` when this Run's discovery selected the Tool. */
  exclusion: ToolExclusionReason | null;
}

function surfaceEntry(
  descriptor: ToolDescriptor,
  providerReadiness: "ready" | "unavailable" | "unknown",
): ToolSurfaceEntry {
  return {
    name: descriptor.name,
    origin: descriptor.origin,
    riskClass: descriptor.riskClass,
    budgetClass: descriptor.budgetClass,
    grounding: descriptor.grounding,
    provider: descriptor.provider,
    schemaVersion: descriptor.schemaVersion,
    providerReadiness,
  };
}

/**
 * Builds the safe, inspectable record of one Run's Tool surface.
 *
 * The snapshot carries names, origins, risk and provider — never a Tool payload, a parameter
 * value or a group id. That is deliberate: this record is written to Trace and shown to the
 * Owner, and a surface report is not a place protected values may appear.
 */
export function describeToolSurface(input: {
  profileName: PiRuntimeProfileName;
  profileActiveTools: readonly string[];
  candidates: readonly ToolSurfaceCandidate[];
  profileVersion?: string;
  policyVersion?: string;
  providerReadiness?: Readonly<Record<string, "ready" | "unavailable" | "unknown">>;
  generatedAt?: string;
}): EffectiveToolSurface {
  const drift = describeToolDrift({
    profileName: input.profileName,
    profileActiveTools: input.profileActiveTools,
  });
  const selected: ToolSurfaceEntry[] = [];
  const excluded: ExcludedToolSurfaceEntry[] = [];
  const undescribed: string[] = [];
  const seen = new Set<string>();
  const readiness = (name: string): "ready" | "unavailable" | "unknown" =>
    input.providerReadiness?.[name] ?? "unknown";

  for (const candidate of input.candidates) {
    const descriptor = DESCRIPTORS_BY_NAME.get(candidate.name);
    if (!descriptor) {
      undescribed.push(candidate.name);
      continue;
    }
    seen.add(candidate.name);
    const entry = surfaceEntry(descriptor, readiness(candidate.name));
    if (candidate.exclusion === null) selected.push(entry);
    else excluded.push({ ...entry, reason: candidate.exclusion });
  }

  // A Kit profile Tool the host removed belongs on the record even when discovery never
  // considered it, because the profile is where a reader would otherwise believe it exists.
  for (const name of drift.disabledByHost) {
    if (seen.has(name)) continue;
    const descriptor = DESCRIPTORS_BY_NAME.get(name);
    if (!descriptor) continue;
    seen.add(name);
    excluded.push({
      ...surfaceEntry(descriptor, readiness(name)),
      reason: "disabled_by_host",
    });
  }

  return {
    profileName: input.profileName,
    profileTools: [...input.profileActiveTools],
    profileVersion: input.profileVersion ?? "unknown",
    policyVersion: input.policyVersion ?? TOOL_SURFACE_POLICY_VERSION,
    selected,
    excluded,
    disabledByHost: drift.disabledByHost,
    undescribed,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Operational state
 * ------------------------------------------------------------------ */

/**
 * What one Tool call did, as a decision the Runtime can branch on.
 *
 * `protected_tool_failed` stays the model-visible code: provider error text must not reach a
 * model or a user. This is the structured form behind it, so a Run can tell "the model never
 * called it" from "the provider refused" without parsing a message.
 */
export type ToolExecutionOutcome =
  | "success"
  | "not_called"
  | "denied"
  | "invalid_input"
  | "provider_unavailable"
  | "provider_failed"
  | "cancelled"
  | "unknown";

/**
 * The outcome a recorded failure code stands for.
 *
 * The Trace carries a fixed code rather than an outcome because the code is what a reader
 * greps for; this is the same fact in the vocabulary the Runtime branches on. An unrecognized
 * code is `unknown`, never `success`: a code this build does not understand is not evidence
 * that the call worked.
 */
export function toolOutcomeFromFailure(code: string): ToolExecutionOutcome {
  switch (code) {
    case "authorization_denied":
    case "capability_category_disabled":
    case "context_missing":
    case "provider_denied":
      return "denied";
    case "input_validation_failed":
      return "invalid_input";
    case "provider_unavailable":
      return "provider_unavailable";
    case "protected_tool_failed":
    case "provider_failed":
      return "provider_failed";
    default:
      return "unknown";
  }
}

/**
 * What is actually known about one Tool right now.
 *
 * The ladder is ordered and every rung is earned. In particular `succeeded` is reachable
 * only from `lastExecution.outcome === "success"`: a Tool definition, an Owner role, a grant
 * or an enabled policy are all inputs to `discoverable`/`authorized`, and none of them is an
 * observation that anything ran.
 */
export type ToolOperationalState =
  | "registered"
  | "discoverable"
  | "authorized"
  | "provider_ready"
  | "succeeded"
  | "failed"
  | "unavailable"
  | "unknown";

export interface ToolOperationalObservation {
  registered: boolean;
  discoverable: boolean;
  authorization: "allowed" | "denied" | "unknown";
  provider: "ready" | "unavailable" | "unknown";
  /** Present only when a concrete call really happened. */
  lastExecution?: { outcome: ToolExecutionOutcome; at: string };
}

/**
 * The strongest state the current evidence supports.
 *
 * A last execution, when there is one, wins: it is the only direct observation. Without one,
 * the answer walks the ladder down from `provider_ready`, and stops at `registered` whenever
 * authorization was denied — a denied Tool is not a ready Tool, however healthy its provider.
 */
export function toolOperationalState(
  observation: ToolOperationalObservation,
): ToolOperationalState {
  if (!observation.registered) return "unknown";
  const last = observation.lastExecution;
  if (last) {
    switch (last.outcome) {
      case "success":
        return "succeeded";
      case "denied":
        return "registered";
      case "invalid_input":
      case "provider_failed":
        return "failed";
      case "provider_unavailable":
        return "unavailable";
      // A cancelled or unknown call is not a verdict on the Tool, so it falls through to
      // whatever readiness is independently known.
      case "cancelled":
      case "unknown":
      case "not_called":
        break;
    }
  }
  if (!observation.discoverable) return "registered";
  if (observation.authorization !== "allowed") return "registered";
  if (observation.provider === "unavailable") return "unavailable";
  if (observation.provider === "unknown") return "unknown";
  return "provider_ready";
}
