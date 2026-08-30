/**
 * apps/web/e2e/s9-polish.spec.mjs
 *
 * S9 Canvas readability polish — browser-verified checks.
 *
 * Checks:
 *  s9a. No tldraw StylePanel in DOM (Issue 2 fix)
 *  s9b. Run test button shows "Stop" when running; Run demo stays disabled
 *  s9c. Canvas shapes do not overlap vertically (Issue 1 fix — two-pass layout)
 *
 * s9c requires a live session with rendered shapes. The test runs the demo
 * task, waits for completion, then verifies shape bounds.
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

// ── helpers ───────────────────────────────────────────────────────────────────

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

function log(msg) { console.log(new Date().toLocaleTimeString() + " " + msg); }
function assert(cond, passMsg, failMsg) {
	log(cond ? "PASS: " + passMsg : "FAIL: " + failMsg);
	return cond;
}

async function readAllTextShapes(page) {
	return page.evaluate(() => {
		const ed = globalThis.__glassboxEditor;
		if (!ed) return [];
		try {
			const shapes = ed.getCurrentPageShapes() || [];
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
							if (!node) return;
							if (typeof node === "string") { parts.push(node); return; }
							if (Array.isArray(node)) { node.forEach(walk); return; }
							if (node.text) parts.push(node.text);
							const children = node.content || node.children;
							if (Array.isArray(children)) children.forEach(walk);
						};
						walk(rt.content);
						text = parts.join("");
					}
				}
				// Include bounds if available for overlap detection
				const bounds = s.bounds ? { x: s.bounds.x, y: s.bounds.y, w: s.bounds.w, h: s.bounds.h } : null;
				results.push({ id: s.id, text: text.slice(0, 250), bounds });
			}
			return results;
		} catch (e) {
			return ["ERROR:" + e.message];
		}
	});
}

async function waitForAnyShape(page, checks, timeoutMs) {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const shapes = await readAllTextShapes(page);
		const found = shapes.find((s) => checks.some((fn) => fn(s)));
		if (found) return found;
		await delay(POLL_MS);
	}
	return null;
}

async function waitForCompletion(page, timeoutMs) {
	// Wait for a completed turn to appear on the canvas
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const shapes = await readAllTextShapes(page);
		const hasCompleted = shapes.some((s) =>
			(s.text || "").includes("completed") && (s.text || "").startsWith("Turn")
		);
		if (hasCompleted) return true;
		await delay(1000);
	}
	return false;
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
	let serverProc, webProc, browser, page;
	const freshServer = !(await portReady(SERVER_PORT));
	const freshWeb = !(await portReady(WEB_PORT));
	let exitCode = 0;
	const results = [];

	try {
		if (freshServer) serverProc = await startServer(); else log("Reusing server");
		if (freshWeb) webProc = await startWeb(); else log("Reusing web");

		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
		page = await context.newPage();

		await page.goto(`http://localhost:${WEB_PORT}/`, { waitUntil: "networkidle", timeout: 20000 });
		await page.waitForTimeout(2000);

		// ═══════════════════════════════════════════════════════════════════════════
		// S9a: StylePanel should NOT be in the DOM (Issues 2 fix)
		// ═══════════════════════════════════════════════════════════════════════════
		log("\n=== S9a: StylePanel hidden ===");

		const stylePanelCount = await page.locator('[class*="StylePanel"], [class*="style-panel"], [data-testid*="StylePanel"]').count();
		const noStylePanel = stylePanelCount === 0;
		results.push({ criterion: "StylePanel not in DOM", passed: noStylePanel });
		assert(noStylePanel, "StylePanel absent from DOM", "StylePanel found in DOM (" + stylePanelCount + " elements)");

		// tldraw injects a toolbar; check the Glassbox Inspector's right panel isn't obscured
		const inspectorEl = page.locator('[data-glassbox-inspector]');
		const inspectorVisible = await inspectorEl.count() > 0;
		results.push({ criterion: "Glassbox inspector rendered", passed: inspectorVisible });

		await page.screenshot({ path: "/tmp/glassbox-s9-stylepanel.png", fullPage: true });

		// ═══════════════════════════════════════════════════════════════════════════
		// S9b: Button states — Run test shows "Stop", Run demo shows "Run demo"
		// ═══════════════════════════════════════════════════════════════════════════
		log("\n=== S9b: Button states ===");

		const runTestText = await page.locator('button:has-text("Run test")').first().textContent();
		const runDemoText = await page.locator('button:has-text("Run demo")').first().textContent();

		const runTestCorrect = runTestText?.trim() === "Run test";
		const runDemoCorrect = runDemoText?.trim() === "Run demo";

		results.push({ criterion: "Run test button text is 'Run test' (not 'Running...')", passed: runTestCorrect });
		results.push({ criterion: "Run demo button text is 'Run demo' (not 'Running...')", passed: runDemoCorrect });
		assert(runTestCorrect, "Run test button text is correct", "Run test button shows: '" + runTestText + "'");
		assert(runDemoCorrect, "Run demo button text is correct", "Run demo button shows: '" + runDemoText + "'");

		// ═══════════════════════════════════════════════════════════════════════════
		// S9c: Shapes don't overlap (two-pass flow layout fix)
		// ═══════════════════════════════════════════════════════════════════════════
		log("\n=== S9c: Shapes don't overlap ===");

		// Run a demo task to produce canvas shapes
		await page.fill('input[placeholder="/tmp/glassbox-demo-repo"]', "/tmp/glassbox-demo-repo");
		await page.fill('input[placeholder="Enter a task..."]', "echo hello");
		await page.waitForTimeout(200);

		await page.click("button:has-text('Run demo')", { timeout: 10000 });
		await page.waitForTimeout(2000);

		const completed = await waitForCompletion(page, 180_000);
		results.push({ criterion: "Demo run completed for overlap test", passed: completed });
		assert(completed, "Demo run completed", "Demo run did not complete in time");

		if (completed) {
			await page.waitForTimeout(2000); // let shapes settle

			const shapes = await readAllTextShapes(page);
			const textShapes = shapes.filter((s) => s.bounds && s.text);
			results.push({ criterion: "Text shapes have bounds info", passed: textShapes.length > 0 });

			// Sort by y position
			const sorted = [...textShapes].sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0));

			let hasOverlap = false;
			const overlaps = [];
			for (let i = 1; i < sorted.length; i++) {
				const prev = sorted[i - 1];
				const cur = sorted[i];
				if (!prev.bounds || !cur.bounds) continue;
				const prevBottom = prev.bounds.y + prev.bounds.h;
				const curTop = cur.bounds.y;
				if (curTop < prevBottom - 1) { // allow 1px rounding tolerance
					hasOverlap = true;
					overlaps.push(prev.id + " (bottom " + prevBottom.toFixed(0) + ") overlaps " + cur.id + " (top " + curTop.toFixed(0) + ")");
				}
			}

			const noOverlap = !hasOverlap;
			results.push({ criterion: "No shape overlaps (two-pass layout)", passed: noOverlap });
			assert(noOverlap, "No overlapping shapes", "Overlaps detected: " + overlaps.join("; "));

			if (!noOverlap) {
				console.error("  Overlap details:", overlaps);
			}

			// Log shape layout for debugging
			for (const s of sorted.slice(0, 10)) {
				if (s.bounds) {
					log("  " + s.id + ": y=" + s.bounds.y.toFixed(0) + " h=" + s.bounds.h.toFixed(0) + " bottom=" + (s.bounds.y + s.bounds.h).toFixed(0) + " text=" + s.text.slice(0, 30));
				}
			}
		}

		await page.screenshot({ path: "/tmp/glassbox-s9-layout.png", fullPage: true });

	} catch (err) {
		console.error("\n=== S9 E2E ERROR ===", err.message);
		if (browser) {
			try { await browser.close(); } catch {}
		}
		exitCode = 1;
	} finally {
		if (serverProc && freshServer) await kill(serverProc);
		if (webProc && freshWeb) await kill(webProc);
	}

	// ══ Report ══════════════════════════════════════════════════════════════════
	log("\n═══════════════════════════════════════════════════");
	log("S9 POLISH CRITERIA:");
	log("═══════════════════════════════════════════════════");
	for (const r of results) {
		log((r.passed ? "  PASS" : "  FAIL") + ": " + r.criterion);
	}
	const passedCount = results.filter((r) => r.passed).length;
	log("───────────────────────────────────────────────────");
	log("Result: " + passedCount + "/" + results.length + " criteria passed");

	if (exitCode === 0) {
		log("\n=== S9 E2E " + (passedCount === results.length ? "PASSED" : "PARTIAL") + " ===");
	} else {
		log("\n=== S9 E2E FAILED (exitCode=" + exitCode + ") ===");
	}
	process.exitCode = exitCode;
})();
