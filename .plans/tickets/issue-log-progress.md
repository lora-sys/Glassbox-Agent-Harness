# Task: issue status — log S0-S6 progress to the Notion roadmap (append-only, no repo file changes)

Glassbox slices S0-S6 are committed (4 commits on main, not pushed). Log progress to the Notion roadmap so the issue tracker is current. This is a recording task; do not modify any repo source file.

## Roadmap DB
- Database id: 86a70420-86dd-4498-9fc7-f36563b8afa4
- Data source id: 21369151-e36a-4d6f-9a30-c67b12799464

## What to record
Done: S0 (P0.2 toolchain facts), S1 (P0.3 codex spike), S2 runtime skeleton, S3 web skeleton, S4 objects + inspector, S5 reload/persistence, S6 steering. Open: token usage in turn/completed, secret screening, S7 editable object, S8 demo. Commits: b63add2, ccc1a7b, ec92e7d, 76b0c61 on main, not pushed.

## Rules (strict)
- Notion writes are append-only. Do NOT destroy existing content.
- If you update a database row status property, back it up first (read the row, save id/title/status/slice to .plans/findings/_notion-roadmap-backup.md), then update only the status property; never overwrite text content of a row.
- Always preserve all existing content. Never use a destructive pages edit on content.
- Read /home/lora/.agents/skills/notion/SKILL.md first if you need ntn usage. If `ntn whoami` fails, stop and say so.

## Steps
1. Query the roadmap DB with ntn to list rows: page id, title, current status, slice label.
2. Backup current rows to .plans/findings/_notion-roadmap-backup.md before any write.
3. Update the status of rows matching S0, S1, S2, S3, S4, S5, S6 to the DB's completed value. If the DB uses a different status vocabulary, map "done" to the closest completed value and record the mapping in the backup file.
4. If a status property update is not possible or risks content, instead append a clearly dated progress entry to the "04 Delivery" page id 3c391e14-dbed-81f6-99f1-f494024298e0 using the children PATCH append-only method, listing S0-S6 done with the commit hashes and open items.
5. Do not touch any other Notion page. Do not push git. Do not modify repo source files (the backup file under .plans/findings/ is the only allowed write).

## When done
Print: the DB row statuses before and after (or the appended progress entry), the backup file path, and confirm no destructive edit happened.
