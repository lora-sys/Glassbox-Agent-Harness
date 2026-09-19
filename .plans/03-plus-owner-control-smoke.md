# P3+ closeout

Status: COMPLETE

This slice finishes the current long-lived P3 Draft PR. It uses the existing P3 Issue, worktree, branch and PR.

## Problems found after real QQ use

The completed P3 loop exposed five product problems:

1. The development environment stopped when its terminal process ended.
2. QQ users received an internal acknowledgement containing a Run identifier.
3. Pi output reached QQ with raw Markdown syntax.
4. Pi received protected Tool schemas before Glassbox checked whether the current Run could discover them.
5. Model output could repeat host paths, internal addresses and internal identifiers.
6. Pi could describe an Owner action as completed without a matching successful Tool call.

The Owner also needs one small administration test. The Owner must be able to enable or disable the Bot in an existing QQ group through a private conversation.

## Implementation

### Service lifecycle

The repository provides these commands:

    npm run agent:up
    npm run agent:status
    npm run agent:logs
    npm run agent:down

The commands use the configured Glassbox data directory. Optional Herdr and NapCat process definitions live in the local service-launch.json. The file contains local executable paths and is not committed with credentials.

The service manager:

- starts Herdr, NapCat and Glassbox without a shell;
- waits for the configured Herdr socket and Glassbox port;
- records the processes it started;
- verifies executable path and arguments before stopping a process;
- uses Herdr's public named-session commands for session status and shutdown;
- keeps logs in the Glassbox data directory.

### QQ presentation

Run completion creates one result delivery. It does not create a user-visible acknowledgement delivery.

Before QQ delivery, Glassbox:

1. checks the raw candidate for secrets and protected host metadata;
2. converts supported Markdown to plain QQ text;
3. checks the rendered text again;
4. creates the Delivery only when both checks pass.

A blocked candidate creates no Delivery. Glassbox marks that Run as excluded from later model Context and appends a digest-only delivery_blocked Trace event. The event records reason codes, byte count and a SHA-256 digest. It does not copy the blocked text.

### Tool visibility

Each Pi Run receives a caller-bound context before its session is created.

Glassbox checks tool:discover for every registered Tool and passes only allowed names to Pi. Group Runs and Visitor private Runs receive no Owner or Ops Tool schema. Owner private Runs receive only the schemas granted for that private scope.

The existing protected Tool wrapper still re-authorizes the concrete resource and action immediately before execution. Tool visibility does not imply execution permission.

The Pi session_start evidence records the Tool names selected for that Run.

An explicit Owner private group-access command also creates a required-Tool condition for that Run. If Pi returns without a successful matching Tool result, Glassbox gives the same Pi session one corrective attempt. A second response without the Tool result fails the Run with a safe message. Glassbox does not deliver the model's unverified success claim.

### Owner group access Tool

P3+ adds one Tool:

    owner_group_set_access

It is visible only in an authorized Owner private Run. It accepts a QQ group identifier and an enabled flag.

Enable performs these checks and changes:

- re-authorize group:manage on the private Owner control resource;
- ask the current OneBot connection whether the Bot is in the group;
- add the group to the existing Channel profile;
- grant the existing Owner and registered Visitors the standard group scope;
- update the live OneBot allowlist;
- append group_access_changed evidence.

Disable first revokes active Agent grants for the Owner and registered Visitors in that group. It then removes the group from the Channel profile and live allowlist. This ordering fails closed if persistence stops partway through the action.

The Tool does not trust unregistered group members. It does not expose arbitrary Channel configuration or shell access.

## Acceptance

Deterministic tests must prove:

- the acknowledgement delivery is gone;
- duplicate QQ events still create one Run and one result;
- Markdown becomes readable plain text;
- paths, private URLs, internal domains, UUIDs, configured runtime names and known secret forms are blocked;
- blocked output creates no Delivery, records digest-only evidence and cannot enter later Context;
- a discovered Tool schema reaches Pi;
- an undiscovered Tool schema does not reach Pi;
- execution permission is checked even when the schema is visible;
- an explicit Owner group-access command cannot report success without a successful Tool result;
- a question about group access does not become an action;
- only an Owner private action can enable or disable a group;
- enabling a group affects the next group event;
- disabling the group prevents the next group event;
- restart preserves the Channel profile and authorization state.

Real acceptance must prove:

- one command starts the configured environment;
- Pi receives the Owner Tool only in Owner private chat;
- the Owner can enable the real test group through QQ;
- a later group mention produces a normal reply;
- the reply contains no acknowledgement identifier or raw Markdown;
- a forced unsafe candidate is withheld and recorded without its payload;
- Herdr remains available and its Pi worker path still reaches REVIEW before Accept;
- restart and reconnect retain durable state and do not duplicate delivery.

## Boundaries

This slice does not add model switching, a general Tool toggle, a QQ Trace browser, Memory, Taste, scheduled group work, Group Tool Registry, Tool generation, new Channels or frontend work.

Those items remain outside the P3 closeout. After this gate passes, the roadmap continues at P4.
