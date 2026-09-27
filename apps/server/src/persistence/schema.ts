import type { Transaction } from "@libsql/client";
import { conversationScopeKey } from "../identity/scope.js";

function persistedText(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid migration record");
  return value;
}

// P4B: separate durable Channel history / retrieval source. Not Agent Run input.
// channel_messages stays durable truth; channel_messages_fts is a derived lexical
// projection. The FTS5 index DDL and the unicode61 tokenizer choice are ported from
// TokenRhythm/opensquilla src/opensquilla/memory/store.py (Apache-2.0, pinned commit
// 75a7085960ee57bc7a17acde5ce08071af4e7632). group_capability_policies is the durable
// Owner-configured per-group capability policy.
export const schemaV7Statements = [
  `CREATE TABLE IF NOT EXISTS channel_messages (id TEXT PRIMARY KEY, channel TEXT NOT NULL, connection_id TEXT NOT NULL, group_id TEXT NOT NULL, external_message_id TEXT NOT NULL, sender_id TEXT NOT NULL, normalized_text TEXT NOT NULL, source_class TEXT NOT NULL DEFAULT 'history', occurred_at TEXT NOT NULL, ingested_at TEXT NOT NULL, resource_id TEXT NOT NULL REFERENCES resources(id), dedup_key TEXT NOT NULL UNIQUE)`,
  `CREATE INDEX IF NOT EXISTS channel_messages_group_time ON channel_messages(group_id, source_class, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS channel_messages_resource ON channel_messages(resource_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS channel_messages_fts USING fts5(segment, id UNINDEXED, group_id UNINDEXED, tokenize='unicode61')`,
  `CREATE TABLE IF NOT EXISTS group_capability_policies (connection_id TEXT NOT NULL, group_id TEXT NOT NULL, policy_json TEXT NOT NULL, version INTEGER NOT NULL CHECK(version >= 1), updated_by_principal_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (connection_id, group_id))`,
];

export const schemaV7Migration = [...schemaV7Statements];

export const schemaV8Migration = [
  `ALTER TABLE channel_messages ADD COLUMN sender_name TEXT`,
  `ALTER TABLE channel_messages ADD COLUMN mention_target_ids_json TEXT NOT NULL DEFAULT '[]'`,
];

