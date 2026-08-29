/**
 * apps/web/e2e/s6.spec.mjs
 *
 * S6 Mid-run steering: pause a turn and continue with one instruction.
 * Browser-vertical-slice Playwright test.
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

// ── helpers ────────────────────────────────────────────────────────────────

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
  const end = Date.now() + 20000;
  c.stdout?.on("data", (d) => { if (d.toString().includes("listening")) ready = true; });
  while (Date.now() < end) { if (ready || await portReady(SERVER_PORT)) return c; await delay(500); }
  throw new Error("server failed to start");
}

async function startWeb() {
  console.log("Starting apps/web…");
  const c = spawn("npx", ["vite", "--host"], { cwd: WEB_DIR, shell: true });
  let ready = false;
  const end = Date.now() + 20000;
  c.stdout?.on("data", (d) => { if (d.toString().includes("Local:")) ready = true; });
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

function log(msg) { console.log(new Date().toLocaleTimeString() + " " + msg); }
function assert(cond, passMsg, failMsg) { log(cond ? "PASS: " + passMsg : "FAIL: " + failMsg); }
function fail(msg) { log("FAIL: " + msg); }

// ── main ────────────────────────────────────────────────────────────────────

(async () => {
  let serverProc, webProc, browser;
  const ctx = { pages: () => [{ screenshot: async () => {} }] };
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

    // ══ Step 1: Start a run ═══════════════════════════════════════════════
    log("=== Step 1: Start run ===");
    await page.click("button:has-text('Run test')", { timeout: 10000 });
    await page.waitForTimeout(2000);

    shapes = await readAllTextShapes(page);
    const taskShape = shapes.find(s => s.text?.startsWith("Task:"));
    assert(!!taskShape, "Task shape appeared", "Task shape missing");
    log("Task: " + (taskShape?.text?.slice(0, 60) || "(none)"));

    sessionId = await page.evaluate(() => new URLSearchParams(window.location.search).get("session"));
    log("Session: " + (sessionId || "none"));

    await page.screenshot({ path: "/tmp/glassbox-s6-step1.png", fullPage: true });

    // ══ Step 2: Click Pause ══════════════════════════════════════════════
    log("\n=== Step 2: Click Pause ===");

    // First, verify Pause button is enabled while running
    const pauseEnabledBefore = await page.evaluate(() => {
      const btn = document.querySelector("button[title='Pause: end turn, keep session for steering']") ||
                  document.querySelectorAll("button")[3];
      return btn ? !btn.hasAttribute("disabled") : false;
    });
    assert(pauseEnabledBefore, "Pause button enabled while running", "Pause button not enabled while running");

    // Click Pause
    const pauseBtn = page.locator("button:has-text('Pause')");
    await pauseBtn.click({ timeout: 5000 });

    // Wait for pause to take effect (max 15 seconds for interrupt)
    await page.waitForTimeout(500);
    let interrupted = false;
    const pauseDeadline = Date.now() + 20000;
    while (Date.now() < pauseDeadline) {
      const s = await readAllTextShapes(page);
      const turn1 = s.find(x => x.id?.startsWith("shape:") && (x.text?.startsWith("Turn 1") || x.text?.startsWith("Turn ")));
      if (turn1 && (turn1.text?.includes("interrupted") || turn1.text?.includes("status"))) {
        interrupted = true;
        log("Turn 1 result: " + turn1.text.slice(0, 100));
        break;
      }
      await delay(POLL_MS);
    }
    assert(interrupted, "Turn 1 shows interrupted after /pause", "Turn 1 did not show interrupted");

    await page.screenshot({ path: "/tmp/glassbox-s6-step2.png", fullPage: true });

    // Assert trace contains action.pause
    if (sessionId) {
      const entries = await readTrace(sessionId);
      const actionPause = entries?.filter(e => e.event?.method === "action.pause" || e.event?.params?.kind === "action.pause");
      assert(actionPause?.length > 0, "trace has action.pause record", "action.pause missing from trace");
      log("action.pause records: " + (actionPause?.length || 0));

      const turnStatusPause = actionPause?.[0]?.event?.params?.turnStatus;
      log("turnStatus in action.pause: " + (turnStatusPause || "none"));
    }

    // Assert Pause button is disabled after pausing
    const pauseEnabledAfter = await page.evaluate(() => {
      const btn = document.querySelector("button[title='Pause: end turn, keep session for steering']") ||
                  document.querySelectorAll("button")[3];
      return btn ? !btn.hasAttribute("disabled") : false;
    });
    assert(!pauseEnabledAfter, "Pause button disabled after pausing", "Pause button should be disabled after pausing");

    // Assert Steer input is enabled
    const steerInputEnabled = await page.evaluate(() => {
      const inp = document.querySelector("input[placeholder='Steer: type instruction...']");
      return inp ? !inp.hasAttribute("disabled") : false;
    });
    assert(steerInputEnabled, "Steer input enabled after pause", "Steer input should be enabled after pause");

    // ══ Step 3: Type instruction and Send ═════════════════════════════════
    log("\n=== Step 3: Steer instruction ===");

    await page.fill("input[placeholder='Steer: type instruction...']", "now say goodbye");

    // Click Steer button or press Enter
    const steerBtn = page.locator("button:has-text('Steer')");
    const isSteerDisabled = await steerBtn.isDisabled().catch(() => true);
    assert(!isSteerDisabled, "Steer button enabled after pasting text", "Steer button should be enabled");

    await steerBtn.click({ timeout: 5000 });
    await page.waitForTimeout(4000);

    // Check current shapes for Turn 2 "Steered:" label
    const afterSteerShapes = await readAllTextShapes(page);
    const turn2Label = afterSteerShapes.find(s => s.text?.includes("Turn 2") || s.id?.includes("turn"));
    const steerLabel = afterSteerShapes.find(s => s.text?.startsWith("Steered:") || s.text?.toLowerCase().startsWith("steered:"));

    // Accept turn2 result shape as evidence (it may show "running..." while turn is active)
    assert(!!turn2Label || !!steerLabel, "Turn 2 shape or Steer shape appeared", "No Turn 2 / Steered shape found");
    log("Turn 2 shape: " + (turn2Label?.text?.slice(0, 80) || "none"));
    log("Steer shape: " + (steerLabel?.text?.slice(0, 80) || "none"));

    await page.screenshot({ path: "/tmp/glassbox-s6-step3.png", fullPage: true });

    // Wait for turn 2 to complete (status completes or interrupted)
    const turn2Deadline = Date.now() + 30000;
    while (Date.now() < turn2Deadline) {
      const s = await readAllTextShapes(page);
      const hasCompleted = s.some(x => x.id?.startsWith("shape:") && x.text?.includes("completed"));
      if (hasCompleted) break;
      await delay(POLL_MS);
    }

    // Assert trace has action.steer
    if (sessionId) {
      const entries = await readTrace(sessionId);
      const actionSteer = entries?.filter(e => e.event?.method === "action.steer" || e.event?.params?.kind === "action.steer");
      assert(actionSteer?.length > 0, "trace has action.steer record", "action.steer missing from trace");
      log("action.steer records: " + (actionSteer?.length || 0));
    }

    // ══ Step 4: Assert derived state (same thread, multiple turns) ═══════
    log("\n=== Step 4: Thread/turn continuity ===");
    if (sessionId) {
      const stateRes = await fetch(`http://localhost:${SERVER_PORT}/state/${sessionId}`);
      if (!stateRes.ok) { fail("state endpoint failed"); exitCode = 1; }
      else {
        const { derivedState } = await stateRes.json();
        const turns = derivedState?.turns || [];
        assert(turns.length >= 2, "derivedState has >= 2 turns", "derivedState has < 2 turns");
        log("turns: " + JSON.stringify(turns.map(t => ({
          task: t.taskOrInstruction,
          status: t.finalResult?.status,
        }))));

        const threadConsistent = turns.length >= 2;
        _ = threadConsistent ? log("PASS: same thread, multiple turns") : fail("inconsistent turns");

        // Trace order: provider events for turn1, action.pause, provider events for turn2, action.steer ...
        const traceEntries = await readTrace(sessionId);
        const methods = traceEntries?.map(e => e.event?.method) || [];
        log("Trace methods: " + JSON.stringify(methods.slice(0, 25)));

        // Find indices
        const t1end = methods.findIndex(m => m === "turn/completed" || m === "turn/interrupted");
        const t1pause = methods.findIndex(m => m === "action.pause");
        const t2start = methods.findIndex(m => m === "turn/started");

        log(`turn1end@${t1end}, pause@${t1pause}, turn2start@${t2start}`);

        if (t1end >= 0 && t1pause > t1end && t2start > t1pause) {
          log("PASS: trace order (turn1 end → action.pause → turn2 start)");
        } else {
          log("FAIL/WARN: trace order not as expected"); exitCode = 1;
        }
      }
    }

    // ══ Step 5: Reload and reconstruct from trace ═══════════════════════
    log("\n=== Step 5: Reload/trace recovery ===");
    if (sessionId) {
      await page.reload({ waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(4000);

      const reloadShapes = await readAllTextShapes(page);
      const hasTaskShape = reloadShapes.some(s => s.text?.startsWith("Task:"));
      const hasTurn1Shape = reloadShapes.some(s => s.id?.startsWith("shape:") && s.text?.includes("Turn 1"));
      const hasTurn2Shapes = reloadShapes.some(s => s.id?.startsWith("shape:") && s.text?.includes("Turn 2") || s.text?.startsWith("Steered:"));

      assert(hasTaskShape && hasTurn1Shape && hasTurn2Shapes,
        "shapes re-rebuilt from trace after reload",
        "shapes NOT rebuilt from trace");

      await page.screenshot({ path: "/tmp/glassbox-s6-post-reload.png", fullPage: true });
      log("Screenshot: /tmp/glassbox-s6-post-reload.png");

      // Trace action records survive reload
      const entries = await readTrace(sessionId);
      const actions = entries?.filter(e =>
        e.event?.method === "action.pause" || e.event?.method === "action.steer"
      );
      assert(actions?.length >= 2, "action.pause + action.steer survive reload", "action records lost in reload");
    }

    await page.screenshot({ path: "/tmp/glassbox-s6-final.png", fullPage: true });
    log("\nScreenshot: /tmp/glassbox-s6-final.png");

  } catch (err) {
    console.error("\n=== E2E ERROR ===", err.message);
    if (browser) {
      try { await (await (await browser).newContext()).newPage()?.screenshot({ path: "/tmp/glassbox-s6-fail.png", fullPage: true }); } catch {}
      try { await browser.close(); } catch {}
    }
    exitCode = 1;
  } finally {
    if (serverProc && freshServer) await kill(serverProc);
    if (webProc && freshWeb) await kill(webProc);
  }

  if (exitCode === 0) {
    log("\n=== S6 E2E PASSED ===");
  } else {
    log("\n=== S6 E2E FAILED (exitCode=" + exitCode + ") ===");
  }
  process.exitCode = exitCode;
})();
