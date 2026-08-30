import { useEffect, useRef, useState, useCallback } from "react";
import { Tldraw, useEditor } from "tldraw";
import { toRichText } from "@tldraw/tlschema";
import "tldraw/tldraw.css";

import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";
import { Inspector, type ObjectMeta, type TraceEntryLike } from "../inspector/Inspector";

const dim = "#52525b";
const muted = "#71717a";

function textShape(id: string, x: number, y: number, text: string) {
	return {
		id,
		type: "text" as const,
		x,
		y,
		props: { richText: toRichText(text), w: 520, autoSize: true },
	};
}

function buildBoardObjects(
	state: Record<string, unknown>,
	sessionId: string,
) {
	const shapes: { kind: string; id: string; text: string; meta: ObjectMeta }[] = [];
	const meta = new Map<string, ObjectMeta>();

	// --- task ---
	if (state.task) {
		shapes.push({ kind: "task", id: "shape:task-" + sessionId.slice(0, 8), text: "Task: " + state.task, meta: { objectType: "task" } });
	}

	// --- per-turn shapes ---
	const turns = (state.turns ?? []) as {
		turnId: string;
		taskOrInstruction: string;
		finalResult: { status: string; durationMs: number; error: string | null } | null;
		agentMessageText: string;
	}[];
	for (let i = 0; i < turns.length; i++) {
		const t = turns[i];
		const label = i === 0
			? "Turn 1 (task)"
			: "Turn " + (i + 1) + " (steered: " + (t.taskOrInstruction || "(empty)") + ")";
		const statusColor = t.finalResult?.status === "completed" ? "#4ade80"
			: t.finalResult?.status === "interrupted" ? "#fbbf24"
			: t.finalResult?.status === "failed" ? "#f87171"
			: "#71717a";
		const lines = [label, statusColor + " " + (t.finalResult?.status ?? "running...")];
		if (t.finalResult?.durationMs != null) lines.push("duration: " + (t.finalResult.durationMs / 1000).toFixed(1) + "s");
		if (t.finalResult?.error) lines.push("error: " + t.finalResult.error.slice(0, 120));
		const id = "shape:turn-" + (t.turnId || ("turn" + i));
		shapes.push({ kind: "turn", id, text: lines.join("\n"), meta: { objectType: "turnResult", itemId: t.turnId, turnIndex: i } });

		if (t.agentMessageText) {
			const msgText = t.agentMessageText.length > 120 ? t.agentMessageText.slice(0, 120) + "..." : t.agentMessageText;
			const msgId = "shape:msg-" + (t.turnId || ("msg" + i));
			shapes.push({ kind: "turn-msg", id: msgId, text: "Agent: " + msgText, meta: { objectType: "turnAgentMessage", itemId: t.turnId, turnIndex: i } });
		}
	}

	// --- current work ---
	const cw = state.currentWork as { itemId: string; text: string } | null | undefined;
	if (cw?.text) {
		const txt = cw.text.length > 180 ? cw.text.slice(0, 180) + "..." : cw.text;
		shapes.push({ kind: "work", id: "shape:work-" + cw.itemId.slice(0, 8), text: "Agent: " + txt, meta: { objectType: "work", itemId: cw.itemId } });
	}

	// --- artifacts ---
	const artifacts = (state.artifacts ?? []) as { itemId: string; changes: { path: string; kind: string; diff?: string }[] }[];
	for (let i = 0; i < artifacts.length; i++) {
		const a = artifacts[i];
		const list = (a.changes ?? []).map((c: any) => "[" + (c.kind ?? "?") + "] " + c.path).join("\n");
		const id = "shape:art-" + a.itemId.slice(0, 8) + "-" + i;
		shapes.push({ kind: "art", id, text: "Artifact:\n" + (list || "(no paths)"), meta: { objectType: "artifact", itemId: a.itemId, index: i } });
	}

	// --- test result ---
	const tr = state.testResult as { itemId: string; status: string; exitCode: number | null; aggregatedOutput: string | null; durationMs: number | null } | null | undefined;
	if (tr) {
		const lines: string[] = ["Test: " + tr.status];
		if (tr.exitCode != null) lines.push("exit: " + String(tr.exitCode));
		if (tr.durationMs != null) lines.push("duration: " + String(tr.durationMs) + "ms");
		if (tr.aggregatedOutput) lines.push("out: " + tr.aggregatedOutput.slice(0, 80));
		shapes.push({ kind: "test", id: "shape:test-" + sessionId.slice(0, 8), text: lines.join("\n"), meta: { objectType: "testResult", itemId: tr.itemId } });
	}

	// --- trace summary ---
	const ts = state.traceSummary as { eventCounts?: Record<string, number>; totalEvents?: number; totalDurationMs?: number | null; tokenUsage?: { totalTokens?: number | null } } | undefined;
	if (ts?.eventCounts) {
		const lines = [
			"Trace: " + (ts.totalEvents ?? 0) + " events",
			...Object.entries(ts.eventCounts).slice(0, 6).map(([k, v]) => "  " + k + ": " + v),
			...(ts.totalDurationMs != null ? ["  duration: " + (ts.totalDurationMs / 1000).toFixed(1) + "s"] : []),
			...(ts.tokenUsage?.totalTokens ? ["  tokens: " + ts.tokenUsage.totalTokens] : []),
		];
		shapes.push({ kind: "trace", id: "shape:trace-" + sessionId.slice(0, 8), text: lines.join("\n"), meta: { objectType: "traceSummary" } });
	}

	for (const s of shapes) meta.set(s.id, s.meta);
	return { shapes, meta };
}

