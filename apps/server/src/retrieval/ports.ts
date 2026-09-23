import type { QqSourceClass } from "@glassbox/contracts";
import type { AuthorizationDecision, AuthorizationRequest } from "../auth/service.js";
import type { DomainDatabase } from "../persistence/database.js";

/** The current authorization decision used by retrieval. */
export interface RetrievalAuthorizationPort {
  check(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}

/** The policy projection Retrieval reads; policy ownership remains in Management. */
export interface RetrievalCapabilityPolicy {
  memorySources?: Partial<Record<QqSourceClass, boolean>>;
}

export interface RetrievalCapabilityPolicyPort {
  read(
    connectionId: string,
    groupId: string,
  ): Promise<{ policy: RetrievalCapabilityPolicy } | undefined>;
}

/** A narrow adapter for the persistence and authorization behavior used by Retrieval. */
export interface RetrievalStorePort {
  db: DomainDatabase;
  authorization: RetrievalAuthorizationPort;
  capabilities: RetrievalCapabilityPolicyPort;
}
