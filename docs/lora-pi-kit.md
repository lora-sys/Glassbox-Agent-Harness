# Lora PI Kit

The current Owner Pi native tool sandbox, its release lock, and its remaining
acceptance work are recorded in [Owner Pi sandbox](owner-pi-sandbox.md).

Status: CURRENT DIRECTION / P4 ACTIVE

This document is the source of truth for what `lora-sys/lora-pi-kit` is, what it contains, how it is installed, and how it relates to Pi, Glassbox, Herdr, and `lora-sys/skills`.

The current pre-P5 closeout is `.plans/issue-24-closeout.md`. Plan 03 remains the completed P3 foundation record.

## One sentence

Lora PI Kit is Lora's reproducible Pi distribution.

It takes a freshly installed upstream Pi and turns it into the Pi environment used by Lora for local coding, Glassbox main-Agent execution, and Pi workers launched through Herdr.

```text
Pi
  Agent engine

Lora PI Kit
  Lora's Pi distribution

Glassbox
  Personal Agent system and product control plane
```

Lora PI Kit is not a fork of Pi and is not the Glassbox product database.

## Why it exists

A fresh Pi install intentionally stays small. Upstream Pi provides the Agent loop, model/provider support, sessions, four basic coding tools, Extensions, Skills, Prompt Templates, Packages, settings, SDK, and other runtime primitives.

Lora PI Kit supplies the owned environment that should not be reconfigured by hand on every machine.

After installing the Kit, the user should not need to manually rebuild the same collection of Skills, Extensions, prompts, MCP integration, profiles, hooks, and compatibility settings each time.

The target experience is:

```text
install Pi
→ install Lora PI Kit
→ run doctor
→ choose a profile
→ use Lora's Pi environment
```

## Upstream mechanism

Use Pi's public package system first.

Upstream Pi packages can bundle:

```text
extensions
skills
prompt templates
themes
```

They can be installed from npm, Git, or local paths, and Pi supports global/project package configuration and resource filtering.

Lora PI Kit should therefore be a real Pi package instead of inventing a parallel plugin loader.

Conceptual package manifest:

```json
{
  "name": "@lora-sys/pi-kit",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

The exact published package name is not frozen until the repository is created.

## Distribution contents

Target structure:

```text
lora-pi-kit/
├── package.json
├── README.md
│
├── extensions/
│   ├── core/
│   │   ├── runtime.ts
│   │   ├── context-hooks.ts
│   │   ├── tool-policy.ts
│   │   └── notifications.ts
│   │
│   ├── glassbox/
│   │   ├── glassbox-bridge.ts
│   │   ├── taste-context.ts
│   │   ├── feedback-bridge.ts
│   │   └── trace-hooks.ts
│   │
│   └── mcp/
│       ├── client.ts
│       ├── registry.ts
│       └── tool-adapter.ts
│
├── skills/
│   └── <pinned snapshot from lora-sys/skills>
│
├── prompts/
│   ├── base.md
│   ├── coding.md
│   ├── review.md
│   └── worker.md
│
├── profiles/
│   ├── local-coding.json
│   ├── main-agent.json
│   ├── owner-direct.json
│   ├── qq-group.json
│   ├── herdr-worker.json
│   └── test.json
│
├── mcp/
│   ├── registry.json
│   └── presets/
│
├── config/
│   ├── settings.template.json
│   ├── models.template.json
│   └── providers/
│
├── locks/
│   ├── pi.lock.json
│   ├── skills.lock.json
│   └── compatibility.json
│
└── scripts/
    ├── install
    ├── doctor
    ├── update
    └── sync-skills
```

Names may move when implementation starts. The ownership and release semantics below are the stable part.

## Skills: bundled snapshot, separate source of truth

`lora-sys/skills` remains the canonical source repository for Lora Skills.

Lora PI Kit releases bundle every structurally valid owned Skill found at the pinned
`lora-sys/skills` commit. A rejected Skill remains outside the bundle and appears in the
lock with its source path and rejection reason.

```text
lora-sys/skills
      │
      │ canonical source
      ▼
sync-skills
      │
      ▼
lora-pi-kit/skills/
      │
      ▼
release tests
      │
      ▼
Lora PI Kit release
```

This means:

```text
canonical Skill source
  = lora-sys/skills

reproducible Skill payload used by one Kit release
  = bundled snapshot inside that release
```

Do not fetch `lora-sys/skills@main` dynamically every time Pi starts.

A Kit version must produce the same Skill payload on a laptop, test environment, and Linux server.

`skills.lock.json` records:

```text
source repository
source commit
included Skill names
optional per-Skill version / license metadata when needed
per-file byte count and SHA-256 digest
excluded Skill source paths and reasons
```

### Bundled does not mean always loaded

The release may contain many Skills.

That does not mean every Skill should be injected into every task.

Profiles and Glassbox policy determine what is active.

```text
Kit contains capability set
→ profile narrows default active set
→ Glassbox narrows it for the authorized location
→ Pi sees names and descriptions only
→ skill_read loads locked files on demand
```

The main-Agent profile selects the full validated catalog. The QQ-group profile supplies a
small default. Each allowed QQ group has a durable whitelist overlay controlled through an
Owner-private action. A Skill that is bundled but absent from the current Run whitelist is
not shown to Pi and cannot be read through the Skill Tool.

## MCP

Upstream Pi intentionally does not make MCP a built-in core requirement.

Lora PI Kit may provide MCP through an owned Extension / Package layer.

MCP belongs in the Kit when it is Pi runtime integration behavior.

Conceptual shape:

```text
Pi
  no required built-in MCP layer
      ↓
