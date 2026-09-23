// Backward-compatible exports for fixtures and integrations that still use the old barrel.
// New application code should depend on the composition root directly and domain modules
// should import only their owning store or a narrow port.
export { openDomainStore } from "../application/domain-store.js";
export type { DomainStore } from "../application/domain-store.js";
export type { CallerContext, TrustedChannelScope } from "../identity/scope.js";
export { scopeKey, conversationScopeKey, identityKey } from "../identity/scope.js";
export { agentResourceId } from "../conversation/store.js";
export { AccessDeniedError } from "../auth/service.js";