// SQL batch/index pattern adapted from trajectory-panel. See SOURCES.md.
export const baseSchema = [
  `CREATE TABLE agents (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`,
  `CREATE TABLE principals (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('owner','visitor')), created_at TEXT NOT NULL)`,
  `CREATE TABLE channel_identities (identity_key TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), created_at TEXT NOT NULL)`,
  `CREATE TABLE resources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('public','private')), owner_id TEXT REFERENCES principals(id))`,
  `CREATE TABLE grants (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), resource_id TEXT NOT NULL REFERENCES resources(id), action TEXT NOT NULL, scope_key TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('allow','approval')), revoked_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX grant_lookup ON grants(principal_id, resource_id, action, scope_key) WHERE revoked_at IS NULL`,
  `CREATE TABLE approvals (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id), approver_id TEXT NOT NULL REFERENCES principals(id), principal_id TEXT NOT NULL REFERENCES principals(id), resource_id TEXT NOT NULL REFERENCES resources(id), action TEXT NOT NULL, scope_key TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE conversations (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), principal_id TEXT NOT NULL REFERENCES principals(id), scope_key TEXT NOT NULL, scope_json TEXT NOT NULL, resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id), provider_kind TEXT, provider_session_id TEXT, provider_session_principal_id TEXT REFERENCES principals(id), created_at TEXT NOT NULL, UNIQUE(agent_id, scope_key), UNIQUE(provider_kind, provider_session_id))`,
  `CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), scope_key TEXT NOT NULL, external_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(scope_key, external_id))`,
  `CREATE TABLE runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), principal_id TEXT NOT NULL REFERENCES principals(id), scope_json TEXT NOT NULL, execution_ref TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','cancelling','cancelled','succeeded','failed','interrupted','unknown')), result_text TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX one_active_run_per_conversation ON runs(conversation_id) WHERE status IN ('running','cancelling')`,
  `CREATE INDEX runs_page ON runs(conversation_id, created_at, id)`,
  `CREATE INDEX runs_principal ON runs(principal_id, created_at, id)`,
  `CREATE INDEX conversations_page ON conversations(principal_id, scope_key, created_at, id)`,
  `CREATE TABLE deliveries (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), dedup_key TEXT NOT NULL, destination_scope_key TEXT NOT NULL, payload_text TEXT NOT NULL, payload_kind TEXT NOT NULL CHECK(payload_kind IN ('text','result','ack','browser_artifact','media_artifact')), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')), external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, dedup_key))`,
  `CREATE TABLE authorization_decisions (id TEXT PRIMARY KEY, principal_id TEXT, resource_id TEXT NOT NULL, action TEXT NOT NULL, scope_key TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('ALLOW','DENY','REQUIRES_APPROVAL')), reason TEXT NOT NULL, grant_id TEXT, approval_id TEXT, conversation_id TEXT REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), delivery_source TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX decisions_page ON authorization_decisions(principal_id, scope_key, created_at, id)`,
  `CREATE TABLE trace_cursors (run_id TEXT PRIMARY KEY REFERENCES runs(id), trace_ref TEXT NOT NULL, byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0), event_count INTEGER NOT NULL CHECK(event_count >= 0), updated_at TEXT NOT NULL)`,
  `CREATE TABLE eval_results (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), sample_id TEXT NOT NULL, scorer_version TEXT NOT NULL, trace_ref TEXT NOT NULL, trace_start INTEGER NOT NULL CHECK(trace_start >= 0), trace_end INTEGER NOT NULL CHECK(trace_end >= trace_start), expected TEXT NOT NULL, observed TEXT NOT NULL, passed INTEGER NOT NULL CHECK(passed IN (0,1)), input_tokens INTEGER CHECK(input_tokens >= 0), output_tokens INTEGER CHECK(output_tokens >= 0), duration_ms INTEGER CHECK(duration_ms >= 0), created_at TEXT NOT NULL)`,
  `CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL CHECK(status IN ('NEW','QUEUED','ASSIGNED','RUNNING','WAITING_INPUT','REVIEW','ACCEPTED','DONE','FAILED','CANCELED')), priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')), creator_principal_id TEXT NOT NULL REFERENCES principals(id), conversation_id TEXT REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), active_attempt_id TEXT, acceptance_criteria_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX tasks_status ON tasks(status, created_at)`,
  `CREATE TABLE task_attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_number INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','running','waiting_input','review','succeeded','failed','canceled')), rework_reason TEXT, started_at TEXT NOT NULL, completed_at TEXT, result_summary TEXT, UNIQUE(task_id, attempt_number))`,
  `CREATE TABLE worker_bindings (id TEXT PRIMARY KEY, task_attempt_id TEXT NOT NULL UNIQUE REFERENCES task_attempts(id), herdr_session TEXT NOT NULL, workspace_id TEXT NOT NULL, pane_id TEXT NOT NULL, tab_id TEXT, worktree_path TEXT, branch TEXT, agent_name TEXT, agent_kind TEXT NOT NULL, last_observed_agent_state TEXT NOT NULL CHECK(last_observed_agent_state IN ('starting','working','blocked','idle','done','unknown')), updated_at TEXT NOT NULL)`,
  `CREATE TABLE attention_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('unanswered_message','worker_blocked','approval_required','task_review','task_failed','delivery_failed','ops_connection_problem')), summary TEXT NOT NULL, principal_id TEXT REFERENCES principals(id), conversation_id TEXT REFERENCES conversations(id), task_id TEXT REFERENCES tasks(id), task_attempt_id TEXT REFERENCES task_attempts(id), created_at TEXT NOT NULL, resolved_at TEXT)`,
  `CREATE INDEX attention_items_kind ON attention_items(kind, resolved_at)`,
  `CREATE INDEX worker_bindings_lookup ON worker_bindings(pane_id, herdr_session, workspace_id, updated_at)`,
  `CREATE TABLE ops_trace_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, type TEXT NOT NULL, task_id TEXT, task_attempt_id TEXT, run_id TEXT, principal_id TEXT, data_json TEXT NOT NULL)`,
  `CREATE INDEX ops_trace_task_page ON ops_trace_events(task_id, sequence)`,
  `CREATE INDEX grant_lookup_active ON grants(principal_id, resource_id, action, scope_key, effect) WHERE revoked_at IS NULL`,
  `CREATE TABLE conversation_locations (agent_id TEXT NOT NULL REFERENCES agents(id), location_key TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), created_at TEXT NOT NULL, PRIMARY KEY (agent_id, location_key))`,
  `CREATE INDEX conversation_locations_conv ON conversation_locations(conversation_id)`,
  `ALTER TABLE tasks ADD COLUMN origin_scope_key TEXT`,
];

