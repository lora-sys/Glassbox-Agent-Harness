# <PROJECT_NAME>

<ONE_LINE_DESCRIPTION>

<HOW_IT_WORKS_IN_ONE_OR_TWO_SENTENCES>

<!--
Before using this template:
- Replace every <PLACEHOLDER>.
- Delete sections that do not apply.
- Do not describe features, apps, providers, or deployment modes that do not exist yet.
- Keep fixed engineering rules unless this project has a concrete reason to change them.
-->

## What makes <PROJECT_NAME> special?

<!--
Write the few product or engineering rules that should change how code gets written.
Three to six is usually enough.
-->

### 1. <PRINCIPLE>

<WHAT_THIS_CHANGES_IN_PRACTICE>

### 2. <PRINCIPLE>

<WHAT_THIS_CHANGES_IN_PRACTICE>

### 3. <PRINCIPLE>

<WHAT_THIS_CHANGES_IN_PRACTICE>

## A small glossary

Use these terms consistently:

- **you** means the agent reading this file and changing <PROJECT_NAME>.
- **we**, **us**, and **maintainers** mean the people building and maintaining <PROJECT_NAME>.
- **user** means <WHO_USES_THE_PRODUCT>.
- **<TERM>** means <DEFINITION>.
- **<TERM>** means <DEFINITION>.
- **<TERM>** means <DEFINITION>.

<!--
Keep terms concrete. If two terms mean the same thing, pick one.
If a term does not affect code or product decisions, leave it out.
-->

Full glossary with file links: `<GLOSSARY_PATH>`

## The three ways to hurt yourself

<!--
Keep this section concrete. Name actions that can damage the repo, local machine, or real user data.
-->

1. **Killing by pattern.** Never kill a process just because its name, path, workspace, worktree, or project string matched. Kill only a PID you captured when you started the process, or a port owner you verified belongs to this worktree.

2. **Writing to live state.** Never use the developer's real <LIVE_STATE> as writable development or test state. Reading or copying it for debugging is fine. Do not run dev servers, migrations, cleanup, tests, or agents against live user state.

3. **Baking in environment assumptions.** Do not hardcode <ORIGIN_OR_ENVIRONMENT_ASSUMPTIONS> into client or shared code. Keep environment details at the boundary.

## Hit every surface

The easiest bug to ship is one that works in the path you tested and breaks somewhere else. Before calling a change done, check what applies:

- **Entry points.** If a behavior is reachable in more than one place, fix every supported entry point.
- **States.** Check the states the feature supports, including reverse, restored, and error states.
- **Providers or adapters.** If behavior depends on an external provider, decide what happens for each adapter. "Not supported" is fine when it is explicit.
- **Contracts.** Type and validate data that crosses a process, network, package, or persistence boundary.
- **Reverse states.** If an action can be reversed, define the reverse path and make the result visible.
- **Persistence and resume.** Decide what survives refresh, reconnect, restart, reopen, and restore.
- **Connections.** Do not depend on accidental local-only assumptions unless the product is intentionally local-only.
- **Docs.** Update the docs that describe changed user behavior, architecture, operations, or shared vocabulary.

## Dev servers

<!-- Replace every placeholder with a real project command or delete the line. -->

- `<INSTALL_COMMAND>` installs dependencies.
- `<DEV_COMMAND>` starts <DEV_PROCESSES>.
- In a worktree, development state lives in `<LOCAL_STATE_DIR>`. Do not point it at shared or live state.
- Do not assume ports. Read the addresses printed by `<DEV_RUNNER_OUTPUT>`.
- <PROCESS_LIFECYCLE_RULE>
- Stop only processes you started, using the PID you captured.

<!--
Add sharing, pairing, tunnels, simulators, or device setup only if the project has them.
-->

## Test data

Do not use empty data unless empty state is what you are testing. Realistic state catches problems that tiny fixtures miss.

- Keep test and development state isolated under `<LOCAL_STATE_DIR>`.
- Prefer checked-in fixtures when they are enough.
- When real data helps, copy or snapshot it into the worktree first.
- Never symlink test state to live state.
- Copy credentials or secrets only when the test needs them. Prefer disposable development credentials.
- If the datastore may be open, use its safe snapshot method. Do not assume a live file copy is valid.
- Tests and test agents may only write inside the test workspace.

