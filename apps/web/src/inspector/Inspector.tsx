import { type ReactNode } from "react";

/* ── Public types ─────────────────────────────────────────── */

export interface ObjectMeta {
	objectType: "task" | "work" | "artifact" | "testResult" | "finalResult" | "traceSummary" | "steer" | "turnResult" | "turnAgentMessage" | "turnFinalAnswer" | "decision" | "systemInstruction";
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
	/** Current draft value for the task, or null when no draft is active. */
	draftTask: string | null;
	/** Update the draft text. Pass null to cancel / revert. */
	onDraftChange: (text: string | null) => void;
	/** Trigger Apply — fires when the user clicks Confirm. */
	onApplyTask: (task: string) => void;
	/** True while the Apply request is in flight. */
	isApplying: boolean;
	/** Current draft for the system instruction, or null when no draft. */
	draftSystemInstruction: string | null;
	/** Update the draft system instruction. Pass null to cancel. */
	onDraftSystemInstructionChange: (text: string | null) => void;
	/** Apply the system instruction (calls /edit-input). */
	onApplySystemInstruction: (value: string) => void;
}

/* ── Theme tokens ─────────────────────────────────────────── */

const accent = "#7c6ff7";
const muted = "#71717a";
const dim = "#52525b";
const textMuted = "#a1a1aa";
const textPrimary = "#d4d4d8";
const draftColor = "#fbbf24";

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
	} else if (p.task != null) {
		detail = `"${String(p.task).slice(0, 42)}"`;
	} else if (p.instruction != null) {
		detail = `"${String(p.instruction).slice(0, 42)}"`;
	} else if (p.value != null) {
		const v = String(p.value);
		detail = `"${v.slice(0, 42)}${v.length > 42 ? "…" : ""}"`;
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
			return ["thread/started", "turn/started"].includes(m ?? "");
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
			return (
				m === "action.steer" ||
				m === "action.stop" ||
				m === "action.send"
			) && p.source === "glassbox-user";
		case "turnResult":
			return m === "turn/completed" || m === "turn/started";
		case "turnAgentMessage":
			return m === "item/agentMessage/delta";
		case "turnFinalAnswer":
			return m === "item/agentMessage/final";
		default:
			return false;
	}
}

/* ── Object context rendering ─────────────────────────────── */

