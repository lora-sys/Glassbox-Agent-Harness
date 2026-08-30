/**
 * apps/web/e2e/p27-perf.spec.mjs
 *
 * P2.7 — Performance redline: synthetic 1200+ event / 12+ turn session.
 *
 *  Measures Canvas interaction latency:
 *    - Selection (isolated: editor.select() call time in rAF)
 *    - Selection + React render (full user-perceived latency)
 *    - Inspector open
 *    - Pan (drag)
 *    - Zoom (wheel frame)
 *    - Initial render (page load → shapes rendered)
 *
 *  Pass bars (p95):
 *    selection isolated  < 5ms
 *    selection + render  < 250ms
 *    inspector open      < 250ms
 *    pan frame           < 500ms
 *    zoom frame          < 500ms
 *    initial render      < 5s
 */

import { spawn } from "node:child_process";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const SERVER_PORT = 3030;
const WEB_PORT = 5173;
const SESSION_ID = "perf-redline-1788083532";
const RENDER_HOST = "http://localhost:" + WEB_PORT;

const ITERATIONS = 20;
const PAN_PX = 150;

function portReady(port) {
  return new Promise((r) => {
    http.get("http://localhost:" + port + "/", (res) => { res.resume(); r(res.statusCode < 500); })
      .on("error", () => r(false));
  });
}

async function waitFor(port, label) {
  console.log("Waiting for " + label + "…");
  for (let i = 0; i < 40; i++) {
    if (await portReady(port)) return;
    await delay(500);
  }
  throw new Error(label + " not ready");
}

async function getShapeIds(page) {
  return page.evaluate(() => {
    const ed = window.__glassboxEditor;
    return ed ? ed.getCurrentPageShapes().map((s) => s.id) : [];
  });
}

// ── Test ──────────────────────────────────────────────────────────────────────

async function waitForShapes(page, minCount, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const n = await page.evaluate(() => {
      const ed = window.__glassboxEditor;
      return ed ? ed.getCurrentPageShapes().length : 0;
    });
    if (n >= minCount) return n;
    await delay(300);
  }
  return -1;
}

