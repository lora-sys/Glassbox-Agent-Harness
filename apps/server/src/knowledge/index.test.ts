import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorizationService } from "../auth/service.js";
import { IdentityService } from "../identity/service.js";
import type { TrustedChannelScope } from "../identity/scope.js";
import { DomainDatabase } from "../persistence/database.js";
import {
  knowledgeSchemaStatements,
  WebsiteKnowledgeService,
  WEBSITE_KNOWLEDGE_DELIVERY_ACTION,
  WEBSITE_KNOWLEDGE_READ_ACTION,
  WEBSITE_KNOWLEDGE_RESOURCE,
  WEBSITE_KNOWLEDGE_SYNC_ACTION,
} from "./index.js";
import type { KnowledgeHttpResponse, KnowledgeNetworkProvider } from "./network.js";

const ROOT = "https://lora-sys.github.io/loraSys/";
const ARTICLE_A = `${ROOT}blog/agent-memory-guide/`;
const ARTICLE_ALIAS = `${ROOT}blog/old-agent-memory-guide/`;
const ARTICLE_STALE = `${ROOT}blog/removed-article/`;
const scope: TrustedChannelScope = {
  connectionId: "connection",
  botId: "bot",
  chatType: "private",
  chatId: "owner-chat",
  senderId: "owner-user",
};

let db: DomainDatabase | undefined;
let auth: AuthorizationService | undefined;
let scratch: string | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
  if (scratch)
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (process.platform !== "win32" || error.code !== "EBUSY") throw error;
      },
    );
  scratch = undefined;
});

function html(
  title: string,
  body: string,
  date = "2026-09-10T00:00:00Z",
  options: { canonical?: string; robots?: string; draft?: boolean } = {},
): string {
  return `<html lang="en"><head><title>${title}</title><meta property="article:published_time" content="${date}">${options.canonical ? `<link rel="canonical" href="${options.canonical}">` : ""}${options.robots ? `<meta name="robots" content="${options.robots}">` : ""}${options.draft ? `<meta name="draft" content="true">` : ""}</head><body><main><article><h1>${title}</h1><p>${body}</p></article></main></body></html>`;
}

function provider(
  options: {
    urls?: string[];
    feedUrls?: string[];
    pages?: Record<string, string>;
    fail?: string;
    redirect?: string;
    robots?: string;
    documents?: Record<string, string>;
  } = {},
) {
  const requests: string[] = [];
  const pageMap = options.pages ?? {
    [ARTICLE_A]: html(
      "Agent memory guide",
      "Glassbox article explains durable agent memory retrieval and authorization.",
    ),
  };
  const feedItems = (options.feedUrls ?? options.urls ?? Object.keys(pageMap))
    .map(
      (url) =>
        `<item><title>Feed title</title><link>${url}</link><pubDate>2026-09-10T00:00:00Z</pubDate></item>`,
    )
    .join("");
  const network: KnowledgeNetworkProvider = {
    resolveHost: async () => ["8.8.8.8"],
    async request(url): Promise<KnowledgeHttpResponse> {
      requests.push(url);
      if (url === ROOT && options.redirect)
        return { status: 302, headers: { location: options.redirect }, body: "" };
      if (options.fail === url) return { status: 503, headers: {}, body: "down" };
      if (options.documents?.[url])
        return { status: 200, headers: {}, body: options.documents[url]! };
      if (url === ROOT)
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: `<html><head><link rel="alternate" type="application/rss+xml" href="${ROOT}feed.xml"></head></html>`,
        };
      if (url === "https://lora-sys.github.io/robots.txt")
        return { status: 200, headers: {}, body: options.robots ?? `Sitemap: ${ROOT}sitemap.xml` };
      if (url === `${ROOT}sitemap.xml`)
        return {
          status: 200,
          headers: {},
          body: `<urlset>${(options.urls ?? Object.keys(pageMap)).map((entry) => `<url><loc>${entry}</loc></url>`).join("")}</urlset>`,
        };
      if (url === `${ROOT}feed.xml`)
        return { status: 200, headers: {}, body: `<rss><channel>${feedItems}</channel></rss>` };
      return pageMap[url]
        ? { status: 200, headers: { "content-type": "text/html" }, body: pageMap[url]! }
        : { status: 404, headers: {}, body: "missing" };
    },
  };
  return { network, requests };
}