function applyFlowLayout(
	editor: any,
	templates: { id: string; text: string; meta: ObjectMeta }[],
	sessionId: string,
) {
	const X = 120;
	const MAX_WIDTH = 520;
	const LINE_H = 22;
	const GAP = 18;
	const PAD_Y = 14;

	function wrapLines(text: string, maxChars: number): string[] {
		const raw = text.split("\n");
		const out: string[] = [];
		for (const line of raw) {
			if (line.length <= maxChars) { out.push(line); continue; }
			let remaining = line;
			while (remaining.length > maxChars) {
				let breakAt = remaining.lastIndexOf(" ", maxChars);
				if (breakAt <= maxChars * 0.4) breakAt = maxChars;
				out.push(remaining.slice(0, breakAt));
				remaining = remaining.slice(breakAt).trimStart();
			}
			if (remaining.length > 0) out.push(remaining);
		}
		return out;
	}

	function estimateHeight(text: string): number {
		const longest = Math.max(...wrapLines(text, 90).map(l => l.length), 1);
		const growthFactor = Math.max(1, Math.ceil(longest / 65));
		const lines = text.split("\n").length * growthFactor;
		return PAD_Y + lines * LINE_H + PAD_Y;
	}

	// Pass 1: rough positioning — place each shape below the previous
	let y = 100;
	for (const t of templates) {
		const estimatedRows = Math.max(t.text.split("\n").length, Math.ceil(t.text.length / 70));
		(t as any)._y = y;
		(t as any)._h = Math.max(PAD_Y + estimatedRows * LINE_H + PAD_Y, 60);
		y = (t as any)._y + (t as any)._h + GAP;
	}
	const totalH = y - GAP;

	// Pass 2: re-measure with editor.getShapeBounds (passes actual rendered heights back)
	const tempShapes = templates.map(t => Object.assign({}, textShape(t.id, X, (t as any)._y, t.text)));
	editor.createShapes(tempShapes);
	editor.getCurrentPageShapes().forEach((s: any) => {
		if (!s || !s.id) return;
		for (const t of templates) {
			if (t.id === s.id && s.bounds) {
				y = (y = s.bounds.h) + GAP;
				(t as any)._y = s.bounds.y;
				(t as any)._h = s.bounds.h;
				break;
			}
		}
	});

	// Do a second overlap-resolution pass after measurement
	for (let i = 1; i < templates.length; i++) {
		const prev = (templates[i - 1] as any);
		const cur = (templates[i] as any);
		const prevBottom = prev._y + prev._h;
		if (cur._y < prevBottom) {
			cur._y = prevBottom + GAP;
			cur._h = Math.max(cur._h, PAD_Y + 40);
		}
	}
	const totalH2 = templates.length > 0 ? (templates[templates.length - 1] as any)._y + (templates[templates.length - 1] as any)._h + GAP : y;

	// Clean temp shapes and build final positioned shapes
	editor.deleteShapes(editor.getCurrentPageShapes().map((s: any) => s.id));

	const positioned = templates.map(t => {
		const textShape_ = textShape(t.id, X, (t as any)._y, t.text) as any;
		return Object.assign({}, textShape_, {
			x: X,
			y: (t as any)._y,
		});
	});

	return { shapes: positioned, meta: new Map(templates.map(t => [t.id, t.meta])), totalHeight: Math.max(totalH2, y) };
}

function BoardLayer({
	editorRef,
	onSelectionChange,
}: {
	editorRef: React.RefObject<any>;
	onSelectionChange: (id: string | null) => void;
}) {
	const editor = useEditor();
	const cbRef = useRef(onSelectionChange);
	cbRef.current = onSelectionChange;

	useEffect(() => {
		editorRef.current = editor;
		(globalThis as any).__glassboxEditor = editor;

		const unsub = editor.store.listen(() => {
			const ids = editor.getSelectedShapeIds();
			if (ids.length === 1 || ids.length === 0) {
				cbRef.current(ids.length === 1 ? ids[0] : null);
			}
		});

		const init = editor.getSelectedShapeIds();
		if (init.length === 1) {
			onSelectionChange(init[0]);
		}

		return unsub;
	}, [editor]);

	return null;
}