Lora PI Kit MCP Extension
      ↓
MCP Registry
      ↓
Profile-selected MCP servers
      ↓
normalized Tools
```

Do not connect every configured MCP server on every run.

The Kit should keep a registry of available integrations and let the active profile select the small set that is needed.

Examples:

```text
local-coding
  GitHub
  browser
  Notion when configured

main-agent
  Glassbox product Tools
  minimal external MCP set

qq-group
  very small remote-safe Tool surface

herdr-worker
  repository / coding integrations needed by the delegated task
```

### MCP does not bypass Glassbox

When Pi runs as the Glassbox main Agent or an authorized Worker, MCP capabilities remain subject to the Glassbox Tool / Ops authorization boundary where applicable.

The fact that an MCP Tool exists in the Kit does not mean every Channel Principal may call it.

## Profiles

Profiles are a first-class Lora PI Kit concept.

The Kit contains a broad capability set; profiles choose the intended runtime environment.

Initial profiles:

```text
local-coding
  normal local Pi coding environment

main-agent
  Glassbox Personal Agent runtime profile

owner-direct
  Owner private-channel runtime projection when a separate profile is useful

qq-group
  remote group profile with a narrow Tool surface for non-Owner Principals

Owner messages in an authorized QQ group use the main-agent profile and its enabled Skills. The
group remains the delivery audience, so Glassbox still checks protected reads and delivery before
sending a result. Non-Owner messages continue to use the qq-group profile and the group's strict
Skill whitelist.

herdr-worker
  delegated coding Worker profile

test
  deterministic / isolated test profile
```

Profiles may control:

```text
enabled Extensions
enabled Skills
enabled MCP integrations
prompt set
model / thinking defaults
Tool surface
notification behavior
Glassbox bridge behavior
trace / usage hooks
runtime-specific safe defaults
```

Profiles do not define Glassbox authorization.

A profile may narrow runtime capability. It may not widen the current Principal's Glassbox authority.

## Main Agent and Worker use the same distribution

The same Lora PI Kit may be used in different roles.

```text
@lora-sys/pi-kit
      │
      ├── main-agent profile
      │      ↓
      │   Glassbox main Personal Agent
      │
      ├── local-coding profile
      │      ↓
      │   interactive local Pi
      │
      └── herdr-worker profile
             ↓
          delegated Pi Worker
```

These roles remain different product identities.

```text
main Personal Agent ≠ delegated Worker
```

Sharing the same Kit does not make a Worker a second Personal Agent.

## Glassbox integration

Glassbox embeds Pi through the public SDK.

The intended runtime path is:

```text
Glassbox
  identity
  authorization
  conversation
  task / attention
  taste / memory
  trace
      ↓
PiRuntimeAdapter
      ↓
Pi SDK
      ↓
Lora PI Kit
  package resources
  active profile
  runtime bridges
      ↓
Pi
```

Glassbox decides:

```text
who is acting
what they may see
what they may do
what Task they are working on
what Taste / Memory / Rules are authorized and relevant
what can be delivered to the audience
```

Lora PI Kit decides how Pi receives and uses the selected runtime material.

Pi executes the Agent loop.

## Taste and Memory bridge

Lora PI Kit is not the canonical Taste or Memory database.

Glassbox / Turso owns:

```text
FeedbackEvent
TasteCandidate
TasteEntry
Taste confidence and scope
MemoryCandidate
Semantic Memory
Episodic Memory
visibility / authorization
provenance
```

The Kit may provide runtime bridges such as:

```text
taste-context
feedback-bridge
memory-context bridge when P4 exists
trace-hooks
```

The intended flow is:

```text
Glassbox selects authorized task-relevant Taste / Memory
→ Runtime Adapter creates a small projection
→ Lora PI Kit injects that projection into Pi runtime Context
→ Pi executes
→ observable user/runtime feedback returns through hooks
→ Glassbox stores the evidence
```

Do not expose the whole Taste or Memory database to Pi when a small task-relevant projection is enough.

## Rules

Lora PI Kit may package runtime instructions and load project rules, but it is not the only Rule authority.

Keep these sources distinct:

```text
Glassbox product / security Rules
  Glassbox-owned

repository / project Rules
  project-owned

Pi runtime instructions
  Lora PI Kit-owned when they are reusable runtime behavior