async function setup(databasePath = ":memory:", network = provider().network) {
  db = await DomainDatabase.open(databasePath);
  await db.transaction((tx) => tx.batch([...knowledgeSchemaStatements]));
  auth = new AuthorizationService(db);
  const identity = new IdentityService(db);
  await identity.bindOwner("owner", scope);
  await auth.registerResource({
    id: WEBSITE_KNOWLEDGE_RESOURCE,
    kind: "website-knowledge",
    visibility: "public",
  });
  for (const action of [
    WEBSITE_KNOWLEDGE_READ_ACTION,
    WEBSITE_KNOWLEDGE_SYNC_ACTION,
    WEBSITE_KNOWLEDGE_DELIVERY_ACTION,
  ])
    await auth.grant({
      principalId: "owner",
      resourceId: WEBSITE_KNOWLEDGE_RESOURCE,
      action,
      scope,
      effect: "allow",
    });
  return {
    service: new WebsiteKnowledgeService({ db, authorization: auth, network }),
    context: { caller: { principalId: "owner", scope } },
  };
}

async function grantArticle(resourceId: string) {
  if (!auth) throw new Error("test setup missing");
  await auth.grant({
    principalId: "owner",
    resourceId,
    action: WEBSITE_KNOWLEDGE_READ_ACTION,
    scope,
    effect: "allow",
  });
  await auth.grant({
    principalId: "owner",
    resourceId,
    action: WEBSITE_KNOWLEDGE_DELIVERY_ACTION,
    scope,
    effect: "allow",
  });
}

