# Glassbox Canvas Harness

Glassbox is a canvas-native workbench for running, inspecting, and steering AI agents.

Agent work should not disappear into a scrolling chat log. Glassbox turns plans, actions, files, diffs, tests, artifacts, approvals, and results into objects that stay on the canvas and can be inspected or rearranged.

## What makes Glassbox special?

### 1. Open at the core

Glassbox is developed in the open. We share the code, architecture, design decisions, experiments, and the reasoning behind changes.

People should be able to understand Glassbox, fork it, change it, and make it their own. That includes seeing how agents connect, how runs become events, and how those events become objects on the canvas.

Use open formats, clear interfaces, and replaceable components when they keep the system simpler.

### 2. Performance without compromise

An infinite canvas receiving live agent activity can get slow fast.

Watch for unnecessary renders, too many live shapes, large WebSocket payloads, heavy DOM nodes, expensive animations, huge diffs, noisy logs, and state that grows forever.

Treat performance regressions as bugs.

Do not turn every raw event into a canvas node. Keep the events the system needs, derive useful state from them, and show only the objects that help the user understand or act on the work.

### 3. Agent-native, not agent-specific

Glassbox connects to existing agents. It does not try to replace them or make them all behave the same way.

Codex, Claude Code, Pi, ACP-compatible agents, and future providers may expose different tools, events, approval flows, and runtime behavior. Share only the concepts Glassbox actually needs.

Keep provider-specific behavior in the adapter. If a provider has a useful native capability, do not hide it just to make the common interface cleaner.

### 4. Canvas-native

The canvas is the workspace. It is not decoration around a chat page.

Plans, actions, artifacts, files, diffs, tests, sources, approvals, annotations, and results can become persistent objects on the board. Users can inspect, move, group, connect, and reorganize them.

Do not turn everything into a node graph. Glassbox should create a sensible layout on its own. A user should not have to build a workflow before an agent can start working.

When adding a feature, ask:

> What should this become on the canvas?

Do not start with:

> Which page should we add to the sidebar?

### 5. Quiet by default

Show the work that matters now.

Keep the current state, important artifacts, and anything that needs human attention in view. Put raw logs, full event streams, metadata, traces, and debugging details behind inspection.

Use this order:

```text
Work → Inspect → Understand
```

The detail can exist. It does not need to be visible all the time.

## A small glossary

Use these terms consistently:

- you means the agent reading this file and changing Glassbox.
we, us, and maintainers mean the people building and maintaining Glassbox.
- user means the person using Glassbox to direct, inspect, and work with agents.
- agent means the AI agent doing work inside Glassbox. Depending on context, that may also include you.
- provider means an external agent runtime or harness that Glassbox connects to, such as Codex, Claude Code, Pi, or an ACP-compatible agent.
- runtime means the Glassbox process that connects providers, manages runs, and emits normalized events.
- project means a workspace rooted in a real directory or another execution environment.
- session means a durable unit of work that a user can leave and return to.
- run means one concrete agent execution inside a session.
- event means a normalized record of something that happened during a run, such as a tool call, approval request, file change, test result, or completion.
- board means the persistent canvas workspace for a session.
- node means an object placed on the board because it is useful to the user, such as a task, plan, tool activity, artifact, diff, test result, source, approval, or annotation.
- artifact means a durable output such as a file, diff, document, image, webpage, or dataset.
- annotation means user-added context or notes attached to the board or one of its objects.
- inspector means the detail panel opened for the selected object. It is not a permanent dashboard.
- composer means the input and control area used to start, continue, steer, or stop agent work.
- canvas means the interactive tldraw workspace. It is not the source of truth for agent execution.

Full glossary with file links: docs/internals/glossary.md