export const learningSchema = [
  `CREATE TABLE memory_candidates (id TEXT PRIMARY KEY, candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('assertion','confirmation','correction','derived')), subject_json TEXT NOT NULL, scope_json TEXT NOT NULL, proposed_type TEXT NOT NULL CHECK(proposed_type IN ('preference','semantic_fact','episodic_event','relationship')), statement TEXT NOT NULL, content_json TEXT NOT NULL, source_json TEXT NOT NULL, evidence_json TEXT NOT NULL, confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)), sensitivity TEXT, retention_policy TEXT, ttl_seconds INTEGER CHECK(ttl_seconds IS NULL OR ttl_seconds >= 0), merge_hint_json TEXT NOT NULL, extensions_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','promoted','rejected')), created_at TEXT NOT NULL, reviewed_at TEXT, promoted_memory_id TEXT)`,
  `CREATE INDEX memory_candidates_status ON memory_candidates(status, created_at, id)`,
  `CREATE TABLE memories (id TEXT PRIMARY KEY, subject_json TEXT NOT NULL, scope_json TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('preference','semantic_fact','episodic_event','relationship')), statement TEXT NOT NULL, content_json TEXT NOT NULL, source_json TEXT NOT NULL, confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)), sensitivity TEXT, retention_policy TEXT, ttl_seconds INTEGER CHECK(ttl_seconds IS NULL OR ttl_seconds >= 0), assertion_mode TEXT NOT NULL, asserted_by_json TEXT NOT NULL, confirmed_by_user INTEGER NOT NULL CHECK(confirmed_by_user IN (0,1)), evidence_json TEXT NOT NULL, derived_from_json TEXT NOT NULL, extensions_json TEXT NOT NULL, signature TEXT NOT NULL, lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('active','expired','revoked','retired')), expires_at TEXT, disabled_at TEXT, supersedes_json TEXT NOT NULL, use_count INTEGER NOT NULL DEFAULT 0 CHECK(use_count >= 0), last_used_at TEXT, retention_factors_json TEXT NOT NULL, retention_value REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX memories_active_signature ON memories(signature) WHERE lifecycle_state = 'active'`,
  `CREATE INDEX memories_scope_state ON memories(scope_json, lifecycle_state, updated_at, id)`,
  `CREATE TABLE feedback_events (id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), scope_json TEXT NOT NULL, signal_type TEXT NOT NULL CHECK(signal_type IN ('accept','reject','edit','revert','explicit_positive','explicit_negative')), statement TEXT NOT NULL, category TEXT, conversation_id TEXT REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), task_id TEXT REFERENCES tasks(id), artifact_ref TEXT, evidence_json TEXT NOT NULL, candidate_id TEXT NOT NULL REFERENCES memory_candidates(id), created_at TEXT NOT NULL)`,
  `CREATE INDEX feedback_candidate ON feedback_events(candidate_id, created_at, id)`,
  `CREATE TABLE memory_audit_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_id TEXT NOT NULL, principal_id TEXT NOT NULL REFERENCES principals(id), action TEXT NOT NULL CHECK(action IN ('write','read','update','expire','revoke','retire','supersede','promote','reject')), target_id TEXT NOT NULL, decision_id TEXT NOT NULL REFERENCES authorization_decisions(id), conversation_id TEXT REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), lineage_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX memory_audit_target ON memory_audit_events(target_id, sequence)`,
];

export const schemaV5Migration = ["ALTER TABLE tasks ADD COLUMN origin_scope_key TEXT"];

export const schemaV2Migration = [
  `CREATE INDEX IF NOT EXISTS worker_bindings_lookup ON worker_bindings(pane_id, herdr_session, workspace_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS ops_trace_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL, type TEXT NOT NULL, task_id TEXT, task_attempt_id TEXT, run_id TEXT, principal_id TEXT, data_json TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ops_trace_task_page ON ops_trace_events(task_id, sequence)`,
];

export const schemaV3Migration = [
  `CREATE INDEX IF NOT EXISTS grant_lookup_active ON grants(principal_id, resource_id, action, scope_key, effect) WHERE revoked_at IS NULL`,
];