```

A runtime prompt cannot override Glassbox authorization.

## Settings and agentDir

Package resources and Pi settings are different concepts.

The Kit should use Pi Packages for distributable resources and bootstrap/generate settings where settings are required.

Glassbox owns the concrete Pi runtime instances it launches.

Conceptual runtime directories:

```text
~/.glassbox/pi/main/
~/.glassbox/pi/workers/<task-or-attempt-id>/
~/.glassbox/pi/test/
```

The exact filesystem layout is not frozen.

The invariant is:

- Glassbox runtime instances do not write into the user's normal interactive Pi state by default.
- main Agent, Worker, and test sessions may have isolated session state and runtime overrides.
- all of them may use the same pinned Lora PI Kit distribution.

## Installation

The desired distribution experience is one Kit install after Pi.

Examples supported by upstream Pi package mechanisms include npm and Git.

Conceptual commands:

```bash
pi install npm:@lora-sys/pi-kit@<version>
```

or:

```bash
pi install git:github.com/lora-sys/lora-pi-kit@<tag-or-commit>
```

The exact public package and release channel are decided when the repository is created.

`doctor` should verify the effective environment, for example:

```text
Pi version compatibility
Kit version
Skill snapshot
required Extensions
profile validity
optional MCP availability
Git / Node / other external dependencies
model/provider configuration
Glassbox bridge configuration when used
```

## Versioning and reproducibility

Do not let Glassbox production behavior track upstream `main` implicitly.

One tested runtime set should identify:

```text
Pi version / commit
Lora PI Kit version / commit
lora-sys/skills source commit
selected external packages / integrations
Glassbox version / commit
```

Upgrade flow:

```text
update Pi or Kit input
→ sync / build Kit
→ compatibility tests
→ Glassbox runtime tests
→ real acceptance where required
→ update locks
→ release / pin
```

`pi.lock.json`, `skills.lock.json`, and compatibility metadata exist to make this reproducible.

## Third-party and upstream capability intake

The Kit may contain both Lora-owned code and selected upstream packages or adapters.

Do not copy every interesting upstream project into the Kit.

Classify capabilities:

```text
Core
  bundled and enabled by the relevant default profiles

Optional
  included or installable, enabled only by selected profiles

Heavy / specialized
  installer or documented add-on, not part of the default footprint
```

Examples of likely Core capability:

```text
Lora Skills snapshot
Glassbox bridge
Taste / feedback bridge
trace / usage hooks
Tool policy bridge
MCP adapter infrastructure
```

Examples of Optional capability:

```text
GitHub integration
browser integration
Notion integration
extra coding helpers
```

Heavy integrations should not make a basic Kit install unnecessarily large or start background services by default.

## Security

Pi packages and Extensions execute with the permissions of the Pi process unless another sandbox is used.

Treat Lora PI Kit as trusted code and review any bundled third-party dependency before release.

For Glassbox remote Channels:

- package presence does not imply Tool authorization;
- the active profile must expose a narrow Tool surface;
- Glassbox Tool / Ops gates remain authoritative;
- unrestricted shell or raw Herdr terminal control is not exposed merely because the Kit contains coding capabilities.

## P3 boundary

P3 does not need the final complete distribution on day one.

P3.1 should establish the real architecture with the smallest useful set:

```text
real Pi package manifest
pinned bundled lora-sys/skills snapshot
main-agent / qq-group / herdr-worker / test profiles
Glassbox policy bridge
trace / usage hooks
minimal MCP adapter boundary, even if only one integration is proven
base prompts
settings / model templates
install / doctor / sync-skills
Pi + Skills compatibility locks
```

Do not postpone the package / profile / lock architecture and later replace a temporary ad-hoc installer.

The P3 MVP may leave many optional Skills and MCP integrations disabled until they have a real use case.

## P3 installation and runtime verification

Kit 0.1.1 uses Pi's public Package API to install selected profile resources into an explicit isolated agentDir. Its profile launcher disables ambient resource discovery. SDK hosts use the same profile resource options and bind Pi Extensions before execution, then emit the shutdown event before disposing a session.

Controlled upgrades activate an explicitly supplied, doctor-verified local Kit checkout. Skills synchronization reads immutable blobs from the reviewed canonical Git commit. It does not relabel local Skill edits as an upstream snapshot. The distribution preserves locked Skill bytes across checkout line-ending settings.

MCP starts only from an explicitly configured, per-session Extension factory. The profile and registry must both select a server. Glassbox-hosted execution still requires product authorization on each Tool call. Glassbox's main runtime exposes its own registered protected Tools and does not enable standalone MCP discovery.

Host verification covers a fresh test-profile installation, the selected bundled Skill, a real local stdio MCP call through the actual Pi SDK, independent session policy, revocation, controlled upgrade behavior, packed-artifact doctor checks, and SDK loading of the packed test/main-agent/qq-group profiles. Verified host metadata currently lists Windows only.

## What does not belong here

Do not move these into Lora PI Kit:

```text
Glassbox identity truth
Glassbox authorization policy
Conversation truth
Task / TaskAttempt truth
Attention Queue
WorkerBinding truth
Taste / Memory database
QQ transport
NapCat / OneBot state
Herdr Task truth
Delivery authorization
Raw Trace canonical evidence
```

Lora PI Kit makes Pi behave like Lora's Pi.

Glassbox makes that runtime part of one durable Personal Agent system.
