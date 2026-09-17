# Glassbox Web Management — Delivery Workspace & Frozen Spec

Status: **FROZEN DELIVERY SPEC — DESIGN FREEZE v2 IMPLEMENTATION CONTRACT**<br />
Tracking Branch: `codex/web-management-freeze`<br />
Delivery Mode: Dedicated Worktree · Long-lived Draft PR · Contract-First Fixtures · Zero Backend Changes in Setup

---

## 1. Provenance & Precedence

### 1.1 Document Provenance

This directory (`docs/ui/`) is the dedicated, frozen source of truth for the Glassbox Web Management frontend delivery stream. The four core design documents are imported verbatim from the Design Freeze v2 archive:

| File | Role & Authority | Verbatim SHA-256 Checksum |
| --- | --- | --- |
| [`DESIGN.md`](./DESIGN.md) | Product definition, 11 page contracts, navigation, and data semantics | `93bd1cc0c69bc487b68faaf892b08e6c1dc4441d09cbb2e7c2b5353eef3826eb` |
| [`UI_PRIMITIVES.md`](./UI_PRIMITIVES.md) | Approved component primitives, foundation tokens, and composition constraints | `30355f20407c331122522a85d3531b6c20dad5cd7c8da53f24e3baa1dc199024` |
| [`glossbox_vercel_admin_v24_vercel_compliance.html`](./glossbox_vercel_admin_v24_vercel_compliance.html) | Canonical interactive benchmark and Vercel-compliance visual reference (v24) | `4883186920fe86248d7f3c5687ca03803a5ef58ecee3e5e35513087e47cfc586` |
| [`DESIGN_EVAL.md`](./DESIGN_EVAL.md) | Verification checklist, responsive matrix, scale benchmarks, and acceptance gates | `0a5d38723b97433139692b089548789ee998e2f3ba487586df8c2eda85acee8b` |

### 1.2 Precedence Hierarchy

When requirements appear ambiguous or interact across layers, apply this strict order of precedence:

```text
1. AGENTS.md (Root repository invariants, trust & authorization boundary)
   ↓
2. docs/ui/DESIGN.md (Product definition, page responsibilities, data honesty vocabulary)
   ↓
3. docs/ui/UI_PRIMITIVES.md (Component assembly rules, foundation design tokens)
   ↓
4. docs/ui/glossbox_vercel_admin_v24_vercel_compliance.html (Canonical visual styling & layout benchmark)
   ↓
5. docs/ui/DESIGN_EVAL.md (Acceptance criteria, stress testing & readiness gates)
```

**Rule**: Do not redesign or alter frozen source content. The HTML prototype and spec markdown files are immutable contracts.

---

## 2. Core Product Boundaries & Invariants

All frontend routes, components, state managers, and mock fixtures must uphold the system invariants codified in `AGENTS.md` and `docs/ui/DESIGN.md`:

```text
Identity ≠ Authorization
Permission ≠ Approval
Channel ≠ Agent
Conversation ≠ Principal
Conversation ≠ PI Session
PI Session ≠ Run
Task ≠ Run
Task ≠ Worker
TaskAttempt ≠ Herdr pane
WorkerBinding ≠ Task truth
Herdr Agent state ≠ Task acceptance
Raw Trace ≠ Derived State
Canvas (/) ≠ Execution State
```

### Critical Operations Invariant

```text
Herdr worker = done
≠
Glassbox Task = DONE
```

- Herdr reports live coding-worker execution facts (e.g. `working`, `blocked`, `done`, `idle`).
- Glassbox owns durable product truth and task acceptance:
  - `Herdr working` → `TaskAttempt RUNNING`
  - `Herdr blocked` → `Task WAITING_INPUT` + `AttentionItem(worker_blocked)`
  - `Herdr done` → `TaskAttempt` settled + `Task REVIEW` + `AttentionItem(task_review)`
  - Explicit human / authorized `Accept` action → `Task DONE`
  - Explicit authorized `Rework` action → preserves prior attempt history + launches next `TaskAttempt`

