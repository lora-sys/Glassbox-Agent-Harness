# Upstream Source Reuse: Platform Runtime

## Upstream Repository

- Repository: `pingdotgg/t3code` (`https://github.com/pingdotgg/t3code`)
- Pinned commit SHA: `4a4c6dd2adc350a68ba18bb28b24b5a7e4660dab`
- Upstream license: MIT (see `LICENSE` in this directory)

## Upstream Files

- `packages/shared/src/shell.ts`
- `apps/server/src/provider/Drivers/ClaudeExecutable.ts`
- `apps/server/src/provider/Drivers/ClaudeHome.ts`

## Local Glassbox Adaptations

- **`apps/server/src/platform/executable.ts`**:
  - Direct implementation of `escapeWindowsShellArg` and `sanitizeShellModeArgsForPlatform` for cmd-safe argv quoting without shell command string interpolation.
  - Portable candidate generation with `%PATH%` and `%PATHEXT%` resolution.
  - Traversal of npm launcher shims (`.cmd`, `.bat`, `.ps1`) to native package entries (`bin/claude.exe` or `cli.js`) for the Claude Agent SDK. If a shim is unsupported or cannot be resolved to a package entry, resolution fails clearly (returning `undefined`) rather than handing an unspawnable script to the SDK.
  - Native package entry discovery for Codex (`@openai/codex` native `codex.exe` or `process.execPath` + `codex.js` with `shell: false`).
  - Strict preservation of explicit configured binary paths without silent fallback.
- **`apps/server/src/platform/paths.ts`**:
  - Dynamic Glassbox repository root discovery without hardcoded developer paths.
  - Canonical realpath containment checks with case-insensitivity on Windows and strict exclusion of repository root and internal `.glassbox` data paths.
  - Proper path containment logic distinguishing nested directories (e.g. child named `..data`) from parent traversal.
- **`apps/server/src/platform/git.ts`**:
  - Pure ESM child_process execution using `execFileSync` with argv arrays (`git diff -- <path>`, `git ls-files -s`) avoiding shell interpolation and CommonJS `require()`.
