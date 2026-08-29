// e2e/s6-steering.spec.ts
// S6 — Explicit steering: Stop + Steer, browser-verified vertical slice.
//
// Run:
//   PORT=3030 npx tsx apps/server/src/index.ts &   (in one terminal)
//   npx playwright test e2e/s6-steering.spec.ts     (in another)

import { test, expect } from "@playwright/test";

const SERVER_BASE = "http://localhost:3030";

async function clearSessionState(page: any): Promise<void> {
  await page.evaluate(() => {
    try { localStorage.removeItem("glassbox:lastSessionId"); } catch {}
    const url = new URL(window.location.href);
    url.search = "";
    window.history.replaceState(null, "", url.toString());
  });
}

test.describe("S6 explicit steering — Stop + Steer", () => {
  test("click Stop during active turn, then Steer, verify trace/canvas", async ({ page }) => {
    // 1. Fresh start
    await page.goto("http://localhost:5173/");
    await clearSessionState(page);
    await page.goto("http://localhost:5173/");

    // 2. Fill prompt and click Run test — /run-test now returns immediately with sessionId
    await page.fill('input[placeholder="Enter a task..."]', "say hello world");
    await page.click('text=Run test');

    // Wait for sessionId to appear in URL (component pushes it immediately)
    const getSessionId = async (): Promise<string> => {
      for (let i = 0; i < 30; i++) {
        const url = new URL(page.url());
        const sid = url.searchParams.get("session");
        if (sid) return sid;
        await page.waitForTimeout(200);
      }
      throw new Error("No sessionId in URL after Run test");
    };

    const sessionId = await getSessionId();
    console.log("[s6] sessionId:", sessionId);

    // Wait for WS to connect and subscribe
    await page.locator("text=Subscribed").waitFor({ timeout: 30_000 });

    // 3. Click Stop while turn is active
    await page.click('button:has-text("Stop")');
    const stopConfirmed = page.locator("text=Stopped: yes");
    await stopConfirmed.waitFor({ timeout: 60_000 });
    console.log("[s6] Stop confirmed");

    // 4. Fetch trace and assert action.stop
    const traceRes = await fetch(`${SERVER_BASE}/trace/${sessionId}`);
    expect(traceRes.ok).toBe(true);
    const traceData = await traceRes.json();
    const entries = traceData.entries;
    const methods = entries.map((e: any) => e.event.method);

    const stopEntry = entries.find((e: any) => e.event.method === "action.stop");
    expect(stopEntry).toBeTruthy();
    expect(stopEntry!.event.params.kind).toBe("action.stop");
    expect(stopEntry!.event.params.source).toBe("glassbox-user");
    const stopSeq = stopEntry!.seq;
    console.log("[s6] action.stop at seq:", stopSeq);

    // 5. Derived state: interrupted
    const stateRes = await fetch(`${SERVER_BASE}/state/${sessionId}`);
    expect(stateRes.ok).toBe(true);
    const stateData = await stateRes.json();
    const ds = stateData.derivedState;
    expect(ds.finalResult?.status).toBe("interrupted");
    console.log("[s6] finalResult status:", ds.finalResult?.status);

    // 6. Steer: send instruction
    await page.fill('input[placeholder="Steer: type instruction..."]', "now say goodbye");
    await page.click('text=Steer');

    // Wait for the second turn to finish (steer response arrives via WS or log)
    const steerConfirmed = page.locator("text=Steered");
    await steerConfirmed.waitFor({ timeout: 60_000 });
    console.log("[s6] Steer confirmed");

    // 7. Check full trace
    const traceRes2 = await fetch(`${SERVER_BASE}/trace/${sessionId}`);
    const traceData2 = await traceRes2.json();
    const entries2 = traceData2.entries;
    const methods2 = entries2.map((e: any) => e.event.method);

    const steerEntry = entries2.find((e: any) => e.event.method === "action.steer");
    expect(steerEntry).toBeTruthy();
    expect(steerEntry!.event.params.instruction).toBe("now say goodbye");
    console.log("[s6] action.steer at seq:", steerEntry!.seq);

    // 8. Trace ordering: first turn/started → action.stop → second turn/started → action.steer
    const firstStart = methods2.indexOf("turn/started");
    const actionStopIdx = methods2.indexOf("action.stop");
    const secondStart = methods2.lastIndexOf("turn/started");
    const actionSteerIdx = methods2.lastIndexOf("action.steer");

    expect(firstStart).toBeGreaterThanOrEqual(0);
    expect(actionStopIdx).toBeGreaterThan(firstStart);
    expect(actionStopIdx).toBeLessThan(secondStart);
    expect(actionSteerIdx).toBeGreaterThan(secondStart);
    expect(methods2.filter((m: string) => m === "turn/started").length).toBe(2);
    console.log("[s6] trace order verified");

    // 9. Same thread for both turns
    const turnParams = entries2
      .filter((e: any) => e.event.method === "turn/started")
      .map((e: any) => e.event.params);
    expect(turnParams.length).toBe(2);
    expect(turnParams[0]?.threadId).toBe(turnParams[1]?.threadId);
    console.log("[s6] same threadId:", String(turnParams[0]?.threadId).slice(0, 20));

    // 10. Derived state turns array: 2 entries
    const stateRes3 = await fetch(`${SERVER_BASE}/state/${sessionId}`);
    const stateData3 = await stateRes3.json();
    const turns = stateData3.derivedState.turns as any[];
    expect(turns).toBeTruthy();
    expect(turns!.length).toBe(2);
    expect(turns![0].finalResult?.status).toBe("interrupted");
    expect(turns![0].taskOrInstruction).toBe("say hello world");
    expect(turns![1].finalResult?.status).toBe("completed");
    expect(turns![1].taskOrInstruction).toBe("now say goodbye");
    console.log("[s6] turns array verified, len:", turns!.length);

    // 11. Reload page and verify both turns reconstruct
    await clearSessionState(page);
    await page.reload();

    // Wait for derived state to arrive via WS
    await page.locator("[data-glassbox-inspector]").waitFor({ timeout: 15_000 });

    const stateRes4 = await fetch(`${SERVER_BASE}/state/${sessionId}`);
    const stateData4 = await stateRes4.json();
    const turnsAfter = stateData4.derivedState.turns as any[];
    expect(turnsAfter).toBeTruthy();
    expect(turnsAfter!.length).toBe(2);
    console.log("[s6] reload verified, turns:", turnsAfter!.length);
  }, 180_000);
});