function App() {
	const editorRef = useRef<any>(null);
	const wsRef = useRef<WebSocket | null>(null);

	const [connected, setConnected] = useState(false);
	const [running, setRunning] = useState(false);
	const [prompt, setPrompt] = useState("say ready");
	const [log, setLog] = useState<string[]>([]);

	const [localState, setLocalState] = useState<Record<string, unknown> | null>(null);
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
	const [steerText, setSteerText] = useState("");

	const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null);
	const [selectedObject, setSelectedObject] = useState<ObjectMeta | null>(null);
	const [traceEntries, setTraceEntries] = useState<TraceEntryLike[]>([]);
	const [traceLoading, setTraceLoading] = useState(false);

	// S7: Editable task — draft state lives in the parent so it survives
	// selection changes and is easy to reset on session switches.
	const [draftTask, setDraftTask] = useState<string | null>(null);
	const [isApplying, setIsApplying] = useState(false);

	// S8: Pending file-change decisions from codex, surfaced for the user.
	const [pendingDecisions, setPendingDecisions] = useState<Array<{
		itemId: string;
		turnId: string;
		threadId: string;
		reason: string | null;
		grantRoot: string | null;
		startedAtMs: number;
	}>>([]);
	const [demoWorkspace, setDemoWorkspace] = useState("/tmp/glassbox-demo-repo");

	// Ref to always-access latest handleDecide without re-triggering useEffect
	const handleDecideRef = useRef<((itemId: string, approved: boolean) => void) | null>(null);

	const shapeIdsRef = useRef<string[]>([]);
	const sessionMetaRef = useRef(new Map<string, Map<string, ObjectMeta>>());
	const tracedSessionsRef = useRef(new Set<string>());
	const traceCacheRef = useRef(new Map<string, TraceEntryLike[]>());
	const currentSidRef = useRef<string | null>(null);
	currentSidRef.current = currentSessionId;

	// P2.4: Session setup state
	const [showSetup, setShowSetup] = useState(false);
	const [provider, setProvider] = useState(function() {
		try {
			return localStorage.getItem("glassbox:provider") || "codex";
		} catch { return "codex"; }
	});
	const [approvalPolicy, setApprovalPolicy] = useState("on-request");
	const [sandboxType, setSandboxType] = useState("read-only");
	const [permissionMode, setPermissionMode] = useState("default");
	const [repoPath, setRepoPath] = useState("/tmp/glassbox-t2.2");
	const [resolvedPath, setResolvedPath] = useState<string | null>(null);
	const [pathError, setPathError] = useState<string | null>(null);

	// Persist provider preference
	useEffect(function() {
		try { localStorage.setItem("glassbox:provider", provider); } catch {}
	}, [provider]);

	// Validate repo path on change (client-side only; server is authoritative)
	useEffect(function() {
		setPathError(null);
		setResolvedPath(null);
		if (!repoPath) return;
		if (repoPath.includes("Glassbox-Agent-Harness")) {
			setPathError("Glassbox repo path is not allowed");
			return;
		}
		if (repoPath === "~/.glassbox" || repoPath.startsWith("~/.glassbox/")) {
			setPathError("~/.glassbox is reserved");
			return;
		}
		setResolvedPath(repoPath);
	}, [repoPath]);


	const addLog = useCallback((msg: string) => {
		setLog((prev) => [
			...prev.slice(-50),
			new Date().toLocaleTimeString() + " " + msg,
		]);
	}, []);

	// Persist sessionId to URL + localStorage when it changes
	useEffect(() => {
		if (!currentSessionId) return;
		const url = new URL(window.location.href);
		url.searchParams.set("session", currentSessionId);
		history.replaceState(null, "", url.toString());
		try {
			localStorage.setItem("glassbox:lastSessionId", currentSessionId);
		} catch {}
	}, [currentSessionId]);

	// Initialize from existing session on mount (reload or open with session URL)
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const fromUrl = params.get("session");
		let fromStorage: string | null = null;
		try { fromStorage = localStorage.getItem("glassbox:lastSessionId"); } catch {}
		const sessionId = fromUrl || fromStorage;
		if (!sessionId) return;

		addLog("Restoring session " + sessionId.slice(0, 8) + "...");

		(async function restore() {
			try {
				var stateRes = await fetch("/api/state/" + sessionId);
				var traceRes = await fetch("/api/trace/" + sessionId);
				if (!stateRes.ok) {
					addLog("Session not found: " + sessionId.slice(0, 8));
					return;
				}
				var stateData = await stateRes.json();
				var derivedState = stateData?.derivedState ?? null;

				if (traceRes.ok) {
					var traceData = await traceRes.json();
					var entries = (traceData?.entries ?? []) as TraceEntryLike[];
					traceCacheRef.current.set(sessionId, entries);
				}

				setCurrentSessionId(sessionId);
				setLocalState(derivedState);
				addLog("Session restored from trace");
			} catch (err: any) {
				addLog("Restore error: " + (err?.message || String(err)));
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Apply shapes whenever [sessionId, state] changes
	useEffect(() => {
		var ed = editorRef.current;
		if (!ed || !currentSessionId || !localState) return;

		// Clean ALL canvas shapes (include stale shapes from previous sessions/turns).
		var pageShapes = ed.getCurrentPageShapes();
		if (pageShapes.length > 0) {
			ed.deleteShapes(pageShapes.map(function(s: any) { return s.id; }));
		}

		var templates = buildBoardObjects(localState, currentSessionId);
		var result = applyFlowLayout(ed, templates.shapes, currentSessionId);
		ed.createShapes(result.shapes.map(function(s: any) { return Object.assign({}, s); }));
		shapeIdsRef.current = result.shapes.map(function(s: any) { return s.id; });
		sessionMetaRef.current.set(currentSessionId, result.meta);

		try {
			ed.zoomToFit({ target: "viewport", padding: 20 }).catch(function() {});
		} catch {}
	}, [currentSessionId, localState]);

	// S8: Render pending decision shapes on the canvas
	useEffect(() => {
		var ed = editorRef.current;
		if (!ed || !currentSessionId || !localState) return;

		var sid = currentSessionId;
		var meta = sessionMetaRef.current.get(sid) || new Map();

		// Remove old decision shapes
		var existingIds = shapeIdsRef.current.filter(function(id: string) {
			return id.startsWith("shape:decision-");
		});
		if (existingIds.length > 0) {
			ed.deleteShapes(existingIds);
			existingIds.forEach(function(id: string) {
				shapeIdsRef.current = shapeIdsRef.current.filter(function(x: string) { return x !== id; });
				meta.delete(id);
			});
		}

		if (pendingDecisions.length === 0) {
			sessionMetaRef.current.set(sid, meta);
			return;
		}

		var X = 120;
		var y = 100;
		var shapes: any[] = [];

		// Put decisions below existing shapes
		var allShapes = ed.getCurrentPageShapes();
		for (var s of allShapes) {
			if (s.type === "text" && s.y != null) {
				var bottom = (s.y || 0) + 60;
				if (bottom > y) y = bottom;
			}
		}

		pendingDecisions.forEach(function(dec: any, idx: number) {
			var shapeId = "shape:decision-" + dec.itemId.slice(0, 8);
			var reason = (dec.reason || "File change").slice(0, 60);
			var text = "DECISION NEEDED\n[fileChange] " + reason + "\nClick to Approve or Decline";
			var shape = {
				id: shapeId,
				type: "text",
				x: X,
				y: y,
				props: { richText: toRichText(text), w: 480, autoSize: true },
			};
			shapes.push(shape);
			meta.set(shapeId, {
				objectType: "decision",
				itemId: dec.itemId,
				reason: dec.reason,
				grantRoot: dec.grantRoot,
				_onApprove: function(itemId: string) { handleDecideRef.current && handleDecideRef.current(itemId, true); },
				_onDecline: function(itemId: string) { handleDecideRef.current && handleDecideRef.current(itemId, false); },
			} as any);
			y += 100;
		});

		ed.createShapes(shapes);
		var newIds = shapes.map(function(s: any) { return s.id; });
		shapeIdsRef.current = shapeIdsRef.current.concat(newIds);
		sessionMetaRef.current.set(sid, meta);
	}, [currentSessionId, localState, pendingDecisions, handleDecideRef]);

	// Selection -> Inspector (read-only for most objects)
	var handleSelection = useCallback(function(sId: string | null) {
		setSelectedShapeId(sId);
		if (!sId) {
			setSelectedObject(null);
			setDraftTask(null); // S7: cancel draft on deselection
			return;
		}
		var sid = currentSidRef.current;
		if (!sid) {
			setSelectedObject(null);
			return;
		}
		var obj = sessionMetaRef.current.get(sid)?.get(sId) ?? null;
		setSelectedObject(obj);
		// S7: reset draft when switching object type (only task supports editing)
		if (obj?.objectType !== "task") {
			setDraftTask(null);
		}
	}, []);

	// Lazy trace fetch (cached per session)
	useEffect(() => {
		if (!currentSessionId || selectedShapeId === null) return;
		var sid = currentSessionId;
		if (tracedSessionsRef.current.has(sid)) return;
		setTraceLoading(true);
		fetch("/api/trace/" + sid)
			.then(function(r: any) { return r.json(); })
			.then(function(data: any) {
				var entries = (data?.entries ?? []) as TraceEntryLike[];
				traceCacheRef.current.set(sid, entries);
				setTraceEntries(entries);
				tracedSessionsRef.current.add(sid);
				setTraceLoading(false);
			})
			.catch(function() {
				setTraceLoading(false);
			});
	}, [currentSessionId, selectedShapeId]);

	var entries =
		currentSessionId != null
			? traceCacheRef.current.get(currentSessionId) ?? traceEntries
			: [];

	// WS resubscribe helper
	var resubscribe = useCallback(function(sessionId: string) {
		var ed = editorRef.current;
		if (ed && shapeIdsRef.current.length > 0) {
			ed.deleteShapes(shapeIdsRef.current);
			shapeIdsRef.current = [];
		}
		setCurrentSessionId(sessionId);
		setLocalState(null);
		setSelectedShapeId(null);
		setSelectedObject(null);
		tracedSessionsRef.current.delete(sessionId);
		traceCacheRef.current.delete(sessionId);

		if (wsRef.current) {
			wsRef.current.close();
			wsRef.current = null;
		}

		(async function load() {
			try {
				var stateRes = await fetch("/api/state/" + sessionId);
				var traceRes = await fetch("/api/trace/" + sessionId);
				if (!stateRes.ok) {
					addLog("Session not found: " + sessionId.slice(0, 8));
					return;
				}
				var stateData = await stateRes.json();
				var derivedState = stateData?.derivedState ?? null;

				if (traceRes.ok) {
					var traceData = await traceRes.json();
					var entries = (traceData?.entries ?? []) as TraceEntryLike[];
					traceCacheRef.current.set(sessionId, entries);
				}

				setLocalState(derivedState);
				addLog("Loaded session " + sessionId.slice(0, 8));
			} catch (err: any) {
				addLog("Load session error: " + (err?.message || String(err)));
			}
		})();

		try {
			var ws = new WebSocket("/ws?sessionId=" + sessionId);
			wsRef.current = ws;

			ws.onopen = function() {
				setConnected(true);
				addLog("WS resubscribed to " + sessionId.slice(0, 8));
			};
			ws.onmessage = function(ev: MessageEvent) {
				var msg: any;
				try { msg = JSON.parse(ev.data); } catch { return; }
				switch (msg.type) {
					case "subscribed":
						addLog("Resubscribed");
						break;
					case "error":
						addLog("WS: " + msg.message);
						break;
					case "sessionEnded":
						ws.close();
						setConnected(false);
						setRunning(false);
						break;
					case "event": {
						var method = msg.event?.method;
						var p = msg.event?.params ?? {};
						if (method === "item/agentMessage/delta" && localState?.currentWork) {
							setLocalState(function(prev: any) {
								return prev && prev.currentWork
									? Object.assign({}, prev, {
											currentWork: Object.assign({}, prev.currentWork, {
												text: prev.currentWork.text + (p.delta ?? ""),
											}),
										})
									: prev;
							});
						}
						break;
					}
					case "derivedState":
						addLog("Derived -> canvas");
						setLocalState(msg.derivedState ?? {});
						break;
				}
			};
			ws.onerror = function() { addLog("WS error"); };
			ws.onclose = function() {
				setConnected(false);
				setRunning(false);
				addLog("WS closed");
			};
		} catch (err: any) {
			addLog("WS: " + (err?.message || String(err)));
		}
	}, [addLog, localState]);

	// Run test
	var handleRunTest = useCallback(async function run() {
		setRunning(true);
		setLog([]);
		setSelectedShapeId(null);
		setSelectedObject(null);
		var ed = editorRef.current;
		if (ed && shapeIdsRef.current.length > 0) {
			ed.deleteShapes(shapeIdsRef.current);
			shapeIdsRef.current = [];
		}
		setLocalState(null);
		tracedSessionsRef.current.clear();
		traceCacheRef.current.clear();
		addLog("Starting /run-test...");

		var sessionId: string;
		try {
			var res = await fetch("/api/run-stream", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					prompt: prompt,
					provider: provider,
					repoPath: repoPath,
					approvalPolicy: approvalPolicy,
					sandboxPolicy: sandboxType,
					permissionMode: permissionMode,
				}),
			});
			var respText = await res.text();
			console.error("[e2e] fetch status=" + res.status + " body=" + respText.slice(0, 200));
			if (!res.ok) throw new Error("HTTP " + res.status + ": " + respText.slice(0, 200));
			var data: any = JSON.parse(respText);
			if (data.error) throw new Error(data.error);
			sessionId = data.sessionId;
			setCurrentSessionId(sessionId);
			setLocalState(data.derivedState ?? {});
			addLog("Session " + sessionId.slice(0, 8) + "...");
		} catch (err: any) {
			addLog("Error: " + (err?.message || String(err)));
			setRunning(false);
			return;
		}

		try {
			var ws = new WebSocket("/ws?sessionId=" + sessionId);
			wsRef.current = ws;

			ws.onopen = function() {
				setConnected(true);
				addLog("WS connected");
			};
			ws.onmessage = function(ev: MessageEvent) {
				var msg: any;
				try { msg = JSON.parse(ev.data); } catch { return; }
				switch (msg.type) {
					case "subscribed":
						addLog("Subscribed");
						break;
					case "error":
						addLog("WS: " + msg.message);
						break;
					case "sessionEnded":
						ws.close();
						setConnected(false);
						setRunning(false);
						break;
					case "derivedState":
						addLog("Derived -> canvas");
						setLocalState(msg.derivedState ?? {});
						break;
				}
			};
			ws.onerror = function() { addLog("WS error"); };
			ws.onclose = function() {
				setConnected(false);
				setRunning(false);
				addLog("WS closed");
			};
		} catch (err: any) {
			addLog("WS: " + (err?.message || String(err)));
			setRunning(false);
		}
	}, [prompt, addLog, provider, repoPath, approvalPolicy, sandboxType, permissionMode]);
	// Pause: end turn but keep session open for steering
	var handlePause = useCallback(async function pause() {
		if (!currentSessionId) return;
		addLog("Pausing turn...");
		try {
			var res = await fetch("/api/pause", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: currentSessionId }),
			});
			if (!res.ok) {
				var errData: any = await res.json();
				throw new Error(errData.error || "HTTP " + res.status);
			}
			var data: any = await res.json();
			addLog("Paused: " + (data.paused ? "yes" : "already idle"));
			if (data.derivedState) setLocalState(data.derivedState);
		} catch (err: any) {
			addLog("Pause error: " + (err?.message || String(err)));
		}
	}, [currentSessionId, addLog]);

	// Stop: interrupt active turn
	var handleStop = useCallback(async function stop() {
		if (!currentSessionId) return;
		addLog("Stopping turn...");
		try {
			var res = await fetch("/api/stop", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: currentSessionId }),
			});
			if (!res.ok) {
				var errData: any = await res.json();
				throw new Error(errData.error || "HTTP " + res.status);
			}
			var data: any = await res.json();
			addLog("Stopped: " + (data.stopped ? "yes" : "already idle"));
			if (data.derivedState) setLocalState(data.derivedState);
		} catch (err: any) {
			addLog("Stop error: " + (err?.message || String(err)));
		}
	}, [currentSessionId, addLog]);

	// Steer: send steering instruction
	var handleSteer = useCallback(async function steer() {
		if (!steerText.trim() || !currentSessionId) return;
		addLog("Steering: \"" + steerText.slice(0, 40) + "\"");
		setRunning(true);
		try {
			var res = await fetch("/api/steer", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: currentSessionId,
					instruction: steerText.trim(),
				}),
			});
			if (!res.ok) {
				var errData: any = await res.json();
				throw new Error(errData.error || "HTTP " + res.status);
			}
			var data: any = await res.json();
			addLog("Steered, turn " + data.turnId?.slice(0, 8) + " started");
			if (data.derivedState) setLocalState(data.derivedState);
		} catch (err: any) {
			addLog("Steer error: " + (err?.message || String(err)));
		}
		setSteerText("");
	}, [currentSessionId, steerText, addLog]);

	// S7: Send edited task — starts a new turn on the same thread
	var handleSendTask = useCallback(async function sendTask(taskText: string) {
		if (!currentSessionId) return;
		setIsApplying(true);
		try {
			var res = await fetch("/api/send-task", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sessionId: currentSessionId,
					task: taskText,
				}),
			});
			if (!res.ok) {
				var errData: any = await res.json();
				throw new Error(errData.error || "HTTP " + res.status);
			}
			var data: any = await res.json();
			setDraftTask(null);
			addLog("Sent: new turn " + data.turnId?.slice(0, 8) + " with edited task");
			if (data.derivedState) setLocalState(data.derivedState);
		} catch (err: any) {
			addLog("Send error: " + (err?.message || String(err)));
		} finally {
			setIsApplying(false);
		}
	}, [currentSessionId, addLog]);

	// S8: Run demo task — starts a session against the controlled demo workspace
	var handleRunDemo = useCallback(async function runDemo() {
		setRunning(true);
		setLog([]);
		setSelectedShapeId(null);
		setSelectedObject(null);
		setPendingDecisions([]);
		var ed = editorRef.current;
		if (ed && shapeIdsRef.current.length > 0) {
			ed.deleteShapes(shapeIdsRef.current);
			shapeIdsRef.current = [];
		}
		setLocalState(null);
		tracedSessionsRef.current.clear();
		traceCacheRef.current.clear();
		addLog("Starting /run-demo against " + demoWorkspace + "...");

		var sessionId: string;
		try {
			var res = await fetch("/api/run-demo", {
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					prompt: prompt || "Fix the off-by-one bug in utils.js and run the test file to verify.",
					provider: provider,
					repoPath: repoPath,
					approvalPolicy: "on-request",
					sandboxPolicy: "workspace-write",
					permissionMode: permissionMode,
				}),
			});
			if (!res.ok) throw new Error("HTTP " + res.status);
			var data: any = await res.json();
			if (data.error) throw new Error(data.error);
			sessionId = data.sessionId;
			setCurrentSessionId(sessionId);
			if (data.derivedState) setLocalState(data.derivedState);
			addLog("Session " + sessionId.slice(0, 8) + " started on workspace " + (data.workspace || ""));
		} catch (err: any) {
			addLog("Error: " + (err?.message || String(err)));
			setRunning(false);
			return;
		}

		// Same WS setup as handleRunTest
		try {
			var ws = new WebSocket("/ws?sessionId=" + sessionId);
			wsRef.current = ws;

			ws.onopen = function() {
				setConnected(true);
				addLog("WS connected");
			};
			ws.onmessage = function(ev: MessageEvent) {
				var msg: any;
				try { msg = JSON.parse(ev.data); } catch { return; }
				switch (msg.type) {
					case "subscribed":
						addLog("Subscribed");
						break;
					case "error":
						addLog("WS: " + msg.message);
						break;
					case "sessionEnded":
						ws.close();
						setConnected(false);
						setRunning(false);
						break;
					case "approval": {
						// S8: file-change decision request from codex
						var approval = msg;
						setPendingDecisions(function(prev) {
							// Avoid duplicates by itemId
							if (prev.some(function(d) { return d.itemId === approval.itemId; })) return prev;
							return prev.concat([{
								itemId: approval.itemId,
								turnId: approval.turnId || "",
								threadId: approval.threadId || "",
								reason: approval.reason,
								grantRoot: approval.grantRoot,
								startedAtMs: approval.startedAtMs,
							}]);
						});
						addLog("Decision needed: " + (approval.reason || "file change") + " [" + approval.itemId + "]");
						break;
					}
					case "derivedState":
						setLocalState(msg.derivedState ?? {});
						break;
					case "event": {
						var method2 = msg.event?.method;
						var p2 = msg.event?.params ?? {};
						if (method2 === "action.decide" || method2 === "actionDecide") {
							// Remove from pending decisions
							setPendingDecisions(function(prev) {
								return prev.filter(function(d) { return d.itemId !== p2.itemId; });
							});
							addLog("Decided: " + (p2.approved ? "approved" : "declined") + " " + p2.itemId);
						}
						break;
					}
				}
			};
			ws.onerror = function() { addLog("WS error"); };
			ws.onclose = function() {
				setConnected(false);
				setRunning(false);
				addLog("WS closed");
			};
		} catch (err: any) {
			addLog("WS: " + (err?.message || String(err)));
			setRunning(false);
		}
	}, [prompt, demoWorkspace, provider, approvalPolicy, sandboxType, permissionMode, addLog]);

	// S8: Handle user Approve/Decline decision for a file-change request
	var handleDecide = useCallback(async function decide(itemId: string, approved: boolean) {
		if (!currentSessionId) return;
		addLog(approved ? "Approving " + itemId : "Declining " + itemId);
		try {
			var res = await fetch("/api/decide", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sessionId: currentSessionId, itemId: itemId, approved: approved }),
			});
			if (!res.ok) {
				var errData: any = await res.json();
				throw new Error(errData.error || "HTTP " + res.status);
			}
			var data: any = await res.json();
			// Remove from pending decisions locally
			setPendingDecisions(function(prev) {
				return prev.filter(function(d) { return d.itemId !== itemId; });
			});
			if (data.derivedState) setLocalState(data.derivedState);
			addLog("Decision recorded: " + (approved ? "approved" : "declined"));
		} catch (err: any) {
			addLog("Decide error: " + (err?.message || String(err)));
		}
		handleDecideRef.current = handleDecide;
	}, [currentSessionId, addLog]);
	var sessionInputState = useState("");
	var sessionInput = sessionInputState[0];
	var setSessionInput = sessionInputState[1];

	var handleReopenSession = useCallback(function() {
		var sid = sessionInput.trim();
		if (!sid) return;
		resubscribe(sid);
	}, [sessionInput, resubscribe]);

	// Unmount cleanup
	useEffect(function() {
		return function() {
			if (wsRef.current && wsRef.current.readyState < 2) {
				try { wsRef.current.close(); } catch {}
			}
			shapeIdsRef.current = [];
		};
	}, []);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100vh",
				width: "100vw",
			}}
		>
			{/* Header */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 12,
					padding: "8px 16px",
					background: "#1a1b23",
					borderBottom: "1px solid #2a2b35",
					zIndex: 100,
					flexShrink: 0,
				}}
			>
					{/* P2.4: Setup toggle */}
					<button
						onClick={function() { setShowSetup(!showSetup); }}
						title="Session setup: provider, permissions, workspace"
						style={{
							padding: "3px 7px",
							borderRadius: 4,
							border: showSetup ? "1px solid #7c6ff7" : "1px solid #2a2b35",
							background: showSetup ? "#2a2545" : "#22232e",
							color: showSetup ? "#a594f7" : "#71717a",
							fontSize: 12,
							cursor: "pointer",
							transition: "all 0.15s",
							display: "flex",
							alignItems: "center",
							gap: 3,
						}}
					>
						⚙ {showSetup ? "Close" : "Setup"}
					</button>
				<span
					style={{
						fontWeight: 700,
						fontSize: 15,
						letterSpacing: "-0.02em",
						color: "#7c6ff7",
					}}
				>
					Glassbox
				</span>
				<input
					type="text"
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					disabled={running}
					placeholder="Enter a task..."
					style={{
						flex: 1,
						maxWidth: 400,
						padding: "6px 12px",
						borderRadius: 6,
						border: "1px solid #2a2b35",
						background: "#0f1117",
						color: "#e4e4d7",
						fontSize: 13,
						outline: "none",
					}}
				/>
				<button
					onClick={handleRunTest}
					disabled={running}
					style={{
						padding: "6px 18px",
						borderRadius: 6,
						border: "none",
						background: running ? "#3b3b55" : "#7c6ff7",
						color: "#fff",
						fontSize: 13,
						fontWeight: 600,
						cursor: running ? "not-allowed" : "pointer",
						transition: "background 0.15s",
					}}
				>
					{running ? "Stop" : "Run test"}
				</button>
				<button
					onClick={handleRunDemo}
					disabled={running}
					title="Run demo task against controlled workspace"
					style={{
						padding: "6px 18px",
						borderRadius: 6,
						border: "1px solid #4ade80",
						background: running ? "#1a2a1a" : "#1a332a",
						color: running ? "#52525b" : "#4ade80",
						fontSize: 12,
						fontWeight: 600,
						cursor: running ? "not-allowed" : "pointer",
						transition: "all 0.15s",
						whiteSpace: "nowrap",
					}}
				>
					{running ? "Running..." : "Run demo"}
				</button>
				<input
					type="text"
					value={demoWorkspace}
					onChange={(e) => setDemoWorkspace(e.target.value)}
					disabled={running}
					placeholder="/tmp/glassbox-demo-repo"
					style={{
						width: 200,
						padding: "5px 8px",
						borderRadius: 4,
						border: "1px solid #2a2b35",
						background: "#0f1117",
						color: "#a1a1aa",
						fontSize: 10,
						fontFamily: "monospace",
						outline: "none",
					}}
				/>
				<span style={{ fontSize: 9, color: "#52525b" }}>workspace</span>
				{currentSessionId && (
					<>
						<button
							onClick={handleStop}
							disabled={!running}
							title="Stop active turn"
							style={{
								padding: "6px 12px",
								borderRadius: 6,
								border: running ? "1px solid #fbbf24" : "1px solid #2a2b35",
								background: running ? "#3d2600" : "#22232e",
								color: running ? "#fbbf24" : "#52525b",
								fontSize: 13,
								fontWeight: 600,
								cursor: running ? "pointer" : "not-allowed",
								transition: "all 0.15s",
							}}
						>
							Stop
						</button>
							<button
					onClick={handlePause}
					disabled={!running}
					title="Pause: end turn, keep session for steering"
					style={{
				padding: "6px 12px",
				borderRadius: 6,
				border: running ? "1px solid #fbbf24" : "1px solid #2a2b35",
				background: running ? "#3d2d00" : "#22232e",
				color: running ? "#fbbf24" : "#52525b",
				fontSize: 13,
				fontWeight: 600,
				cursor: running ? "pointer" : "not-allowed",
				transition: "all 0.15s",
					}}
							>
								Pause
							</button>
						<input
							type="text"
							value={steerText}
							onChange={(e) => setSteerText(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") handleSteer(); }}
							placeholder="Steer: type instruction..."
							style={{
								width: 200,
								padding: "6px 10px",
								borderRadius: 6,
								border: currentSessionId ? "1px solid #2a2b35" : "1px solid #1a1b23",
								background: "#0f1117",
								color: "#e4e4d7",
								fontSize: 12,
								outline: "none",
							}}
						/>
						<button
							onClick={handleSteer}
							disabled={!currentSessionId || !steerText.trim()}
							style={{
								padding: "6px 12px",
								borderRadius: 6,
								border: "none",
								background: currentSessionId && steerText.trim() ? "#7c6ff7" : "#3b3b55",
								color: "#fff",
								fontSize: 12,
								fontWeight: 600,
								cursor: currentSessionId && steerText.trim() ? "pointer" : "not-allowed",
								transition: "background 0.15s",
							}}
						>
							Steer
						</button>
					</>
				)}
				<span
					style={{
						fontSize: 11,
						color: connected ? "#4ade80" : "#71717a",
						minWidth: 60,
					}}
				>
					{connected ? "WS live" : "idle"}
				</span>
				<input
					type="text"
					value={sessionInput}
					onChange={(e) => setSessionInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && handleReopenSession()}
					placeholder="Reopen session..."
					style={{
						width: 180,
						padding: "4px 8px",
						borderRadius: 4,
						border: "1px solid #2a2b35",
						background: "#0f1117",
						color: "#a1a1aa",
						fontSize: 11,
						fontFamily: "monospace",
						outline: "none",
					}}
				/>
				<button
					onClick={handleReopenSession}
					disabled={!sessionInput.trim()}
					style={{
						padding: "4px 10px",
						borderRadius: 4,
						border: "1px solid #2a2b35",
						background: "#22232e",
						color: "#a1a1aa",
						fontSize: 11,
						cursor: sessionInput.trim() ? "pointer" : "not-allowed",
					}}
				>
					Open
				</button>
			</div>

				{/* P2.4: Collapsible session setup bar */}
				{showSetup && (
					<div style={{
						display: "flex",
						alignItems: "center",
						gap: 12,
						padding: "6px 16px",
						background: "#14151d",
						borderBottom: "1px solid #2a2b35",
						flexShrink: 0,
						flexWrap: "wrap",
					}}>
						{/* Provider picker */}
						<select
							value={provider}
							onChange={function(e) { setProvider((e.target as HTMLSelectElement).value); }}
							title="Provider"
							style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #2a2b35", background: "#0f1117", color: "#e4e4d7", fontSize: 12 }}
						>
							<option value="codex">codex</option>
							<option value="claude-code">claude-code</option>
						</select>

						{/* Provider-aware permission controls */}
						{provider === "codex" ? (
							<>
								<select value={approvalPolicy} onChange={function(e) { setApprovalPolicy((e.target as HTMLSelectElement).value); }} title="Codex approval policy"
									style={{ padding: "4px 8px", borderRadius: 4, border: "1px solid #2a2b35", background: "#0f1117", color: "#e4e4d7", fontSize: 12 }}>
									<option value="untrusted">Approval: untrusted (ask per file)</option>
									<option value="on-request">Approval: on-request</option>
									<option value="never">Approval: never (hands-off)</option>
								</select>
								<select value={sandboxType} onChange={function(e) { setSandboxType((e.target as HTMLSelectElement).value); }} title="Codex sandbox"
									style={{ padding: "4px 8px", borderRadius: 4, border: sandboxType === "danger-full-access" ? "1px solid #f87171" : "1px solid #2a2b35", background: sandboxType === "danger-full-access" ? "#2a1515" : "#0f1117", color: sandboxType === "danger-full-access" ? "#f87171" : "#e4e4d7", fontSize: 12 }}>
									<option value="read-only">Sandbox: readOnly</option>
									<option value="workspace-write">Sandbox: workspaceWrite</option>
									<option value="danger-full-access">Sandbox: dangerFullAccess ⚠</option>
								</select>
							</>
						) : (
							<select value={permissionMode} onChange={function(e) { setPermissionMode((e.target as HTMLSelectElement).value); }} title="Claude-code permission mode"
								style={{ padding: "4px 8px", borderRadius: 4, border: permissionMode === "bypassPermissions" ? "1px solid #f87171" : "1px solid #2a2b35", background: permissionMode === "bypassPermissions" ? "#2a1515" : "#0f1117", color: permissionMode === "bypassPermissions" ? "#f87171" : "#e4e4d7", fontSize: 12 }}>
								<option value="default">Permission: default</option>
								<option value="plan">Permission: plan</option>
								<option value="manual">Permission: manual (full manual)</option>
								<option value="acceptEdits">Permission: acceptEdits</option>
								<option value="auto">Permission: auto</option>
								<option value="bypassPermissions">Permission: bypassPermissions ⚠</option>
							</select>
						)}

						{/* Repo path input with guardrails */}
						<input type="text" value={repoPath} onChange={function(e) { setRepoPath(e.target.value); setPathError(null); }} placeholder="Repo path (or use default)"
							style={{ width: 200, padding: "4px 8px", borderRadius: 4, border: pathError ? "1px solid #f87171" : "1px solid #2a2b35", background: "#0f1117", color: pathError ? "#f87171" : "#e4e4d7", fontSize: 11, fontFamily: "monospace", outline: "none" }} />
						{resolvedPath && !pathError && <span style={{ fontSize: 10, color: "#52525b" }}>→ {resolvedPath}</span>}
						{pathError && <span style={{ fontSize: 10, color: "#f87171" }}>{pathError}</span>}
					</div>
				)}

			<div style={{ flex: 1, position: "relative" }}>
				<Tldraw components={{ StylePanel: () => null }}>
					<BoardLayer
						editorRef={editorRef}
						onSelectionChange={handleSelection}
					/>
				</Tldraw>

				{currentSessionId && localState && (
					<div
						data-glassbox-inspector
						style={{
							position: "absolute",
							top: 0,
							right: 0,
							bottom: 0,
							width: 340,
							background: "rgba(26, 27, 35, 0.95)",
							backdropFilter: "blur(8px)",
							borderLeft: "1px solid #2a2b35",
							zIndex: 40,
							overflowY: "auto",
							padding: "14px 12px",
						}}
					>
						{selectedShapeId && (
							<div
								style={{
									marginBottom: 6,
									fontSize: 10,
									color: dim,
									fontFamily: "monospace",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								}}
							>
								{selectedShapeId}
							</div>
						)}
						{traceLoading && (
							<div
								style={{
									fontSize: 11,
									color: muted,
									padding: "8px 0",
								}}
							>
								Loading trace...
							</div>
						)}
						<Inspector
							selectedObject={selectedObject}
							traceEntries={entries}
							derivedState={localState}
							draftTask={draftTask}
							onDraftChange={setDraftTask}
							onApplyTask={handleSendTask}
							isApplying={isApplying}
						/>
					</div>
				)}
			</div>

			{log.length > 0 && (
				<div
					style={{
						position: "absolute",
						bottom: 16,
						left: 16,
						maxHeight: 180,
						overflowY: "auto",
						background: "rgba(15,17,23,0.88)",
						backdropFilter: "blur(8px)",
						borderRadius: 8,
						border: "1px solid #2a2b35",
						padding: "8px 12px",
						fontSize: 11,
						fontFamily: "monospace",
						color: "#a1a1aa",
						zIndex: 60,
						maxWidth: 420,
						pointerEvents: "none",
					}}
				>
					{log.map((l: string, i: number) => (
						<div key={i} style={{ lineHeight: 1.5 }}>
							{l}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export const Route = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: App,
});
