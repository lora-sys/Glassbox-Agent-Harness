# Configuration sources

`model-profiles.ts` adapts the named ProviderProfile fields and atomic file-write mechanism from HKUDS/OpenHarness, commit `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`.

Original paths:

- `src/openharness/config/settings.py`, ProviderProfile
- `src/openharness/utils/fs.py`, atomic_write_bytes

The source is MIT licensed. See `LICENSE.openharness` in this directory.

Glassbox changes Python models to TypeScript runtime validation, explicitly selects one of three model protocols, stores credentials through slots, and exposes a separate public profile view. It omits automatic provider detection, global credential discovery, memory, hooks, and shell execution. Writes use a same-directory temporary file, flush, and rename. This store serializes writes within one server instance. It does not claim coordination across multiple server processes or Windows ACL enforcement through POSIX file modes. The server must own its data directory exclusively.
