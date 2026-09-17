import { AuthorizationService } from "../auth/service.js";
import { ConversationStore } from "../conversation/store.js";
import { LifecycleStore } from "../conversation/lifecycle.js";
import { IdentityService } from "../identity/service.js";
import { DomainDatabase } from "./database.js";
import { EvidenceStore } from "./evidence.js";
import { OwnerManagementRecords } from "../management/records.js";
import { TaskStore } from "../ops/task-store.js";

export async function openDomainStore(options: { databasePath: string }) {
  const db = await DomainDatabase.open(options.databasePath);
  return {
    identities: new IdentityService(db),
    authorization: new AuthorizationService(db),
    conversations: new ConversationStore(db),
    lifecycle: new LifecycleStore(db),
    evidence: new EvidenceStore(db),
    management: new OwnerManagementRecords(db),
    tasks: new TaskStore(db),
    close: () => db.close(),
  };
}

export type DomainStore = Awaited<ReturnType<typeof openDomainStore>>;
export type { CallerContext, TrustedChannelScope } from "../identity/scope.js";
export { scopeKey } from "../identity/scope.js";
export { agentResourceId } from "../conversation/store.js";
export { AccessDeniedError } from "../auth/service.js";
