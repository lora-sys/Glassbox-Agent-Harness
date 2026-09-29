# Authorization decision rotation

For the local SQLite database, run a bounded rotation during a maintenance window. Choose the
retention cutoff explicitly; for example, a 90-day window:

```sh
npx tsx scripts/archive-auth-decisions.mts --database /path/to/glassbox.db --before 2026-06-30T00:00:00.000Z --output /secure/path/authorization-decisions.jsonl
```

The command moves older decisions in batches of at most 500 to
`authorization_decisions_archive`, then exports the archive to JSONL through a temporary file and
rename. A failed export leaves the database archive intact; rerun the command with the same cutoff
to regenerate the file. Each JSONL row includes its stable decision ID for deduplication. Secure
the exported file like the database because it contains principals, scopes, resources, and audit
metadata.

Decisions referenced by `memory_audit_events` stay in the live table to preserve the foreign key.
Decisions for a nonterminal Run also remain live. Historical decision lists, delivery checks, and
Run context reads query both live and archived rows. The archive remains in the same database until
an operator backs up and removes it under a separate retention policy; this rotation bounds the
hot decision table, not total database size.