function ObjectFields({
	selectedObject,
	derivedState,
	draftTask,
	isApplying,
	onDraftChange,
	onApplyTask,
	draftSystemInstruction,
	onDraftSystemInstructionChange,
	onApplySystemInstruction,
}: {
	selectedObject: ObjectMeta;
	derivedState: Record<string, unknown> | null;
	draftTask: string | null;
	isApplying: boolean;
	onDraftChange: (text: string | null) => void;
	onApplyTask: (task: string) => void;
	draftSystemInstruction: string | null;
	onDraftSystemInstructionChange: (text: string | null) => void;
	onApplySystemInstruction: (value: string) => void;
}) {
	if (selectedObject.objectType === "task") {
		const appliedTask = (derivedState as { task?: string })?.task ?? "";
		const isDrafting = draftTask !== null;
		const displayTask = isDrafting ? draftTask : appliedTask;

		return (
			<Section label={isDrafting ? "Prompt (editing)" : "Prompt"}>
				<textarea
					value={displayTask}
					onChange={(e) => onDraftChange(e.target.value)}
					readOnly={isApplying}
					rows={4}
					style={{
						width: "100%",
						whiteSpace: "pre-wrap",
						fontSize: 12,
						color: textPrimary,
						background: isDrafting ? "#2a2d1f" : "transparent",
						border: isDrafting
							? `1px solid ${draftColor}`
							: "none",
						borderRadius: 4,
						padding: isDrafting ? 6 : 2,
						resize: "vertical",
						fontFamily: "inherit",
						opacity: isApplying ? 0.7 : 1,
						transition: "background 0.15s, border-color 0.15s",
					}}
				/>
				{isDrafting && (
					<>
						<div
							style={{
								fontSize: 10,
								color: draftColor,
								marginTop: 4,
								fontWeight: 600,
							}}
						>
							DRAFT — not applied
						</div>
						<div style={{ display: "flex", gap: 6, marginTop: 8 }}>
							<button
								onClick={() => onApplyTask(draftTask)}
								disabled={isApplying}
								style={{
									padding: "4px 14px",
									borderRadius: 4,
									border: "none",
									background: isApplying ? "#3b3b55" : accent,
									color: "#fff",
									fontSize: 11,
									fontWeight: 600,
									cursor: isApplying
										? "not-allowed"
										: "pointer",
									transition: "background 0.15s",
								}}
							>
								{isApplying ? "Sending…" : "Send"}
							</button>
							<button
								onClick={() => {
									if (!isApplying) onDraftChange(null);
								}}
								disabled={isApplying}
								style={{
									padding: "4px 14px",
									borderRadius: 4,
									border: "1px solid #2a2b35",
									background: isApplying
										? "#1f2028"
										: "#22232e",
									color: isApplying
										? "#52525b"
										: "#a1a1aa",
									fontSize: 11,
									fontWeight: 600,
									cursor: isApplying
										? "not-allowed"
										: "pointer",
									transition: "all 0.15s",
								}}
							>
								Cancel
							</button>
						</div>
					</>
				)}
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
						<span style={{ color: textPrimary }}>{tr?.status ?? "—"}</span>
					</div>
					{tr?.exitCode != null && (
						<div>
							Exit:{" "}
							<span style={{ color: textPrimary }}>
								{String(tr.exitCode)}
							</span>
						</div>
					)}
					{tr?.durationMs != null && (
						<div>
							Duration:{" "}
							<span style={{ color: textPrimary }}>
								{tr.durationMs}ms
							</span>
						</div>
					)}
					{tr?.aggregatedOutput && (
						<pre
							style={{
								marginTop: 6,
								color: textMuted,
								fontSize: 10,
								maxHeight: 120,
								overflowY: "auto",
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
		const fr = (derivedState as { finalResult?: { status: string; startedAt: number; completedAt: number; durationMs: number; error: string | null } | null }).finalResult;
		return (
			<Section label="Result">
				<div
					style={{
						fontFamily: "monospace",
						fontSize: 11,
						lineHeight: 1.6,
					}}
				>
					<div>
						Status:{" "}
						<span
							style={{
								color:
									fr?.status === "completed" ? "#4ade80"
									: fr?.status === "interrupted" ? "#fbbf24"
									: "#f87171",
							}}
						>
							{fr?.status ?? "—"}
						</span>
					</div>
					{fr?.durationMs != null && (
						<div>
							Duration:{" "}
							<span style={{ color: textPrimary }}>
								{(fr.durationMs / 1000).toFixed(1)}s
							</span>
						</div>
					)}
					{fr?.error && (
						<div style={{ color: "#f87171" }}>
							Error: {fr.error.slice(0, 200)}
						</div>
					)}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "turnResult") {
		const turns = (derivedState as { turns?: Array<{ taskOrInstruction: string; finalResult: { status: string; durationMs: number; error: string | null } | null; agentMessageText: string; finalAnswer: string }> }).turns ?? [];
		const idx = selectedObject.turnIndex ?? 0;
		const t = turns[idx];
		if (!t) return <Section label="Turn"><div style={{ fontSize: 11, color: muted }}>Turn data not found</div></Section>;
		return (
			<Section label="Turn Details">
				{t.finalAnswer && (
					<Section label="Answer">
						<div
							style={{
								fontSize: 11,
								color: textPrimary,
								whiteSpace: "pre-wrap",
								lineHeight: 1.5,
								padding: "6px 8px",
								background: "rgba(74, 222, 128, 0.06)",
								borderRadius: 4,
								marginBottom: 8,
							}}
						>
							{t.finalAnswer}
						</div>
					</Section>
				)}
				<div style={{ fontSize: 11, lineHeight: 1.6 }}>
					<div>
						Input:{" "}
						<span style={{ color: textPrimary }}>
							{t.taskOrInstruction || "(empty)"}
						</span>
					</div>
					{t.finalResult && (
						<div>
							Status:{" "}
							<span
								style={{
									color: t.finalResult.status === "completed" ? "#4ade80"
										: t.finalResult.status === "interrupted" ? "#fbbf24"
										: "#f87171",
								}}
							>
								{t.finalResult.status}
							</span>
							{" "}({(t.finalResult.durationMs / 1000).toFixed(1)}s)
						</div>
					)}
					{t.finalResult?.error && (
						<div style={{ color: "#f87171" }}>
							{t.finalResult.error.slice(0, 200)}
						</div>
					)}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "turnAgentMessage") {
		const turns = (derivedState as { turns?: Array<{ agentMessageText: string }> }).turns ?? [];
		const idx = selectedObject.turnIndex ?? 0;
		const t = turns[idx];
		return (
			<Section label="Agent Message">
				<pre
					style={{
						fontSize: 10,
						color: textMuted,
						maxHeight: 200,
						overflowY: "auto",
						margin: 0,
					}}
				>
					{t?.agentMessageText || "(no message yet)"}
				</pre>
			</Section>
		);
	}
	if (selectedObject.objectType === "turnFinalAnswer") {
		const turns = (derivedState as { turns?: Array<{ finalAnswer: string }> }).turns ?? [];
		const idx = selectedObject.turnIndex ?? 0;
		const t = turns[idx];
		return (
			<Section label="Answer">
				<pre
					style={{
						fontSize: 11,
						color: textPrimary,
						whiteSpace: "pre-wrap",
						maxHeight: 400,
						overflowY: "auto",
						margin: 0,
						lineHeight: 1.5,
					}}
				>
					{t?.finalAnswer || "(no answer yet)"}
				</pre>
			</Section>
		);
	}
	if (selectedObject.objectType === "traceSummary") {
		const ts = (derivedState as
			| { traceSummary?: { eventCounts?: Record<string, number>; totalEvents?: number; totalDurationMs?: number | null } }
			| null
			| undefined)?.traceSummary;
		if (!ts) return <Section label="Trace"><div style={{ fontSize: 11, color: muted }}>No trace data</div></Section>;
		return (
			<Section label="Event Counts">
				<div style={{ fontSize: 11, fontFamily: "monospace" }}>
					{Object.entries(ts.eventCounts ?? {}).map(([k, v]) => (
						<div key={k} style={{ padding: "1px 0" }}>
							<span style={{ color: muted }}>{k}:</span>{" "}
							<span style={{ color: textPrimary }}>{String(v)}</span>
						</div>
					))}
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "decision") {
		const pending = selectedObject as any;
		const itemId = pending.itemId || "";
		const reason = pending.reason || "File change requested by agent";
		const grantRoot = pending.grantRoot || "";
		return (
			<Section label="File-Change Decision">
				<div style={{ fontSize: 11, lineHeight: 1.6, marginBottom: 8 }}>
					<div><span style={{ color: muted }}>Item:</span> <span style={{ color: textPrimary, fontFamily: "monospace" }}>{itemId}</span></div>
					<div><span style={{ color: muted }}>Reason:</span> <span style={{ color: textPrimary }}>{reason}</span></div>
					{grantRoot && <div><span style={{ color: muted }}>Scope:</span> <span style={{ color: textPrimary, fontFamily: "monospace" }}>{grantRoot}</span></div>}
				</div>
				<div style={{ fontSize: 10, color: "#fbbf24", fontWeight: 600, marginBottom: 8 }}>
					NEEDS YOUR DECISION
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						onClick={() => { pending._onApprove && pending._onApprove(itemId); }}
						style={{
							padding: "6px 18px",
							borderRadius: 4,
							border: "none",
							background: "#4ade80",
							color: "#000",
							fontSize: 12,
							fontWeight: 700,
							cursor: "pointer",
						}}
					>
						Approve
					</button>
					<button
						onClick={() => { pending._onDecline && pending._onDecline(itemId); }}
						style={{
							padding: "6px 18px",
							borderRadius: 4,
							border: "none",
							background: "#f87171",
							color: "#fff",
							fontSize: 12,
							fontWeight: 700,
							cursor: "pointer",
						}}
					>
						Decline
					</button>
				</div>
			</Section>
		);
	}
	if (selectedObject.objectType === "systemInstruction") {
		const appliedInstruction = (derivedState as { systemInstruction?: string })?.systemInstruction ?? "";
		const isDrafting = draftSystemInstruction !== null;
		const displayValue = isDrafting ? draftSystemInstruction : appliedInstruction;
		const isEmpty = !appliedInstruction && !isDrafting;

		return (
			<Section label={isDrafting ? "System Instruction (editing)" : "System Instruction"}>
				{isEmpty && !isDrafting && (
					<div style={{ fontSize: 11, color: muted, marginBottom: 6 }}>empty</div>
				)}
				<textarea
					value={displayValue ?? ""}
					onChange={(e) => onDraftSystemInstructionChange(e.target.value)}
					readOnly={isApplying}
					rows={isDrafting ? 6 : 3}
					style={{
						width: "100%",
						whiteSpace: "pre-wrap",
						fontSize: 12,
						color: textPrimary,
						background: isDrafting ? "#2a2d1f" : "transparent",
						border: isDrafting
							? `1px solid ${draftColor}`
							: "none",
						borderRadius: 4,
						padding: isDrafting ? 6 : 2,
						resize: "vertical",
						fontFamily: "inherit",
						opacity: isApplying ? 0.7 : 1,
						transition: "background 0.15s, border-color 0.15s",
					}}
				/>
				{isDrafting && (
					<>
						<div
							style={{
								fontSize: 10,
								color: draftColor,
								marginTop: 4,
								fontWeight: 600,
							}}
						>
							DRAFT — not applied
						</div>
						<div style={{ display: "flex", gap: 6, marginTop: 8 }}>
							<button
								onClick={() => onApplySystemInstruction(draftSystemInstruction)}
								disabled={isApplying}
								style={{
									padding: "4px 14px",
									borderRadius: 4,
									border: "none",
									background: isApplying ? "#3b3b55" : accent,
									color: "#fff",
									fontSize: 11,
									fontWeight: 600,
									cursor: isApplying
										? "not-allowed"
										: "pointer",
									transition: "background 0.15s",
								}}
							>
								{isApplying ? "Sending…" : "Apply"}
							</button>
							<button
								onClick={() => {
									if (!isApplying) onDraftSystemInstructionChange(null);
								}}
								disabled={isApplying}
								style={{
									padding: "4px 14px",
									borderRadius: 4,
									border: "1px solid #2a2b35",
									background: isApplying
										? "#1f2028"
										: "#22232e",
									color: isApplying
										? "#52525b"
										: "#a1a1aa",
									fontSize: 11,
									fontWeight: 600,
									cursor: isApplying
										? "not-allowed"
										: "pointer",
									transition: "all 0.15s",
								}}
							>
								Cancel
							</button>
						</div>
					</>
				)}
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
	draftTask,
	isApplying,
	onDraftChange,
	onApplyTask,
	draftSystemInstruction,
	onDraftSystemInstructionChange,
	onApplySystemInstruction,
}: InspectorProps) {
	/* -- Filtered trace entries -- */
	const filtered = (() => {
		if (!selectedObject) return traceEntries.slice(-25).reverse();
		return traceEntries
			.filter((e) => matchesObject(e, selectedObject))
			.reverse();
	})();

	const hasSelection = selectedObject != null;

	/* -- Context section (shown when nothing is selected) -- */
	const overviewNode = ((): ReactNode => {
		if (hasSelection) return null;
		const ts = (derivedState as
			| { traceSummary?: { eventCounts?: Record<string, number>; totalEvents?: number; totalDurationMs?: number | null } }
			| null
			| undefined)?.traceSummary;
		if (!ts) return null;

		return (
			<>
				<Section label="Events">
					{Object.entries(ts.eventCounts ?? {}).map(([k, v]) => (
						<div
							key={k}
							style={{ fontSize: 11, color: textMuted, fontFamily: "monospace", padding: "1px 0" }}
						>
							{k}: <span style={{ color: textPrimary }}>{String(v)}</span>
						</div>
					))}
				</Section>
				<Section label="Totals">
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
				</Section>
			</>
		);
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
				<ObjectFields
					selectedObject={selectedObject}
					derivedState={derivedState}
					draftTask={draftTask}
					isApplying={isApplying}
					onDraftChange={onDraftChange}
					onApplyTask={onApplyTask}
					draftSystemInstruction={draftSystemInstruction}
					onDraftSystemInstructionChange={onDraftSystemInstructionChange}
					onApplySystemInstruction={onApplySystemInstruction}
				/>
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
