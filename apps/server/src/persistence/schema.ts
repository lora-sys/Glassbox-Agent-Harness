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

// SQL batch/index pattern adapted from trajectory-panel. See SOURCES.md.
export const schema = [
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
  `CREATE TABLE deliveries (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), dedup_key TEXT NOT NULL, destination_scope_key TEXT NOT NULL, payload_text TEXT NOT NULL, payload_kind TEXT NOT NULL CHECK(payload_kind IN ('text','result','ack')), status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','failed','unknown')), external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(run_id, dedup_key))`,
  `CREATE TABLE authorization_decisions (id TEXT PRIMARY KEY, principal_id TEXT, resource_id TEXT NOT NULL, action TEXT NOT NULL, scope_key TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('ALLOW','DENY','REQUIRES_APPROVAL')), reason TEXT NOT NULL, grant_id TEXT, approval_id TEXT, conversation_id TEXT REFERENCES conversations(id), run_id TEXT REFERENCES runs(id), created_at TEXT NOT NULL)`,
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
  ...schemaV7Statements,
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