---

## 3. The 11 Frozen Pages

The management surface is locked to exactly 11 pages organized under two primary navigation groups plus Settings:

```text
工作台 (Workbench)
  ├── 1. 概览 (Overview)
  ├── 2. 会话 (Conversations)
  ├── 3. 任务协作 (Task Collaboration)
  ├── 4. 身份与访问 (Identity & Access)
  ├── 5. 运行记录 (Runs)
  └── 6. 追踪 (Trace)

PI Core
  ├── 7. PI (PI Engine & Models)
  ├── 8. 渠道与集成 (Channels & Integrations)
  ├── 9. 权限 (Permissions & Gates)
  └── 10. 监控 (Monitor & Telemetry)

设置 (Settings)
  └── 11. 设置 (Settings)
```

### Detailed Page Responsibilities

| # | Page (ZH / EN) | Responsibility & Primary Reading Order | Core Controls & Components |
|---|---|---|---|
| 1 | **概览**<br>`Overview` | High-level operational summary for Owner. Intentionally shallow. Answers: Is anything waiting? What is running? How much was used?<br>`Key Summary → Needs Attention Queue → Current Run → Usage Trend → PI Model Table` | `PageShell`, `SummaryBar`, `AttentionQueue`, `DataTable` (models), trend sparkline |
| 2 | **会话**<br>`Conversations` | Durable conversation thread inspector. Shows Principal, Channel, Scope, Visibility, linked Runs and Tasks, token/cost rollups.<br>`Thread Identity → Channel/Principal → Linked Work → Activity Timeline` | `FilterBar` (channel, scope), `DataTable`, `DetailRail` (sanitized projection, linked runs/tasks) |
| 3 | **任务协作**<br>`Task Collaboration` | Durable Task truth vs Herdr live worker state. Manages Attention Queue, review, acceptance, and rework.<br>`Task Truth → TaskAttempt History → WorkerBinding → Review Actions` | `AttentionQueue`, `DataTable` (tasks), `DetailRail` (attempt lineage, worker diff, accept/rework buttons) |
| 4 | **身份与访问**<br>`Identity & Access` | Authorization and principal mapping inspector. Resolves `ChannelIdentity → User → Principal`. Shows roles, grants, and delegation limits.<br>`Principal Identity → Channel Identities → Active Grants → Delegation Scope` | `DataTable` (principals, channel mappings), `DetailRail` (grant inspector, audit events) |
| 5 | **运行记录**<br>`Runs` | Concrete execution history of the Agent. Links to Conversation, TaskAttempt, tools executed, artifacts produced, and Trace.<br>`Run ID → Model / Duration → Tool Invocations → Artifacts → Trace Link` | `FilterBar` (status, model), `DataTable`, `DetailRail` (execution breakdown, artifacts, trace deep-link) |
| 6 | **追踪**<br>`Trace` | Full execution evidence inspector. 3-column layout: Run List, Timeline Events, Event Inspector. Strict distinction between Timeline and Raw Trace.<br>`Run Selection → Timeline Stream → Scrubber → Event Inspector (Payload/Auth)` | 3-column `MasterDetail`, `TraceRunList`, `TraceEvent` timeline, `TraceInspector`, scrubber |
| 7 | **PI**<br>`PI Engine` | Model-centric execution core. Active models, default model selection, sampling parameters, session list, and token consumption.<br>`Model Inventory → Active Default → Session History → Quota & Usage` | `DataTable` (models, sessions), `SettingsGroup` (temperature, context limits), `Notice` |
| 8 | **渠道与集成**<br>`Channels & Integrations` | Ingress and egress adapters (OneBot 11 / QQ, Web, future integrations). Ingress authorization, delivery policies, and connection health.<br>`Channel State → Ingress Policy → Delivery Gate Policy → Event Logs` | `DataTable` (channels), `DetailRail` (ingress/delivery audit, webhook configuration) |
| 9 | **权限**<br>`Permissions` | Decision-first authorization control plane (`ALLOW`, `DENY`, `REQUIRES_APPROVAL`). Four hard gates enforcement and interactive Decision Tester.<br>`Hard Gates Status → Rule Matrix → Decision Tester → Audit Log` | `DataTable` (policies), `DecisionTester` (interactive principal × resource × action form), `Notice` |
| 10 | **监控**<br>`Monitor` | Health and telemetry. Separates durable product truth from live observation health. Tracks PI latency, Herdr connection, DB, and storage.<br>`System Pulse → Subsystem Status (PI, Herdr, DB) → Latency Trends → Alerts` | `ChartPanel` (latency, error rate), `DataTable` (subsystem telemetry, incident log) |
| 11 | **设置**<br>`Settings` | Operational configuration. Native form controls for retention rules, unknown-pricing display behavior, and channel defaults.<br>`Retention Policies → Display Formatting → Channel Defaults` | `SettingsGroup`, native switches, selects, number inputs |

