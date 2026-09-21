/**
 * The read-only QQ acceptance: really calling each provider-backed read path once.
 *
 * Issue #16 §7 asks for acceptance that is a *call*, not a definition. A capability that is
 * registered, allowlisted and covered by deterministic tests is still not known to work
 * against the bridge in front of it, and §1 forbids reporting "定义在" as "实测可用". So this
 * module runs the five read domains the issue names through the same allowlisted provider
 * path the capability Tools use, and records what actually came back.
 *
 * Four properties make the record trustworthy:
 *
 *  - The paths are derived from the registry, not restated. A path whose operation is not a
 *    real operation of a read-only capability throws at load, so a registry change cannot
 *    leave a stale path behind. The allowlist itself is enforced where it always is — the
 *    adapter refuses a non-allowlisted action — and `capability-probe.test.ts` asserts that
 *    every path here is on it, so acceptance can never prove something a model could not call.
 *  - Every path is authorized before it is called. Acceptance is not a way around the product's
 *    authorization: a path is probed only when the same Principal × Resource × Action × Context
 *    decision a Run's Tool call gets comes back ALLOW, and a denied path is recorded as
 *    `denied` with no call made. The question is injected (`decide`), not answered here,
 *    because the answer is the product's and a second implementation of it would be the very
 *    defect this module exists to catch. A path that could be probed while no Run could call it
 *    would prove the opposite of what acceptance is for.
 *  - Nothing but structure is recorded. `safeResultShape` describes a result's field names and
 *    counts and never a value, so acceptance evidence can be read, shared and kept without
 *    copying a member's nickname, a notice or a message into the Trace.
 *  - A provider-free path never counts as provider health. `qq_groups`' managed listing is a
 *    projection over Glassbox's own inventory; it can succeed with the bridge down, so it is
 *    recorded with `providerBacked: false` and excluded from the provider verdict.
 *
 * The outcome vocabulary is `ToolExecutionOutcome` from `tool-plane.ts`, unchanged: an
 * acceptance that invented its own words for "the call failed" could not be compared with what
 * a Run records about the same Tool.
 */

import type { OneBotCapabilityResult } from "./adapter.js";
import type { QqCapability, QqCapabilityCategory, QqCapabilityResource } from "./capabilities.js";
import { QQ_CAPABILITIES } from "./capabilities.js";
import { providerOutcome } from "../../runtime/pi/provider-outcome.js";
import type { ToolExecutionOutcome } from "../../runtime/pi/tool-plane.js";

/** The provider the acceptance is about. Recorded so evidence stays readable if it changes. */
export const ACCEPTANCE_PROVIDER = "qq-napcat";

/**
 * One read path the acceptance calls.
 *
 * The registry facts are carried rather than re-derived at the call site so the authorization
 * question asked about a path is the one the registry declares for it: the same Action, on the
 * same class of Resource, under the same policy category the Tool itself would use.
 *
 * `operation: null` is the one path that reaches no provider: `qq_groups`' managed listing,
 * which is a projection over the Owner's own inventory. It is in the list because §7 asks for
 * it, and marked apart because its success is not evidence about the bridge.
 */
export interface ReadAcceptancePath {
  tool: string;
  /** The allowlisted provider action, or `null` when the path reaches no provider. */
  operation: string | null;
  /** The protected Action this path is authorized against. */
  action: string;
  /** The class of Resource the path is authorized against. */
  resource: QqCapabilityResource;
  /** The Owner policy category that must be enabled for a group-scoped path. */
  category: QqCapabilityCategory;
  /** True only for the provider-free managed listing. */
  listing: boolean;
  /** What this path proves, in the registry's own words. */
  description: string;
}

/**
 * The registry facts for one Tool, or a load-time failure.
 *
 * A path that is not a real allowlisted read of a real read-only capability is a wiring bug:
 * the acceptance would be calling something Glassbox never exposes, or something that changes a
 * group. Both are worse than a missing check, so this fails at load. Every path below is built
 * through here, including the provider-free one, so no entry can carry facts the registry does
 * not declare.
 */
