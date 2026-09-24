import { AuthorizationService } from "../auth/service.js";
import { ConversationStore } from "../conversation/store.js";
import { LifecycleStore } from "../conversation/lifecycle.js";
import { IdentityService } from "../identity/service.js";
import { DomainDatabase } from "../persistence/database.js";
import { EvidenceStore } from "../persistence/evidence.js";
import { OwnerManagementRecords } from "../management/records.js";
import { CapabilityPolicyStore } from "../management/capability-policy.js";
import { TaskStore } from "../ops/task-store.js";
import { LearningStore } from "../learning/store.js";

/**
 * Composition root for the stores shared by server application workflows.
 * Product domains own each store; this module only wires their dependencies and lifecycle.
 */
export async function openDomainStore(options: { databasePath: string }) {
  const db = await DomainDatabase.open(options.databasePath);
  const authorization = new AuthorizationService(db);
  return {
    db,
    identities: new IdentityService(db),
    authorization,
    conversations: new ConversationStore(db),
    lifecycle: new LifecycleStore(db),
    evidence: new EvidenceStore(db),
    management: new OwnerManagementRecords(db),
    capabilities: new CapabilityPolicyStore(db),
    tasks: new TaskStore(db),
    learning: new LearningStore(db, authorization),
    close: () => db.close(),
  };
}

export type DomainStore = Awaited<ReturnType<typeof openDomainStore>>;