export async function applySchemaV4Migration(tx: Transaction): Promise<void> {
  await tx.execute("DROP INDEX IF EXISTS one_active_grant");
  await tx.execute(
    "CREATE INDEX IF NOT EXISTS grant_lookup_active ON grants(principal_id, resource_id, action, scope_key, effect) WHERE revoked_at IS NULL",
  );

  const runColumns = await tx.execute("PRAGMA table_info(runs)");
  const colNames = new Set(runColumns.rows.map((r) => persistedText(r.name)));
  if (!colNames.has("principal_id")) {
    await tx.execute("ALTER TABLE runs ADD COLUMN principal_id TEXT REFERENCES principals(id)");
  }
  if (!colNames.has("scope_json")) {
    await tx.execute("ALTER TABLE runs ADD COLUMN scope_json TEXT");
  }
  await tx.execute(
    "UPDATE runs SET principal_id = (SELECT principal_id FROM conversations WHERE conversations.id = runs.conversation_id) WHERE principal_id IS NULL",
  );
  await tx.execute(
    "UPDATE runs SET scope_json = (SELECT scope_json FROM conversations WHERE conversations.id = runs.conversation_id) WHERE scope_json IS NULL",
  );
  await tx.execute(
    "CREATE INDEX IF NOT EXISTS runs_principal ON runs(principal_id, created_at, id)",
  );

  const convColumns = await tx.execute("PRAGMA table_info(conversations)");
  const convColNames = new Set(convColumns.rows.map((r) => persistedText(r.name)));
  if (!convColNames.has("provider_session_principal_id")) {
    await tx.execute(
      "ALTER TABLE conversations ADD COLUMN provider_session_principal_id TEXT REFERENCES principals(id)",
    );
  }
  await tx.execute(
    "UPDATE conversations SET provider_session_principal_id = principal_id WHERE provider_session_principal_id IS NULL AND provider_session_id IS NOT NULL",
  );

  await tx.execute(
    "CREATE TABLE IF NOT EXISTS conversation_locations (agent_id TEXT NOT NULL REFERENCES agents(id), location_key TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), created_at TEXT NOT NULL, PRIMARY KEY (agent_id, location_key))",
  );
  await tx.execute(
    "CREATE INDEX IF NOT EXISTS conversation_locations_conv ON conversation_locations(conversation_id)",
  );

  const convRows = await tx.execute(
    "SELECT id, agent_id, scope_key, scope_json, created_at FROM conversations ORDER BY created_at ASC, id ASC",
  );
  for (const row of convRows.rows) {
    const id = persistedText(row.id);
    const agentId = persistedText(row.agent_id);
    const createdAt = persistedText(row.created_at);
    let locationKey: string | null = null;
    try {
      const scope = JSON.parse(persistedText(row.scope_json));
      if (scope && typeof scope === "object" && scope.chatType) {
        locationKey = conversationScopeKey(scope);
      }
    } catch {
      // Ignore parse failure on invalid test fixture rows
    }
    if (!locationKey) {
      locationKey = persistedText(row.scope_key);
    }
    await tx.execute({
      sql: "INSERT OR IGNORE INTO conversation_locations(agent_id, location_key, conversation_id, created_at) VALUES (?, ?, ?, ?)",
      args: [agentId, locationKey, id, createdAt],
    });
  }
}

export const schemaV6Migration = ["DROP INDEX IF EXISTS one_owner"];

export const schemaV9Migration = learningSchema;

export const schemaV10Migration = [
  `CREATE TABLE deliveries_v10 (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), dedup_key TEXT NOT NULL, destination_scope_key TEXT NOT NULL, payload_text TEXT NOT NULL, payload_kind TEXT NOT NULL CHECK(payload_kind IN ('text','result','ack','browser_artifact')), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')), external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, dedup_key))`,
  `INSERT INTO deliveries_v10 SELECT id, run_id, dedup_key, destination_scope_key, payload_text, payload_kind, status, external_id, created_at, updated_at FROM deliveries`,
  `DROP TABLE deliveries`,
  `ALTER TABLE deliveries_v10 RENAME TO deliveries`,
];

export const schemaV11Migration = [
  `CREATE TABLE deliveries_v11 (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), dedup_key TEXT NOT NULL, destination_scope_key TEXT NOT NULL, payload_text TEXT NOT NULL, payload_kind TEXT NOT NULL CHECK(payload_kind IN ('text','result','ack','browser_artifact','media_artifact')), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')), external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, dedup_key))`,
  `INSERT INTO deliveries_v11 SELECT id, run_id, dedup_key, destination_scope_key, payload_text, payload_kind, status, external_id, created_at, updated_at FROM deliveries`,
  `DROP TABLE deliveries`,
  `ALTER TABLE deliveries_v11 RENAME TO deliveries`,
];

