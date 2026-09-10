# Web E2E

This directory contains browser regression tests from the earlier Coding Agent workbench plus future Glassbox browser tests.

## Important

These specs are not all portable smoke tests yet.

Several historical files were written during Plan 01 and Plan 02 and may assume:

- live Codex or Claude Code
- local credentials
- a pre-generated session or trace
- a controlled demo repository
- historical UI labels
- ports 3030 and 5173
- older machine-specific absolute paths

Do not run the whole directory as the default verification for every change.

## Plan 03 rule

New Personal Agent Foundation tests must be portable.

Do not add machine-specific paths such as `/data/lora/...`.

Resolve repository-relative fixtures from the test file or `process.cwd()` when a real filesystem path is required.

Prefer:

```text
Fake Channel
Fake Principal
Fake public/private Resource
Fake protected Tool
Disposable Turso database
```

Use a live Provider only when the behavior under test genuinely depends on that Provider.

## Authorization tests

New authorization-related browser tests should prove behavior through server truth, not UI hiding.

At minimum, when relevant, verify:

```text
Visitor can use public resource
Visitor cannot access Owner-private resource
private resource content never appears in model-visible output
revocation takes effect
approval does not create permission
protected Tool cannot be invoked through confused-deputy prompting
```

A hidden button is not proof of authorization.

## Existing historical specs

The `p*` and `s*` filenames correspond to earlier implementation phases. Keep them only while they still protect real behavior.

When a historical spec becomes redundant, impossible to run, or tied to removed product behavior, delete it instead of maintaining a fake green test.

If a historical spec is ported, remove absolute machine paths and document any remaining live-provider requirement in the file header.
