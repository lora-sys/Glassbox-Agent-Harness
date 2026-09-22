# P4A learning source provenance

## HKUDS/MGP

- Commit: `54ce6c00e3d0aa731ecbe17e74407cbbb5a96f10`
- License: MIT
- Paths: `schemas/memory-object.schema.json`, `schemas/memory-candidate.schema.json`, `schemas/memory-evidence.schema.json`, `schemas/memory-merge-hint.schema.json`, `schemas/audit-event.schema.json`, `spec/runtime-write-candidate.md`, `reference/gateway/semantics.py`, `compliance/dedupe/test_dedupe_upsert.py`
- Ported behavior: candidate-before-memory, candidate/evidence/merge contracts, deterministic dedupe, stable identity, upsert/replace/merge/reinforce behavior, lifecycle distinctions, lineage and audit records.
- Glassbox changes: MGP scope is mapped to explicit `global` / `project` extensions; Glassbox Principal, Authorization, Turso and Trace remain authoritative. The Python gateway and policy engine are not included.

## langchain-ai/langmem

- Commit: `9d033b47d9ce53e37e92c92241b0496c0278932e`
- License: MIT
- Path: `src/langmem/knowledge/extraction.py` and semantic/episodic extraction guides.
- Ported behavior: current messages and relevant existing memories are supplied together to an extractor which returns create/update/retire decisions.
- Glassbox changes: extractor output can only create a reviewable MGP-style candidate. LangGraph is not added and inference cannot directly mutate canonical memory.

## HKUDS/OpenHarness

- Commit: `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`
- License: MIT
- Paths: `src/openharness/memory/schema.py`, `manager.py`, `scan.py`, `usage.py`, `tests/test_memory/`.
- Ported behavior: normalized signature, duplicate detection, stable ID, TTL projection, disabled/inactive state, supersedes metadata, timestamps, freshness/usage metadata and atomic persistence.
- Glassbox changes: Turso tables replace file manifests and Glassbox lifecycle/authorization owns mutation.

## zhibao-dev/Learning-Multi-Factor-Memory

- Commit: `2d51bdf279cd837eed7d582bad2bde58caa74c61`
- License status: MIT metadata in `pyproject.toml`; no separately verified license file at review time.
- Paths: `borge/memory/value.py`, `borge/memory/forgetting.py`, `tests/test_memory_value.py`, `tests/test_forgetting_value.py`.
- Reused mechanism only: interpretable weighted memory value and value-resistant retention review score. No substantial source slice is vendored.
- Glassbox changes: automatic destructive forgetting is absent; retention produces metadata/review signals and never deletes Raw Trace or evidence.

## CommandCodeAI/command-code

- Commit: `5c8f1b48c9d6704210cb3f9a476fdcffe5093e9a`
- License status: unconfirmed; research reference only.
- Public reference: Taste accept/reject/edit behavior and separate user/project scopes.
- Reused product behavior: feedback becomes evidence on a scoped candidate; one edit is never active Taste and project Taste never becomes global implicitly. No source code is vendored.