function registryFacts(tool: string): { capability: QqCapability; description: string } {
  const capability = QQ_CAPABILITIES.find((entry) => entry.tool === tool);
  if (!capability || capability.risk !== "read")
    throw new Error(`acceptance path is not an allowlisted read: ${tool}`);
  return { capability, description: capability.description };
}

function describePath(tool: string, operation: string): ReadAcceptancePath {
  const { capability, description } = registryFacts(tool);
  const allowed = capability.operations.find((entry) => entry.action === operation);
  if (!allowed) throw new Error(`acceptance path is not an allowlisted read: ${tool}.${operation}`);
  return {
    tool,
    operation,
    action: capability.action,
    resource: capability.resource,
    category: capability.category,
    listing: false,
    description,
  };
}

/**
 * The provider-free managed listing, described by the same rules as every other path.
 *
 * Its own words rather than the capability's, because it is not a provider read of one group:
 * a report that described it as "read group metadata" would invite exactly the mistake
 * `providerBacked: false` exists to prevent.
 */
function describeListing(tool: string): ReadAcceptancePath {
  const { capability } = registryFacts(tool);
  return {
    tool,
    operation: null,
    action: capability.action,
    resource: capability.resource,
    category: capability.category,
    listing: true,
    description: "The Owner's managed-group inventory.",
  };
}

/**
 * Every read path §7 accepts, in the order it is probed.
 *
 * `qq_groups` appears twice because the issue asks for two different things under it: the
 * Owner's managed listing, and one real provider metadata read. The listing is first so a
 * report reads from the local view outward to the bridge.
 */
export const READ_ACCEPTANCE_PATHS: readonly ReadAcceptancePath[] = Object.freeze([
  describeListing("qq_groups"),
  describePath("qq_groups", "get_group_info"),
  describePath("qq_group_members", "get_group_member_list"),
  describePath("qq_group_history", "get_group_msg_history"),
  describePath("qq_group_content", "_get_group_notice"),
  describePath("qq_group_content", "get_essence_msg_list"),
  describePath("qq_group_files", "get_group_root_files"),
]);

/**
 * The one authorization question asked before each path.
 *
 * `groupId` is the group the path targets, or `null` for the provider-free listing, which names
 * no group. Anything but `allowed` is `denied`: the acceptance has no vocabulary of its own for
 * "the product said no", and inventing one would put it out of step with the outcome a Run
 * records about the same call.
 */
export type ProbeDecision = "allowed" | "denied";

/** How many field names one shape may carry, so a wide result cannot fill the record. */
const MAX_SHAPE_FIELDS = 32;

/** What a provider field name may look like before it is treated as content instead. */
const SCHEMA_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

/**
 * A result's structure: kinds, field names and counts. Never a value.
 *
 * Field names are schema, not data — `member_list`, `group_id` — which is what makes a shape
 * both useful and safe. A name that does not look like one is withheld rather than copied: a
 * provider (or a confused upstream) putting a message where a field name belongs must not have
 * that message land in evidence.
 */
export interface SafeResultShape {
  kind: "object" | "array" | "string" | "number" | "boolean" | "null";
  /** The result's own field names, sorted. Present only for an object. */
  fields?: string[];
  /** How many entries the provider returned. Present only for an array. */
  count?: number;
  /** The field names of the array's first object element, when it has one. */
  elementFields?: string[];
  /** True when a field name was withheld because it did not look like a schema name. */
  fieldsRedacted?: boolean;
}