// P6 records extend the existing Task identity. The legacy columns and rows remain
// valid; a null step_id on an older TaskAttempt means the P3 whole-Task attempt.
export const schemaV12Migration = [
  `ALTER TABLE tasks ADD COLUMN origin_scope_json TEXT`,
  `ALTER TABLE tasks ADD COLUMN orchestration_mode TEXT NOT NULL DEFAULT 'legacy' CHECK(orchestration_mode IN ('legacy','durable'))`,
  `ALTER TABLE tasks ADD COLUMN current_phase TEXT`,
  `ALTER TABLE tasks ADD COLUMN root_step_id TEXT`,
  `ALTER TABLE tasks ADD COLUMN active_step_ids_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE tasks ADD COLUMN waiting_reason TEXT`,
  `ALTER TABLE tasks ADD COLUMN checkpoint_ref TEXT`,
  `ALTER TABLE tasks ADD COLUMN cancellation_state TEXT NOT NULL DEFAULT 'none' CHECK(cancellation_state IN ('none','requested','stopping','settled'))`,
  `ALTER TABLE tasks ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(policy_revision >= 1)`,
  `ALTER TABLE tasks ADD COLUMN completed_at TEXT`,
  `ALTER TABLE task_attempts ADD COLUMN step_id TEXT`,
  `CREATE TABLE task_steps (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL CHECK(kind IN ('model','tool','herdr_worker','timer_wait','signal_wait','approval_wait','child_task','join')), title TEXT NOT NULL, instructions TEXT, spec_ref TEXT, status TEXT NOT NULL CHECK(status IN ('pending','ready','running','waiting','blocked','review','succeeded','failed','cancelled','skipped')), dependency_policy_json TEXT NOT NULL, max_attempts INTEGER NOT NULL CHECK(max_attempts >= 1), timeout_ms INTEGER CHECK(timeout_ms IS NULL OR timeout_ms > 0), retry_policy_json TEXT, wait_policy_json TEXT, required_capabilities_json TEXT NOT NULL, delegated_permissions_json TEXT NOT NULL, checkpoint_ref TEXT, output_ref TEXT, version INTEGER NOT NULL CHECK(version >= 1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(task_id,id))`,
  `CREATE INDEX task_steps_status ON task_steps(task_id,status,created_at,id)`,
  `CREATE TABLE task_step_dependencies (task_id TEXT NOT NULL, step_id TEXT NOT NULL, dependency_id TEXT NOT NULL, PRIMARY KEY(task_id,step_id,dependency_id), FOREIGN KEY(task_id,step_id) REFERENCES task_steps(task_id,id), FOREIGN KEY(task_id,dependency_id) REFERENCES task_steps(task_id,id), CHECK(step_id <> dependency_id))`,
  `CREATE INDEX task_step_dependencies_reverse ON task_step_dependencies(task_id,dependency_id,step_id)`,
  `CREATE TABLE task_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id), step_id TEXT REFERENCES task_steps(id), attempt_id TEXT REFERENCES task_attempts(id), type TEXT NOT NULL, actor_principal_id TEXT REFERENCES principals(id), decision_id TEXT REFERENCES authorization_decisions(id), evidence_ref TEXT, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX task_events_page ON task_events(task_id,sequence)`,
  `CREATE TRIGGER task_events_no_update BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT,'task events are append only'); END`,
  `CREATE TRIGGER task_events_no_delete BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT,'task events are append only'); END`,
  `CREATE TABLE task_waits (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), step_id TEXT NOT NULL REFERENCES task_steps(id), attempt_id TEXT REFERENCES task_attempts(id), generation INTEGER NOT NULL CHECK(generation >= 1), kind TEXT NOT NULL CHECK(kind IN ('duration','until','deadline','signal','approval','retry')), status TEXT NOT NULL CHECK(status IN ('waiting','resumed','cancelled','stale')), started_at TEXT NOT NULL, due_at TEXT, signal_key TEXT, timeout_at TEXT, policy_json TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(step_id,generation))`,
  `CREATE INDEX task_waits_pending ON task_waits(status,due_at,task_id)`,
  `CREATE TABLE task_signals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), step_id TEXT NOT NULL REFERENCES task_steps(id), wait_id TEXT REFERENCES task_waits(id), target_step_version INTEGER NOT NULL CHECK(target_step_version >= 1), target_attempt_id TEXT REFERENCES task_attempts(id), signal_type TEXT NOT NULL, principal_id TEXT REFERENCES principals(id), source TEXT NOT NULL CHECK(source IN ('principal','trusted_system')), decision_id TEXT NOT NULL REFERENCES authorization_decisions(id), payload_ref TEXT, metadata_json TEXT NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('applied','duplicate','stale','denied')), idempotency_key TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(task_id,idempotency_key))`,
  `CREATE TABLE task_checkpoints (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), step_id TEXT REFERENCES task_steps(id), attempt_id TEXT REFERENCES task_attempts(id), checkpoint_type TEXT NOT NULL, state_ref TEXT NOT NULL, artifact_ref TEXT, evidence_ref TEXT NOT NULL, policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1), created_at TEXT NOT NULL)`,
  `CREATE INDEX task_checkpoints_latest ON task_checkpoints(task_id,step_id,created_at,id)`,
  `CREATE TRIGGER task_checkpoints_no_update BEFORE UPDATE ON task_checkpoints BEGIN SELECT RAISE(ABORT,'task checkpoints are append only'); END`,
  `CREATE TRIGGER task_checkpoints_no_delete BEFORE DELETE ON task_checkpoints BEGIN SELECT RAISE(ABORT,'task checkpoints are append only'); END`,
  `CREATE TABLE task_child_links (child_task_id TEXT PRIMARY KEY REFERENCES tasks(id), parent_task_id TEXT NOT NULL REFERENCES tasks(id), parent_step_id TEXT NOT NULL REFERENCES task_steps(id), delegated_permissions_json TEXT NOT NULL, acceptance_criteria_json TEXT NOT NULL, cancel_policy TEXT NOT NULL CHECK(cancel_policy IN ('cancel_child','keep_child')), failure_policy TEXT NOT NULL CHECK(failure_policy IN ('block_parent','fail_parent','review_parent')), result_ref TEXT, created_at TEXT NOT NULL, CHECK(child_task_id <> parent_task_id))`,
  `CREATE INDEX task_child_links_parent ON task_child_links(parent_task_id,parent_step_id)`,
  `CREATE TABLE task_workflow_bindings (task_id TEXT PRIMARY KEY REFERENCES tasks(id), workflow_id TEXT NOT NULL UNIQUE, run_id TEXT, backend TEXT NOT NULL CHECK(backend = 'temporal'), state TEXT NOT NULL CHECK(state IN ('starting','running','unavailable','closed')), policy_revision INTEGER NOT NULL CHECK(policy_revision >= 1), continuation INTEGER NOT NULL DEFAULT 0 CHECK(continuation >= 0), updated_at TEXT NOT NULL)`,
  `CREATE TABLE task_step_leases (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), step_id TEXT NOT NULL REFERENCES task_steps(id), attempt_id TEXT REFERENCES task_attempts(id), worker_binding_id TEXT REFERENCES worker_bindings(id), owner_instance_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','released','expired','quarantined')), version INTEGER NOT NULL CHECK(version >= 1), acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT NOT NULL, released_at TEXT)`,
  `CREATE UNIQUE INDEX task_step_one_active_lease ON task_step_leases(step_id) WHERE state = 'active'`,
  `CREATE INDEX task_step_leases_expiry ON task_step_leases(state,expires_at)`,
];

