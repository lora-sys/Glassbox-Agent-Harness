# Channel configuration sources

`channel-profiles.ts` adapts the existing Glassbox `model-profiles.ts` profile projection, credential-slot boundary and serialized atomic file-write mechanism. It does not import the model store or upstream framework.

The original reference is HKUDS/OpenHarness at commit `9b2efd795c6aa09f88b0c257d269a9e518da6ae7`.

- `src/openharness/config/settings.py`, named configuration profiles.
- `src/openharness/utils/fs.py`, `atomic_write_bytes`.

These references are MIT licensed. The original notice is preserved in `LICENSE.openharness` in this directory. The source was adapted from Python behavior into TypeScript, not copied byte for byte.

Channel-specific changes include the owned `parseOneBotConfig` validator, loopback-only management input, independent credential slots for every connection, strict input field allowlists, explicit restart intent, and a public projection that never includes tokens or credential-slot names. Replacing an endpoint origin requires replacing or clearing the token. Token replacement and all other writes prune orphan credentials before validating the next file. Credential lookup does not inspect process environment, QQ messages or global application state.

`channels.json` is written through a same-directory temporary file, flush and atomic rename. A single store instance serializes saves and auto-connect intent changes. Corrupt files fail closed and remain unchanged. The store does not claim cross-process write coordination or Windows ACL enforcement through POSIX modes. The server must own the data directory exclusively.

The store only owns persisted configuration. Public connection state defaults to `disconnected`. The runtime supplies current connection state and fixed safe error messages. The runtime must authorize management requests, reject configuration changes while connecting or connected, and check execution support and token availability before connecting. Saving a configuration does not bind arbitrary inbound identities or start the adapter.

The management client reuses the owned management request helper and form layout. Its shared contract is `packages/contracts/src/channels.ts`. Browser drafts never receive saved tokens, and saving, connecting and disconnecting use separate API actions. No NapCat or SnowLuma source was copied.