describe("website knowledge", () => {
  it("updates and removes articles only after a complete sync", async () => {
    const firstProvider = provider();
    const { service, context } = await setup(":memory:", firstProvider.network);
    const first = await service.syncSite(context);
    expect(first).toMatchObject({ articleCount: 1, inserted: 1, updated: 0, removed: 0 });
    const before = (await service.currentArticleResources())[0]!;
    await grantArticle(before.resourceId);

    const newer = provider({
      pages: {
        [ARTICLE_A]: html(
          "Agent memory retrieval",
          "Updated article explains query driven memory retrieval.",
          "2026-10-01T00:00:00Z",
        ),
      },
    });
    const updatedService = new WebsiteKnowledgeService({
      db: db!,
      authorization: auth!,
      network: newer.network,
    });
    const update = await updatedService.syncSite(context);
    expect(update).toMatchObject({ articleCount: 1, inserted: 0, updated: 1, removed: 0 });
    const after = (await service.currentArticleResources())[0]!;
    expect(after.digest).not.toBe(before.digest);
    await expect(
      auth!.check({
        caller: context.caller,
        resourceId: before.resourceId,
        action: WEBSITE_KNOWLEDGE_READ_ACTION,
      }),
    ).resolves.toMatchObject({ decision: "DENY" });

    const empty = provider({ urls: [], pages: {} });
    const emptyService = new WebsiteKnowledgeService({
      db: db!,
      authorization: auth!,
      network: empty.network,
    });
    const removal = await emptyService.syncSite(context);
    expect(removal).toMatchObject({ articleCount: 0, inserted: 0, removed: 1 });
    expect(await service.currentArticleResources()).toEqual([]);
    const republished = await service.syncSite(context);
    expect(republished).toMatchObject({ articleCount: 1, inserted: 1 });
    const restored = (await service.currentArticleResources())[0]!;
    expect(restored.digest).toBe(before.digest);
    expect(restored.resourceId).not.toBe(before.resourceId);
    await expect(
      auth!.check({
        caller: context.caller,
        resourceId: before.resourceId,
        action: WEBSITE_KNOWLEDGE_READ_ACTION,
      }),
    ).resolves.toMatchObject({ decision: "DENY" });
  });

  it("preserves the previous snapshot when one article fetch fails", async () => {
    const initial = provider();
    const { service, context } = await setup(":memory:", initial.network);
    await service.syncSite(context);
    const partial = provider({
      urls: [ARTICLE_A],
      pages: {
        [ARTICLE_A]: html(
          "Changed",
          "A changed document that must not replace the existing stored article.",
        ),
      },
      fail: ARTICLE_A,
    });
    const broken = new WebsiteKnowledgeService({
      db: db!,
      authorization: auth!,
      network: partial.network,
    });
    await expect(broken.syncSite(context)).rejects.toMatchObject({
      code: "knowledge_article_unavailable",
    });
    expect(await service.currentArticleResources()).toHaveLength(1);
    await db!.transaction(async (tx) => {
      const sync = await tx.execute({
        sql: "SELECT article_count FROM website_knowledge_syncs WHERE site_id = ?",
        args: ["lora-sys.github.io/loraSys"],
      });
      expect(sync.rows[0]?.article_count).toBe(1);
      const events = await tx.execute({
        sql: "SELECT status,failure_code FROM website_knowledge_sync_events ORDER BY occurred_at",
        args: [],
      });
      expect(events.rows.map((row) => row.status)).toEqual(["succeeded", "failed"]);
      expect(events.rows[1]?.failure_code).toBe("knowledge_article_unavailable");
      await expect(
        tx.execute({ sql: "DELETE FROM website_knowledge_sync_events", args: [] }),
      ).rejects.toThrow(/append-only/u);
    });
  });

  it("rejects malicious sitemap URLs and redirects before requesting them", async () => {
    const malicious = "http://127.0.0.1/private";
    const initial = provider();
    const { service, context } = await setup(":memory:", initial.network);
    await service.syncSite(context);
    const currentBefore = await service.currentArticleResources();
    const listed = provider({ urls: [ARTICLE_A, malicious] });
    const maliciousSite = new WebsiteKnowledgeService({
      db: db!,
      authorization: auth!,
      network: listed.network,
    });
    await expect(maliciousSite.syncSite(context)).rejects.toMatchObject({
      code: "knowledge_sitemap_url_not_allowed",
    });
    expect(listed.requests).not.toContain(malicious);

    const redirected = provider({ redirect: malicious });
    const unsafe = new WebsiteKnowledgeService({
      db: db!,
      authorization: auth!,
      network: redirected.network,
    });
    await expect(unsafe.syncSite(context)).rejects.toMatchObject({
      code: "knowledge_network_target_denied",
    });
    expect(redirected.requests).toEqual([ROOT]);
    expect(await service.currentArticleResources()).toEqual(currentBefore);
  });

  it("uses the authoritative robots sitemap index without requiring sitemap.xml", async () => {
    const indexUrl = `${ROOT}sitemap-index.xml`;
    const childUrl = `${ROOT}sitemaps/blog.xml`;
    const indexed = provider({
      robots: `Sitemap: ${indexUrl}`,
      documents: {
        [indexUrl]: `<sitemapindex><sitemap><loc>${childUrl}</loc></sitemap></sitemapindex>`,
        [childUrl]: `<urlset><url><loc>${ARTICLE_A}</loc></url></urlset>`,
      },
    });
    const { service, context } = await setup(":memory:", indexed.network);
    await expect(service.syncSite(context)).resolves.toMatchObject({ articleCount: 1 });
    expect(indexed.requests).toContain(indexUrl);
    expect(indexed.requests).toContain(childUrl);
    expect(indexed.requests).not.toContain(`${ROOT}sitemap.xml`);
  });

  it("limits indexing to canonical blog articles and ignores RSS entries absent from the sitemap", async () => {
    const nonArticleUrls = [
      `${ROOT}about/`,
      `${ROOT}contact/`,
      `${ROOT}terms/`,
      `${ROOT}blog/`,
      `${ROOT}blog/en/`,
      `${ROOT}blog/tags/`,
      `${ROOT}blog/noindex-article/`,
      `${ROOT}blog/draft-article/`,
    ];
    const staleFeeds = provider({
      urls: [...nonArticleUrls, ARTICLE_A],
      feedUrls: [ARTICLE_A, ARTICLE_STALE],
      pages: {
        [ARTICLE_A]: html(
          "Agent memory guide",
          "Glassbox article explains durable agent memory retrieval and authorization.",
        ),
        [`${ROOT}blog/noindex-article/`]: html(
          "Noindex",
          "This page must not be indexed.",
          undefined,
          { robots: "noindex,follow" },
        ),
        [`${ROOT}blog/draft-article/`]: html(
          "Draft",
          "Draft material must not be indexed.",
          undefined,
          { draft: true },
        ),
      },
    });
    const { service, context } = await setup(":memory:", staleFeeds.network);
    await service.syncSite(context);
    expect(staleFeeds.requests).toContain(ARTICLE_A);
    for (const url of [
      ...nonArticleUrls.filter((url) => !url.includes("/noindex-") && !url.includes("/draft-")),
      ARTICLE_STALE,
    ])
      expect(staleFeeds.requests).not.toContain(url);
    expect(await service.currentArticleResources()).toHaveLength(1);
  });

  it("deduplicates pages that declare the same canonical article URL", async () => {
    const pages = provider({
      urls: [ARTICLE_ALIAS, ARTICLE_A],
      pages: {
        [ARTICLE_ALIAS]: html("Agent memory guide", "Same canonical article content.", undefined, {
          canonical: ARTICLE_A,
        }),
        [ARTICLE_A]: html("Agent memory guide", "Same canonical article content."),
      },
    });
    const { service, context } = await setup(":memory:", pages.network);
    await expect(service.syncSite(context)).resolves.toMatchObject({
      articleCount: 1,
      inserted: 1,
    });
    expect(await service.currentArticleResources()).toMatchObject([{ url: ARTICLE_A }]);
  });

  it("fails closed when a sitemap index exceeds its child limit", async () => {
    const indexUrl = `${ROOT}sitemap-index.xml`;
    const childUrls = Array.from({ length: 6 }, (_, index) => `${ROOT}sitemaps/${index}.xml`);
    const indexed = provider({
      robots: `Sitemap: ${indexUrl}`,
      documents: {
        [indexUrl]: `<sitemapindex>${childUrls.map((url) => `<sitemap><loc>${url}</loc></sitemap>`).join("")}</sitemapindex>`,
      },
    });
    const { service, context } = await setup(":memory:");
    await service.syncSite(context);
    const incomplete = new WebsiteKnowledgeService({
      db: db!,
      authorization: auth!,
      network: indexed.network,
    });
    await expect(incomplete.syncSite(context)).rejects.toMatchObject({
      code: "knowledge_sitemap_limit_exceeded",
    });
    expect(await service.currentArticleResources()).toHaveLength(1);
  });

  it("preserves the prior snapshot when an indexed child sitemap is malformed", async () => {
    const indexUrl = `${ROOT}sitemap-index.xml`;
    const childUrl = `${ROOT}sitemaps/blog.xml`;
    const initial = provider();
    const { service, context } = await setup(":memory:", initial.network);
    await service.syncSite(context);
    const before = await service.currentArticleResources();
    const malformed = provider({
      robots: `Sitemap: ${indexUrl}`,
      documents: {
        [indexUrl]: `<sitemapindex><sitemap><loc>${childUrl}</loc></sitemap></sitemapindex>`,
        [childUrl]: `<urlset><url><loc>${ARTICLE_A}</loc></url>`,
      },
    });
    const incomplete = new WebsiteKnowledgeService({
      db: db!,
      authorization: auth!,
      network: malformed.network,
    });
    await expect(incomplete.syncSite(context)).rejects.toMatchObject({
      code: "knowledge_sitemap_invalid",
    });
    expect(await service.currentArticleResources()).toEqual(before);
  });

  it("rechecks sync authorization inside the snapshot commit", async () => {
    const initial = provider();
    const { service, context } = await setup(":memory:", initial.network);
    await service.syncSite(context);
    const before = (await service.currentArticleResources())[0]!;
    const changed = provider({
      pages: {
        [ARTICLE_A]: html(
          "Changed title",
          "A newly revised article about durable Glassbox memory retrieval.",
        ),
      },
    });
    const network: KnowledgeNetworkProvider = {
      ...changed.network,
      async request(url, signal) {
        if (url === ARTICLE_A)
          await auth!.revokeScopeAction({
            principalId: context.caller.principalId,
            resourceId: WEBSITE_KNOWLEDGE_RESOURCE,
            action: WEBSITE_KNOWLEDGE_SYNC_ACTION,
            scope,
          });
        return changed.network.request(url, signal);
      },
    };
    const pending = new WebsiteKnowledgeService({ db: db!, authorization: auth!, network });
    await expect(pending.syncSite(context)).rejects.toMatchObject({
      decision: { decision: "DENY" },
    });
    expect(await service.currentArticleResources()).toEqual([before]);
  });

  it("does not commit a scheduled refresh after sync has been disabled", async () => {
    const initial = provider();
    const { service, context } = await setup(":memory:", initial.network);
    await service.syncSite(context);
    const before = (await service.currentArticleResources())[0]!;
    await service.setSyncEnabled(context, true);
    await db!.transaction((tx) =>
      tx
        .execute({
          sql: "UPDATE website_knowledge_sync_policy SET next_attempt_at=? WHERE site_id=?",
          args: ["2000-01-01T00:00:00.000Z", "lora-sys.github.io/loraSys"],
        })
        .then(() => undefined),
    );
    const changed = provider({
      pages: { [ARTICLE_A]: html("Scheduled title", "A refreshed scheduled sync candidate.") },
    });
    const network: KnowledgeNetworkProvider = {
      ...changed.network,
      async request(url, signal) {
        if (url === ARTICLE_A) await service.setSyncEnabled(context, false);
        return changed.network.request(url, signal);
      },
    };
    const scheduled = new WebsiteKnowledgeService({ db: db!, authorization: auth!, network });
    await expect(scheduled.refreshIfDue()).rejects.toMatchObject({
      code: "knowledge_sync_disabled",
    });
    expect(await service.currentArticleResources()).toEqual([before]);
    expect(await service.getSyncPolicy()).toMatchObject({ enabled: false });
  });

  it("returns only relevant authorized hits and reopens from durable storage", async () => {
    scratch = await mkdtemp(join(tmpdir(), "glassbox-knowledge-"));
    const path = join(scratch, "knowledge.db");
    const { service, context } = await setup(path);
    await service.setSyncEnabled(context, true);
    await service.syncSite(context);
    const resource = (await service.currentArticleResources())[0]!;
    expect(await service.searchAuthorized(context, "unrelated underwater welding")).toEqual([]);
    expect(await service.searchAuthorized(context, "durable agent memory")).toEqual([]);
    await grantArticle(resource.resourceId);
    const hits = await service.searchAuthorized(context, "durable agent memory");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ url: ARTICLE_A, title: "Agent memory guide" });
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(602);
    await service.recheckAuthorized(context, hits);

    await db!.close();
    db = await DomainDatabase.open(path);
    await db.transaction((tx) => tx.batch([...knowledgeSchemaStatements]));
    const reopened = new WebsiteKnowledgeService({
      db,
      authorization: new AuthorizationService(db),
    });
    expect(await reopened.currentArticleResources()).toEqual([resource]);
    expect(await reopened.getSyncPolicy()).toMatchObject({ enabled: true, consecutiveFailures: 0 });
  });
});