export const schemaV13Migration = [
  `ALTER TABLE runs ADD COLUMN source TEXT NOT NULL DEFAULT 'external' CHECK(source IN ('external','task_step'))`,
  `CREATE UNIQUE INDEX task_attempts_identity_task_step ON task_attempts(id,task_id,step_id)`,
  `CREATE TABLE task_attempt_runs (attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), task_id TEXT NOT NULL REFERENCES tasks(id), step_id TEXT NOT NULL, FOREIGN KEY(attempt_id,task_id,step_id) REFERENCES task_attempts(id,task_id,step_id), FOREIGN KEY(task_id,step_id) REFERENCES task_steps(task_id,id))`,
];

// P6 used schema version 11 for media Assets, while delivery reauthorization also
// introduced version 11 on the #24 branch. Version 14 upgrades databases created by
// either branch to the shared deliveries constraint without discarding existing rows.
export async function applySchemaV14Migration(tx: Transaction): Promise<void> {
  const table = await tx.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'deliveries'",
  );
  const ddl = table.rows[0]?.sql;
  if (typeof ddl !== "string" || ddl.includes("media_artifact")) return;
  await tx.batch([
    `CREATE TABLE deliveries_v14 (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), dedup_key TEXT NOT NULL, destination_scope_key TEXT NOT NULL, payload_text TEXT NOT NULL, payload_kind TEXT NOT NULL CHECK(payload_kind IN ('text','result','ack','browser_artifact','media_artifact')), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')), external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, dedup_key))`,
    `INSERT INTO deliveries_v14 SELECT id, run_id, dedup_key, destination_scope_key, payload_text, payload_kind, status, external_id, created_at, updated_at FROM deliveries`,
    `DROP TABLE deliveries`,
    `ALTER TABLE deliveries_v14 RENAME TO deliveries`,
  ]);
}