---

## 4. Approved UI Primitives & Composition Rules

All pages must be composed exclusively from the primitives cataloged in [`UI_PRIMITIVES.md`](./UI_PRIMITIVES.md):

### 4.1 Foundation Tokens
- **Surfaces**: Canvas (`#FAFAFA`), Surface (`#FFFFFF`), Sidebar (`#F5F5F5`), Border (`#EAEAEA`), Strong Border (`#D4D4D4`).
- **Text**: Ink (`#111111`), Body (`#333333`), Secondary (`#666666`), Metadata (`#737373`), Disabled (`#999999`).
- **Semantics**: Brand/Current/Auth (`warm amber`), Success (`green`), Danger/Deny/Error (`red`), Focus (`blue`).
- **Radii**: Small (`6px`), Default (`8px`), Large (`10px`). Avoid pill buttons for containers or oversized rounded cards.
- **Typography Density**: Comfort density (Page title 24–26px, Section title 14–16px, Body 15–16px, Table body 13–14px, Metadata 11–12px).

### 4.2 Approved Primitives Catalog
- `PageShell`: 232px desktop sidebar, mobile drawer (44px tap target), topbar breadcrumbs.
- `PageHeader` & `SectionHeader`: Structured h1/h2 with concise subtitles and contextual actions.
- `FilterBar`: Native inputs, selects, segmented filters, and result counters.
- `DataTable`: Dense management tables with local scrolling, sorting, and row selection.
- `DetailRail`: Sliding/stacking context panel with close button, ESC key handler, and focus restoration.
- `SummaryBar`: Compact KPI and key summary strips (not giant decorative cards).
- `EntityMark` & `Status`: Semantic entity badges and state indicators with distinct text and color.
- `PrimaryButton`, `SecondaryButton`, `DangerButton`: High-contrast, keyboard-accessible action buttons.
- `Tabs`: Accessible tab navigation with URL query parameter synchronization.
- `SettingsGroup`: Native form field grouping with semantic labels.
- `MasterDetail`, `TraceRunList`, `TraceEvent`, `TraceInspector`: Trace viewing and inspection primitives.
- `ChartPanel`: Accessible time-series and bar charts with legend, tooltip, and tabular fallback.
- `EmptyState` & `Notice`: Clear contextual guidance without fake data.

### 4.3 Forbidden Anti-Patterns
- **No card-grid maximalism**: Tables and lists must take precedence over repetitive card grids.
- **No glassmorphism or decorative gradients**: Keep surfaces clean, white, and bordered.
- **No "generic AI" styling**: Avoid purple/blue gradient backgrounds, glowing borders, or non-functional animations.
- **No page-level horizontal scroll**: Tables and code blocks scroll within their containers.
- **No modal sprawl**: Use `DetailRail` for item inspection; reserve modals only for destructive confirmation gates.

---

## 5. Contracts-First Typed Fixtures & Adapter Boundary

### 5.1 Decoupled Frontend Velocity

To prevent frontend implementation from being blocked by backend schedule, this workspace implements a **Contracts-First Adapter Architecture**:

```text
@glassbox/contracts (Shared TypeScript Schemas & Types)
         ↓
Typed Mock Fixtures (Comprehensive, deterministic data for all 11 pages)
         ↓
Management Data Adapter Boundary (useManagementData / Query Hooks)
         ├── Development / Mock Mode: In-memory typed fixtures with realistic latency
         └── Production / Live Mode: HTTP/WebSocket client connected to Glassbox Server
         ↓
Web Management React Components (11 Pages, DetailRails, Trace)
```

### 5.2 Fixture Requirements
- Typed fixtures must strictly implement the schemas in `packages/contracts`.
- Fixtures must cover all realistic edge cases: empty lists, high volume, multi-turn traces, denied authorizations, and pending approvals.
- Switching between mock fixtures and live backend must require only an environment variable or query parameter (`?mock=true`), with zero component code modification.

---

## 6. Current API Gaps & Honest Data States

### 6.1 Strict Data Honesty Vocabulary

The UI must reflect reality and distinguish implemented functionality from roadmap goals. The following vocabulary is mandatory:

| Label | Meaning & Usage |
| --- | --- |
| `已实现` | Active repository capability currently working in code. |
| `P3 目标` | Planned capability within the active P3 scope; must not be claimed as already working. |
| `设计数据` | Prototype fixture or illustrative presentation data. |
| `后续` | Future roadmap item beyond the current milestone. |
| `未知` | Meaningful field whose value cannot currently be reported by the system. |
| `—` | Field is not applicable in this context. |

**Strict Constraints**:
- Never display `$0.00` for unpriced or unknown models; display `成本不可用` or `未知`.
- Never fabricate token usage, latency, worker health, or authorization decisions.

### 6.2 Current API Gap Analysis

| Subsystem | Implemented Backend Reality | Active Web UI Gap / Requirement | Delivery Strategy |
| --- | --- | --- | --- |
| **Canvas** | Full WebSocket synchronization on `/` | Must remain isolated and untouched | Kept at route `/`; management at `/manage` |
| **Trace** | JSONL file / in-memory run store | 3-column timeline, scrubber, inspector | Typed fixtures initially, then bind to trace store |
| **Conversations** | Core session persistence | Thread list, sanitized projection | Contract-first fixtures → Server API adapter |
| **Tasks & Herdr** | Basic architecture defined | Reconciler status, AttentionQueue, Accept/Rework | Complete mock fixture suite for all states |
| **Identity & Auth** | Authorization engine invariants | Decision tester UI, principal mapping inspector | Interactive client tester with fixture engine |
| **Channels** | Initial OneBot 11 adapter | Ingress/delivery gate audit logs | Typed audit fixtures |
| **Monitor** | Process metrics | Latency trends, subsystem health rollup | Simulated telemetry fixtures |

---

## 7. Five Required Responsive Viewports

Every page, table, form, and rail must be verified against the following five canonical viewports:

| Viewport | Dimensions | Target Device | Layout Constraints |
| --- | --- | --- | --- |
| **Desktop** | `1440 × 900` | Standard Desktop / Monitor | Full 232px sidebar, side-by-side DetailRail, 3-column Trace. |
| **Laptop** | `1024 × 768` | Laptop display | Full management view; local scroll in wide tables; preserved comfort density. |
| **Tablet** | `768 × 1024` | Tablet portrait | Compact sidebar; DetailRail stacks below main content; local table scroll. |
| **Mobile** | `390 × 844` | Modern smartphone | Sidebar collapses to drawer (44px touch target); stacked cards; inputs ≥16px. |
| **Narrow Mobile** | `320 × 700` | Small smartphone / stress | Minimum responsive width. Zero page-level horizontal overflow. Local scrolling. |

---

## 8. Required Real Browser Interactions

Implementation acceptance requires real interactive browser behavior, not static templates:

1. **Table Interactions**: Sorting by column headers, multi-select, status filtering, debounced search, and pagination / virtual scrolling.
2. **DetailRail Behaviors**:
   - Open on table row selection;
   - Close on close button or `Escape` key press;
   - Focus trap and restoration to triggering element upon closure;
   - Simultaneous side-by-side view on desktop, stacked below on tablet/mobile.
