# upstream/t3-code — Vendored Files

**Source project:** T3 Code (pingdotgg/t3code)
**Repo URL:** https://github.com/pingdotgg/t3code
**Commit:** `78f462c4` (2026-08-30)
**License:** See upstream/LICENSE (from the T3 Code project)
**Why vendored:** Glassbox is adding a Claude Code adapter. These files show the proven patterns for driving Claude Code headlessly via the Agent SDK and CLI, including permission mapping, session resume, and event normalization.

## What each file is

| File | Lines | Role |
|---|---|---|
| `ClaudeAdapter.ts` | 4735 | **Core adapter.** Wraps `@anthropic-ai/claude-agent-sdk` `query()` sessions, implements `CanUseTool` callback for per-request permission decisions, normalizes SDK messages to canonical runtime events, handles session resume via `resume`/`resumeSessionAt`. This is the primary file to read when implementing Glassbox's Claude adapter. |
| `ClaudeDriver.ts` | 240 | **Provider driver.** Wires adapter, snapshot, and text generation together. Shows how to resolve the Claude binary path, create per-instance configurations, keyed capability probes, and maintenance resolvers. |
| `ClaudeProvider.ts` | 1021 | **Provider layer.** Defines the Claude model catalog (Fable 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6), capability probing, model resolution (`resolveClaudeApiModelId`), effort normalization, and text generation helpers. |
| `ClaudeTextGeneration.ts` | 368 | **CLI subprocess text generation.** Shows how to spawn `claude -p --output-format json --json-schema ... --dangerously-skip-permissions` for structured output (commit messages, PR titles, branch names). Uses `ChildProcess.make()` with piped stdin. |
| `ClaudeHome.ts` | 52 | **Config directory isolation.** Shows how to set `CLAUDE_CONFIG_DIR` env var (rather than overriding HOME) to isolate Claude's per-instance configuration. This is the key pattern for scoping Claude to one project context. |
| `ClaudeExecutable.ts` | 90 | **Binary resolution.** Resolves the `claude` CLI binary path, including Windows npm shim following. The SDK needs an absolute path (no PATH resolution); this file shows how to find it. |
| `ClaudeSkills.ts` | 155 | **Skill discovery.** Discovers Claude Code skills from the binary's filesystem for the provider capability list. Not directly needed for Glassbox but shows how skills are surfaced. |

## Key patterns to copy (proven by T3 Code)

### Per-request permission control (CanUseTool callback)
```typescript
// From ClaudeAdapter.ts ~line 4237
const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
  runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));
```
The `CanUseTool` callback receives each tool request; returning `{ behavior: "allow" }` or `{ behavior: "deny" }` is the per-request approval mechanism.

### Permission mode mapping
```typescript
// From ClaudeAdapter.ts ~line 4268
const runtimeModeToPermission: Record<string, PermissionMode> = {
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions",
};
```

### Session resume state
```typescript
// From ClaudeAdapter.ts ~line 683
interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;           // session UUID to resume
  readonly resumeSessionAt?: string;  // last assistant UUID for re-entry point
  readonly turnCount?: number;
}
```

### Config isolation without keychain breakage
```typescript
// From ClaudeHome.ts
CLAUDE_CONFIG_DIR: resolvedHomePath,  // set in env, NOT overriding HOME
```

### Scoping writes to one repo
```typescript
// From ClaudeAdapter.ts ~line 4291
const queryOptions: ClaudeQueryOptions = {
  cwd: input.cwd,                                    // working directory
  additionalDirectories: [input.cwd, attachmentsDir], // explicit access grants
  // No --allowedTools needed — CanUseTool handles per-request decisions
};
```

### Add to system prompt after existing instructions
```typescript
// Set before query()
queryOptions.systemPrompt = { type: "preset", preset: "claude_code" };
// Research input injection: append to the prompt text itself on each turn
```

## Dependencies to ignore

T3 Code uses Effect (`effect` npm package), `@anthropic-ai/claude-agent-sdk`, and internal packages (`@t3tools/contracts`, `@t3tools/shared`). Glassbox should only import `@anthropic-ai/claude-agent-sdk` at runtime.