export const schemaV15Migration = [
  `ALTER TABLE worker_bindings ADD COLUMN prompt_dispatched_at TEXT`,
];

export const schemaV16Migration = [
  `CREATE TABLE IF NOT EXISTS task_notifications (id TEXT PRIMARY KEY, event_sequence INTEGER NOT NULL UNIQUE REFERENCES task_events(sequence), task_id TEXT NOT NULL REFERENCES tasks(id), origin_run_id TEXT NOT NULL REFERENCES runs(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), principal_id TEXT NOT NULL REFERENCES principals(id), destination_scope_key TEXT NOT NULL, destination_scope_json TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('STEP_BLOCKED','STEP_REVIEW','STEP_FAILED','TASK_BLOCKED','TASK_REVIEW','TASK_ACCEPTED','WORKER_LOST')), payload_text TEXT NOT NULL CHECK(length(payload_text) <= 2048), payload_kind TEXT NOT NULL CHECK(payload_kind = 'text'), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown','suppressed')), external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS task_notifications_pending ON task_notifications(status,event_sequence)`,
  `CREATE TRIGGER IF NOT EXISTS task_notifications_payload_immutable BEFORE UPDATE ON task_notifications WHEN NEW.event_sequence <> OLD.event_sequence OR NEW.task_id <> OLD.task_id OR NEW.origin_run_id <> OLD.origin_run_id OR NEW.conversation_id <> OLD.conversation_id OR NEW.principal_id <> OLD.principal_id OR NEW.destination_scope_key <> OLD.destination_scope_key OR NEW.destination_scope_json <> OLD.destination_scope_json OR NEW.event_type <> OLD.event_type OR NEW.payload_text <> OLD.payload_text OR NEW.payload_kind <> OLD.payload_kind OR NEW.created_at <> OLD.created_at BEGIN SELECT RAISE(ABORT,'task notification payload is immutable'); END`,
];

export const schemaV17Migration = [
  `CREATE TABLE IF NOT EXISTS worker_candidate_outputs (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, worker_binding_id TEXT NOT NULL REFERENCES worker_bindings(id), output_excerpt TEXT NOT NULL CHECK(length(CAST(output_excerpt AS BLOB)) <= 16384), output_sha256 TEXT NOT NULL CHECK(length(output_sha256) = 64), truncated INTEGER NOT NULL CHECK(truncated IN (0,1)), created_at TEXT NOT NULL, FOREIGN KEY(attempt_id,task_id,step_id) REFERENCES task_attempts(id,task_id,step_id), FOREIGN KEY(task_id,step_id) REFERENCES task_steps(task_id,id))`,
  `CREATE TRIGGER IF NOT EXISTS worker_candidate_outputs_no_update BEFORE UPDATE ON worker_candidate_outputs BEGIN SELECT RAISE(ABORT,'worker candidate outputs are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS worker_candidate_outputs_no_delete BEFORE DELETE ON worker_candidate_outputs BEGIN SELECT RAISE(ABORT,'worker candidate outputs are immutable'); END`,
];

export const schemaV18Migration = [
  `CREATE TABLE IF NOT EXISTS worker_file_artifacts (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, worker_binding_id TEXT NOT NULL REFERENCES worker_bindings(id), relative_path TEXT NOT NULL, content_text TEXT NOT NULL CHECK(length(CAST(content_text AS BLOB)) <= 262144), content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'), created_at TEXT NOT NULL, FOREIGN KEY(attempt_id,task_id,step_id) REFERENCES task_attempts(id,task_id,step_id))`,
  `CREATE TRIGGER IF NOT EXISTS worker_file_artifacts_no_update BEFORE UPDATE ON worker_file_artifacts BEGIN SELECT RAISE(ABORT,'worker file artifacts are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS worker_file_artifacts_no_delete BEFORE DELETE ON worker_file_artifacts BEGIN SELECT RAISE(ABORT,'worker file artifacts are immutable'); END`,
];

export const schemaV19Migration = [
  `ALTER TABLE task_steps ADD COLUMN operation_generation INTEGER NOT NULL DEFAULT 1 CHECK(operation_generation >= 1)`,
];

export async function applySchemaV19Migration(tx: Transaction): Promise<void> {
  const columns = await tx.execute("PRAGMA table_info(task_steps)");
  if (!columns.rows.some((row) => row.name === "operation_generation"))
    await tx.batch(schemaV19Migration);
}

