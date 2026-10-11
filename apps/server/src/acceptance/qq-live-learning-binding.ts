import type { ExecutionInput } from "../execution/run-service/types.js";
import { scopeKey } from "../identity/scope.js";
import { canonicalQqLiveTextSha256, type QqLiveLeaseBinding } from "./qq-live-lease.js";

/** Server-created binding recorded after exact inbound validation and durable audit. */
export type QqLiveLearningBinding = QqLiveLeaseBinding & {
  /** Internal message row ID, distinct from the account-local external OneBot ID. */
  runMessageId: string;
  textSha256: string;
};

export function isBoundQqLiveLearningInput(
  binding: QqLiveLearningBinding | undefined,
  input: Pick<ExecutionInput, "caller" | "run" | "text">,
): boolean {
  if (!binding || input.run.source !== "external") return false;
  return (
    binding.runId === input.run.id &&
    binding.runMessageId === input.run.messageId &&
    binding.principalId === input.caller.principalId &&
    binding.principalId === input.run.principalId &&
    binding.scope.senderId === input.caller.scope.senderId &&
    scopeKey(binding.scope) === scopeKey(input.caller.scope) &&
    binding.textSha256 === canonicalQqLiveTextSha256(input.text)
  );
}
