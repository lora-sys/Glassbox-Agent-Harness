import { afterEach, describe, expect, it } from "vite-plus/test";
import { createApplicationFixtureScope } from "./application-test-helpers.js";
import { ManagementApplication } from "./application.js";
import type { HistorySyncOutcome } from "../runtime/pi/history-tools.js";
import type { CallerContext } from "../identity/scope.js";

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
  const ownerCaller: CallerContext = {
    principalId: "owner",
    scope: {
      connectionId: "fixture",
      botId: "10001",
      chatType: "private",
      chatId: "10002",
      senderId: "10002",
    },
  };
  const authorizeHistory = async (app: ManagementApplication) => {
    const internal = app as unknown as {
      store: {
        authorization: {
          registerResource(input: {
            id: string;
            kind: string;
            visibility: "public" | "private";
            ifAbsent: boolean;
          }): Promise<void>;
          grant(input: {
            principalId: string;
            resourceId: string;
            action: string;
            scope: CallerContext["scope"];
            effect: "allow";
          }): Promise<string>;
        };
        capabilities: {
          setHistory(input: {
            connectionId: string;
            groupId: string;
            principalId: string;
            enabled: boolean;
          }): Promise<{ version: number }>;
        };
      };
    };
    await internal.store.authorization.registerResource({
      id: "group:10003",
      kind: "qq_group",
      visibility: "public",
      ifAbsent: true,
    });
    await internal.store.capabilities.setHistory({
      connectionId: "fixture",
      groupId: "10003",
      principalId: "owner",
      enabled: true,
    });
    await internal.store.authorization.grant({
      principalId: ownerCaller.principalId,
      resourceId: "group:10003",
      action: "history:read",
      scope: ownerCaller.scope,
      effect: "allow",
    });
    return ownerCaller;
  };
  const sync = (app: ManagementApplication) => {
    const internal = app as unknown as {
      syncGroupHistory(
        this: ManagementApplication,
        connectionId: string,
        groupId: string,
        options: { maxPages?: number; since?: string } | undefined,
        caller: CallerContext,
      ): Promise<HistorySyncOutcome>;
    };
    return {
      syncGroupHistory: async (
        connectionId: string,
        groupId: string,
        options?: { maxPages?: number; since?: string },
      ) =>
        internal.syncGroupHistory.call(
          app,
          connectionId,
          groupId,
          options,
          await authorizeHistory(app),
        ),
    };
  };
  const pollSync = (app: ManagementApplication) => {
    const internal = app as unknown as {
      syncPolledGroupHistory(
        this: ManagementApplication,
        target: { connectionId: string; groupId: string; caller: CallerContext },
        options: { maxPages: number; mode: "poll" | "backfill" },
      ): Promise<HistorySyncOutcome>;
    };
    return {
      syncPolledGroupHistory: async (
        target: { connectionId: string; groupId: string },
        options: { maxPages: number; mode: "poll" | "backfill" },
      ) =>
        internal.syncPolledGroupHistory.call(
          app,
          { ...target, caller: await authorizeHistory(app) },
          options,
        ),
    };
  };
  const storedIds = async (app: ManagementApplication) =>
    (await app.archive.searchMessages({ allowedGroupIds: ["10003"], limit: 200 }))
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

  it("continues a bounded reconnect backfill until it reaches the previous sync boundary", async () => {
    let total = 6;
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: (params) => paged(total)(params),
    });
    const app = pollSync(f.app);

    // The last previously observed message becomes the boundary for a later outage window.
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 1 });
    total = 75;

    const first = await app.syncPolledGroupHistory(
      { connectionId: "fixture", groupId: "10003" },
      { maxPages: 20, mode: "backfill" },
    );
    expect(first).toEqual({ pagesWalked: 20, stop: "page_bound_reached" });

    // The next ordinary bounded poll resumes from the saved cursor, rather than starting at
    // the newest page again. It stops at message 6, the newest message archived before outage.
    const continued = await app.syncPolledGroupHistory(
      { connectionId: "fixture", groupId: "10003" },
      { maxPages: 5, mode: "poll" },
    );
    expect(continued).toEqual({ pagesWalked: 4, stop: "cursor_boundary_reached" });
    expect(await storedIds(f.app)).toEqual(
      Array.from({ length: 72 }, (_, index) => String(index + 4)).sort(),
    );
  });

  it("treats a cursor-only continuation page as end-of-source", async () => {
    let total = 9;
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: (params) => paged(total)(params),
    });
    const app = pollSync(f.app);
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 1 });
    total = 6;

    const first = await app.syncPolledGroupHistory(
      { connectionId: "fixture", groupId: "10003" },
      { maxPages: 1, mode: "backfill" },
    );
    expect(first).toEqual({ pagesWalked: 1, stop: "page_bound_reached" });

    const continuation = await app.syncPolledGroupHistory(
      { connectionId: "fixture", groupId: "10003" },
      { maxPages: 1, mode: "poll" },
    );
    expect(continuation).toEqual({ pagesWalked: 1, stop: "page_bound_reached" });

    // The provider returns the inclusive cursor record by itself at the source tail.
    const tail = await app.syncPolledGroupHistory(
      { connectionId: "fixture", groupId: "10003" },
      { maxPages: 1, mode: "poll" },
    );
    expect(tail).toEqual({ pagesWalked: 1, stop: "end_of_source" });
  });
  it("serializes a reconnect backfill with a tick already in flight for that group", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(6),
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 1 });
    const app = pollSync(f.app);
    const internal = f.app as unknown as {
      connections: Map<
        string,
        {
          getGroupHistory: (input: { groupId: string; count: number; cursor?: string }) => Promise<{
            status: "ok";
            messages: Array<{ messageId: string }>;
            nextCursor?: string;
          }>;
        }
      >;
    };
    const connection = internal.connections.get("fixture");
    if (!connection) throw new Error("fixture connection missing");
    const original = connection.getGroupHistory.bind(connection);
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    let enteredFirst!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    connection.getGroupHistory = async (input) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (calls === 1) {
        enteredFirst();
        await firstGate;
      }
      try {
        return (await original(input)) as {
          status: "ok";
          messages: Array<{ messageId: string }>;
          nextCursor?: string;
        };
      } finally {
        inFlight -= 1;
      }
    };

    const backfill = app.syncPolledGroupHistory(
      { connectionId: "fixture", groupId: "10003" },
      { maxPages: 1, mode: "backfill" },
    );
    await firstStarted;
    const tick = app.syncPolledGroupHistory(
      { connectionId: "fixture", groupId: "10003" },
      { maxPages: 1, mode: "poll" },
    );
    expect(calls).toBe(1);

    releaseFirst();
    await Promise.all([backfill, tick]);
    expect(calls).toBe(2);
    expect(maxInFlight).toBe(1);
  });

  it("rechecks history authority after a provider page returns", async () => {
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: paged(6),
    });
    const caller = await authorizeHistory(f.app);
    const internal = f.app as unknown as {
      connections: Map<
        string,
        {
          getGroupHistory: (input: { groupId: string; count: number; cursor?: string }) => Promise<{
            status: "ok";
            messages: Array<{ messageId: string }>;
            nextCursor?: string;
          }>;
        }
      >;
      store: {
        authorization: {
          revokeScopeAction(input: {
            principalId: string;
            resourceId: string;
            action: string;
            scope: CallerContext["scope"];
          }): Promise<void>;
        };
      };
      syncGroupHistory(
        this: ManagementApplication,
        connectionId: string,
        groupId: string,
        options: { maxPages?: number } | undefined,
        caller: CallerContext,
      ): Promise<HistorySyncOutcome>;
    };
    const connection = internal.connections.get("fixture");
    if (!connection) throw new Error("fixture connection missing");
    const original = connection.getGroupHistory.bind(connection);
    connection.getGroupHistory = async (input) => {
      const result = await original(input);
      await internal.store.authorization.revokeScopeAction({
        principalId: caller.principalId,
        resourceId: "group:10003",
        action: "history:read",
        scope: caller.scope,
      });
      return result;
    };

    expect(
      await internal.syncGroupHistory.call(f.app, "fixture", "10003", { maxPages: 2 }, caller),
    ).toEqual({ pagesWalked: 1, stop: "authorization_denied" });
    expect(await storedIds(f.app)).toEqual([]);
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

  it("does not archive the bot's own replies, and says how many it skipped", async () => {
    // 254 of the 633 archived messages on 2026-09-28 were the bot answering itself, and later
    // Runs read those answers back as something a person had said. The count is part of the
    // outcome because a channel whose `botId` is wrong stops dropping anything, and nothing
    // else about the walk looks any different.
    const ownOnEveryPage = (params: { message_seq?: number }) =>
      paged()(params).map((record) => ({
        ...record,
        user_id: 10001,
        sender: { user_id: 10001, nickname: "Bot" },
      }));
    const f = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: ownOnEveryPage,
    });
    await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 1 });
    expect(await storedIds(f.app)).toEqual([]);
    expect(await sync(f.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 5,
      stop: "end_of_source",
      skippedOwnMessages: 12,
    });

    // A page that mixes both is archived for the people and skipped for the bot — on every
    // page, not just the first one the walk happens to open on.
    const mixed = (params: { message_seq?: number }) =>
      paged()(params).map((record, index) =>
        index === 0
          ? { ...record, user_id: 10001, sender: { user_id: 10001, nickname: "Bot" } }
          : record,
      );
    const g = await fixture(async () => ({ status: "succeeded", text: "ok" }), {
      history: mixed,
    });
    expect(await sync(g.app).syncGroupHistory("fixture", "10003", { maxPages: 10 })).toEqual({
      pagesWalked: 5,
      stop: "end_of_source",
      skippedOwnMessages: 4,
    });
    const stored = await storedIds(g.app);
    expect(stored).toHaveLength(8);
    for (const own of ["12", "9", "6", "3"]) expect(stored).not.toContain(own);
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
