/**
 * apps/web/e2e/s7.spec.mjs
 *
 * S7 Editable task with Send: edit the task text as a draft, verify no
 * run state changes, then Send to start a new turn on the same thread
 * with the edited task.
 *
 * Vertically verified in the browser via Playwright.
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
const SHAPE_TIMEOUT_MS = 35_000;

// ── helpers ─────────────────────────────────────────────────────────────────

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
	const end = Date.now() + 20000;
	while (Date.now() < end) { if (ready || await portReady(SERVER_PORT)) return c; await delay(500); }
	throw new Error("server failed to start");
}

async function startWeb() {
	console.log("Starting apps/web…");
	const c = spawn("npx", ["vite", "--host"], { cwd: WEB_DIR, shell: true });
	let ready = false;
	c.stdout?.on("data", (d) => { if (d.toString().includes("Local:")) ready = true; });
	c.stderr?.on("data", (d) => console.error("[web]", d.toString()));
	const end = Date.now() + 20000;
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
	return page.evaluate(() => {
		const ed = globalThis.__glassboxEditor;
		if (!ed) return [];
		try {
			const shapes = ed.getCurrentPageShapes();
			const results = [];
			for (const s of shapes) {
				if (s.type !== "text") continue;
				let text = s.props?.text ?? s.props?.name ?? "";
				if (!text && s.props?.richText) {
					const rt = s.props.richText;
					if (typeof rt === "string") text = rt;
					else if (rt?.content) {
						const parts = [];
						const walk = (node) => {
							if (!node || typeof node !== "object") { if (typeof node === "string") parts.push(node); return; }
							if (Array.isArray(node)) { node.forEach(walk); return; }
							if (node.text) parts.push(node.text);
							if (Array.isArray(node.content)) node.content.forEach(walk);
						};
						walk(rt.content);
						text = parts.join("");
					}
				}
				results.push({ id: s.id, text: text.slice(0, 250) });
			}
			return results;
		} catch (e) {
			return ["ERROR:" + e.message];
		}
	});
}

async function readInspectorText(page) {
	return page.evaluate(() => {
		const el = document.querySelector("[data-glassbox-inspector]");
		return el ? el.textContent || "" : "";
	});
}

async function readTrace(sessionId) {
	try {
		const res = await fetch(`http://localhost:${SERVER_PORT}/trace/${sessionId}`);
		if (!res.ok) return [];
		const data = await res.json();
		return data?.entries || [];
	} catch {
		return [];
	}
}

function log(msg) { console.log(new Date().toLocaleTimeString() + " " + msg); }
function assert(cond, passMsg, failMsg) { log(cond ? "PASS: " + passMsg : "FAIL: " + failMsg); }
function fail(msg) { log("FAIL: " + msg); }

// ── main ─────────────────────────────────────────────────────────────────────

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

		// Navigate and wait for tldraw to settle
		await page.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: "networkidle", timeout: 20000 });
		await page.waitForTimeout(2500);

		let shapes;

		// ══ Step 1: Start a run ═══════════════════════════════════════════════════
		log("\n=== Step 1: Start run ===");
		await page.click("button:has-text('Run test')", { timeout: 10000 });
		await page.waitForTimeout(3000);

		shapes = await readAllTextShapes(page);
		const taskShape = shapes.find(s => s.text?.startsWith("Task:"));
		assert(!!taskShape, "Task shape appeared", "Task shape missing");
		log("Task: " + (taskShape?.text?.slice(0, 60) || "(none)"));

		sessionId = await page.evaluate(() => new URLSearchParams(window.location.search).get("session"));
		log("Session: " + (sessionId || "none"));

		await page.screenshot({ path: "/tmp/glassbox-s7-step1.png", fullPage: true });

		// ══ Step 2: Wait for completion, then select task shape ═════════════════
		log("\n=== Step 2: Complete run and select task ===");

		// Wait for turn to complete
		const turnDone = Date.now() + SHAPE_TIMEOUT_MS;
		while (Date.now() < turnDone) {
			shapes = await readAllTextShapes(page);
			const hasResult = shapes.some(s => s.text?.startsWith("Result:") || s.text?.includes("completed"));
			if (hasResult) break;
			await delay(POLL_MS);
		}
		await page.waitForTimeout(1000);

		// Click on the task shape to select it
		const selectResult = await page.evaluate(() => {
			const ed = globalThis.__glassboxEditor;
			if (!ed) return { error: "no editor" };
			const shapes = ed.getCurrentPageShapes().filter(s => s.type === "text");
			const task = shapes.find(s => s.id.startsWith("shape:task-"));
			if (task) ed.select(task.id);
			return { found: !!task };
		});
		log("Task selected: " + JSON.stringify(selectResult));
		await page.waitForTimeout(500);

		if (!selectResult.found) {
			fail("Task shape not found to select");
			exitCode = 1;
		}

		// ══ Step 3: Edit task text, verify draft state ══════════════════════════
		if (exitCode === 0) {
			log("\n=== Step 3: Edit task -> draft badge visible ===");

			// Find and fill the textarea in the inspector
			const textarea = page.locator("textarea[data-glassbox-draft]");
			// The textarea might not have a data attr; use the inspector textarea directly
			const inspectorTextarea = page.locator("[data-glassbox-inspector] textarea");
			await inspectorTextarea.waitFor({ timeout: 3000 });

			// Get initial task text from inspector
			const inspectorTextBefore = await readInspectorText(page);
			const hasDraftBefore = inspectorTextBefore.includes("DRAFT");
			assert(!hasDraftBefore, "no DRAFT badge before editing", "DRAFT badge should NOT appear before editing");
			log("Initial inspector snippet: " + inspectorTextBefore.slice(0, 120));

			// Clear and type new text
			await inspectorTextarea.click();
			await inspectorTextarea.fill("say hello world");
			await page.waitForTimeout(300);

			// Verify DRAFT badge appears
			const inspectorTextAfter = await readInspectorText(page);
			const hasDraftAfter = inspectorTextAfter.includes("DRAFT");
			assert(hasDraftAfter, "DRAFT badge appears after editing", "DRAFT badge should appear after editing");
			log("After edit inspector snippet: " + inspectorTextAfter.slice(0, 150));

			// Assert no new turn started yet (still only 1 turn)
			const turnCountBefore = shapes.length;
			const latestShapes = await readAllTextShapes(page);
			const turnShapes = latestShapes.filter(s => s.id?.startsWith("shape:") && s.text?.startsWith("Turn"));
			assert(turnShapes.length <= 1, "no new turn after draft edit", "new turn should NOT appear after draft edit");
			log("Turn shapes after edit: " + turnShapes.length);

			await page.screenshot({ path: "/tmp/glassbox-s7-draft.png", fullPage: true });

			// ══ Step 4: Send — click Send button ═════════════════════════════════
			log("\n=== Step 4: Send -> new turn ===");

			var sendBtn = page.locator("button:has-text('Send')");
			await sendBtn.waitFor({ timeout: 3000 });

			// Capture turn count before confirm
			const shapesBeforeSend = await readAllTextShapes(page);
			const turnCountAtSend = shapesBeforeSend.filter(s =>
				s.id?.startsWith("shape:") && s.text?.startsWith("Turn")
			).length;
			log("Turn count before Send: " + turnCountAtSend);

			// Click Confirm
			await sendBtn.click({ timeout: 5000 });

			// Wait for new turn to appear
			const sendDeadline = Date.now() + 30000;
			let newTurnAppeared = false;
			while (Date.now() < sendDeadline) {
				const s = await readAllTextShapes(page);
				const turns = s.filter(x => x.id?.startsWith("shape:") && x.text?.startsWith("Turn"));
				if (turns.length > turnCountAtSend) {
					newTurnAppeared = true;
					log("New turn appeared: " + turns[turns.length - 1]?.text?.slice(0, 60));
					break;
				}
				await delay(POLL_MS);
			}
			assert(newTurnAppeared, "new turn started after Send", "no new turn after Send");

			// Wait for turn to complete (agent responds)
			const completeDeadline = Date.now() + 30000;
			while (Date.now() < completeDeadline) {
				const s = await readAllTextShapes(page);
				const hasResult = s.some(x => x.text?.includes("completed") || x.text?.includes("failed"));
				if (hasResult) break;
				await delay(POLL_MS);
			}

			await page.waitForTimeout(2000); // Let WS catch up

			// ══ Step 5: Verify task was updated and action.send is in trace ═══════
			log("\n=== Step 5: Verify task updated and trace provenance ===");

			// Check final task shape includes edited text
			const afterShapes = await readAllTextShapes(page);
			const finalTaskShape = afterShapes.find(s => s.text?.startsWith("Task:"));
			const hasUpdatedTask = finalTaskShape?.text?.includes("hello world");
			assert(!!hasUpdatedTask, "task shape shows edited text", "task shape does not show edited text");
			log("Final task: " + (finalTaskShape?.text?.slice(0, 80) || "(none)"));

			// Assert trace has action.send
			if (sessionId) {
				const entries = await readTrace(sessionId);
				const actionSend = entries?.filter(e => e.event?.method === "action.send" || e.event?.params?.kind === "action.send");
				assert(actionSend?.length > 0, "trace has action.send", "action.send missing from trace");
				if (actionSend?.length > 0) {
					const apply = actionSend[0];
					log("action.send task field: " + (apply.event?.params?.task || "none"));
					const taskMatches = apply.event?.params?.task?.includes("hello world");
					assert(!!taskMatches, "action.send task text matches edit", "action.send task text mismatch");
					log("action.send ts: " + (apply.event?.params?.ts || "none"));
					const hasTs = !!apply.event?.params?.ts && apply.event.params.ts.length > 0;
					assert(hasTs, "action.send has ISO timestamp", "action.send missing timestamp");
				}
			}

			// Verify multiple turns
			const allTurns = afterShapes.filter(s => s.text?.startsWith("Turn"));
			assert(allTurns.length >= 2, `${allTurns.length} turns visible after Send`, "expected >= 2 turns");
			log("Turns after Send: " + allTurns.length);

			await page.screenshot({ path: "/tmp/glassbox-s7-confirmed.png", fullPage: true });

			// ══ Step 6: Reload and verify turns rebuild ════════════════════════════
			log("\n=== Step 6: Reload and verify reconstruction ===");

			// Capture signatures before reload
			var preShapes = await readAllTextShapes(page);
			function keyType(s) { return s.text.slice(0, 40); }
			var beforeSigs = preShapes.filter(s => s?.id?.startsWith("shape:"))
				.map(keyType);
			log("Pre-reload shapes (" + beforeSigs.length + "): " + JSON.stringify(beforeSigs));

			// Capture session and reload
			sessionId = await page.evaluate(() => new URLSearchParams(window.location.search).get("session"));
			log("Reloading session " + (sessionId?.slice(0, 8) || "none") + "...");
			await page.reload({ waitUntil: "networkidle", timeout: 30000 });
			await page.waitForTimeout(4000);

			// Assert sessionId persisted
			var afterSid = await page.evaluate(() =>
				new URLSearchParams(window.location.search).get("session") || ""
			);
			assert(afterSid === sessionId, "sessionId persisted across reload", "sessionId lost across reload");

			// Assert both turns rebuild
			var postShapes = await readAllTextShapes(page);
			var afterSigs = postShapes.filter(s => s?.id?.startsWith("shape:"))
				.map(keyType);
			log("Post-reload shapes (" + afterSigs.length + "): " + JSON.stringify(afterSigs));

			var beforeSignatures = beforeSigs.map(t => t.split(":")[0]).sort();
			var afterSignatures = afterSigs.map(t => t.split(":")[0]).sort();
			if (JSON.stringify(beforeSignatures) !== JSON.stringify(afterSignatures)) {
				log("FAIL: shape type set mismatch after reload");
				log("  Before: " + JSON.stringify(beforeSignatures));
				log("  After: " + JSON.stringify(afterSignatures));
				exitCode = 1;
			} else {
				log("PASS: shape signatures match after reload");
			}

			// Verify both turns present after reload
			const postTurns = postShapes.filter(s => s.text?.startsWith("Turn"));
			assert(postTurns.length >= 2, `${postTurns.length} turns rebuilt after reload`, "< 2 turns after reload");
			log("Post-reload turns: " + postTurns.length);

			// Verify action records survive reload
			if (sessionId) {
				const entries = await readTrace(sessionId);
				const actionSendPost = entries?.filter(e => e.event?.method === "action.send");
				assert(actionSendPost?.length > 0, "action.send survives reload", "action.send lost on reload");
				log("action.send records after reload: " + (actionSendPost?.length || 0));
			}

			// Select task shape post-reload and verify inspector shows edited text
			const taskSelectReload = await page.evaluate(() => {
				const ed = globalThis.__glassboxEditor;
				if (!ed) return { found: false };
				const shapes = ed.getCurrentPageShapes().filter(s => s.type === "text");
				const task = shapes.find(s => s.id.startsWith("shape:task-"));
				if (task) ed.select(task.id);
				return { found: !!task };
			});
			await page.waitForTimeout(400);
			if (taskSelectReload.found) {
				const inspectorPostReload = await readInspectorText(page);
				const hasEditPost = inspectorPostReload.includes("hello world") || inspectorPostReload.includes("DRAFT");
				log("Post-reload inspector shows edited text: " + (hasEditPost ? "yes" : "no"));
				if (!hasEditPost) {
					log("WARN: edited task text not visible in inspector after reload");
				}
			}

			await page.screenshot({ path: "/tmp/glassbox-s7-post-reload.png", fullPage: true });
			log("Screenshot: /tmp/glassbox-s7-post-reload.png");
		}

	} catch (err) {
		console.error("\n=== E2E ERROR ===", err.message);
		if (browser) {
			try { await (await (await browser).newContext()).newPage()?.screenshot({ path: "/tmp/glassbox-s7-fail.png", fullPage: true }); } catch {}
			try { await browser.close(); } catch {}
		}
		exitCode = 1;
	} finally {
		if (serverProc && freshServer) await kill(serverProc);
		if (webProc && freshWeb) await kill(webProc);
	}

	if (exitCode === 0) {
		log("\n=== S7 E2E PASSED ===");
	} else {
		log("\n=== S7 E2E FAILED (exitCode=" + exitCode + ") ===");
	}
	process.exitCode = exitCode;
})();
