import { createHash } from "node:crypto";

const projectionBrand = Symbol("glassbox.authorization_projection_result");

export type ProjectionKind = "managed_group_inventory" | "capability_search";
export type ProjectionPurpose =
  | "managed_group_category_availability"
  | "capability_tool_discovery_availability"
  | "capability_group_category_availability"
  | "capability_search_availability";

export interface ProjectionDecisionEvidence {
  decisionId: string;
  action: string;
  resourceId: string;
  decision: "ALLOW" | "DENY" | "REQUIRES_APPROVAL";
  reason: string;
  purpose?: ProjectionPurpose;
}

export interface ProjectionInputEvidence {
  inputSha256: string;
  inputBytes: number;
}

export interface ProjectionOutputEvidence {
  outputSha256: string;
  outputBytes: number;
}

export interface ProjectionReceiptContext {
  caller: { principalId: string; scope: unknown };
  conversationId: string;
  runId: string;
  toolCallId?: string;
}

interface ProjectionMetadata {
  kind: ProjectionKind;
  purpose: ProjectionPurpose;
  decisions: ProjectionDecisionEvidence[];
  input: Record<string, unknown>;
  record: (input: {
    context: ProjectionReceiptContext;
    input: ProjectionInputEvidence;
    output: ProjectionOutputEvidence;
  }) => Promise<void>;
}
export interface ProjectionEnvelope<TResult> extends ProjectionMetadata {
  readonly [projectionBrand]: true;
  result: TResult;
}

export function authorizationProjectionResult<TResult>(
  result: TResult,
  metadata: ProjectionMetadata,
): ProjectionEnvelope<TResult> {
  const envelope = { result, ...metadata } as ProjectionEnvelope<TResult>;
  Object.defineProperty(envelope, projectionBrand, { value: true });
  return envelope;
}

export function unwrapAuthorizationProjection<TResult>(
  value: unknown,
): { result: TResult; metadata: ProjectionMetadata } | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    (value as ProjectionEnvelope<TResult>)[projectionBrand] !== true
  )
    return undefined;
  const envelope = value as ProjectionEnvelope<TResult>;
  return {
    result: envelope.result,
    metadata: {
      kind: envelope.kind,
      purpose: envelope.purpose,
      decisions: envelope.decisions,
      input: envelope.input,
      record: envelope.record,
    },
  };
}

export function projectionInputEvidence(input: Record<string, unknown>): ProjectionInputEvidence {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
      );
    return value;
  };
  const serialized = JSON.stringify(canonicalize(input));
  if (typeof serialized !== "string") throw new Error("projection_input_not_json");
  return {
    inputSha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
    inputBytes: Buffer.byteLength(serialized, "utf8"),
  };
}