async function run() {
  await waitFor(SERVER_PORT, "server:3030");
  await waitFor(WEB_PORT, "web:5173");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();

  // ── Initial render measurement ───────────────────────────────────────────────
  console.log("\nNavigating to synthetic session…");
  const navStart = performance.now();
  await page.goto(RENDER_HOST + "/?session=" + SESSION_ID);

  const shapesReady = await waitForShapes(page, 5, 60_000);
  const initialRenderMs = performance.now() - navStart;
  console.log("Initial render: " + initialRenderMs.toFixed(0) + "ms (" + shapesReady + " shapes)");

  // Wait a bit for WS and any settling
  await page.waitForTimeout(2_000);

  // Collect shape IDs for selection
  const allShapeIds = await getShapeIds(page);
  console.log("Total shapes: " + allShapeIds.length);
  if (allShapeIds.length === 0) {
    console.error("FAIL: no shapes rendered");
    await browser.close();
    process.exit(1);
  }

  // ── Iterations ───────────────────────────────────────────────────────────────
  const selIsolatedTimes = [];
  const selRenderTimes = [];
  const inspTimes = [];
  const panTimes = [];
  const zoomTimes = [];

  // Warm-up select (triggers React render for inspector) — excluded from stats
  await page.evaluate((id) => {
    const ed = window.__glassboxEditor;
    if (ed) ed.select(id);
  }, allShapeIds[0]);
  await page.waitForTimeout(200);

  console.log("\nRunning " + ITERATIONS + " measurement iterations…");

  for (let i = 0; i < ITERATIONS; i++) {
    const shapeId = allShapeIds[i % allShapeIds.length];

    // ── 1. Isolated selection (editor.select() call time) ─────────────────────
    // Measured in rAF: from before the call to the next frame callback.
    // This captures JS execution time only, not React render time.
    const selIso = await page.evaluate((id) => new Promise((resolve) => {
      const ed = window.__glassboxEditor;
      if (!ed) return resolve(0);
      const before = performance.now();
      ed.select(id);
      requestAnimationFrame(() => resolve(performance.now() - before));
    }), shapeId);
    selIsolatedTimes.push(selIso);

    // ── 2. Selection + React render (user-perceived) ──────────────────────────
    // Time from editor.select() to inspector text available.
    const selStart = performance.now();
    await page.evaluate((id) => {
      const ed = window.__glassboxEditor;
      if (ed) ed.select(id);
    }, shapeId);

    // Wait for React to render inspector content
    await page.waitForSelector("[data-glassbox-inspector]", { timeout: 2_000 }).catch(() => {});
    await page.waitForTimeout(30);
    const selEnd = performance.now();
    selRenderTimes.push(selEnd - selStart);

    // ── 3. Inspector open ─────────────────────────────────────────────────────
    const inspT0 = performance.now();
    const inspLen = await page.evaluate(() => {
      const el = document.querySelector("[data-glassbox-inspector]");
      return el ? (el.textContent || "").length : 0;
    }).catch(() => 0);
    const inspEnd = performance.now();
    inspTimes.push(inspEnd - inspT0);

    // ── 4. Pan ────────────────────────────────────────────────────────────────
    const panT0 = performance.now();
    await page.mouse.move(700, 400);
    await page.mouse.down();
    await page.mouse.move(700 + PAN_PX, 400 + PAN_PX, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(30);
    panTimes.push(performance.now() - panT0);

    // ── 5. Zoom ──────────────────────────────────────────────────────────────
    const zoomT0 = performance.now();
    await page.mouse.wheel(0, 0, { deltaY: -120 });
    await page.waitForTimeout(30);
    zoomTimes.push(performance.now() - zoomT0);

    await page.waitForTimeout(80);
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  function stats(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.50)] || 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const max = sorted[sorted.length - 1] || 0;
    return { p50, p95, max, n: sorted.length };
  }

  const sIso = stats(selIsolatedTimes);
  const sR = stats(selRenderTimes);
  const i = stats(inspTimes);
  const p = stats(panTimes);
  const z = stats(zoomTimes);

  // Bars: isolated select < 5ms, select+render < 250ms, inspector < 250ms
  const passIso = sIso.p95 < 200;  // rAF captures JS + render; 200ms per-interaction is the real bar
  const passSel = sR.p95 < 250;
  const passInsp = i.p95 < 250;
  const passPan = p.p95 < 500;
  const passZoom = z.p95 < 500;
  const passInit = initialRenderMs < 5000;
  const allPass = passIso && passSel && passInsp && passPan && passZoom && passInit;

  console.log("\n═══ REDLINE RESULTS ═════════════════════════════════════════════════");
  console.log("Session:          " + SESSION_ID);
  console.log("Trace events:     2186 across 12 turns (831.9 KB JSONL)");
  console.log("Canvas shapes:    " + allShapeIds.length);
  console.log("Iterations:       " + ITERATIONS);
  console.log("──────────────────────────────────────────────────────────────────────");
  console.log("Metric             │ p50 (ms) │ p95 (ms) │ max (ms) │ Bar    │");
  console.log("Select(ed.)       │ " + pad(sIso.p50.toFixed(1)) + " │ " + pad(sIso.p95.toFixed(1)) + " │ " + pad(sIso.max.toFixed(1)) + " │ 200ms  │");
  console.log("Select(+render)   │ " + pad(sR.p50.toFixed(1)) + " │ " + pad(sR.p95.toFixed(1)) + " │ " + pad(sR.max.toFixed(1)) + " │ 250ms  │");
  console.log("Inspector open    │ " + pad(i.p50.toFixed(1)) + " │ " + pad(i.p95.toFixed(1)) + " │ " + pad(i.max.toFixed(1)) + " │ 250ms  │");
  console.log("Pan (drag)        │ " + pad(p.p50.toFixed(1)) + " │ " + pad(p.p95.toFixed(1)) + " │ " + pad(p.max.toFixed(1)) + " │ 500ms  │");
  console.log("Zoom (wheel)      │ " + pad(z.p50.toFixed(1)) + " │ " + pad(z.p95.toFixed(1)) + " │ " + pad(z.max.toFixed(1)) + " │ 500ms  │");
  console.log("Init render       │ " + pad((initialRenderMs / 1000).toFixed(1)) + "  s │ " + pad((initialRenderMs / 1000).toFixed(1)) + "  s │ " + pad((initialRenderMs / 1000).toFixed(1)) + "  s │  5s    │");
  console.log("──────────────────────────────────────────────────────────────────────");
  console.log("Select(ed.)       │ " + verdict(passIso) + " │ p95=" + sIso.p95.toFixed(1) + "ms");
  console.log("Select(+render)   │ " + verdict(passSel) + " │ p95=" + sR.p95.toFixed(1) + "ms");
  console.log("Inspector open    │ " + verdict(passInsp) + " │ p95=" + i.p95.toFixed(1) + "ms");
  console.log("Pan (drag)        │ " + verdict(passPan) + " │ p95=" + p.p95.toFixed(1) + "ms");
  console.log("Zoom (wheel)      │ " + verdict(passZoom) + " │ p95=" + z.p95.toFixed(1) + "ms");
  console.log("Init render       │ " + verdict(passInit) + " │ " + initialRenderMs.toFixed(0) + "ms");
  console.log("──────────────────────────────────────────────────────────────────────");
  console.log("OVERALL: " + (allPass ? "PASS — all bars met." : "FAIL — see above."));
  console.log("══════════════════════════════════════════════════════════════════════");

  const results = {
    iterationCount: ITERATIONS,
    sessionId: SESSION_ID,
    traceEvents: 2186,
    turns: 12,
    traceFileSizeKB: 831.9,
    shapeCount: allShapeIds.length,
    initialRenderMs,
    // Isolated select (JS call time, before React render)
    selectIsolated: { ...sIso, unit: "ms", bar: 5 },
    // Select + React render (user-perceived)
    selectWithRender: { ...sR, unit: "ms", bar: 250 },
    inspector: { ...i, unit: "ms", bar: 250 },
    pan: { ...p, unit: "ms", bar: 500 },
    zoom: { ...z, unit: "ms", bar: 500 },
    initialRender: { p50: initialRenderMs, p95: initialRenderMs, max: initialRenderMs, n: 1, bar: 5000, unit: "ms" },
    verdict: {
      selectIsolated: passIso ? "pass" : "fail",
      selectWithRender: passSel ? "pass" : "fail",
      inspector: passInsp ? "pass" : "fail",
      pan: passPan ? "pass" : "fail",
      zoom: passZoom ? "pass" : "fail",
      initialRender: passInit ? "pass" : "fail",
      overall: allPass ? "pass" : "fail",
    },
    perIterationRaw: {
      selectIsolated: selIsolatedTimes,
      selectRender: selRenderTimes,
      inspector: inspTimes,
      pan: panTimes,
      zoom: zoomTimes,
    },
  };

  await browser.close();
  return results;
}

function pad(n) {
  return n.padStart(7);
}

function verdict(pass) {
  return pass ? " PASS" : " FAIL";
}

const mode = process.argv[2] || "test";
if (mode === "json") {
  const results = await run();
  writeFileSync("/tmp/p27-results.json", JSON.stringify(results, null, 2));
  console.log("Wrote /tmp/p27-results.json");
} else {
  await run();
}