3. **Trace Stream & Scrubber**:
   - Time scrubber supporting drag and point-and-click seeking;
   - Keyboard shortcuts: `j` (next event), `k` (previous event), `e` (expand/collapse event payload), `/` (search);
   - Deep-linking to specific event IDs via URL hash / params.
4. **Decision Tester**: Interactive form evaluating `Principal × Resource × Action × Context`, rendering instant visual `ALLOW` / `DENY` / `REQUIRES_APPROVAL` results with full evaluation provenance.
5. **Settings Controls**: Native checkbox switches, number inputs, select menus with instant feedback and dirty-state indicators.
6. **Mobile Navigation Drawer**: Smooth slide-in drawer with backdrop blur/overlay and focus containment.

---

## 9. Trace Scale Tiers & Large Raw Trace Handling

The Trace inspector must handle high-throughput agent runs without browser degradation:

| Scale Tier | Event Count | Performance Benchmark |
| --- | --- | --- |
| **Minimal** | 28 events | Instant rendering, full payload inspection, interactive scrubber. |
| **Standard** | 100 events | Smooth timeline scrolling (<16ms frame budget), instant search filter. |
| **Heavy** | 500 events | Virtualized list rendering, responsive scrubber without layout lag. |
| **Extreme** | 500+ events & Large Raw Trace | Virtual windowing, lazy-loaded raw JSON payloads, memory-safe event caching. |

**Architectural Separation**: The UI must strictly separate **Timeline View** (sanitized, structured events) from **Raw Trace View** (verbatim system logs). Heavy raw payloads must not be loaded into memory until explicitly requested by the user.

---

## 10. Stress Cases & Ready Acceptance Gates

### 10.1 Stress Cases Checklist
- [ ] **Long Content**: Extreme Chinese/English titles, 64-char hex hashes, deep file paths, multiline stack traces with proper text wrapping and copyable tooltips.
- [ ] **Empty States**: 0 conversations, 0 tasks, 0 runs, 0 trace events, no quota, unpriced models. Every empty state must have helpful copy and no fake zeros.
- [ ] **Disconnected & Stale States**: Clear visual indication when WebSocket is disconnected or HerdrBridge is unreachable.
- [ ] **Color-Blind Accessibility**: Chart series distinguishable by stroke dash pattern (`solid`, `dashed`, `dotted`), legends, tooltips, and tabular data fallbacks.

### 10.2 Freeze Ready Gates
Before any milestone or final delivery is accepted:
1. **IA Conformity**: Page structure and navigation match `DESIGN.md` across all 11 pages.
2. **Primitive Discipline**: All UI is composed exclusively of `UI_PRIMITIVES.md` components.
3. **Visual Fidelity**: Styling matches `glossbox_vercel_admin_v24_vercel_compliance.html`.
4. **Viewport Matrix**: All 5 viewports pass with zero page-level horizontal overflow.
5. **Keyboard & A11y**: Full tab navigation, visible blue focus rings, accessible names on icon buttons.
6. **Data Honesty**: Zero fabricated token costs or fake connection statuses.
7. **E2E Test Suite**: Playwright suite green across viewports and interaction workflows.

---

## 11. Technology Stack Intent vs. Dependency Reality

### 11.1 Intent vs. Current Repository State

| Technology | Target Role | Current Status in `apps/web/package.json` | Implementation Notes |
| --- | --- | --- | --- |
| **React 19** | Core UI library | `^19.2.0` (Installed) | Modern React 19 hooks and transitions. |
| **TanStack Router** | Client-side routing | `^1.132.0` (Installed) | Type-safe routing for 11 management pages. |
| **TanStack Start** | Full-stack SSR framework | `^1.168.49` (In dependencies, but build is SPA Vite) | Build currently uses `@vitejs/plugin-react` and SPA `index.html`. Do not assume Start SSR server is active. Keep client-first SPA portability. |
| **TanStack Query** | Server state & cache | *Not yet installed* in `origin/main` | To be introduced cleanly in frontend implementation phase for fixture/API caching. |
| **Vite** | Dev server & bundle tool | `^7.0.0` (Installed) | Fast HMR and build pipeline. |
| **tldraw** | Canvas workbench | `^5.3.2` (Installed) | Mounts at `/`. Must remain isolated from `/manage`. |
| **Vitest** | Unit & component tests | `^3.2.7` (Installed at root) | Unit testing for adapters and utilities. |
| **Playwright** | E2E browser tests | `^1.62.1` (Installed at root) | Automated multi-viewport and interaction testing. |