function shapeFields(keys: readonly string[]): {
  fields: string[];
  fieldsRedacted: boolean;
} {
  const fields: string[] = [];
  let fieldsRedacted = false;
  for (const key of [...keys].sort()) {
    if (fields.length >= MAX_SHAPE_FIELDS) break;
    if (SCHEMA_FIELD_NAME.test(key)) fields.push(key);
    else fieldsRedacted = true;
  }
  // A result wider than the bound is reported as redacted rather than silently cut: a reader
  // must be able to tell "the provider sent 100 fields" from "the provider sent 32".
  if (keys.length > MAX_SHAPE_FIELDS) fieldsRedacted = true;
  return { fields, fieldsRedacted };
}

export function safeResultShape(value: unknown): SafeResultShape {
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) {
    const shape: SafeResultShape = { kind: "array", count: value.length };
    const first = value[0];
    if (first !== null && typeof first === "object" && !Array.isArray(first))
      shape.elementFields = shapeFields(Object.keys(first)).fields;
    return shape;
  }
  if (typeof value === "object") {
    const { fields, fieldsRedacted } = shapeFields(Object.keys(value));
    return { kind: "object", fields, ...(fieldsRedacted ? { fieldsRedacted: true } : {}) };
  }
  if (typeof value === "string") return { kind: "string" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  // Functions, symbols and `undefined` are not something a provider response can carry; they
  // are reported as `null` rather than guessed at, because a shape is not a place to speculate.
  return { kind: "null" };
}

/**
 * What one path did, as the acceptance records it.
 *
 * `providerBacked` is the field that keeps the record honest. Without it, a report of "seven
 * paths succeeded" would read as a healthy bridge even when the only thing that answered was
 * Glassbox's own inventory.
 */
export interface CapabilityProbeObservation {
  tool: string;
  operation: string | null;
  /** The group the call targeted, or `null` when the path is not group-scoped. */
  groupId: string | null;
  providerBacked: boolean;
  outcome: ToolExecutionOutcome;
  /** Structure only. `null` when the path produced no result to describe. */
  resultShape: SafeResultShape | null;
  observedAt: string;
}

export interface CapabilityProbeSummary {
  /** How many paths were probed. */
  paths: number;
  /** How many of them reached the provider. */
  providerBacked: number;
  /** Provider-backed paths the bridge really answered. The only provider verdict here. */
  providerBackedSucceeded: number;
  providerFailed: number;
  providerUnavailable: number;
  /** Paths the product refused. A denied path is never called, so it proves nothing. */
  denied: number;
  unknown: number;
  /** Provider-free paths that genuinely failed. A refused one is counted in `denied`, not here. */
  localFailed: number;
}

export interface CapabilityProbeReport {
  provider: string;
  groupId: string;
  observedAt: string;
  observations: CapabilityProbeObservation[];
  summary: CapabilityProbeSummary;
  /**
   * True only when every provider-backed path really succeeded.
   *
   * The provider-free listing cannot make this true or false: an acceptance that could be
   * satisfied by a projection over Glassbox's own state would prove nothing about the bridge.
   * A denied path makes it false too — a path that was refused was never called, so it is not
   * evidence that the bridge works, and an acceptance over a group no Run could read is not a
   * successful acceptance.
   */
  complete: boolean;
}

export interface CapabilityProbeInput {
  groupId: string;
  /**
   * The authorization question for one path, asked before the path is called.
   *
   * Injected because the answer belongs to the product, not to the acceptance: it is the same
   * decision a Run's Tool call is re-authorized with, plus the Owner's durable per-group policy.
   * Answering it here would be a second authorization implementation.
   */
  decide: (path: ReadAcceptancePath, groupId: string | null) => Promise<ProbeDecision>;
  /** The one outbound provider path: the same allowlisted call the capability Tools make. */
  invoke: (input: {
    action: string;
    params: Record<string, string | number | boolean>;
  }) => Promise<OneBotCapabilityResult>;
  /** The managed-group inventory, for the one path that reaches no provider. */
  projectManagedGroups: () => Promise<unknown>;
  /** Records one observation as evidence. Awaited, so a probe cannot outrun its own record. */
  record: (observation: CapabilityProbeObservation) => Promise<void>;
  now?: () => Date;
  provider?: string;
}

