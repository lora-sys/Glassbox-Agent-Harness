// apps/web/src/inspector/Inspector.tsx
// Inspector panel: shows per-object domain details + the trace
// events that produced them.  Selection is read-only.

import { type ReactNode } from "react";

/* ── Public types ─────────────────────────────────────────── */

export interface ObjectMeta {
	objectType: "task" | "work" | "artifact" | "testResult" | "finalResult" | "traceSummary" | "steer" | "turnResult" | "turnAgentMessage";
	itemId?: string;
	turnIndex?: number;
	index?: number;
}

export interface TraceEntryLike {
	seq: number;
	ts: string;
	event: { method: string; params: Record<string, unknown> };
	provenance: string;
}

export interface InspectorProps {
	selectedObject: ObjectMeta | null;
	traceEntries: TraceEntryLike[];
	derivedState: Record<string, unknown> | null;
}

/* ── Theme tokens ─────────────────────────────────────────── */

const accent = "#7c6ff7";
const muted = "#71717a";
const dim = "#52525b";
const textMuted = "#a1a1aa";
const textPrimary = "#d4d4d8";

/* ── Small building blocks ────────────────────────────────── */

function Section({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div style={{ marginBottom: 14 }}>
			<div
				style={{
					fontSize: 10,
					fontWeight: 600,
					textTransform: "uppercase",
					letterSpacing: ".06em",
					color: dim,
					marginBottom: 4,
				}}
			>
				{label}
			</div>
			{children}
		</div>
	);
}

function TraceLine({ entry }: { entry: TraceEntryLike }) {
	const method = entry.event?.method ?? "?";
	const p = entry.event?.params ?? {};
	let detail = "";
	if (p.delta != null) {
		const s = String(p.delta);
		detail = `"${s.slice(0, 42)}${s.length > 42 ? "…" : ""}"`;
	} else if (p.path) {
		detail = String(p.path);
	} else if (p.status != null) {
		detail = String(p.status);
	} else if (p.error != null) {
		detail = JSON.stringify(p.error).slice(0, 60);
	}
	return (
		<div
			key={entry.seq}
			style={{
				fontSize: 11,
				borderBottom: "1px solid #1a1b23",
				padding: "4px 0",
			}}
		>
			<span style={{ color: dim, marginRight: 6 }}>#{entry.seq}</span>
			<span style={{ color: accent, fontFamily: "monospace" }}>
				{method}
			</span>
			{detail && (
				<div style={{ color: textMuted, padding: "1px 0 0 20px" }}>
					{detail}
				</div>
			)}
		</div>
	);
}

/* ── Trace filtering ──────────────────────────────────────── */

function matchesObject(
	e: TraceEntryLike,
	om: ObjectMeta | null,
): boolean {
	if (!om) return true;
	const m = e.event?.method;
	const p = (e.event?.params ?? {}) as Record<string, unknown>;
	switch (om.objectType) {
		case "task":
			return m === "thread/started" || m === "turn/started";
		case "work":
			return (
				["item/started", "item/agentMessage/delta"].includes(m ?? "") &&
				p.itemId === om.itemId
			);
		case "artifact":
			return m === "item/fileChange" && p.itemId === om.itemId;
		case "testResult":
			return (
				m === "item/completed" &&
				(p.item as { id?: string } | undefined)?.id === om.itemId
			);
		case "finalResult":
			return m === "turn/completed";
		case "traceSummary":
			return true;
		case "steer":
			return (m === "action.steer" || m === "action.stop") && p.source === "glassbox-user";
		case "turnResult":
			return m === "turn/completed" || m === "turn/started";
		case "turnAgentMessage":
			return m === "item/agentMessage/delta";
		default:
			return false;
	}
}

/* ── Object context rendering ─────────────────────────────── */

