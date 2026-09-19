# Conversation source record

Conversation routing uses the OpenHarness adaptation documented in ../identity/SOURCES.md. Transactional SQL writes, conflict handling and typed row mapping adapt trajectory-panel as documented in ../persistence/SOURCES.md. Those adjacent directories preserve the corresponding upstream MIT licenses and pinned commits.

store.ts and lifecycle.ts add Glassbox-specific Principal checks, full-scope isolation, ingress deduplication, Run queue intent, guarded transitions, delivery outcome persistence, and bounded queries. No upstream trust model or in-memory deduplication is used as a security or durability guarantee.

An identity binding never transfers a previous Principal's Conversation. Group and private scopes never share a Provider Session. The domain API exposes no unfiltered channel-facing get-by-ID operation.
