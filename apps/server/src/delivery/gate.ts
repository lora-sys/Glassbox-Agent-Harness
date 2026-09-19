import type { Audience, ResourceVisibility } from "@glassbox/contracts";

export interface DeliveryCheckRequest {
  resourceVisibility: ResourceVisibility;
  resourceOwnerId?: string | null;
  audience: Audience;
  callerPrincipalId: string;
  authorizedRecipientIds?: readonly string[];
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
 * Core invariants:
 * 1. Default deny: No matching grant means DENY.
 * 2. Empty audience or missing destination scope is strictly rejected.
 * 3. Read permission does NOT imply delivery permission.
 * 4. Caller is the actor initiating delivery, not the recipient.
 * 5. Private data cannot be delivered to a group audience even if requested by Owner.
 * 6. Private data with empty/null owner is strictly denied.
 * 7. For private data, ALL audience recipients must be authorized (audience.allowedPrincipals ⊆ authorized).
 */
export function checkDelivery(request: DeliveryCheckRequest): DeliveryCheckResult {
  // 1. Caller validation: must be an identified actor
  if (!request.callerPrincipalId || request.callerPrincipalId.trim() === "") {
    return {
      allowed: false,
      reason: "caller_required",
    };
  }

  // 2. Audience validation: default deny on empty or invalid audience
  if (
    !request.audience ||
    !request.audience.destinationScopeKey ||
    !Array.isArray(request.audience.allowedPrincipals) ||
    request.audience.allowedPrincipals.length === 0
  ) {
    return {
      allowed: false,
      reason: "empty_audience",
    };
  }

  // 3. Visibility validation
  if (request.resourceVisibility === "private") {
    // Private resources cannot be delivered to group audiences
    if (request.audience.kind === "group") {
      return {
        allowed: false,
        reason: "private_group_delivery_denied",
      };
    }

    // Private resources must have an identifiable owner
    if (!request.resourceOwnerId || request.resourceOwnerId.trim() === "") {
      return {
        allowed: false,
        reason: "private_owner_missing",
      };
    }

    // ALL recipients in the audience must be authorized for this private resource:
    // audience.allowedPrincipals ⊆ authorizedPrincipals
    const authorized = new Set<string>();
    authorized.add(request.resourceOwnerId);
    if (request.authorizedRecipientIds) {
      for (const id of request.authorizedRecipientIds) {
        if (id) authorized.add(id);
      }
    }

    const allAuthorized = request.audience.allowedPrincipals.every((recipient) =>
      authorized.has(recipient),
    );

    if (!allAuthorized) {
      return {
        allowed: false,
        reason: "private_audience_mismatch",
      };
    }

    return {
      allowed: true,
      reason: "delivery_allowed",
    };
  }

  if (request.resourceVisibility === "public") {
    return {
      allowed: true,
      reason: "delivery_allowed",
    };
  }

  return {
    allowed: false,
    reason: "unsupported_visibility",
  };
}
