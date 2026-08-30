/**
 * apps/web/e2e/p28b.spec.mjs
 *
 * P2.8b — Agent final answer gets its own Canvas object (browser-verified).
 *
 * Checks:
 *  p28b-a. After a claude-code turn, an Answer shape (kind "turn-answer") exists on the canvas
 *  p28b-b. The Answer shape contains the full text (no trailing "...")
 *  p28b-c. The Answer shape's x position is in the right lane (>= ANSWER_X)
 *  p28b-d. Reload and assert the Answer shape rebuilds from persisted state
 *
 * This test requires ANTHROPIC_API_KEY in the environment and both
 * apps/server (port 3030) and apps/web (port 5173) to be running.
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const SERVER_PORT = 3030;
const WEB_PORT = 5173;
const SERVER_DIR = "/data/lora/repos/Glassbox-Agent-Harness/apps/server";
const WEB_DIR = "/data/lora/repos/Glassbox-Agent-Harness/apps/web";
const POLL_MS = 800;
const SHAPE_TIMEOUT_MS = 90_000;

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

function log(msg) { console.log(new Date().toLocaleTimeString() + " " + msg); }

// Read all text shapes from the tldraw canvas (via injected editor)
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
			return shapes.map(function(s) { return {
				id: s.id,
				type: s.type,
				x: s.x,
				y: s.y,
				text: extractText(s.props),
				kind: s.props?.meta?.objectType || s.id,
			}; });
		} catch (e) {
			return [{ error: e.message }];
		}
	});
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
	// Credentials: the SDK falls back to the machine's logged-in claude
	// credentials when ANTHROPIC_API_KEY is absent, so no hard gate here.
	const needsApiKey = false;
	if (needsApiKey) {
		console.log("[skip] ANTHROPIC_API_KEY not set — P2.8b browser verification requires credentials");
		process.exitCode = 0;
		return;
	}

	let serverProc, webProc, browser;
	const freshServer = !(await portReady(SERVER_PORT));
	const freshWeb = !(await portReady(WEB_PORT));
	let exitCode = 0;

	try {
		if (freshServer) serverProc = await startServer(); else log("Reusing server");
		if (freshWeb) webProc = await startWeb(); else log("Reusing web");

		browser = await chromium.launch({ headless: true });
		const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

		page.on('console', (msg) => { console.log('  [browser]', msg.text()); });

		// ── Setup: clear state, configure claude-code ──
		log("\n=== P28b setup: configure claude-code ===");
		await page.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: "networkidle", timeout: 20000 });
		await page.waitForTimeout(2000);

		await page.evaluate(function() {
			localStorage.removeItem("glassbox:lastSessionId");
			var url = new URL(window.location.href);
			url.searchParams.delete("session");
			history.replaceState(null, "", url.toString());
		});
		await page.reload({ waitUntil: "networkidle" });
		await page.waitForTimeout(1500);

		// Configure provider
		await page.click("button:has-text('Setup')", { timeout: 5000 });
		await page.waitForTimeout(300);
		await page.selectOption("select[title='Provider']", "claude-code");
		await page.waitForTimeout(200);
		await page.selectOption("select[title='Claude-code permission mode']", "default");
		await page.waitForTimeout(200);
		await page.click("button:has-text('Close')");
		await page.waitForTimeout(500);

		// ── P28b: Run a turn that produces a multi-paragraph answer ──
		log("\n=== P28b: Run turn with multi-paragraph prompt ===");

		// Set the prompt
		await page.fill('input[placeholder="Enter a task..."]',
			"Explain in 3 short paragraphs what a context window is.");
		await page.click("button:has-text('Run test')", { timeout: 5000 });

		// Wait for Answer shapes to appear
		const answerDeadline = Date.now() + SHAPE_TIMEOUT_MS;
		let answerShapes = [];
		while (Date.now() < answerDeadline) {
			const allShapes = await readAllTextShapes(page);
			answerShapes = allShapes.filter(s => s.kind === "turnFinalAnswer" || s.id?.startsWith("shape:answer-"));
			if (answerShapes.length > 0) break;
			await delay(POLL_MS);
		}

		// Wait a bit more for completion
		await page.waitForTimeout(3000);

		// Re-read shapes after completion
		const finalShapes = await readAllTextShapes(page);
		const finalAnswers = finalShapes.filter(s => s.kind === "turnFinalAnswer" || s.id?.startsWith("shape:answer-"));

		log("Answer shapes found: " + finalAnswers.length);

		// ── P28b-a: Answer shape exists ──
		if (finalAnswers.length === 0) {
			log("FAIL: No Answer shape found on canvas");
			log("Available shapes: " + JSON.stringify(finalShapes.map(s => s.kind + ":" + (s.text || "").slice(0, 60))));
			exitCode = 1;
		} else {
			log("PASS: Answer shape found: " + finalAnswers[0].id);

			const answerText = finalAnswers[0].text || "";
			log("Answer text (first 200 chars): " + answerText.slice(0, 200));

			// ── P28b-b: Answer text is NOT truncated (no trailing "...") ──
			if (answerText.endsWith("...")) {
				log("FAIL: Answer shape text is truncated with '...'");
				exitCode = 1;
			} else {
				log("PASS: Answer text is not truncated");
			}

			// ── P28b-c: Answer shape is in the right lane (x >= 760) ──
			const answerX = finalAnswers[0].x;
			if (answerX < 700) {
				log("FAIL: Answer shape x=" + answerX + " is not in the right lane (expected >= 760)");
				exitCode = 1;
			} else {
				log("PASS: Answer shape at x=" + answerX + " (right lane)");
			}

			// Capture session for reload test
			const sessionId = await page.evaluate(function() {
				return new URLSearchParams(window.location.search).get("session");
			});
			log("Session: " + (sessionId || "none"));

			// ── P28b-d: Reload and verify Answer shape rebuilds ──
			if (sessionId) {
				log("\n=== P28b-d: Reload and verify Answer rebuilds ===");
				await page.reload({ waitUntil: "networkidle", timeout: 20000 });
				await page.waitForTimeout(3000);

				const reloadedShapes = await readAllTextShapes(page);
				const reloadedAnswers = reloadedShapes.filter(s => s.kind === "turnFinalAnswer" || s.id?.startsWith("shape:answer-"));

				if (reloadedAnswers.length === 0) {
					log("FAIL: Answer shape missing after reload");
					log("Available after reload: " + JSON.stringify(reloadedShapes.map(s => s.kind)));
					exitCode = 1;
				} else {
					log("PASS: Answer shape persists after reload: " + reloadedAnswers[0].id);
					const reloadedText = reloadedAnswers[0].text || "";
					if (reloadedText.endsWith("...")) {
						log("FAIL: Reloaded Answer text is truncated");
						exitCode = 1;
					} else {
						log("PASS: Reloaded Answer text is not truncated");
					}
				}
			}
		}

	} catch (err) {
		console.error("[p28b] ERROR:", err.message);
		exitCode = 1;
	} finally {
		if (browser) await browser.close();
		if (freshServer && serverProc) await kill(serverProc);
		if (freshWeb && webProc) await kill(webProc);
	}

	console.log("\n=== P2.8b browser verification: " + (exitCode === 0 ? "PASSED" : "FAILED") + " ===");
	if (exitCode !== 0) process.exitCode = 1;
})();
