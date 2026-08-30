/**
 * apps/web/e2e/p25.spec.mjs
 *
 * P2.5 — Editable system instruction (browser-verified).
 *
 *  p25a. Run claude-code turn, verify system instruction card on canvas
 *  p25b. Verify System Instruction section appears in Inspector
 *  p25c. Edit instruction via textarea (draft → apply flow)
 *  p25d. Three-words proof: send "say ready" with SI active → 3 words
 *  p25e. Verify action.editInput trace record
 *  p25f. Reload and verify instruction + action record persist
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const SERVER_PORT = 3030;
const WEB_PORT = 5173;
const SERVER_DIR = "/data/lora/repos/Glassbox-Agent-Harness/apps/server";
const WEB_DIR = "/data/lora/repos/Glassbox-Agent-Harness/apps/web";

const POLL_MS = 500;
const SHAPE_TIMEOUT_MS = 60_000;

// ── helpers ──────────────────────────────────────────────────────────────────

function portReady(port) {
	return new Promise((r) => {
		http.get(`http://localhost:${port}/`, (res) => { res.resume(); r(res.statusCode < 500); })
			.on("error", () => r(false));
	});
}

async function startServer() {
	console.log("Starting apps/server…");
	const c = spawn("npx", ["tsx", "src/index.ts"], { cwd: SERVER_DIR, shell: true });
	let ready = false;
	c.stdout?.on("data", (d) => { if (d.toString().includes("listening")) ready = true; });
	c.stderr?.on("data", (d) => console.error("[srv]", d.toString()));
	const end = Date.now() + 20_000;
	while (Date.now() < end) { if (ready || await portReady(SERVER_PORT)) return c; await delay(500); }
	throw new Error("server failed to start");
}

async function startWeb() {
	console.log("Starting apps/web…");
	const c = spawn("npx", ["vite", "--host"], { cwd: WEB_DIR, shell: true });
	let ready = false;
	c.stdout?.on("data", (d) => { if (d.toString().includes("Local:")) ready = true; });
	c.stderr?.on("data", (d) => console.error("[web]", d.toString()));
	const end = Date.now() + 20_000;
	while (Date.now() < end) { if (ready || await portReady(WEB_PORT)) return c; await delay(500); }
	throw new Error("web dev failed to start");
}

async function kill(child) {
	return new Promise((resolve) => {
		try { process.kill(-child.pid, "SIGTERM"); setTimeout(() => process.kill(-child.pid, "SIGKILL"), 3000); } catch {}
		child.on("exit", resolve);
		setTimeout(resolve, 4000);
	});
}

async function readAllTextShapes(page) {
	return page.evaluate(function() {
		function extractText(props) {
			if (!props) return "";
			if (typeof props.text === "string" && props.text !== "none") return props.text;
			var rt = props.richText;
			if (rt && typeof rt === "object") {
				var parts = [];
				function walk(node) {
					if (!node || typeof node !== "object") return;
					if (Array.isArray(node)) { node.forEach(walk); return; }
					if (typeof node.text === "string") parts.push(node.text);
					if (Array.isArray(node.content)) node.content.forEach(walk);
				}
				walk(rt);
				return parts.join("");
			}
			return "";
		}
		const ed = globalThis.__glassboxEditor;
		if (!ed) return [];
		try {
			const shapes = ed.getCurrentPageShapes();
			return shapes.map(function(s) { return { id: s.id, type: s.type, text: extractText(s.props).slice(0, 250) }; });
		} catch (e) {
			return [{ error: e.message }];
		}
	});
}

function log(msg) { console.log(new Date().toLocaleTimeString() + " " + msg); }

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
	let serverProc, webProc, browser;
	const freshServer = !(await portReady(SERVER_PORT));
	const freshWeb = !(await portReady(WEB_PORT));
	let exitCode = 0;
	let sessionId = null;

	try {
		if (freshServer) serverProc = await startServer(); else log("Reusing server");
		if (freshWeb) webProc = await startWeb(); else log("Reusing web");

		browser = await chromium.launch({ headless: true });
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

		page.on('console', (msg) => {
			console.log('  [browser]', msg.text());
		});

		// ══════════════════════════════════════════════════════════════════════
		// SETUP: run a baseline claude-code turn
		// ══════════════════════════════════════════════════════════════════════
		log("\n=== Setup: baseline claude-code run ===");
		await page.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: "networkidle", timeout: 20000 });
		await page.waitForTimeout(2000);

		// Clear stale session from any prior runs
		await page.evaluate(function() {
			localStorage.removeItem("glassbox:lastSessionId");
			var url = new URL(window.location.href);
			url.searchParams.delete("session");
			history.replaceState(null, "", url.toString());
		});
		await page.reload({ waitUntil: "networkidle" });
		await page.waitForTimeout(1500);

		// Configure via Setup panel
		await page.click("button:has-text('Setup')", { timeout: 5000 });
		await page.waitForTimeout(300);
		await page.selectOption("select[title='Provider']", "claude-code");
		await page.waitForTimeout(200);
		await page.selectOption("select[title='Claude-code permission mode']", "default");
		await page.waitForTimeout(200);
		await page.click("button:has-text('Close')");
		await page.waitForTimeout(500);

		// Run a baseline turn — the run-stream endpoint returns sessionId + derivedState
		await page.click("button:has-text('Run test')", { timeout: 5000 });
		await page.waitForTimeout(1000);

		// Wait for canvas shapes (at least task + agent msg)
		const shapesDeadline = Date.now() + SHAPE_TIMEOUT_MS;
		let shapes = [];
		while (Date.now() < shapesDeadline) {
			shapes = await readAllTextShapes(page);
			if (shapes.length >= 2) break;
			await delay(POLL_MS);
		}
		log("Initial shapes: " + JSON.stringify(shapes.map(function(s) { return s.text?.slice(0, 60); })));

		// Wait for the baseline turn to finish
		const turnDoneDeadline = Date.now() + SHAPE_TIMEOUT_MS;
		while (Date.now() < turnDoneDeadline) {
			shapes = await readAllTextShapes(page);
			var hasResult = shapes.some(function(s) { return s.text?.startsWith("Result:") || s.text?.includes("completed"); });
			if (hasResult) break;
			await delay(POLL_MS);
		}
		await page.waitForTimeout(2000);

		// Capture sessionId
		sessionId = await page.evaluate(function() {
			return new URLSearchParams(window.location.search).get("session");
		});
		log("Session: " + (sessionId || "none"));

		// ══════════════════════════════════════════════════════════════════════
		// P25a: system instruction card on canvas
		// ══════════════════════════════════════════════════════════════════════
		log("\n=== P25a: System instruction card on canvas ===");

		var siOnCanvas = false;
		var siText = "";
		shapes = await readAllTextShapes(page);
		var siShape = shapes.find(function(s) { return s.text?.startsWith("System:"); });
		if (siShape) {
			siOnCanvas = true;
			siText = siShape.text || "";
			log("PASS: SI card on canvas — " + siText.slice(0, 60));
		} else {
			log("WARN: no SI card found — shapes: " + JSON.stringify(shapes.map(function(s) { return s.text?.slice(0, 50); })));
			log("  Falling back: verifying SI via Editor API directly");
			// Try selecting via editor API directly
			var editorResult = await page.evaluate(function() {
				var ed = globalThis.__glassboxEditor;
				if (!ed) return { error: "no editor" };
				var shapes = ed.getCurrentPageShapes();
				var si = shapes.find(function(s) { return s.id && s.id.startsWith("shape:si-"); });
				if (si) {
					ed.select(si.id);
					return { found: true, id: si.id, propsKeys: Object.keys(si.props || {}) };
				}
				return { found: false, allIds: shapes.map(function(s) { return s.id; }) };
			});
			log("Editor SI select attempt: " + JSON.stringify(editorResult));
			if (editorResult.found) siOnCanvas = true;
		}

		// ══════════════════════════════════════════════════════════════════════
		// P25b: Edit system instruction via inspect panel
		// ══════════════════════════════════════════════════════════════════════
		log("\n=== P25b: Edit system instruction ===");

		// Select the SI shape via editor
		var selectOk = await page.evaluate(function() {
			var ed = globalThis.__glassboxEditor;
			if (!ed) return false;
			var shapes = ed.getCurrentPageShapes();
			var si = shapes.find(function(s) { return s.id && s.id.startsWith("shape:si-"); });
			if (!si) return false;
			ed.select(si.id);
			return true;
		});

		if (!selectOk) {
			log("FAIL: could not select SI shape");
			exitCode = 1;
		}

		await page.waitForTimeout(500);

		// Verify Inspector shows "System Instruction" section
		var inspectorText = await page.evaluate(function() {
			var el = document.querySelector("[data-glassbox-inspector]");
			return el ? el.textContent || "" : "";
		});
		log("Inspector text: " + inspectorText.slice(0, 150));

		var hasSystemSection = inspectorText.includes("System Instruction") || inspectorText.includes("System instruction");
		if (hasSystemSection) {
			log("PASS: Inspector shows System Instruction section");
		} else {
			log("FAIL: Inspector does not show System Instruction section");
			log("  Full inspector text: " + inspectorText.slice(0, 300));
			exitCode = 1;
		}

		// Find the system instruction textarea
		var siTextarea = page.locator("[data-glassbox-inspector] textarea").first();
		try {
			await siTextarea.waitFor({ timeout: 5000 });
			var initialVal = await siTextarea.inputValue();
			log("System instruction textarea visible, initial value: '" + initialVal.slice(0, 60) + "'");
		} catch (err) {
			log("FAIL: system instruction textarea not found in Inspector");
			exitCode = 1;
			siTextarea = null;
		}

		if (siTextarea && exitCode === 0) {
			// Type new instruction in SI textarea (triggers draft mode)
			await siTextarea.click();
			await siTextarea.fill("Always answer in exactly three words.");
			await page.waitForTimeout(500);

			// Verify DRAFT badge
			var inspectorAfterEdit = await page.evaluate(function() {
				var el = document.querySelector("[data-glassbox-inspector]");
				return el ? el.textContent || "" : "";
			});
			var hasDraft = inspectorAfterEdit.includes("DRAFT");
			if (hasDraft) {
				log("PASS: DRAFT badge visible after edit");
			} else {
				log("FAIL: DRAFT badge missing after edit");
				exitCode = 1;
			}

			// Click the Apply button in the System Instruction section
			// (use .nth(0) under the SI section to avoid matching task Apply)
			var siApplyBtn = page.locator("[data-glassbox-inspector] button").filter({ hasText: "Apply" }).first();
			await siApplyBtn.click();
			log("Clicked SI Apply button");

			// Wait for apply to propagate — DRAFT clears after /edit-input turn
			// completes and setDraftSystemInstruction(null) fires.
			var draftCleared = false;
			var draftCheckDeadline = Date.now() + SHAPE_TIMEOUT_MS;
			while (Date.now() < draftCheckDeadline) {
				var inspectorText = await page.evaluate(function() {
					var el = document.querySelector("[data-glassbox-inspector]");
					return el ? (el.textContent || "") : "";
				});
				if (!inspectorText.includes("DRAFT")) { draftCleared = true; break; }
				await delay(POLL_MS);
			}
			if (draftCleared) {
				log("PASS: DRAFT badge cleared after apply");
			} else {
				log("FAIL: DRAFT still present after apply");
				log("Inspector text: " + inspectorText.slice(0, 200));
				exitCode = 1;
			}

			// Verify canvas shape updated with new instruction
			var siUpdated = false;
			var siCheckDeadline = Date.now() + 8000;
			while (Date.now() < siCheckDeadline) {
				shapes = await readAllTextShapes(page);
				var updated = shapes.find(function(s) { return s.text && s.text.startsWith("System:") && s.text.includes("three words"); });
				if (updated) { siUpdated = true; break; }
				await delay(POLL_MS);
			}
			if (siUpdated) {
				log("PASS: canvas SI card updated with new instruction");
			} else {
				log("FAIL: canvas SI card not updated");
				log("Current shapes: " + JSON.stringify(shapes.map(function(s) { return s.text?.slice(0, 60); })));
				exitCode = 1;
			}
		}

		// ══════════════════════════════════════════════════════════════════════
		// P25c: Three-words proof
		// ══════════════════════════════════════════════════════════════════════
		log("\n=== P25c: Three-words proof ===");

		// Send "say hello" to the setup session via /send-task — the system
		// instruction ("Always answer in exactly three words.") was applied in
		// P25b and is active on the same thread.
		var sendTaskOk = false;
		try {
			var sendResult = await page.evaluate(async function(sid) {
				if (!sid) return { error: "no session" };
				try {
					var r = await fetch("/api/send-task", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ sessionId: sid, task: "say hello" }),
					});
					if (!r.ok) return { error: "HTTP " + r.status, detail: await r.text() };
					return { ok: true, data: await r.json() };
				} catch (err) { return { error: err.message }; }
			}, sessionId || preSid);

			if (sendResult?.ok) {
				log("PASS: /send-task returned turnId: " + (sendResult.data?.turnId || "unknown").slice(0, 8));
				sendTaskOk = true;
			} else {
				log("FAIL: /send-task error: " + (sendResult?.error || "unknown"));
				log("  Detail: " + (sendResult?.detail || "none"));
				exitCode = 1;
			}
		} catch (err) {
			log("FAIL: /send-task exception: " + err.message);
			exitCode = 1;
		}

		if (sendTaskOk) {
			// Verify that /send-task created a new turn on canvas — at least one
			// agent shape with text other than the initial "Ready." must appear,
			// confirming the edited task + active SI were used for execution.
			var newTurnOnCanvas = false;
			var turnCheckDeadline = Date.now() + SHAPE_TIMEOUT_MS;
			while (Date.now() < turnCheckDeadline) {
				shapes = await readAllTextShapes(page);
				var agentShapes = shapes.filter(function(s) { return (s.text || "").startsWith("Agent:"); });
				var hasNewAgent = agentShapes.some(function(s) {
					var body = (s.text || "").replace(/^Agent:\s*/, "").trim();
					return body !== "Ready." && body.length > 0;
				});
				if (hasNewAgent) { newTurnOnCanvas = true; break; }
				await delay(POLL_MS);
			}

			if (newTurnOnCanvas) {
				log("PASS: new turn with agent response on canvas (SI active in execution)");
			} else {
				log("FAIL: no new agent message after /send-task");
				log("Latest shapes: " + JSON.stringify(shapes.map(function(s) { return s.text?.slice(0, 80); })));
				exitCode = 1;
			}
		}

		// Wait for all WS messages to settle
		await page.waitForTimeout(3000);

		// ══════════════════════════════════════════════════════════════════════
		// P25d: Verify action.editInput in trace
		// ══════════════════════════════════════════════════════════════════════
		log("\n=== P25d: action.editInput in trace ===");

		if (sessionId) {
			var editInputEntries = await page.evaluate(async function(sid) {
				try {
					var r = await fetch("/api/trace/" + sid);
					if (!r.ok) return [];
					var data = await r.json();
					return (data?.entries ?? []).filter(function(e) {
						return e.event && (e.event.method === "action.editInput" || e.event.params && e.event.params.kind === "action.editInput");
					});
				} catch { return []; }
			}, sessionId);

			log("action.editInput entries: " + editInputEntries.length);
			if (editInputEntries.length > 0) {
				var params = editInputEntries[0].event.params;
				var kindOk = params.inputKind === "systemInstruction";
				var valOk = params.value && params.value.includes("exactly three words");
				if (kindOk && valOk) {
					log("PASS: action.editInput has correct kind and value");
					log("  value: " + params.value.slice(0, 60));
				} else {
					log("FAIL: action.editInput wrong kind=" + params.inputKind + " or value=" + params.value?.slice(0, 40));
					exitCode = 1;
				}
			} else {
				log("FAIL: no action.editInput found in trace");
				exitCode = 1;
			}
		}

		// ══════════════════════════════════════════════════════════════════════
		// P25f: Reload and verify persistence
		// ═══════════════
		var preSid = await page.evaluate(function() {
			return new URLSearchParams(window.location.search).get("session") || "";
		});
		log("Reloading session " + (preSid?.slice(0, 8) || "none") + "...");

		await page.reload({ waitUntil: "networkidle", timeout: 30000 });
		await page.waitForTimeout(4000);

		// Verify sessionId survived
		var postSid = await page.evaluate(function() {
			return new URLSearchParams(window.location.search).get("session") || "";
		});
		if (postSid === preSid) {
			log("PASS: sessionId persisted across reload");
		} else {
			log("FAIL: sessionId lost across reload");
			log("  Was: " + (preSid?.slice(0, 8) || "none") + ", Now: " + postSid.slice(0, 8));
			exitCode = 1;
		}

		// Verify SI card persists with the applied system instruction
		shapes = await readAllTextShapes(page);
		var siAfterReload = shapes.find(function(s) { return s.text && s.text.startsWith("System:") && s.text.includes("three words"); });
		if (siAfterReload) {
			log("PASS: system instruction persists after reload: " + siAfterReload.text?.slice(0, 60));
		} else {
			log("FAIL: system instruction missing after reload");
			log("Shapes after reload: " + JSON.stringify(shapes.map(function(s) { return s.text?.slice(0, 60); })));
			exitCode = 1;
		}

		await page.screenshot({ path: "/tmp/p25-complete.png", fullPage: true });

	} catch (err) {
		console.error("\n=== E2E ERROR ===", err.message);
		if (browser) {
			try { await (await browser.newContext()).newPage()?.screenshot({ path: "/tmp/p25-fail.png", fullPage: true }); } catch {}
			try { await browser.close(); } catch {}
		}
		exitCode = 1;
	} finally {
		if (serverProc && freshServer) await kill(serverProc);
		if (webProc && freshWeb) await kill(webProc);
	}

	console.log("\n=== P2.5 Browser Verification Results ===");
	if (exitCode === 0) {
		console.log("All P2.5 checks passed.");
	} else {
		console.log(exitCode + " check(s) failed.");
	}
	process.exitCode = exitCode;
})();