function summarize(observations: readonly CapabilityProbeObservation[]): CapabilityProbeSummary {
  const providerBacked = observations.filter((entry) => entry.providerBacked);
  const count = (outcome: ToolExecutionOutcome) =>
    observations.filter((entry) => entry.outcome === outcome).length;
  return {
    paths: observations.length,
    providerBacked: providerBacked.length,
    providerBackedSucceeded: providerBacked.filter((entry) => entry.outcome === "success").length,
    providerFailed: count("provider_failed"),
    providerUnavailable: count("provider_unavailable"),
    denied: count("denied"),
    unknown: count("unknown"),
    localFailed: observations.filter(
      (entry) => !entry.providerBacked && entry.outcome !== "success" && entry.outcome !== "denied",
    ).length,
  };
}

/**
 * Runs every acceptance path once and returns what each one did.
 *
 * A failure does not stop the run: one broken path must not hide whether the others work, and
 * a report that stopped at the first failure could not tell "the bridge is down" from "one
 * operation is refused". Each observation is recorded as it is made, so evidence exists even
 * if the process dies mid-probe.
 *
 * A denial does not stop it either, and is recorded for the same reason: an acceptance that
 * ended at the first refusal could not say which paths the product permits, and "everything
 * after the first denial" is not a fact worth withholding. What a denial never does is call
 * the path — `decide` is asked first, and a `denied` path reaches neither the provider nor the
 * managed-group projection.
 */
export async function probeReadCapabilities(
  input: CapabilityProbeInput,
): Promise<CapabilityProbeReport> {
  const now = input.now ?? (() => new Date());
  const observations: CapabilityProbeObservation[] = [];

  for (const path of READ_ACCEPTANCE_PATHS) {
    const observedAt = now().toISOString();
    const groupId = path.operation === null ? null : input.groupId;
    const base = {
      tool: path.tool,
      operation: path.operation,
      groupId,
      providerBacked: path.operation !== null,
      observedAt,
    };
    const decision = await input.decide(path, groupId);
    let observation: CapabilityProbeObservation;
    if (decision !== "allowed") {
      // Refused before the call, so there is nothing to describe: a shape here would have to
      // come from a result that does not exist.
      observation = { ...base, outcome: "denied", resultShape: null };
    } else if (path.operation === null) {
      observation = await localObservation(base, input);
    } else {
      const result = await input
        .invoke({ action: path.operation, params: { group_id: Number(input.groupId) } })
        .catch((): OneBotCapabilityResult => ({ status: "unknown", code: "invalid_response" }));
      const outcome = providerOutcome(result);
      observation = {
        ...base,
        outcome,
        resultShape: result.status === "ok" ? safeResultShape(result.data) : null,
      };
    }
    observations.push(observation);
    await input.record(observation);
  }

  const summary = summarize(observations);
  return {
    provider: input.provider ?? ACCEPTANCE_PROVIDER,
    groupId: input.groupId,
    observedAt: now().toISOString(),
    observations,
    summary,
    complete:
      summary.providerBacked > 0 && summary.providerBackedSucceeded === summary.providerBacked,
  };
}

/**
 * The provider-free path's observation.
 *
 * A throw here is `unknown`, not `provider_failed`: the projection reads Glassbox's own
 * inventory and never touches the bridge, so a failure says nothing about the provider — and
 * `providerBacked: false` is what stops a reader from taking it as one either way.
 */
async function localObservation(
  base: Omit<CapabilityProbeObservation, "outcome" | "resultShape">,
  input: CapabilityProbeInput,
): Promise<CapabilityProbeObservation> {
  try {
    const projected = await input.projectManagedGroups();
    return { ...base, outcome: "success", resultShape: safeResultShape(projected) };
  } catch {
    return { ...base, outcome: "unknown", resultShape: null };
  }
}
