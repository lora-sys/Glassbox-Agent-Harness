# Workspace artifact fallback snapshots

Audit DATA04/DATA05. Seven of ten initial disposable Git/adapter cases failed before repair: empty repositories, additions/deletions, mixed staged and unstaged work, Chinese path quoting, and pre-existing dirty content incorrectly reported as this turn's work. Fixtures use git init/add only and no commits or provider processes.

The fallback now captures actual worktree content hashes before a turn and compares the union of before/after visible paths. Git's index is used only to enumerate tracked paths alongside untracked, non-ignored paths with NUL-delimited output. Empty workspaces remain a valid baseline. Both Codex and Claude adapters use the same helper. A baseline is bound to its canonical workspace in memory and cannot be compared to another directory.

Content previews compare captured before/after UTF-8 text rather than an index-to-worktree diff. Pre-existing edits disappear from zero-write turns; a later change starts from that actual dirty content. Chinese names, spaces, quotes and leading dashes retain their real paths; POSIX-only newline/tab/backslash names have additional coverage. Rename observations are represented as deletion plus addition, without guessing file identity. Binary files get hashes but no text preview. Credential-like paths (.env variants, package credentials, private key containers and .ssh/.aws files) likewise get no content preview; this filename guard is not a complete secret detector.

The scan is read-only: no index/object writes, no commit and no shell command interpolation. A Git hook's ambient directory/index variables cannot redirect the scan, and the scanner disables external fsmonitor hooks for its enumeration. Ignored additions are excluded; previously captured paths are rechecked even when a changed ignore rule omits them from the next enumeration. Directory symlinks/junctions are not traversed; a final symlink's target text can be recorded, never its target bytes. Hard-linked regular files and unstable reads are treated as unknown. Open-file identity and workspace identity are rechecked around capture.

## Bounds and interpretation

- Maximum 5,000 paths and 4 MiB Git enumeration output
- At most 8 MiB per regular file and 128 MiB total hashed per scan, with 64 KiB read buffers
- At most 64 KiB text per file and 4 MiB text retained per snapshot
- At most 2,048 characters in a review diff preview; clipping is explicitly marked
- Unreadable, unstable, oversized or over-budget paths are unknown and omitted, never invented as deletions

This remains a bounded fallback, not a complete filesystem journal. No-result output does not certify that an oversized or unreadable workspace had no changes. A newly visible untracked path means newly observed within Git's current inclusion rules. Concurrent user or other-process edits in the same time window cannot be attributed to a particular actor; the artifact records only observed differences. It does not retroactively repair existing artifact history or implement atomic hostile-filesystem race protection.

Changed-file lint/types pass. Focused Git/platform/Claude adapter coverage passes 65 tests, including actual Codex and Claude snapshot lifecycles, safe cleanup of disposable repositories, binary and size bounds, index-byte preservation and an external-parent-junction test. Aggregate gates remain pending.