### 11.2 Route & Authentication Architecture
- **Preserve Canvas (`/`)**: The tldraw canvas route at `apps/web/src/routes/index.tsx` remains the core workbench and is untouched by management UI.
- **Dedicated Management Subtree (`/manage`)**: All 11 pages are mounted under `/manage/*` (e.g. `/manage/overview`, `/manage/tasks`, `/manage/trace`, etc.).
- **Management Access Invariant**: Access to `/manage` requires Owner authentication. Unauthorized visitors must see an explicit `DENY` screen without exposing management controls.

---

## 12. Delivery Roadmap & Implementation Tracking

| Phase | Description | Deliverables | Status |
| --- | --- | --- | --- |
| **Phase 0** | **Workspace & Spec Setup** | Dedicated worktree, `codex/web-management-freeze` branch, verbatim frozen docs, `README.md`, tracking Issue, Draft PR | **Completed** |
| **Phase 1** | **Primitives & Design Tokens** | Foundation tokens, typography, CSS variables, `PageShell`, buttons, badges, tables, `ChartPanel`, `DetailRail` | **Completed** |
| **Phase 2** | **Navigation & 11 Page Layouts** | TanStack route `/manage`, `ManagementRoot`, all 11 pages implemented, typed mock fixtures | **Completed** |
| **Phase 3** | **Interactive Rails & Trace** | `DetailRail` (focus/Escape), 3-column Trace (j/k/e shortcuts, scrubber), `DecisionTester` (mock simulation) | **Completed** |
| **Phase 4** | **Responsive & Stress Testing** | 5 viewports verified (1440x900, 1024x768, 768x1024, 390x844, 320x700 with zero overflow), 15 Vitest tests, 12 Playwright E2E tests, 6 visual evidence screenshots | **Completed** |
| **Phase 5** | **Live Adapter Binding & Ready Gate** | Standalone UI complete with clean FixtureAdapter and HttpApiAdapter. Pending live backend reconciler endpoints. | In Progress |

### 12.1 Verification Evidence & Audit Trail

- **Vitest Unit & Scale Tests**: 15 passed (100%), 0 failed (`apps/web/src/management/*.test.ts`).
- **Playwright E2E Multi-Viewport & Interaction Tests**: 12 passed (100%), 0 failed (`apps/web/e2e/management.spec.mjs`).
- **Visual Evidence Screenshots**:
  - `docs/ui/evidence/overview-desktop.png`: 1440x900 full overview, KPI summary, attention items, current run, sparkline trend, and model usage table.
  - `docs/ui/evidence/ops-detailrail.png`: Task truth (`REVIEW`) vs Herdr observation (`done`), task attempt history, worker bindings, and Accept/Rework actions.
  - `docs/ui/evidence/trace-inspector.png`: 3-column trace layout with run list, event timeline with scrubber, and tabbed inspector.
  - `docs/ui/evidence/permissions-tester.png`: Four hard gates summary, policy rule table, and interactive simulation.
  - `docs/ui/evidence/mobile-drawer-390x844.png`: Mobile view with open drawer menu and >=44px touch targets.
  - `docs/ui/evidence/narrow-mobile-320x700.png`: Extreme narrow responsive view with zero horizontal overflow.

> **Delivery Rule**: All frontend development occurs on branch `codex/web-management-freeze` within the dedicated worktree. No direct pushes to `main`, no premature merges, and no unverified backend modifications.