> Copy in. Never point in. Never write back.

## Verifying

- Prove the change with the smallest useful check. Run focused tests for the files or behavior you changed, plus targeted lint and typecheck for that scope.
- **Do not run repo-wide checks by default.** Do not run `<FULL_CHECK_COMMAND>`, `<FULL_TEST_COMMAND>`, or `<FULL_TYPECHECK_COMMAND>` unless explicitly requested. CI or the maintainer owns the full suite.
- Behavior changes need focused tests for that behavior. Test the layer you changed instead of relying on unrelated end-to-end coverage.
- Async tests wait for real completion. Use an event, promise, receipt, drain, or state transition when one exists. Do not make tests pass with arbitrary sleeps.
- Run one integrated client check when the change depends on real client behavior or the user asks for it.
- Subagents do not start their own dev servers, browsers, simulators, or external processes unless explicitly asked.
- For stateful or visual behavior, test both the underlying state and the user-visible result when both matter.

## Pull requests

- Never create a PR unless the developer explicitly asks.
- Use conventional commit titles in plain language: `<type>(<scope>): <short description>`.
- Keep the body short. State the problem and explain the fix. Add model and harness attribution only if this project wants it.
- UI changes need before and after images. Motion, timing, or drag-and-drop changes need a short video.
- One concern per PR. If the description says "also" or "while here", split it.
- When monitoring a PR, only act on checks and comments newer than the last push. Verify bot findings against the source. Fix real issues and explain false positives. Stay quiet when nothing changed. Stop when the latest commit is green.

## How it works

<!--
Describe the system that exists now. A few short paragraphs are enough.
-->

<CLIENT_OR_ENTRYPOINT> talks to <RUNTIME_OR_BACKEND> over <TRANSPORT_OR_BOUNDARY>.

<USER_ACTIONS_OR_INPUTS> become <COMMAND_OR_REQUEST_MODEL>. <ADAPTERS_OR_INTEGRATIONS> connect to <EXTERNAL_SYSTEMS> and translate their native behavior into <PROJECT_EVENTS_OR_STATE>.

<STATE_DERIVER_OR_CORE> derives <CURRENT_STATE_OR_READ_MODEL>. <PROJECTOR_OR_RENDERER> turns that state into <USER_VISIBLE_OUTPUT>.

<PERSISTENCE_AND_LIFECYCLE_RULE>

Full glossary with file links: `<GLOSSARY_PATH>`

## Where code lives

<!-- List only directories with a real responsibility. -->

- `<PATH>` contains <RESPONSIBILITY>. <BOUNDARY_RULE>.
- `<PATH>` contains <RESPONSIBILITY>. <BOUNDARY_RULE>.
- `<PATH>` contains <RESPONSIBILITY>. <BOUNDARY_RULE>.
- `<PATH>` contains <RESPONSIBILITY>. <BOUNDARY_RULE>.

## Taste

- Keep complexity at boundaries. External quirks belong in adapters, not in the core model.
- Use the smallest model that solves the current problem. Do not add abstractions for users, agents, clients, providers, protocols, or deployment modes that do not exist yet.
- Prefer inferred types when the compiler already knows the type. Avoid `any`. Validate unknown external data when it enters the system.
- Comments explain intent, constraints, or non-obvious usage. Do not narrate the code.
- The UI must not lie. Loading means work is pending. Success means the underlying work finished. Stale labels, fake progress, and optimistic states with no recovery path are bugs.
- Reuse mature code when it already solves the problem well. Do not rewrite standard infrastructure or interaction code just to own it.
- If a rule here blocks the real task, say so and get human approval before breaking it.

## Additional tips

- Do not launch a browser, computer-use tool, or visual automation unless the user asks for it or the behavior needs client-level verification.
- Match security work to the actual threat. Do not bury local maintainer tools under production security machinery without a concrete reason.
- Use existing project tools and upstream patterns before adding a dependency, framework, or service.
- Do not grow the task while fixing it. Write down adjacent work instead of quietly doing it.
