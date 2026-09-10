# upstream/t3-code — Vendored reference

**Source project:** T3 Code

**Source repository:** `pingdotgg/t3code`

**Reference commit:** `78f462c4`

**License:** MIT

**License file:** `./LICENSE`

**Why vendored:** Glassbox needed a proven Claude Code integration reference for headless Agent SDK execution, permission mapping, session resume, executable discovery, configuration isolation, and event normalization.

## Files

| File | Reference purpose |
| --- | --- |
| `ClaudeAdapter.ts` | Agent SDK session lifecycle, per-request tool permission decisions, event normalization, resume |
| `ClaudeDriver.ts` | Adapter wiring, capability probing, executable and configuration integration |
| `ClaudeProvider.ts` | Provider capability and model handling |
| `ClaudeTextGeneration.ts` | Structured subprocess generation patterns |
| `ClaudeHome.ts` | `CLAUDE_CONFIG_DIR` isolation without replacing the user's HOME |
| `ClaudeExecutable.ts` | Claude CLI executable discovery |
| `ClaudeSkills.ts` | Skill discovery patterns |

## Proven patterns worth consulting

### Per-request permission control

T3 Code uses the Claude Agent SDK `CanUseTool` callback so individual tool requests can be allowed or denied at runtime.

Glassbox can borrow that provider-level mechanism, but provider permission is not a replacement for Glassbox authorization.

The effective Glassbox rule remains:

```text
Principal
  ↓
Glassbox Authorization
  ↓
Delegated Provider Grant
  ↓
Provider-native permission callback
```

### Session resume

The adapter preserves native Claude resume state instead of pretending all providers resume identically.

Keep provider-specific resume details inside the provider integration boundary.

### Configuration isolation

Use `CLAUDE_CONFIG_DIR` when provider-local configuration needs isolation. Do not replace HOME merely to scope one provider if doing so breaks normal credentials or platform behavior.

### Workspace scoping

Provider filesystem access should be explicit and bounded to the task workspace and specifically granted extra directories.

Plan 03 adds a stricter rule above this: an allowed provider path still cannot exceed the current Principal's Glassbox authorization.

## Vendoring rules

These files are reference material. Production code must not import from `upstream/`.

When copying a substantial implementation into production:

- preserve the relevant MIT copyright and license notice
- record the source file and reference commit in the implementation or nearby documentation
- adapt the trust model to Glassbox rather than inheriting upstream defaults
- copy only the mechanism needed by the current plan

The MIT license text for this vendored source is preserved in `upstream/t3-code/LICENSE`.