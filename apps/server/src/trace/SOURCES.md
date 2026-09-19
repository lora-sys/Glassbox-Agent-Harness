# Trace source record

The secret screening patterns and incremental record parsing patterns in this directory are adapted from the following MIT source. Glassbox uses its own append-only domain schema, safe identifier validation, per-file serialization, and boundary-checked cursor pagination.

| Repository                 | Commit                                   | Original path         | Local use                                                                                                                    |
| -------------------------- | ---------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| joyehuang/trajectory-panel | ef3ac78f48523d0902e71bca896eae28e2324fe6 | daemon/lib/redact.js  | Secret screening patterns, token/key regular expressions, and bounded text truncation in redact.ts                           |
| joyehuang/trajectory-panel | ef3ac78f48523d0902e71bca896eae28e2324fe6 | daemon/lib/session.js | Line-by-line JSONL record handling concepts adapted into bounded chunked reader and indexed range inspection in run-store.ts |

The original MIT license is preserved in LICENSE.trajectory-panel. Glassbox never imports the reference checkout at runtime.

Local changes:

- Raw Trace is append-only evidence: trace files on disk are never deleted, truncated, or rewritten to "repair" corruption.
- Secret redaction is strictly applied to public projection views (e.g. `redactSecrets: true`); raw authorized evidence remains intact on disk.
- Safe identifier validation enforces strict path safety against traversal, absolute paths, illegal characters, and Windows reserved names before any filesystem operation.
- Per-file append serialization ensures concurrent writes to the same run trace are serialized while independent runs execute in parallel.
- Restart sequence recovery scans without O(N^2) full-history reads on every append.
- Record offset cursors enforce complete record boundaries and cannot cross runs or escape data directories.
- Exact indexed range inspection allows Eval validation without loading entire trace streams into memory.
