import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { CallerContext } from "../../identity/scope.js";
import type { AuthorizationService } from "../../auth/service.js";
import { ProviderCallError } from "./provider-outcome.js";

export interface ProtectedToolContext {
  caller: CallerContext;
  conversationId: string;
  runId: string;
  /**
   * The Tool the *current user message* requires, when it requires one.
   *
   * Derived only from `input.text`, never from Conversation history, retrieved history text,
   * notices, file content or an earlier Tool result. A mutating Tool reads it to prove the
   * mutation was asked for, so retrieved text can never become mutation authority.
   */
  requiredToolName?: string;
  /** The exact input the current user message requires of that Tool. */
  requiredToolInput?: Record<string, unknown>;
}

/**
 * A refusal whose message is a fixed Glassbox-authored code rather than model input.
 *
 * Execution failures collapse into one opaque code so no provider detail or parameter
 * value can leak. Input refusals are the deliberate exception: a model can only correct a
 * malformed call if it learns which rule it broke, and a caller that cannot tell "you named
 * an operation I do not have" from "the provider broke" will simply retry the same call.
 *
 * The constructor accepts only a bare code, so model-supplied text can never reach the
 * message even if a future caller tries to interpolate one.
 */
export class ToolInputError extends Error {
  constructor(code: string) {
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(code)) throw new Error("invalid_tool_input_error_code");
    super(code);
    this.name = "ToolInputError";
  }
}

/** A fixed-code execution-time authorization refusal outside the durable grant service. */
export class ToolAuthorizationError extends Error {
  constructor(code: "native_group_role_denied" | "native_group_role_unverified") {
    super(code);
    this.name = "ToolAuthorizationError";
  }
}

export interface ProtectedToolOptions<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  name: string;
  label?: string;
  description: string;
  parameters: TSchema;
  /** The authorization action may depend on the validated operation selected by the call. */
  action: string | ((params: TParams, context: ProtectedToolContext) => string);
  /**
   * The Resource this Action protects. A function may derive it from the call params
   * and/or the Run context, so a tool can bind to the current Channel scope (for
   * example the group the Run is in) without letting the model choose the Resource.
   */
  resourceId: string | ((params: TParams, context: ProtectedToolContext) => string);
  authService: AuthorizationService;
  getContext: () => ProtectedToolContext | undefined;
  execute: (
    params: TParams,
    context: ProtectedToolContext,
    signal?: AbortSignal,
  ) => Promise<TResult>;
  redactSensitive?: (params: TParams) => Record<string, unknown>;
  /**
   * Builds the text the model receives, when the raw result must not be shown verbatim.
   *
   * Pi separates the two: `content` is the model-visible result and `details` is structured
   * data for logs and UI. A Tool whose result carries implementation identifiers supplies a
   * projection so those stay out of model-visible Context while the detail keeps them.
   */
  projectResult?: (result: TResult) => string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether one primitive the message required and the primitive the call carries are the same.
 *
 * A provider parameter is the same parameter whether the model sends `10004` or `"10004"`, so
 * numbers and numeric strings compare equal. Booleans compare strictly: a string can never
 * stand in for a flag, because `"false"` is not the `false` the Owner asked for.
 */
function samePrimitive(actual: unknown, required: unknown): boolean {
  if (typeof actual === "boolean" || typeof required === "boolean") return actual === required;
  if (actual === null || required === null || actual === undefined || required === undefined)
    return actual === required;
  if (typeof actual === "object" || typeof required === "object") return false;
  if (!isTextualPrimitive(actual) || !isTextualPrimitive(required)) return actual === required;
  return String(actual) === String(required);
}

/** The primitives a provider parameter may name itself as: a number and its text are one value. */
function isTextualPrimitive(value: unknown): value is string | number | bigint {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint";
}

/**
 * Whether a Tool call satisfies the exact input the current user message requires.
 *
 * A required value may itself be an object — a Tool's nested `params` — and that object must
 * match the call's *exactly*: every entry the message pinned down agrees, and the call adds no
 * entry the message did not name. A provider parameter is authority-bearing, so an optional
 * one the model supplies on its own (a kick's `reject_add_request`, say) is a different
 * request than the one the Owner made, not an implementation detail of it. Omitting it leaves
 * the provider default in force rather than a value the model chose.
 *
 * The top level stays a subset check: it is the Tool's own envelope (which Tool, which
 * operation, which Resource), which a message never enumerates in full.
 *
 * Run completion uses this comparison after a Tool reports success. Mutating Tools also
 * reject additional top-level authority-bearing fields before execution, so a refused call
 * cannot be counted as completed.
 */
export function satisfiesRequiredInput(
  required: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): boolean {
  for (const [key, value] of Object.entries(required)) {
    const actualValue = actual[key];
    if (isPlainRecord(value)) {
      if (!isPlainRecord(actualValue)) return false;
      if (Object.keys(actualValue).length !== Object.keys(value).length) return false;
      for (const [nestedKey, nestedValue] of Object.entries(value))
        if (!samePrimitive(actualValue[nestedKey], nestedValue)) return false;
      continue;
    }
    if (!samePrimitive(actualValue, value)) return false;
  }
  return true;
}