function ObjectFields({
	selectedObject,
	derivedState,
}: {
	selectedObject: ObjectMeta;
	derivedState: Record<string, unknown> | null;
}) {
	if (selectedObject.objectType === "task") {
		return (
			<Section label="Prompt">
				<div
					style={{
						whiteSpace: "pre-wrap",
						fontSize: 12,
						color: textPrimary,
					}}
				>
					{(derivedState as { task?: string })?.task ?? "(empty)"}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "work") {
		return (
			<Section label="Content">
				<div
					style={{
						whiteSpace: "pre-wrap",
						fontSize: 12,
						color: textPrimary,
						maxHeight: 200,
						overflowY: "auto",
					}}
				>
					{(derivedState?.currentWork as { text?: string } | null | undefined)?.text?.slice(
						0,
						1000,
					) ?? "(no content)"}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "artifact") {
		const arts = ((derivedState as { artifacts?: unknown[] })?.artifacts ??
			[]) as {
			itemId: string;
			changes: { path: string; kind: string; diff?: string }[];
		}[];
		const a = selectedObject.itemId
			? arts.find((x) => x.itemId === selectedObject.itemId)
			: undefined;
		return (
			<Section label="File Changes">
				<div style={{ fontSize: 11, fontFamily: "monospace" }}>
					{(a?.changes ?? []).map((c) => (
						<div key={c.path} style={{ marginBottom: 4 }}>
							<span style={{ color: accent }}>[{c.kind}]</span>{" "}
							<span style={{ color: "#4ade80" }}>{c.path}</span>
							{c.diff && (
								<pre
									style={{
										marginTop: 2,
										color: textMuted,
										fontSize: 10,
										maxHeight: 80,
										overflowY: "auto",
									}}
								>
									{c.diff.slice(0, 200)}
								</pre>
							)}
						</div>
					))}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "testResult") {
		const tr = (derivedState as {
			testResult?:
				| { status: string; exitCode: number | null; aggregatedOutput: string | null; durationMs: number | null }
				| null;
		}).testResult;
		return (
			<Section label="Test Output">
				<div
					style={{
						fontFamily: "monospace",
						fontSize: 11,
						lineHeight: 1.6,
					}}
				>
					<div>
						Status:{" "}
						<span style={{ color: textPrimary }}>
							{tr?.status ?? "?"}
						</span>
					</div>
					{tr?.exitCode != null && (
						<div>
							Exit:{" "}
							<span
								style={{
									color: tr.exitCode === 0 ? "#4ade80" : "#f87171",
								}}
							>
								{tr.exitCode}
							</span>
						</div>
					)}
					{tr?.durationMs != null && (
						<div>
							Duration:{" "}
							<span style={{ color: textPrimary }}>
								{tr.durationMs} ms
							</span>
						</div>
					)}
					{tr?.aggregatedOutput && (
						<pre
							style={{
								marginTop: 6,
								whiteSpace: "pre-wrap",
								maxHeight: 150,
								overflowY: "auto",
								fontSize: 10,
								color: textMuted,
							}}
						>
							{tr.aggregatedOutput.slice(0, 500)}
						</pre>
					)}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "finalResult") {
		const fr = (derivedState as {
			finalResult?:
				| { status: string; durationMs: number; error: string | null }
				| null;
		}).finalResult;
		return (
			<Section label="Turn Outcome">
				<div
					style={{
						fontFamily: "monospace",
						fontSize: 11,
						lineHeight: 1.7,
					}}
				>
					<div>
						Status:{" "}
						<span
							style={{
								color: fr?.status === "completed" ? "#4ade80" : "#f87171",
							}}
						>
							{fr?.status ?? "?"}
						</span>
					</div>
					{fr?.durationMs != null && (
						<div>
							Duration:{" "}
							<span style={{ color: textPrimary }}>
								{(fr.durationMs / 1000).toFixed(1)} s
							</span>
						</div>
					)}
					{fr?.error && (
						<div style={{ color: "#f87171" }}>
							{fr.error.slice(0, 300)}
						</div>
					)}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "turnResult") {
		const idx = selectedObject.turnIndex ?? 0;
		const turns = ((derivedState as { turns?: Array<{
			turnId: string;
			taskOrInstruction: string;
			finalResult: { status: string; durationMs: number; error: string | null } | null;
			agentMessageText: string;
		} | null> })?.turns) ?? [];
		const t = turns[idx] || turns[turns.length - 1];
		if (!t) return null;
		return (
			<Section label={"Turn " + (idx + 1) + " Outcome"}>
				<div style={{ fontFamily: "monospace", fontSize: 11, lineHeight: 1.7 }}>
					<div>Input: {t.taskOrInstruction || "(empty)"}</div>
					<div>
						Status:{" "}
						<span style={{ color: t.finalResult?.status === "completed" ? "#4ade80" : "#fbbf24" }}>
							{t.finalResult?.status ?? "running..."}
						</span>
					</div>
					{t.finalResult?.durationMs != null && (
						<div>Duration: {(t.finalResult.durationMs / 1000).toFixed(1)}s</div>
					)}
					{t.finalResult?.error && (
						<div style={{ color: "#f87171" }}>{t.finalResult.error.slice(0, 200)}</div>
					)}
					{t.agentMessageText && (
						<div style={{ marginTop: 6, color: textMuted, fontSize: 10 }}>
							{t.agentMessageText.slice(0, 200)}
						</div>
					)}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "turnAgentMessage") {
		const idx = selectedObject.turnIndex ?? 0;
		const turns = ((derivedState as { turns?: Array<{
			agentMessageText: string;
		} | null> })?.turns) ?? [];
		const t = turns[idx];
		if (!t) return null;
		return (
			<Section label={"Turn " + (idx + 1) + " Agent Message"}>
				<pre
					style={{
						whiteSpace: "pre-wrap",
						fontSize: 10,
						color: textMuted,
						maxHeight: 200,
						overflowY: "auto",
						margin: 0,
					}}
				>
					{t.agentMessageText || "(no message yet)"}
				</pre>
			</Section>
		);
	}
	if (selectedObject.objectType === "steer") {
		return (
			<Section label="Steer Instruction">
				<div style={{ whiteSpace: "pre-wrap", fontSize: 12, color: textPrimary }}>
					{(derivedState as Record<string, unknown>)?.["lastSteer"] as string || "(steer action)"}
				</div>
			</Section>
		);
	}
	return null;
}

/* ── Component ─────────────────────────────────────────────── */

export function Inspector({
	selectedObject,
	traceEntries = [],
	derivedState,
}: InspectorProps) {
	/* — Filtered trace entries — */
	const filtered = (() => {
		if (!selectedObject) return traceEntries.slice(-25).reverse();
		return traceEntries
			.filter((e) => matchesObject(e, selectedObject))
			.reverse();
	})();

	const hasSelection = selectedObject != null;

	/* -- Context section (depends on selection state) ----------- */
	const overviewNode = ((): ReactNode => {
		if (hasSelection) return null;
		const ts = (derivedState as
			| { traceSummary?: { eventCounts?: Record<string, number>; totalEvents?: number; totalDurationMs?: number | null; tokenUsage?: { totalTokens?: number | null } } }
			| null
			| undefined)?.traceSummary;
		if (!ts) return null;

		const children: ReactNode[] = [
			<Section key="events" label="Events">
				{Object.entries(ts.eventCounts ?? {}).map(([k, v]) => (
					<div
						key={k}
						style={{ fontSize: 11, color: textMuted, fontFamily: "monospace", padding: "1px 0" }}
					>
						{k}: <span style={{ color: textPrimary }}>{String(v)}</span>
					</div>
				))}
			</Section>,
			<Section key="totals" label="Totals">
				<div style={{ fontSize: 11, color: textMuted }}>
					Events: <span style={{ color: textPrimary }}>{ts.totalEvents}</span>
				</div>
				{ts.totalDurationMs != null && (
					<div style={{ fontSize: 11, color: textMuted }}>
						Duration:{" "}
						<span style={{ color: textPrimary }}>
							{(ts.totalDurationMs / 1000).toFixed(1)}s
						</span>
					</div>
				)}
				{ts.tokenUsage?.totalTokens && (
					<div style={{ fontSize: 11, color: textMuted }}>
						Tokens: <span style={{ color: textPrimary }}>{ts.tokenUsage.totalTokens}</span>
					</div>
				)}
			</Section>,
		];

		return <div key="ov">{children}</div>;
	})();

	return (
		<div style={{ fontSize: 12, color: textMuted }}>
			{/* Selection header */}
			<div
				style={{
					marginBottom: 12,
					paddingBottom: 8,
					borderBottom: "1px solid #2a2b35",
				}}
			>
				{hasSelection ? (
					<>
						<div
							style={{
								fontSize: 13,
								fontWeight: 600,
								color: textPrimary,
								textTransform: "capitalize",
							}}
						>
							{selectedObject!.objectType}
						</div>
						{selectedObject!.itemId && (
							<div
								style={{
									fontSize: 10,
									color: muted,
									fontFamily: "monospace",
									marginTop: 2,
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{selectedObject!.itemId}
							</div>
						)}
					</>
				) : (
					<div style={{ fontSize: 13, color: muted }}>
						Select an object to inspect
					</div>
				)}
			</div>

			{/* Object-specific fields */}
			{hasSelection && selectedObject && (
				<ObjectFields selectedObject={selectedObject} derivedState={derivedState} />
			)}
			{overviewNode}

			{/* Trace events */}
			<Section label={`Trace (${filtered.length})`}>
				{filtered.length === 0 ? (
					<div style={{ fontSize: 11, color: dim, padding: "4px 0" }}>
						No matching trace events
					</div>
				) : (
					filtered.map((e) => <TraceLine key={e.seq} entry={e} />)
				)}
			</Section>
		</div>
	);
}
