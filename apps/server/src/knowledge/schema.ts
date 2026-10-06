/** Statements exported for the root schema migration to compose. */
export const knowledgeSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS website_knowledge_articles (canonical_url TEXT PRIMARY KEY, current_digest TEXT NOT NULL, current_resource_id TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS website_knowledge_article_versions (digest TEXT PRIMARY KEY, canonical_url TEXT NOT NULL, title TEXT NOT NULL, published_at TEXT, language TEXT, body TEXT NOT NULL, fetched_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS website_knowledge_version_url ON website_knowledge_article_versions(canonical_url, fetched_at)`,
  `CREATE TABLE IF NOT EXISTS website_knowledge_syncs (site_id TEXT PRIMARY KEY, completed_at TEXT NOT NULL, article_count INTEGER NOT NULL CHECK(article_count >= 0), source_digest TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS website_knowledge_sync_policy (site_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), owner_principal_id TEXT NOT NULL, scope_json TEXT NOT NULL, next_attempt_at TEXT NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0), updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS website_knowledge_sync_events (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, actor_principal_id TEXT NOT NULL, action TEXT NOT NULL, run_id TEXT, status TEXT NOT NULL CHECK(status IN ('succeeded','failed','denied','enabled','disabled')), occurred_at TEXT NOT NULL, article_count INTEGER, inserted_count INTEGER, updated_count INTEGER, removed_count INTEGER, source_digest TEXT, failure_code TEXT)`,
  `CREATE INDEX IF NOT EXISTS website_knowledge_sync_events_page ON website_knowledge_sync_events(site_id, occurred_at DESC, id)`,
  `CREATE TRIGGER IF NOT EXISTS website_knowledge_sync_events_no_update BEFORE UPDATE ON website_knowledge_sync_events BEGIN SELECT RAISE(ABORT, 'website_knowledge_sync_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS website_knowledge_sync_events_no_delete BEFORE DELETE ON website_knowledge_sync_events BEGIN SELECT RAISE(ABORT, 'website_knowledge_sync_events are append-only'); END`,
] as const;