/** Mutations may not add a target or switch that the current message did not bind. */
function satisfiesRequiredMutationInput(
  required: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): boolean {
  return (
    satisfiesRequiredInput(required, actual) &&
    Object.entries(actual).every(([key, value]) => value === undefined || key in required)
  );
}

/**
 * The exact-input clause of a required-Tool instruction.
 *
 * A required Tool that pins down no parameter — a search whose query the message does not
 * dictate — contributes no clause at all. Naming the empty object would tell the model to
 * send `{}`, which the Tool's own schema rejects.
 */
export function requiredInputClause(input: Record<string, unknown> | undefined): string {
  return input && Object.keys(input).length > 0
    ? ` with exactly this JSON input: ${JSON.stringify(input)}`
    : "";
}

/**
 * Refuses a mutating call the current user message did not ask for.
 *
 * A mutation is only permitted when the Run's required-Tool context names this Tool *and*
 * every key that context carries agrees with the call — including the target and value the
 * message named, and with no provider parameter the message never named. That context is
 * derived from the current user message alone, so a retrieved instruction — group history, a
 * notice, file content, a Tool result, Conversation history — cannot create mutation
 * authority, and a read-only question cannot turn into a mutation.
 *
 * The refusal is a fixed code rather than a permission reason: whether the mutation was
 * requested is a property of the current message, not of any grant.
 */
export function requireMutationIntent(
  context: ProtectedToolContext,
  name: string,
  actual: Readonly<Record<string, unknown>>,
): void {
  if (context.requiredToolName !== name) throw new ToolInputError("mutation_not_requested");
  const required = context.requiredToolInput;
  if (!required || !satisfiesRequiredMutationInput(required, actual))
    throw new ToolInputError("mutation_not_requested");
}

/**
 * The exact mutation request objects already used by this process.
 *
 * `requiredToolInput` is created once for a Run and every Tool context keeps that same object
 * reference. A WeakSet therefore gives the Run one mutation attempt without adding mutable
 * authority to persisted input or retaining completed Runs. The check and add are synchronous,
 * so two concurrent calls cannot both cross the boundary before the provider is invoked.
 */
const consumedMutationIntents = new WeakSet<Readonly<Record<string, unknown>>>();

/**
 * Consumes the current Run's exact mutation request immediately before its side effect.
 *
 * Provider success is deliberately irrelevant. Once Glassbox has attempted the requested
 * mutation, a model retry in the same Run is refused. A new user message creates a new Run and
 * a new request object, so an explicit retry by the user remains possible.
 */
export function consumeMutationIntent(
  context: ProtectedToolContext,
  name: string,
  actual: Readonly<Record<string, unknown>>,
): void {
  requireMutationIntent(context, name, actual);
  const required = context.requiredToolInput!;
  if (consumedMutationIntents.has(required)) throw new ToolInputError("mutation_already_attempted");
  consumedMutationIntents.add(required);
}

export function createProtectedTool<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
>(options: ProtectedToolOptions<TParams, TResult>): ToolDefinition {
  return {
    name: options.name,
    label: options.label ?? options.name,
    description: options.description,
    parameters: options.parameters,
    async execute(
      _id: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<TResult>> {
      if (signal?.aborted) {
        throw new Error("Operation cancelled");
      }

      const context = options.getContext();
      if (!context) {
        throw new Error(`Permission denied for tool '${options.name}': context_missing`);
      }

      const typedParams = (params ?? {}) as TParams;
      const resourceId =
        typeof options.resourceId === "function"
          ? options.resourceId(typedParams, context)
          : options.resourceId;
      const action =
        typeof options.action === "function"
          ? options.action(typedParams, context)
          : options.action;

      // Gate 3 — Re-authorize immediately before executing side effect!
      const decision = await options.authService.check({
        caller: context.caller,
        resourceId,
        action,
        conversationId: context.conversationId,
        runId: context.runId,
      });

      if (decision.decision !== "ALLOW") {
        // Redact any confidential arguments from the denial output. Never echo raw parameters.
        throw new Error(`Permission denied: ${decision.reason}`);
      }

      if (signal?.aborted) {
        throw new Error("Operation cancelled");
      }

      try {
        const result = await options.execute(typedParams, context, signal);
        if (signal?.aborted) {
          throw new Error("Operation cancelled");
        }
        return {
          content: [
            {
              type: "text",
              text: options.projectResult
                ? options.projectResult(result)
                : typeof result === "string"
                  ? result
                  : JSON.stringify(result),
            },
          ],
          details: result,
        };
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof Error && error.message === "Operation cancelled")
        ) {
          throw new Error("Operation cancelled");
        }
        if (error instanceof ToolInputError || error instanceof ToolAuthorizationError) throw error;
        // A provider refusal is a fact about the world, not a broken Tool. Collapsing it into
        // the generic failure would erase the difference between "the bridge is down" and
        // "the Tool threw", which is exactly what a Run has to be able to report.
        if (error instanceof ProviderCallError) throw error;
        throw new Error("protected_tool_failed");
      }
    },
  };
}