## The three ways to hurt yourself
- Killing by pattern. Never use pkill -f, pgrep | kill, or kill a PID just because its name, path, workspace, worktree, or project string matched. Your own agent process may include this worktree path in its argv, and other dev servers or agents may be running on the same machine. Kill only a PID you captured when you started the process, or a port owner you verified belongs to this worktree.
- Writing to the live install. Never use the developer's real Glassbox data, active workspaces, or live sessions as writable development state. Reading or copying them for debugging is fine. Do not run a dev server, migration, cleanup, test, or agent against live user state.
- Baking in origins. Never set VITE_HTTP_URL or VITE_WS_URL for dev. The web client uses relative /api and /ws paths through the dev server. Hardcoding localhost or a dev port into the bundle breaks clients running against a different host.
## Hit every surface

The easiest frontend bug to ship is one that works in the path you tested and breaks somewhere else. Before calling a change done, check the parts that apply:

- Entry points. A canvas action may also be available from the Inspector, composer, command palette, context menu, or a keybinding. Fix every supported entry point.
- Canvas states. Check the states the feature supports, including selected, unselected, moved, grouped, collapsed, expanded, restored, and reopened.
- Providers. If behavior depends on a provider, decide what happens for each adapter. "Not supported" is a valid answer when it is explicit.
- Contracts. Anything crossing the runtime boundary is typed. If an event or shared state contract changes, check the runtime, canvas projection, Inspector, persistence, and tests.
- Reverse states. If something can be opened, grouped, pinned, approved, or stopped, define what happens next and how the user reverses it when reversal makes sense.
- Persistence and resume. Decide what survives refresh, reconnect, session reopen, and board restore. Restored board state must still agree with the session.
- Connections. Local single-origin development is the default. Client code must not assume a hardcoded localhost address or that the runtime shares the browser process.
Docs. Put user behavior in docs/user/, architecture and contributor notes in docs/internals/, runbooks in docs/operations/, and shared terminology in docs/internals/glossary.md.
## Dev servers
- <INSTALL_COMMAND> installs dependencies. If the project has a worktree setup script, confirm it ran before debugging broken module resolution or workspace links.
- <DEV_COMMAND> starts the server and web client.
In a worktree, development state lives in that worktree's gitignored <LOCAL_STATE_DIR>. Worktree state must take precedence over shared or live state unless <HOME_DIR_FLAG> is explicitly provided.
- Do not assume ports. Read the addresses printed by <DEV_RUNNER_LOG_PREFIX>. Occupied ports may shift.
- If remote sharing exists, use <DEV_COMMAND> <SHARE_FLAG> and return the full URL printed under <PAIRING_URL_LOG_KEY>. Do not configure the underlying tunnel by hand unless the project requires it.
- If pairing is required, return the pairing URL with its token. If the token is already used, mint a new one with <PAIR_COMMAND>. Document scope differences under <PAIRING_SCOPE_RULES>.
- Stop only processes you started, using the PID you captured. See "The three ways to hurt yourself".
## Test data

- Do not test with an empty workspace unless empty state is what you are testing. Real sessions, boards, files, and agent runs catch problems that tiny fixtures miss.

- Each worktree owns its own gitignored .glassbox/ state. Never point a dev server, migration, or test run at ~/.glassbox or another live Glassbox install.

- Prefer checked-in fixtures when they are enough.
When real data helps, copy or snapshot it into the worktree's .glassbox/ directory first.
- Never symlink worktree state to live state.
- Copy credentials, provider tokens, or secrets only when the test needs them. Prefer disposable development credentials.
- If the database may be open, use its safe snapshot method. Do not cp a live database and assume the copy is valid.
- Test agents may only receive paths inside the test workspace. They must never be able to modify the developer's real repositories or Glassbox state.

Copy in. Never point in. Never write back.

