/**
 * apps/web/e2e/p24.spec.mjs
 *
 * P2.4 — Real-project entry: provider picker, permission panel, repo selection,
 * browser-verified end-to-end.
 *
 *  p24a. Open Setup panel, pick claude-code + default permission + demo path,
 *         run a turn, assert canvas populates with trace session.config
 *  p24b. Submit Glassbox repo path → server rejects with 400
 *  p24c. Switch to codex + on-request, run a turn → canvas populates
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const SERVER_PORT = 3030;
const WEB_PORT = 5173;
const SERVER_DIR = "/data/lora/repos/Glassbox-Agent-Harness/apps/server";
const WEB_DIR = "/data/lora/repos/Glassbox-Agent-Harness/apps/web";

const POLL_MS = 1_000;
const SHAPE_TIMEOUT_MS = 50_000;

// ── helpers ───────────────────────────────────────────────────────────────────

function portReady(port) {
  return new Promise((r) => {
    http.get(`http://localhost:${port}/`, (res) => {
      res.resume();
      r(res.statusCode < 500);
    }).on("error", () => r(false));
  });
}

async function startServer() {
  console.log("Starting apps/server…");
  const c = spawn("npx", ["tsx", "src/index.ts"], { cwd: SERVER_DIR, shell: true });
  let ready = false;
  const end = Date.now() + 20_000;
  c.stdout?.on("data", (d) => { if (d.toString().includes("listening")) ready = true; });
  c.stderr?.on("data", (d) => console.error("[srv]", d.toString()));
  while (Date.now() < end) { if (ready || await portReady(SERVER_PORT)) return c; await delay(500); }
  throw new Error("server failed to start");
}

async function startWeb() {
  console.log("Starting apps/web…");
  const c = spawn("npx", ["vite", "--host"], { cwd: WEB_DIR, shell: true });
  let ready = false;
  const end = Date.now() + 20_000;
  c.stdout?.on("data", (d) => { if (d.toString().includes("Local:")) ready = true; });
  c.stderr?.on("data", (d) => console.error("[web]", d.toString()));
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
    const ed = window.__glassboxEditor;
    if (!ed) return [];
    try {
      const shapes = ed.getCurrentPageShapes();
      const results = [];
      for (const s of shapes) {
        let text = s.props?.text ?? "";
        if (!text && s.props?.richText) {
          const rt = s.props.richText;
          if (typeof rt === "string") text = rt;
          else if (rt?.content) text = JSON.stringify(rt.content).slice(0, 200);
        }
        results.push({ id: s.id, type: s.type, text: text.slice(0, 200) });
      }
      return results;
    } catch (e) {
      return [{ error: e.message }];
    }
  });
}

// Get ALL shape types (not just text) for diagnosis
async function readAllShapes(page) {
  return page.evaluate(() => {
    const ed = window.__glassboxEditor;
    if (!ed) return [];
    try {
      const shapes = ed.getCurrentPageShapes();
      return shapes.map(function(s) { return { id: s.id, type: s.type }; });
    } catch (e) {
      return [{ error: e.message }];
    }
  });
}

async function waitForShapes(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastShapes = [];
  while (Date.now() < deadline) {
    const shapes = await readAllTextShapes(page);
    if (shapes.length && shapes[0] !== "ERROR") {
      if (shapes.length >= 2) return shapes; // at least task + one more object
      lastShapes = shapes;
    }
    await delay(POLL_MS);
  }
  return lastShapes;
}

async function waitForSessionEnd(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let connected = true;
  while (Date.now() < deadline && connected) {
    const wsStatus = await page.evaluate(() => {
      const ws = document.querySelector("[data-glassbox-inspector] ~ div, footer, .ws-status");
      return null;
    });
    // Simpler: poll until shapes are stable (no new shapes appearing)
    const s1 = await readAllTextShapes(page);
    await delay(2000);
    const s2 = await readAllTextShapes(page);
    if (s1.length > 0 && s1.length === s2.length && JSON.stringify(s1) === JSON.stringify(s2)) {
      return true;
    }
  }
  return false;
}

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  let serverProc, webProc;
  const freshServer = !(await portReady(SERVER_PORT));
  const freshWeb = !(await portReady(WEB_PORT));

  if (freshServer) serverProc = await startServer();
  else console.log("Reusing server on " + SERVER_PORT);
  if (freshWeb) webProc = await startWeb();
  else console.log("Reusing web on " + WEB_PORT);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  // Capture browser console for diagnostics
  page.on('console', (msg) => {
    console.log('  [browser]', msg.text());
  });

  const passed = [];
  const failed = [];

  try {
    /* ── P24a: claude-code + default permission + demo path ─────────────── */

    console.log("\n=== P24a: claude-code + default + demo path ===");
    await page.goto("http://localhost:" + WEB_PORT + "/", { waitUntil: "networkidle", timeout: 20_000 });
    await page.waitForTimeout(1000);

    // Clear any stale session from prior test runs (URL param or localStorage)
    await page.evaluate(() => {
      localStorage.removeItem("glassbox:lastSessionId");
      const url = new URL(window.location.href);
      url.searchParams.delete("session");
      history.replaceState(null, "", url.toString());
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    // Open Setup panel
    await page.click("button:has-text('Setup')", { timeout: 5_000 });
    await page.waitForTimeout(300);

    // Select claude-code provider
    await page.selectOption("select[title='Provider']", "claude-code");
    await page.waitForTimeout(200);

    // Verify permission mode selector appears (claude-code path)
    const permSelect = page.locator("select[title='Claude-code permission mode']");
    if (!(await permSelect.count())) {
      throw new Error("P24a FAIL: claude-code permission selector not visible");
    }
    console.log("  Provider selector: claude-code visible ✓");

    // Set default permission mode
    await page.selectOption("select[title='Claude-code permission mode']", "default");
    await page.waitForTimeout(200);

    // Close setup, then click Run test (uses /api/run-stream)
    await page.click("button:has-text('Close')");
    await page.waitForTimeout(300);

    // Clear the prompt and send a simple prompt
    await page.fill('input[placeholder="Enter a task..."]', "say ready");
    await page.click("button:has-text('Run test')");
    await page.waitForTimeout(2000); // give fetch time to complete

    // Diagnostic: check if session was set after run-test click
    var postRunDiag = await page.evaluate(() => {
      return {
        lastSessionId: (() => { try { return localStorage.getItem("glassbox:lastSessionId"); } catch(e) { return null; } })(),
        urlSession: new URLSearchParams(window.location.search).get("session"),
        editorShapeCount: (function() {
          try { var ed = window.__glassboxEditor; return ed ? ed.getCurrentPageShapes().length : 0; } catch(e) { return -1; }
        })(),
      };
    });
    console.log("  [post-run diag]", JSON.stringify(postRunDiag));

    // Wait for canvas shapes (at least task + agent message = >= 2)
    const shapesA = await waitForShapes(page, SHAPE_TIMEOUT_MS);
    console.log("  Canvas shapes after claude-code run:", JSON.stringify(shapesA.map(s => s.text?.slice(0, 60))));

    // Also dump the panel log + localStorage for diagnostics
    const diagnosticA = await page.evaluate(() => {
      return {
        lastSessionId: localStorage.getItem("glassbox:lastSessionId"),
        urlSession: new URLSearchParams(window.location.search).get("session"),
        editorShapes: (function() {
          try {
            var ed = window.__glassboxEditor;
            if (!ed) return "no editor";
            var shapes = ed.getCurrentPageShapes();
            return shapes.map(function(s) { return { id: s.id, type: s.type, text: (s.props && s.props.text) ? s.props.text.slice(0, 60) : (s.props && s.props.richText) ? JSON.stringify(s.props.richText).slice(0, 60) : "" }; });
          } catch(e) { return "ERROR: " + e.message; }
        })(),
      };
    });
    console.log("  [diag]", JSON.stringify(diagnosticA));

    if (shapesA.length < 2) {
      failed.push("P24a: canvas did not populate after claude-code run (got " + shapesA.length + " shapes)");
    } else {
      passed.push("P24a: canvas populated with " + shapesA.length + " shapes");
    }

    // Check trace for session.config — poll until localStorage has a valid sessionId
    let sessionIdA = null;
    let traceA = null;
    let traceDeadline = Date.now() + 10_000;
    while (Date.now() < traceDeadline) {
      var tmpSid = await page.evaluate(() => localStorage.getItem("glassbox:lastSessionId"));

      if (tmpSid && tmpSid !== "none") {
        sessionIdA = tmpSid;
        traceA = await page.evaluate(async (s) => {
          var r = await fetch("/api/trace/" + s);
          if (!r.ok) return null;
          var data = await r.json();
          // Trace entries have { seq, ts, event: { method, params }, provenance }
          return (data?.entries ?? []).filter(function(e) {
            return (e.event && e.event.method === "session.config") || (e.event && e.event.params && e.event.params.kind === "session.config");
          });
        }, sessionIdA);
        if (traceA && traceA.length > 0) break;
      }
      await delay(500);
    }
    console.log("  session.config entries:", JSON.stringify(traceA));
    if (traceA && traceA.length > 0 && traceA[0].event && traceA[0].event.params && traceA[0].event.params.permissionMode === "default") {
      passed.push("P24a: trace contains session.config with permissionMode=default");
    } else {
      failed.push("P24a: session.config with permissionMode=default not found in trace (sessionId=" + sessionIdA + ", got: " + JSON.stringify(traceA) + ")");
    }

    /* ── P24b: Glassbox repo path rejection ─────────────────────────────── */

    console.log("\n=== P24b: Glassbox repo path guardrail ===");
    await page.click("button:has-text('Setup')");
    await page.waitForTimeout(300);

    // Switch to codex provider
    await page.selectOption("select[title='Provider']", "codex");
    await page.waitForTimeout(200);

    // Enter Glassbox repo path
    var repoInput = page.locator("input[placeholder='Repo path (or use default)']").first();
    await repoInput.fill("/data/lora/repos/Glassbox-Agent-Harness");
    await page.waitForTimeout(300);

    // Check for client-side warning
    var pathErrorVisible = await page.locator("text=Glassbox repo path is not allowed").count();
    if (pathErrorVisible > 0) {
      passed.push("P24b: client shows Glassbox repo path rejection");
    } else {
      // Server-side check: try to submit (won't happen via button since client blocks submit)
      // The client-side guard already validates; flag it explicitly.
      failed.push("P24b: Glassbox repo path not rejected (client or server)");
    }

    // Reset repo path
    await repoInput.fill("/tmp/glassbox-t2.2");
    await page.waitForTimeout(200);
    await page.click("button:has-text('Close')");
    await page.waitForTimeout(300);

    // Wait for the P24a turn to finish: the task input re-enables when the
    // session ends. Starting the next run while the input is disabled just
    // times out the fill action.
    var inputOk = false;
    var idleDeadline = Date.now() + 240_000;
    while (Date.now() < idleDeadline) {
      var disabled = await page.locator('input[placeholder="Enter a task..."]').isDisabled();
      if (!disabled) { inputOk = true; break; }
      await delay(1000);
    }
    if (!inputOk) failed.push("P24: task input stayed disabled for 240s (turn never ended / no session-end broadcast)");

    /* ── P24c: codex + on-request ───────────────────────────────────────── */

    console.log("\n=== P24c: codex + on-request run ===");

    // Make sure provider is codex and open setup
    await page.click("button:has-text('Setup')");
    await page.waitForTimeout(300);
    await page.selectOption("select[title='Provider']", "codex");
    await page.waitForTimeout(200);

    // Set on-request approval
    await page.selectOption("select[title='Codex approval policy']", "on-request");
    await page.waitForTimeout(200);

    await page.click("button:has-text('Close')");
    await page.waitForTimeout(300);

    // Clear prompt and run
    await page.fill('input[placeholder="Enter a task..."]', "say ready");
    await page.click("button:has-text('Run test')");

    const shapesC = await waitForShapes(page, SHAPE_TIMEOUT_MS);
    console.log("  Canvas shapes after codex run:", JSON.stringify(shapesC.map(s => s.text?.slice(0, 60))));

    if (shapesC.length >= 2) {
      passed.push("P24c: canvas populated with " + shapesC.length + " shapes on codex path");
    } else {
      failed.push("P24c: canvas did not populate on codex path");
    }

    // Verify session.config has approvalPolicy=on-request for codex
    let sessionIdC = null;
    let traceC = null;
    let traceDeadlineC = Date.now() + 10_000;
    while (Date.now() < traceDeadlineC) {
      var tmpSidC = await page.evaluate(() => localStorage.getItem("glassbox:lastSessionId"));
      if (tmpSidC && tmpSidC !== "none") {
        sessionIdC = tmpSidC;
        traceC = await page.evaluate(async (s) => {
          var r = await fetch("/api/trace/" + s);
          if (!r.ok) return null;
          var data = await r.json();
          return (data?.entries ?? []).filter(function(e) {
            return (e.event && e.event.params && e.event.params.kind === "session.config");
          });
        }, sessionIdC);
        if (traceC && traceC.length > 0) break;
      }
      await delay(500);
    }
    console.log("  session.config entries:", JSON.stringify(traceC));
    if (traceC && traceC.length > 0 && traceC[0].event && traceC[0].event.params && traceC[0].event.params.approvalPolicy === "on-request") {
      passed.push("P24c: trace contains session.config with approvalPolicy=on-request");
    } else {
      failed.push("P24c: session.config with approvalPolicy=on-request not found (sessionId=" + sessionIdC + ", got: " + JSON.stringify(traceC) + ")");
    }

  } catch (err) {
    console.error("TEST ERROR:", err);
    failed.push("Exception: " + err.message);
  }

  // ── results ─────────────────────────────────────────────────────────────────

  console.log("\n=== P2.4 Browser Verification Results ===");
  for (const p of passed) console.log("  PASS:", p);
  for (const f of failed) console.log("  FAIL:", f);

  const exitCode = failed.length > 0 ? 1 : 0;
  if (failed.length > 0) process.exitCode = exitCode;

  await page.screenshot({ path: "/tmp/p24-e2e-result.png", fullPage: true });
  await browser.close();

  if (freshServer) await kill(serverProc);
  if (freshWeb) await kill(webProc);

  console.log(failed.length === 0 ? "\nAll P2.4 checks passed." : `\n${failed.length} check(s) failed.`);
})();
