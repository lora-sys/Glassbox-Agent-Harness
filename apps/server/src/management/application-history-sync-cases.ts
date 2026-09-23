import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import { ManagementApplication } from "./application.js";
import type { HistorySyncOutcome } from "../runtime/pi/history-tools.js";

const { fixture, afterEachCleanup } = createApplicationFixtureScope();
afterEach(afterEachCleanup);

describe("bounded authorized history synchronization", () => {
  const PAGE = 3;
  const TOTAL = 12;
  const message = (seq: number) => ({
    message_id: seq,
    message_seq: seq,
    real_id: seq,
    time: 1_758_000_000 + seq,
    user_id: 10004,
    group_id: 10003,
    message_type: "group",
    sender: { user_id: 10004, nickname: "Visitor" },
    message: [{ type: "text", data: { text: `msg-${seq}` } }],
  });
  /** Pages backwards from the requested sequence, three records at a time. */
  const paged =
    (total = TOTAL) =>
    (params: { message_seq?: number }) => {
      const top = params.message_seq ?? total + 1;
      const records: Record<string, unknown>[] = [];
      for (let seq = top - 1; seq > 0 && records.length < PAGE; seq -= 1)
        records.push(message(seq));
      return records;
    };
  const sync = (app: ManagementApplication) =>
    app as unknown as {
      syncGroupHistory(
        connectionId: string,
        groupId: string,
        options?: { maxPages?: number; since?: string },
      ): Promise<HistorySyncOutcome>;
    };
  const storedIds = async (app: ManagementApplication) =>
    (await app.archive.searchMessages({ allowedGroupIds: ["10003"], limit: 50 }))
      .map((row) => row.externalMessageId)
      .sort();

  it("walks older pages up to the configured bound instead of only the newest page", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 2 });
    expect(await storedIds(f.app)).toEqual(["10", "11", "12", "7", "8", "9"]);
  });

  it("reaches older authorized history beyond the first page", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 });
    expect(await storedIds(f.app)).toHaveLength(TOTAL);
    expect(await storedIds(f.app)).toContain("1");
  });

  it("dedupes a repeated sync and stops without looping on a cursor that cannot advance", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 });
    expect(await storedIds(f.app)).toHaveLength(TOTAL);

    // A provider that keeps returning the same cursor must not be walked forever.
    const stuck = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: () => [message(5), message(5)],
    });
    await sync(stuck.app).syncGroupHistory("fixture", "10003", { maxPages: 10 });
    expect(await storedIds(stuck.app)).toEqual(["5"]);
  });

  it("treats NapCat's inclusive cursor-only page as the end of the source", async () => {
    const inclusive = (params: { message_seq?: number }) => {
      if (params.message_seq === undefined) return [message(3), message(2)];
      if (params.message_seq === 2) return [message(2), message(1)];
      return [message(1)];
    };
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: inclusive,
    });

    expect(await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 3,
      stop: "end_of_source",
    });
    expect(await storedIds(f.app)).toEqual(["1", "2", "3"]);
  });

  it("stops at the requested time bound", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", {
      maxPages: 10,
      since: new Date((1_758_000_000 + 9) * 1000).toISOString(),
    });
    expect(await storedIds(f.app)).toEqual(["10", "11", "12", "9"]);
  });

  it("reports how much of the source the walk reached", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });

    // Twelve records at three per page. Two pages is the bound, so older history exists that
    // this sync never read. Reporting that walk as an exhausted source is what let a search
    // call a partial window "the whole history" and answer a question the messages it never
    // reached were the answer to.
    expect(await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 2 })).toEqual({
      pagesWalked: 2,
      stop: "page_bound_reached",
    });

    // More pages than the fixture holds, so the walk ends because the provider said there is
    // no older page. This is the one case in which the archive really is the source.
    expect(await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 5,
      stop: "end_of_source",
    });
  });

  it("names the bound a walk stopped on instead of calling it the end of the source", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(),
    });
    // The caller asked for everything from sequence 9 onwards, and the walk passed that bound.
    // The archived window is the whole range the question is about, which is a different
    // statement from "the group has no older history" — and the one that is true here.
    expect(
      await sync(f.app).syncGroupHistory("fixture", "10003", {
        maxPages: 10,
        since: new Date((1_758_000_000 + 9) * 1000).toISOString(),
      }),
    ).toEqual({ pagesWalked: 2, stop: "since_bound_reached" });

    // A provider that keeps returning the same cursor has not said there is no older page,
    // so what follows it stays unknown rather than becoming the end of the source.
    const stuck = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: () => [message(5), message(5)],
    });
    expect(await sync(stuck.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 2,
      stop: "cursor_stuck",
    });
  });

  it("does not call a page it cannot page past the end of the source", async () => {
    // Records without a usable provider sequence cannot supply a backwards-page cursor.
    // That is not the provider saying it has nothing older, so what follows stays unknown
    // instead of becoming the end of the source.
    const unsequenced = () => [
      {
        message_id: 7,
        real_id: 7,
        time: 1_758_000_000 + 7,
        user_id: 10004,
        group_id: 10003,
        message_type: "group",
        sender: { user_id: 10004, nickname: "Visitor" },
        message: [{ type: "text", data: { text: "msg-7" } }],
      },
    ];
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: unsequenced,
    });
    expect(await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 1,
      stop: "provider_unknown",
    });

    // And the caller's own bound does not get to name this page either: the provider is the
    // one that left the walk's reach unknown, and a stop that reads as the caller's choice
    // would hide a stalled walk behind a deliberate one.
    expect(
      await sync(f.app).syncGroupHistory("fixture", "10003", {
        maxPages: 10,
        since: new Date((1_758_000_000 + 10) * 1000).toISOString(),
      }),
    ).toEqual({ pagesWalked: 1, stop: "provider_unknown" });
  });
});