## Verifying
- Prove the change with the smallest useful check. Run focused tests for the files or behavior you changed, plus targeted lint and typecheck for that scope.
- Do not run repo-wide checks by default. Do not run vp check, recursive test suites, or full-repo typechecks unless explicitly requested. CI owns the full suite.
- Behavior changes need focused tests for that behavior. Runtime changes test runtime behavior. Canvas changes test the projection or interaction that changed.
- Async tests wait for real completion. Use an event, promise, receipt, drain, or state transition when one exists. Do not make tests pass with arbitrary sleeps.
- Run one integrated web check when the change depends on real browser behavior or the user asks for it. Test the actual board flow, not just the component by itself.
- Subagents do not start their own dev servers, browsers, simulators, or external processes unless explicitly asked.
- For tldraw behavior, test both the underlying state and the visible board behavior when selection, grouping, persistence, restore, or Inspector state matters.
## Pull requests
- Never create a PR unless the developer explicitly asks.
- Use conventional commit titles in plain language: fix(canvas): restored boards keep node selection.
- Keep the body short. State the problem, explain the fix, then note the model and harness used.
- UI changes need before and after images. Motion, timing, or drag-and-drop changes need a short video.
- One concern per PR. If the description says "also" or "while here", split it.
- When monitoring a PR, only act on checks and comments newer than the last push.
- Verify bot findings against the source.
- Fix real issues and explain false positives.
- Stay quiet when nothing changed. 
- Stop when the latest commit is green.
## How it works

- The web client talks to a local TypeScript runtime over typed HTTP and WebSocket contracts.

- User actions become commands. Provider adapters connect to Codex, Claude Code, Pi, ACP-compatible agents, and other runtimes, then translate their native activity into Glassbox events.

- A session reducer derives the current run state from those events.

- A canvas projector turns useful state into objects on the tldraw board. Plans, actions, artifacts, diffs, tests, approvals, and results can become nodes. Raw provider activity can stay available for inspection, but it does not become a node by default.

- The canvas, Inspector, and composer read the same session state. Board layout and user annotations persist separately from agent execution, so refreshing the UI does not destroy the work.

- Full glossary with file links: docs/internals/glossary.md

## Where code lives
- apps/server contains the local runtime, HTTP and WebSocket transport, provider adapters, session lifecycle, and event normalization. Keep provider quirks here.
- apps/web contains the React and Vite+ app, tldraw integration, board projection, Inspector, composer, and user interaction.
- packages/contracts contains schemas, event types, commands, and small helpers shared across process boundaries. Do not put provider implementations or heavy runtime logic here.
- packages/shared contains small runtime-independent utilities that are genuinely shared. Keep it boring.
- packages/agent-runtime contains shared session, run, capability, or normalized-event logic only when more than one app actually needs it.
- .repos/ contains read-only upstream references. Study them. Do not edit them, and do not import production code from them.
## Taste
- Keep provider quirks in adapters and tldraw quirks in the web projection code. Do not leak either into the core session model.
- Use the smallest model that solves the current problem. Do not add abstractions for agents, clients, or protocols that do not exist yet.
- Prefer inferred TypeScript types when the compiler already knows the type. Avoid any. Validate unknown external data when it enters the system.
- Comments explain intent, constraints, or non-obvious usage. Do not narrate the code.
- Keep the canvas responsive during long runs. Avoid broad re-renders, always-running visual effects, node spam, and UI state that grows without a limit.
- The UI must not lie. A spinner means work is still pending. Success means the underlying work finished. Stale labels, fake progress, and optimistic states with no recovery path are bugs.
- Reuse mature code when it already solves the problem well. Do not rewrite standard agent UI, canvas, transport, or interaction code just to own it.
- If a rule here blocks the real task, say so and get human approval before breaking it.
如果这里的规则阻碍了真正的任务，请说明并在违反前获得人工批准。

## Additional tips
- Do not launch a browser, computer-use tool, or visual automation unless the user asks for it or the behavior really needs browser-level verification.
- Match security work to the actual threat. Do not bury local maintainer tools under production auth machinery without a concrete reason.
- Use existing project tools and upstream patterns before adding a dependency, framework, or service.
- Do not grow the task while fixing it. Write down adjacent work instead of quietly doing it.