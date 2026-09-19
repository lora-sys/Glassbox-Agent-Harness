# Authorization boundary

This module implements the current Glassbox authorization rules. No OpenHarness permission policy or model prompt is copied as the trust boundary.

The database metadata and transaction mechanism are documented in ../persistence/SOURCES.md. Identity scope routing provenance is documented in ../identity/SOURCES.md.

Management must authenticate the caller before exposing resource registration, grants, revocation, approval or identity binding. Channel callers receive only the checks and scoped domain operations that the server explicitly exposes. Denial reasons are a fixed vocabulary. Every protected operation resolves the current identity and re-reads current grants.