export const schemaV20Migration = [
  `CREATE TABLE IF NOT EXISTS worker_launch_intents (attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, step_id TEXT NOT NULL, lease_id TEXT NOT NULL UNIQUE REFERENCES task_step_leases(id), owner_instance_id TEXT NOT NULL, step_version INTEGER NOT NULL CHECK(step_version >= 1), lease_version INTEGER NOT NULL CHECK(lease_version >= 1), herdr_session TEXT NOT NULL, workspace_id TEXT NOT NULL, agent_name TEXT NOT NULL UNIQUE, agent_kind TEXT NOT NULL, worktree_path TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(attempt_id,task_id,step_id) REFERENCES task_attempts(id,task_id,step_id), FOREIGN KEY(task_id,step_id) REFERENCES task_steps(task_id,id))`,
  `CREATE TRIGGER IF NOT EXISTS worker_launch_intents_no_update BEFORE UPDATE ON worker_launch_intents BEGIN SELECT RAISE(ABORT,'worker launch intents are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS worker_launch_intents_no_delete BEFORE DELETE ON worker_launch_intents BEGIN SELECT RAISE(ABORT,'worker launch intents are immutable'); END`,
];

export async function applySchemaV21Migration(tx: Transaction): Promise<void> {
  const childLinkColumns = await tx.execute("PRAGMA table_info(task_child_links)");
  if (!childLinkColumns.rows.some((row) => row.name === "parent_notification_policy"))
    await tx.execute(
      "ALTER TABLE task_child_links ADD COLUMN parent_notification_policy TEXT NOT NULL DEFAULT 'suppress' CHECK(parent_notification_policy IN ('suppress','notify_parent'))",
    );
  const notificationColumns = await tx.execute("PRAGMA table_info(task_notifications)");
  if (!notificationColumns.rows.some((row) => row.name === "routing_parent_task_id"))
    await tx.execute(
      "ALTER TABLE task_notifications ADD COLUMN routing_parent_task_id TEXT REFERENCES tasks(id)",
    );
  await tx.execute("DROP TRIGGER IF EXISTS task_notifications_payload_immutable");
  await tx.execute(
    `CREATE TRIGGER task_notifications_payload_immutable BEFORE UPDATE ON task_notifications WHEN NEW.event_sequence <> OLD.event_sequence OR NEW.task_id <> OLD.task_id OR NEW.origin_run_id <> OLD.origin_run_id OR NEW.conversation_id <> OLD.conversation_id OR NEW.principal_id <> OLD.principal_id OR NEW.destination_scope_key <> OLD.destination_scope_key OR NEW.destination_scope_json <> OLD.destination_scope_json OR NEW.event_type <> OLD.event_type OR NEW.payload_text <> OLD.payload_text OR NEW.payload_kind <> OLD.payload_kind OR NEW.routing_parent_task_id IS NOT OLD.routing_parent_task_id OR NEW.created_at <> OLD.created_at BEGIN SELECT RAISE(ABORT,'task notification payload is immutable'); END`,
  );
}

export const schema = [
  ...baseSchema,
  ...schemaV7Statements,
  ...schemaV8Migration,
  ...learningSchema,
  ...schemaV12Migration,
  ...schemaV13Migration,
];

// Existing ALLOW rows predate trusted execution-source markers. Preserve the old
// conservative delivery recheck for them, while new discovery decisions stay unmarked.
export async function applySchemaV11Migration(tx: Transaction): Promise<void> {
  const table = await tx.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'authorization_decisions'",
  );
  // Partial migration fixtures can carry an older user_version without the full product
  // schema. The production v10 schema always has this table.
  if (table.rows.length === 0) return;
  const columns = await tx.execute("PRAGMA table_info(authorization_decisions)");
  if (!columns.rows.some((row) => row.name === "delivery_source"))
    await tx.execute("ALTER TABLE authorization_decisions ADD COLUMN delivery_source TEXT");
  await tx.execute(
    "UPDATE authorization_decisions SET delivery_source = 'legacy_content_source' WHERE decision = 'ALLOW' AND (action = 'read' OR action LIKE '%:read' OR action LIKE '%:list' OR action LIKE '%:status') AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.id = authorization_decisions.resource_id AND r.kind = 'web-public')",
  );
  await tx.execute(
    "UPDATE authorization_decisions SET delivery_source = 'legacy_access_gate' WHERE decision = 'ALLOW' AND action LIKE '%:search' AND delivery_source IS NULL AND NOT EXISTS (SELECT 1 FROM resources r WHERE r.id = authorization_decisions.resource_id AND r.kind = 'web-public')",
  );
}
