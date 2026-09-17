import {
  PRIVATE_CANARY,
  type Audience,
  type ResourceVisibility,
} from "@glassbox/contracts";

export interface DeliveryCheckRequest {
  resourceVisibility: ResourceVisibility;
  resourceOwnerId?: string | null;
  audience: Audience;
  callerPrincipalId: string;
}

export interface DeliveryCheckResult {
  allowed: boolean;
  reason: string;
}

export class DeliveryDeniedError extends Error {
  constructor(readonly reason: string) {
    super(`Delivery denied: ${reason}`);
    this.name = "DeliveryDeniedError";
  }
}

/**
 * Gate 4: Delivery Authorization
 * Enforces server-side delivery policy.
 * Core invariant: Read permission does NOT imply delivery permission.
 * Private data cannot be delivered to a group audience even if requested by Owner.
 */
export function checkDelivery(request: DeliveryCheckRequest): DeliveryCheckResult {
  // 1. Private resources cannot be delivered to group audiences
  if (request.resourceVisibility === "private" && request.audience.kind === "group") {
    return {
      allowed: false,
      reason: "private_group_delivery_denied",
    };
  }

  // 2. Private resources can only be delivered to authorized principals
  if (request.resourceVisibility === "private" && request.resourceOwnerId) {
    if (!request.audience.allowedPrincipals.includes(request.resourceOwnerId)) {
      return {
        allowed: false,
        reason: "private_audience_mismatch",
      };
    }
  }

  // 3. Caller must be an allowed recipient for this audience
  if (
    request.audience.allowedPrincipals.length > 0 &&
    !request.audience.allowedPrincipals.includes(request.callerPrincipalId)
  ) {
    return {
      allowed: false,
      reason: "caller_not_in_audience",
    };
  }

  return {
    allowed: true,
    reason: "delivery_allowed",
  };
}

/**
 * Security Canary assertion:
 * Verifies that PRIVATE_CANARY never leaks into unauthorized payload text,
 * tool results, or delivery payloads.
 */
export function assertCanarySafety(
  payload: string,
  audience: Audience,
  isAuthorizedForCanary: boolean,
): void {
  if (!isAuthorizedForCanary && payload.includes(PRIVATE_CANARY)) {
    throw new Error(
      `SECURITY LEAK: PRIVATE_CANARY leaked to unauthorized audience kind="${audience.kind}" key="${audience.destinationScopeKey}"`,
    );
  }
}
