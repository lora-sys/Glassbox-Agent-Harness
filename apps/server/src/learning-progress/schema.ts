/** Parent schema integration should append these statements as a versioned migration. */
export const learningProgressSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS learning_progress_records (
    id TEXT PRIMARY KEY,
    person_key TEXT NOT NULL,
    principal_id TEXT NOT NULL REFERENCES principals(id),
    kind TEXT NOT NULL CHECK(kind IN ('goal','milestone','question_cue')),
    state TEXT NOT NULL CHECK(state IN ('observed','confirmed','deleted')),
    statement TEXT NOT NULL,
    confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
    connection_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    source_chat_type TEXT NOT NULL CHECK(source_chat_type IN ('private','group')),
    source_chat_id TEXT NOT NULL,
    source_scope_json TEXT NOT NULL,
    source_scope_key TEXT NOT NULL,
    source_run_id TEXT NOT NULL REFERENCES runs(id),
    source_message_id TEXT NOT NULL REFERENCES messages(id),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
    occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS learning_progress_person ON learning_progress_records(person_key,state,created_at,id)`,
  `CREATE INDEX IF NOT EXISTS learning_progress_source ON learning_progress_records(source_run_id,source_message_id)`,
  `CREATE TABLE IF NOT EXISTS learning_progress_audit (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    person_key TEXT NOT NULL,
    principal_id TEXT NOT NULL REFERENCES principals(id),
    action TEXT NOT NULL CHECK(action IN ('capture','read','correct','delete','confirm')),
    target_id TEXT NOT NULL,
    decision_id TEXT NOT NULL REFERENCES authorization_decisions(id),
    conversation_id TEXT REFERENCES conversations(id),
    run_id TEXT REFERENCES runs(id),
    created_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS learning_progress_audit_no_update
    BEFORE UPDATE ON learning_progress_audit
    BEGIN SELECT RAISE(ABORT, 'learning_progress_audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS learning_progress_audit_no_delete
    BEFORE DELETE ON learning_progress_audit
    BEGIN SELECT RAISE(ABORT, 'learning_progress_audit is append-only'); END`,
] as const;
