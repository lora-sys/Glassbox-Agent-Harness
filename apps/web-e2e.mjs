/**
 * Playwright verification for apps/web:
 * 1. Load page → check control bar appears
 * 2. Click "Run test" with default prompt "say ready"
 * 3. Wait for Canvas text shapes (task + result) to appear
 * 4. Assert both are visible
 */

import { chromium } from "playwright";
import http from "node:http";

const WEB_URL = "http://localhost:5173/";
const SERVER_URL = "http://localhost:3032/"; // mock server for verification

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function isServerUp(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 404);
      res.resume();
    }).on("error", () => resolve(false));
  });
}

async function main() {
  console.log("=== Glassbox Playwright Verification ===\n");

  // Wait for servers
  console.log("Checking server health…");
  for (let i = 0; i < 10; i++) {
    if (await isServerUp(SERVER_URL) && await isServerUp(WEB_URL)) break;
    await wait(1000);
  }
  const webOk = await isServerUp(WEB_URL);
  const serverOk = await isServerUp(SERVER_URL);
  console.log(`  apps/web  (5173): ${webOk ? "UP" : "DOWN"}`);
  console.log(`  apps/server (3030): ${serverOk ? "UP" : "DOWN"}`);

  if (!webOk || !serverOk) {
    console.log("\nFATAL: Server(s) not responding.");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // Collect console errors
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });

  try {
    // ── Step 1: Load page ──────────────────────────
    console.log("\n[1] Loading Glassbox Canvas…");
    const response = await page.goto(WEB_URL, { waitUntil: "domcontentloaded", timeout: 15000 });
    console.log(`    HTTP ${response?.status()}`);

    // Wait for tldraw to mount (fonts + canvas)
    await wait(4000);

    console.log("    Waiting for 'Glassbox' control bar…");
    await page.getByText("Glassbox", { exact: false }).waitFor({ timeout: 10000 });
    console.log("    ✓ Glassbox brand found");

    const runButton = page.getByRole("button", { name: "Run test" });
    await runButton.waitFor({ timeout: 5000 });
    console.log("    ✓ 'Run test' button found");

    // ── Step 2: Click "Run test" ────────────────────
    console.log("\n[2] Starting test run…");
    await runButton.click();
    console.log("    ✓ Sent POST /api/run-test → proxied to /run-test");

    // Wait for button to show "Running…" (confirms fetch started)
    // Use first() in case React StrictMode creates duplicate elements
    await page.getByRole("button", { name: "Running…" }).first().waitFor({ timeout: 10000 });
    console.log("    ✓ Button shows 'Running…'");

    // Wait for Result text to appear. The /run-test takes ~30s.
    console.log("    Waiting for derivedState (up to 45s)…");

    const appeared = await page
      .waitForFunction(
        () => {
          function findText(needle) {
            const els = document.querySelectorAll("*");
            for (const el of els) {
              const t = (el.textContent || "").trim();
              if (t.includes(needle)) return true;
            }
            return false;
          }
          return findText("Result:") && findText("say ready");
        },
        { timeout: 45000 }
      )
      .then(() => true)
      .catch(() => false);

    if (!appeared) {
      console.log("    ✗ Result text NOT found within 45s");
      console.log("    Page text at timeout:", await page.evaluate(() => document.body.innerText.slice(0, 500)));
      // Continue with assertions anyway (they will fail)
    } else {
      console.log("    ✓ Result + Task text visible on canvas");
    }

    // Wait for button to become "Run test" again (session ended)
    console.log("    Waiting for session end…");
    try {
      await runButton.waitFor({ state: "visible", timeout: 45000 });
    } catch {
      //may fail if still running
    }
    const btnText = await runButton.textContent();
    console.log(`    Button text: "${btnText}"`);

    // ── Step 3: Verify canvas content ──────────────
    console.log("\n[3] Verifying canvas shapes…");
    const canvasText = await page.evaluate(() => {
      const editorEl = document.querySelector('[data-tldraw-area="canvas"]');
      if (!editorEl) return { foundArea: false, texts: [] };
      const texts = [];
      for (const el of editorEl.querySelectorAll("*")) {
        const t = (el.textContent || "").trim();
        if (t && t.length > 0 && t.length < 500) texts.push(t);
      }
      return { foundArea: true, texts: texts.slice(0, 20) };
    });
    console.log(`    Text fragments: ${JSON.stringify(canvasText.texts.slice(0, 8))}`);

    // ── Assertions ──────────────────────────────────
    const asserts = [
      {
        name: "Control bar (Glassbox) is visible",
        check: async () => (await page.getByText("Glassbox").count()) > 0,
      },
      {
        name: "Run test button is visible",
        check: async () => (await page.getByRole("button", { name: "Run test" }).count()) > 0,
      },
      {
        name: "Task text appears on canvas",
        check: async () =>
          canvasText.texts.some((t) => t.includes("Task:") && t.includes("say ready")),
      },
      {
        name: "Result text appears on canvas",
        check: async () => canvasText.texts.some((t) => t.includes("Result:")),
      },
      {
        name: "No JS console errors",
        check: async () => {
          const relevant = consoleErrors.filter(
            (e) => !e.includes("favicon") && !e.includes("Source map")
          );
          return relevant.length === 0;
        },
      },
    ];

    console.log("\n=== Assertions ===\n");
    let passed = 0;
    let failed = 0;
    for (const a of asserts) {
      try {
        const result = await a.check();
        console.log(result ? `  PASS  ${a.name}` : `  FAIL  ${a.name}`);
        result ? passed++ : failed++;
      } catch (e) {
        failed++;
        console.log(`  FAIL  ${a.name}: ${e?.message || e}`);
      }
    }

    console.log(`\n=== VERIFICATION RESULT: ${passed}/${asserts.length} passed ===`);

    if (consoleErrors.length > 0) {
      console.log("\nConsole messages:");
      consoleErrors.forEach((e) => console.log(`  ${e}`));
    }

    if (failed > 0) {
      console.log("\nScreenshots saved to /tmp/web-check*.png");
      await page.screenshot({ path: "/tmp/web-verification-fail.png", fullPage: true });
    }

    await browser.close();
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error(`\nFATAL ERROR: ${err?.message || err}`);
    await page.screenshot({ path: "/tmp/web-fatal.png", fullPage: true });
    await browser.close();
    process.exit(1);
  }
}

main();
