# GlossBox Design Eval Checklist

Status: **REQUIRED BEFORE UI ACCEPTANCE**

Run this checklist after implementation changes that affect layout, components, information hierarchy, or interaction.

---

## 1. Canonical inputs

Review against:

```text
DESIGN.md
UI_PRIMITIVES.md
glossbox_vercel_admin_v24_vercel_compliance.html
```

Do not approve based on screenshots alone.

---

## 2. Required viewport matrix

Test:

```text
1440 × 900   Desktop
1024 × 768   Laptop
768 × 1024   Tablet
390 × 844    Mobile
320 × 700    Narrow mobile
```

Verify:

- no page-level horizontal scroll;
- tables use local scroll;
- sidebar becomes drawer on mobile;
- DetailRail stacks correctly;
- Trace remains usable;
- inputs do not trigger iOS zoom;
- actions remain tappable.

---

## 3. Typography checks

Verify:

```text
body >= 15px
table body ≈ 13–14px
metadata >= 11px where possible
mobile input >= 16px
```

Reject:

- large areas of 8–9px text;
- metadata that is visually unreadable;
- contrast that relies on very light gray.

---

## 4. Contrast

Check at minimum:

```text
body text
secondary text
metadata
disabled / placeholder
status
links / actions
focus
```

Target normal text contrast consistent with accessible Web UI.

`#999` should not be used for important readable metadata.

---

## 5. Focus and keyboard

Keyboard-only test:

```text
Tab through main navigation
Open / close mobile drawer
Use FilterBar
Select table rows
Use Decision Tester
Use Settings switches
Use Trace timeline
```

Trace:

```text
j / k
e
/
```

Focus ring must be visible and separate from brand/authorization amber.

---

## 6. Long-content cases

Test:

```text
very long Chinese Task title
very long Conversation title
long Principal ID
long model ID
long Run ID
long resource path
long Tool result summary
long error message
```

Verify:

- wrapping or truncation is intentional;
- IDs remain inspectable;
- table does not destroy page layout;
- DetailRail remains usable.

---

## 7. Empty states

Test:

```text
0 Conversations
0 Tasks
0 Runs
0 Trace search results
0 Approval items
0 Alerts
no quota
no pricing
no worker binding
```

Expected:

- clear empty copy;
- no fake zero value;
- no broken table;
- no oversized empty illustration.

---

## 8. Unknown vs not-applicable

Test fields with:

```text
Unknown
Not applicable
Not reported
Not priced
Disconnected
Stale
```

Rules:

```text
未知
  meaningful field, unavailable value

—
  not applicable

成本不可用
  pricing unavailable

stale / unknown
  live observation unavailable
```

Never collapse these states.

---

## 9. Capability-state checks

Every capability shown as one of:

```text
已实现
P3 目标
设计数据
后续
未知
```

Reject inconsistent visible vocabulary such as:

```text
fixture
experimental
planned
target
future
```

Technical logs may preserve original values.

---

## 10. Overview eval

The user should answer within a few seconds:

```text
Is something waiting for me?
What is the current Run?
How much did PI use?
Where do I drill down?
```

Reject if Overview becomes:

- analytics wall;
- card grid;
- duplicated Monitor;
- duplicated Task page.

---

## 11. Conversation eval

Test:

```text
Web private Owner
QQ private Owner
QQ test group Visitor
Conversation with Tasks
Conversation with Direct Runs only
```

Verify visibility of:

```text
Principal
Channel
Scope
Visibility
PI Session
Runs
Tasks
Cost
Section usage
Execution lineage
Recent activity
```

---

## 12. Task Collaboration eval

Test state matrix:

```text
NEW
QUEUED
ASSIGNED
RUNNING
WAITING_INPUT
REVIEW
DONE
FAILED
CANCELED
```

Herdr observations:

```text
working
blocked
done
idle
unknown
stale
disappeared
```

Critical invariant test:

```text
Herdr done
must not display Task DONE
unless acceptance exists
```

---

## 13. Identity eval

Test:

```text
verified Web Owner
QQ Owner
QQ Visitor
Worker Principal
unknown ChannelIdentity
conflicting identity
```

Verify chain:

```text
ChannelIdentity → User → Principal
```

Verify relationship provenance remains visible.

---

## 14. Run eval

Test:

```text
Direct Run
Task Run
Run with no files
Run with files
Run with tests
Run with failure
Run with unknown pricing
Run with artifacts
```

Detail should not become a Trace duplicate.

---

## 15. Trace scale eval

Test:

```text
28 semantic events
100 semantic events
500 semantic events
large Raw Trace volume
```

Trace should support:

```text
filter
search
scrubber
jump latest
Inspector
expand/collapse
keyboard navigation
```

At 500+ events:

- Timeline remains usable;
- filtering does not freeze UI;
- Run list stays usable;
- Inspector selection persists.

---

## 16. Trace type coverage

Ensure renderer supports:

```text
user
authorization
system
context
memory
skill
thinking
tool
file
test
ops
delivery
assistant
error
```

Memory:

```text
search
read
candidate
write
```

Skill:

```text
match
loaded
result
```

Agent Ops:

```text
task created / updated
worker binding
worker state
review
accept
rework
cancel
connection
reconcile
```

Tool:

```text
decision
args
result
duration
error
usage
```

---

## 17. PI eval

Test:

```text
3 models
1 default
unknown quota
unknown cost
last error
no sessions
many sessions
incompatible PI version
```

Verify PI stays model-centric.

Reject any reintroduction of:

```text
Codex Admin
Claude Code Admin
Provider Management
multi-runtime policy UI
```

---

## 18. Channel eval

QQ scenarios:

```text
Owner direct
Visitor direct
allowed group
blocked group
mentioned group
not-mentioned group
duplicate event
reconnect
delivery deny
```

Verify:

```text
Ingress
Identity
Conversation
Tool
Delivery
Trace
```

remain inspectable.

---

## 19. Permission eval

Decision cases:

```text
ALLOW
DENY
REQUIRES_APPROVAL
```

Test:

```text
Owner reads private resource
Owner tries private result → group
Visitor reads unrelated Task
Worker reads delegated Task
Worker reads unrelated repository
destructive worktree operation
```

Decision provenance must explain the result.

---

## 20. Monitor eval

Test:

```text
PI healthy
PI slow
Herdr connected
Herdr disconnected
Herdr stale
unknown worker
stale WorkerBinding
WebSocket disconnected
Turso unavailable
R2 unavailable
```

Monitor must distinguish:

```text
product truth
vs
observation health
```

---

## 21. Settings eval

Verify:

- switches are native controls;
- labels are accessible;
- destructive product truth is not edited here;
- unknown pricing behavior is configurable;
- retention values are explicit;
- channel defaults are clearly defaults, not authorization rules.

---

## 22. Color-blind eval

Charts must remain understandable when series colors are not distinguishable.

Require:

```text
line pattern
legend
tooltip
numeric values
table fallback
```

Status meaning must not rely on color alone.

---

## 23. Data honesty eval

For each page, identify which displayed fields are:

```text
Observed
Calculated
Configured
Fixture
Unknown
Planned
```

Reject any UI where:

- Fixture looks production-real;
- Planned looks implemented;
- Unknown looks zero;
- Derived metric looks provider-native.

---

## 24. Regression scenarios

Run after any major UI change:

```text
Navigate all 11 pages
Open every DetailRail
Use every filter
Use every search
Switch PI model in prototype
Use Settings switches
Use Decision Tester
Use mobile drawer
Use Trace keyboard controls
Use Trace Inspector tabs
```

No console errors.

No duplicate DOM IDs.

No Inspector leakage across pages.

---

## 25. Freeze acceptance

UI can be considered implementation-ready when:

```text
IA matches DESIGN.md
composition matches UI_PRIMITIVES.md
visual direction matches v24
all required Eval scenarios pass
no known accessibility blocker remains
no capability-status dishonesty remains
no major page invents a new design language
```
