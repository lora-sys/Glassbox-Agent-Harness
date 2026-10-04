import { createHash, randomUUID } from "node:crypto";
import {
  AccessDeniedError,
  evaluate,
  type AuthorizationRequest,
  type AuthorizationService,
  type AuthorizedReadReceipt,
} from "../auth/service.js";
import type { CallerContext } from "../identity/scope.js";
import { validateScope } from "../identity/scope.js";
import { DomainDatabase, optionalString, stringColumn } from "../persistence/database.js";
import { tokenizeText } from "../retrieval/tokenizer.js";
import {
  canonicalSiteUrl,
  createWebsiteKnowledgeNetworkProvider,
  fetchCanonicalSiteDocument,
  KnowledgeSyncError,
  LORA_SITE_ROOT,
  type KnowledgeNetworkProvider,
} from "./network.js";

export {
  canonicalSiteUrl,
  createWebsiteKnowledgeNetworkProvider,
  KnowledgeSyncError,
  LORA_SITE_ROOT,
} from "./network.js";
export type { KnowledgeHttpResponse, KnowledgeNetworkProvider } from "./network.js";

export const WEBSITE_KNOWLEDGE_RESOURCE = "knowledge:lora-site";
export const WEBSITE_KNOWLEDGE_SITE_ID = "lora-sys.github.io/loraSys";
export const WEBSITE_KNOWLEDGE_READ_ACTION = "knowledge:read";
export const WEBSITE_KNOWLEDGE_SYNC_ACTION = "knowledge:sync";
export const WEBSITE_KNOWLEDGE_DELIVERY_ACTION = "delivery:send";
export const MAX_ARTICLES = 500;
export const MAX_SITEMAP_LOCATIONS = 20_000;
export const MAX_ARTICLE_TEXT = 30_000;
export const MAX_HITS = 10;
export const MAX_SNIPPET = 600;

/** Main integrates these statements into its schema migration. */
export { knowledgeSchemaStatements } from "./schema.js";

export interface KnowledgeContext {
  caller: CallerContext;
  conversationId?: string;
  runId?: string;
  delegatedTaskId?: string;
}

export interface WebsiteArticle {
  url: string;
  digest: string;
  title: string;
  publishedAt: string | null;
  language: string | null;
  text: string;
  fetchedAt?: string;
  syncedAt?: string | null;
}

interface InternalArticle extends WebsiteArticle {
  fetchedAt: string;
}

export interface WebsiteKnowledgeHit {
  url: string;
  digest: string;
  title: string;
  publishedAt: string | null;
  language: string | null;
  fetchedAt: string;
  syncedAt: string | null;
  score: number;
  snippet: string;
  receipt: {
    site: AuthorizedReadReceipt;
    article: AuthorizedReadReceipt;
  };
}

export interface WebsiteKnowledgeSyncResult {
  articleCount: number;
  inserted: number;
  updated: number;
  removed: number;
  completedAt: string;
}

export interface WebsiteKnowledgeSyncPolicy {
  enabled: boolean;
  nextAttemptAt: string;
  consecutiveFailures: number;
}

export interface WebsiteKnowledgeServiceOptions {
  db: DomainDatabase;
  authorization: AuthorizationService;
  network?: KnowledgeNetworkProvider;
}

function requestFor(
  context: KnowledgeContext,
  resourceId: string,
  action: string,
): AuthorizationRequest {
  return {
    caller: context.caller,
    resourceId,
    action,
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.delegatedTaskId ? { delegatedTaskId: context.delegatedTaskId } : {}),
  };
}

export function createArticleResourceId(digest: string): string {
  return `knowledge:article:${digest}:${randomUUID()}`;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
}

function tagText(html: string, tag: string): string | undefined {
  const expression = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "iu");
  const match = html.match(expression);
  return match?.[1]?.replace(/<[^>]+>/gu, " ").trim();
}

function attribute(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return html.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "iu"))?.[2];
}

function metaContent(html: string, selector: RegExp): string | undefined {
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    if (!selector.test(match[0])) continue;
    const value = attribute(match[0], "content");
    if (value?.trim()) return decodeEntities(value.trim());
  }
  return undefined;
}

function parseArticle(html: string, url: string, fetchedAt: string): InternalArticle | undefined {
  const title = decodeEntities(
    metaContent(html, /(?:property|name)\s*=\s*["'](?:og:title|twitter:title)["']/iu) ??
      tagText(html, "h1") ??
      tagText(html, "title") ??
      "",
  )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
  const language =
    attribute(html.match(/<html\b[^>]*>/iu)?.[0] ?? "", "lang")?.slice(0, 32) ?? null;
  const date =
    metaContent(
      html,
      /(?:property|name)\s*=\s*["'](?:article:published_time|datePublished|pubdate)["']/iu,
    ) ?? html.match(/<time\b[^>]*datetime\s*=\s*(["'])(.*?)\1/iu)?.[2];
  const publishedAt =
    date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null;
  const content =
    html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)\s*>/iu)?.[1] ?? html;
  const text = decodeEntities(
    content
      .replace(/<(script|style|svg|nav|header|footer|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
      .replace(/<br\b[^>]*>|<\/(?:p|div|li|h[1-6]|section|article)>/giu, "\n")
      .replace(/<[^>]+>/gu, " "),
  )
    .replace(/[\t\u00a0 ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, MAX_ARTICLE_TEXT);
  if (!title || !text) return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify([url, title, publishedAt, language, text]))
    .digest("hex");
  return { url, digest, title, publishedAt, language, text, fetchedAt };
}

function xmlText(value: string): string {
  return decodeEntities(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1").trim());
}

function xmlValues(xml: string, tag: string): string[] {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`, "giu");
  return [...xml.matchAll(expression)].map((match) => xmlText(match[1] ?? "")).filter(Boolean);
}

function isXmlRootDocument(xml: string, rootName: "urlset" | "sitemapindex"): boolean {
  const escaped = rootName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`<${escaped}\\b[\\s\\S]*?<\\/${escaped}\\s*>`, "iu").test(xml) ||
    new RegExp(`<${escaped}\\b[^>]*\\/>`, "iu").test(xml)
  );
}

function sitemapLocations(xml: string, baseUrl: string): string[] {
  const locations: string[] = [];
  for (const raw of xmlValues(xml, "loc")) {
    const canonical = canonicalSiteUrl(raw, baseUrl);
    if (!canonical) throw new KnowledgeSyncError("knowledge_sitemap_url_not_allowed");
    locations.push(canonical);
  }
  return locations;
}

function feedUrls(html: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const type = attribute(tag, "type")?.toLowerCase();
    const rel = attribute(tag, "rel")?.toLowerCase() ?? "";
    const href = attribute(tag, "href");
    if (
      href &&
      (rel.split(/\s+/u).includes("alternate") || rel === "alternate") &&
      (type === "application/rss+xml" || type === "application/atom+xml")
    )
      urls.push(href);
  }
  return urls;
}

const NON_ARTICLE_SLUGS = new Set([
  "about",
  "archive",
  "archives",
  "author",
  "authors",
  "category",
  "categories",
  "contact",
  "index",
  "page",
  "pages",
  "tag",
  "tags",
  "terms",
  "en",
  "zh",
  "zh-cn",
  "zh-tw",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
  "pt",
  "ru",
]);

function isBlogArticleUrl(value: string): boolean {
  const canonical = canonicalSiteUrl(value);
  if (!canonical) return false;
  const path = new URL(canonical).pathname.toLowerCase();
  const prefix = `${new URL(LORA_SITE_ROOT).pathname}blog/`.toLowerCase();
  if (!path.startsWith(prefix)) return false;
  const slug = path.slice(prefix.length).replace(/\/+$/u, "");
  return Boolean(slug) && !slug.includes("/") && !NON_ARTICLE_SLUGS.has(slug);
}

function canonicalArticleUrl(html: string, currentUrl: string): string | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0];
    const rel = attribute(tag, "rel")?.toLowerCase().split(/\s+/u) ?? [];
    if (!rel.includes("canonical")) continue;
    const href = attribute(tag, "href");
    if (!href) return undefined;
    return canonicalSiteUrl(href, currentUrl);
  }
  return canonicalSiteUrl(currentUrl);
}

function isNoIndexOrDraft(html: string): boolean {
  for (const match of html.matchAll(/<meta\b[^>]*>/giu)) {
    const tag = match[0];
    const name = attribute(tag, "name")?.toLowerCase();
    const content = attribute(tag, "content")?.toLowerCase() ?? "";
    if (
      (name === "robots" || name === "googlebot") &&
      /(?:^|[,\s])noindex(?:[,\s]|$)/u.test(content)
    )
      return true;
    if ((name === "draft" || name === "is-draft") && /^(?:1|true|yes)$/u.test(content.trim()))
      return true;
  }
  return /<article\b[^>]*\bdata-draft\s*=\s*(["'])(?:1|true|yes)\1/iu.test(html);
}

function snippet(text: string, terms: ReadonlySet<string>): string {
  const lower = text.toLowerCase();
  let offset = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase());
    if (found >= 0 && (offset < 0 || found < offset)) offset = found;
  }
  const start = Math.max(0, (offset < 0 ? 0 : offset) - Math.floor(MAX_SNIPPET / 3));
  const end = Math.min(text.length, start + MAX_SNIPPET);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function scoreArticle(article: WebsiteArticle, queryTokens: ReadonlySet<string>): number {
  const bodyTokens = tokenizeText(article.text);
  const titleTokens = tokenizeText(article.title);
  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) score += 3;
    if (bodyTokens.has(token)) score += 1;
  }
  return score / Math.max(1, queryTokens.size * 4);
}

export function websiteArticleInterestCandidate(
  article: Pick<WebsiteArticle, "url" | "digest" | "title" | "text">,
) {
  const words = [...tokenizeText(`${article.title} ${article.text}`)]
    .filter((word) => word.length > 2)
    .slice(0, 12);
  return {
    source: "website_article" as const,
    url: article.url,
    digest: article.digest,
    title: article.title,
    keywords: words,
  };
}

export class WebsiteKnowledgeService {
  private readonly network: KnowledgeNetworkProvider;
  private refreshRunning = false;

  constructor(private readonly options: WebsiteKnowledgeServiceOptions) {
    this.network = options.network ?? createWebsiteKnowledgeNetworkProvider();
  }

  /** The only write entry point. It commits replacement/removal only after a complete crawl. */
  async syncSite(
    context: KnowledgeContext,
    signal?: AbortSignal,
  ): Promise<WebsiteKnowledgeSyncResult> {
    return this.syncSiteInternal(context, signal, false);
  }

  private async syncSiteInternal(
    context: KnowledgeContext,
    signal: AbortSignal | undefined,
    scheduled: boolean,
  ): Promise<WebsiteKnowledgeSyncResult> {
    await this.requireOwnerPrivate(context);
    const decision = await this.options.authorization.check(
      requestFor(context, WEBSITE_KNOWLEDGE_RESOURCE, WEBSITE_KNOWLEDGE_SYNC_ACTION),
    );
    if (decision.decision !== "ALLOW") {
      await this.recordSyncEvent(context, "denied", { failureCode: "knowledge_sync_denied" });
      throw new AccessDeniedError(decision);
    }
    try {
      return await this.performSync(context, signal, scheduled);
    } catch (error) {
      const failureCode =
        error instanceof AccessDeniedError
          ? "knowledge_sync_denied"
          : error instanceof KnowledgeSyncError && /^[a-z_]{1,80}$/u.test(error.code)
            ? error.code
            : "knowledge_sync_failed";
      await this.recordSyncEvent(context, "failed", { failureCode });
      throw error;
    }
  }

  private async performSync(
    context: KnowledgeContext,
    signal: AbortSignal | undefined,
    scheduled: boolean,
  ): Promise<WebsiteKnowledgeSyncResult> {
    const root = await this.readDocument(LORA_SITE_ROOT, signal);
    if (root.response.status < 200 || root.response.status >= 300)
      throw new KnowledgeSyncError("knowledge_site_unavailable");
    const discoveredSitemaps = xmlValues(root.response.body, "sitemap")
      .map((raw) => canonicalSiteUrl(raw, root.url))
      .filter((url): url is string => !!url);
    const robots = await this.readDocument(new URL("/robots.txt", LORA_SITE_ROOT).href, signal);
    if (robots.response.status < 200 || robots.response.status >= 300)
      throw new KnowledgeSyncError("knowledge_sitemap_unavailable");
    const robotsEntries = [...robots.response.body.matchAll(/^\s*sitemap\s*:\s*(\S+)/gimu)];
    const robotsSitemaps = robotsEntries.map((match) => {
      const canonical = canonicalSiteUrl(match[1] ?? "");
      if (!canonical) throw new KnowledgeSyncError("knowledge_sitemap_not_allowed");
      return canonical;
    });
    if (robotsEntries.length > 0 && robotsSitemaps.length === 0)
      throw new KnowledgeSyncError("knowledge_sitemap_not_allowed");
    const sitemapUrls = [
      ...new Set(
        robotsSitemaps.length > 0
          ? robotsSitemaps
          : discoveredSitemaps.length > 0
            ? discoveredSitemaps
            : [new URL("sitemap.xml", LORA_SITE_ROOT).href],
      ),
    ];
    if (sitemapUrls.length > 5) throw new KnowledgeSyncError("knowledge_sitemap_limit_exceeded");
    const pageUrls = new Set<string>();
    const feedMeta = new Map<string, { title?: string; date?: string }>();
    const feeds = feedUrls(root.response.body)
      .map((url) => canonicalSiteUrl(url, root.url))
      .filter((url): url is string => !!url)
      .slice(0, 3);

    for (const sitemapUrl of sitemapUrls) {
      const sitemap = await this.readDocument(sitemapUrl, signal);
      if (sitemap.response.status < 200 || sitemap.response.status >= 300)
        throw new KnowledgeSyncError("knowledge_sitemap_unavailable");
      const sitemapIsIndex = isXmlRootDocument(sitemap.response.body, "sitemapindex");
      const sitemapIsUrlset = isXmlRootDocument(sitemap.response.body, "urlset");
      if (!sitemapIsIndex && !sitemapIsUrlset)
        throw new KnowledgeSyncError("knowledge_sitemap_invalid");
      const indexUrls = sitemapLocations(sitemap.response.body, sitemap.url);
      if (sitemapIsIndex) {
        if (indexUrls.length > 5) throw new KnowledgeSyncError("knowledge_sitemap_limit_exceeded");
        for (const childUrl of indexUrls) {
          const child = await this.readDocument(childUrl, signal);
          if (child.response.status < 200 || child.response.status >= 300)
            throw new KnowledgeSyncError("knowledge_sitemap_unavailable");
          if (!isXmlRootDocument(child.response.body, "urlset"))
            throw new KnowledgeSyncError("knowledge_sitemap_invalid");
          for (const canonical of sitemapLocations(child.response.body, child.url)) {
            pageUrls.add(canonical);
            if (pageUrls.size > MAX_SITEMAP_LOCATIONS)
              throw new KnowledgeSyncError("knowledge_sitemap_location_limit_exceeded");
          }
        }
      } else {
        for (const canonical of indexUrls) pageUrls.add(canonical);
      }
    }
    for (const feedUrl of feeds) {
      const feed = await this.readDocument(feedUrl, signal);
      if (feed.response.status < 200 || feed.response.status >= 300)
        throw new KnowledgeSyncError("knowledge_feed_unavailable");
      const items = [
        ...feed.response.body.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)\s*>/giu),
      ];
      for (const item of items.slice(0, MAX_ARTICLES)) {
        const block = item[1] ?? "";
        const rawLink =
          xmlValues(block, "link")[0] ?? block.match(/<link\b[^>]*href\s*=\s*(["'])(.*?)\1/iu)?.[2];
        const url = rawLink ? canonicalSiteUrl(rawLink, feed.url) : undefined;
        if (!url || !pageUrls.has(url)) continue;
        const title = xmlValues(block, "title")[0];
        const date =
          xmlValues(block, "pubDate")[0] ??
          xmlValues(block, "published")[0] ??
          xmlValues(block, "updated")[0];
        feedMeta.set(url, { ...(title ? { title } : {}), ...(date ? { date } : {}) });
      }
    }
    const candidates = [...pageUrls]
      .filter((url) => {
        const path = new URL(url).pathname.toLowerCase();
        return (
          !/\.(?:xml|json|png|jpe?g|gif|svg|webp|pdf|zip|css|js|woff2?)$/u.test(path) &&
          isBlogArticleUrl(url)
        );
      })
      .sort();
    if (candidates.length > MAX_ARTICLES)
      throw new KnowledgeSyncError("knowledge_article_limit_exceeded");

    const articles: InternalArticle[] = [];
    for (const url of candidates) {
      const page = await this.readDocument(url, signal);
      if (page.response.status < 200 || page.response.status >= 300)
        throw new KnowledgeSyncError("knowledge_article_unavailable");
      const canonical = canonicalSiteUrl(page.url);
      if (!canonical) throw new KnowledgeSyncError("knowledge_article_redirect_not_allowed");
      const declaredCanonical = canonicalArticleUrl(page.response.body, canonical);
      if (!declaredCanonical)
        throw new KnowledgeSyncError("knowledge_article_canonical_not_allowed");
      if (!isBlogArticleUrl(declaredCanonical)) continue;
      if (isNoIndexOrDraft(page.response.body)) continue;
      const article = parseArticle(page.response.body, declaredCanonical, new Date().toISOString());
      if (!article) throw new KnowledgeSyncError("knowledge_article_unparseable");
      const hint = feedMeta.get(url);
      if (hint?.title && !tagText(page.response.body, "h1"))
        article.title = hint.title.slice(0, 300);
      if (hint?.date && !article.publishedAt && Number.isFinite(Date.parse(hint.date)))
        article.publishedAt = new Date(hint.date).toISOString();
      article.digest = createHash("sha256")
        .update(
          JSON.stringify([
            article.url,
            article.title,
            article.publishedAt,
            article.language,
            article.text,
          ]),
        )
        .digest("hex");
      articles.push(article);
    }

    const deduplicatedArticles = new Map<string, InternalArticle>();
    for (const article of articles) {
      const existing = deduplicatedArticles.get(article.url);
      if (existing && existing.digest !== article.digest)
        throw new KnowledgeSyncError("knowledge_article_canonical_conflict");
      deduplicatedArticles.set(article.url, article);
    }

    const completedAt = new Date().toISOString();
    const sourceDigest = createHash("sha256").update(candidates.join("\n")).digest("hex");
    let inserted = 0;
    let updated = 0;
    let removed = 0;
    const committed = await this.options.db.transaction(async (tx) => {
      if (scheduled) {
        const policy = await tx.execute({
          sql: "SELECT enabled,owner_principal_id,scope_json FROM website_knowledge_sync_policy WHERE site_id=? LIMIT 1",
          args: [WEBSITE_KNOWLEDGE_SITE_ID],
        });
        const row = policy.rows[0];
        if (
          !row ||
          Number(row.enabled) !== 1 ||
          stringColumn(row, "owner_principal_id") !== context.caller.principalId ||
          stringColumn(row, "scope_json") !== JSON.stringify(context.caller.scope)
        )
          return { rejected: new KnowledgeSyncError("knowledge_sync_disabled") } as const;
      }
      const commitDecision = await evaluate(
        tx,
        requestFor(context, WEBSITE_KNOWLEDGE_RESOURCE, WEBSITE_KNOWLEDGE_SYNC_ACTION),
      );
      if (commitDecision.decision !== "ALLOW")
        return { rejected: new AccessDeniedError(commitDecision) } as const;

      const previous = await tx.execute({
        sql: "SELECT canonical_url,current_digest,current_resource_id FROM website_knowledge_articles",
        args: [],
      });
      const before = new Map(
        previous.rows.map((row) => [
          stringColumn(row, "canonical_url"),
          {
            digest: stringColumn(row, "current_digest"),
            resourceId: stringColumn(row, "current_resource_id"),
          },
        ]),
      );
      const currentArticles = [...deduplicatedArticles.values()];
      const current = new Set(currentArticles.map((article) => article.url));
      for (const article of currentArticles) {
        const previousArticle = before.get(article.url);
        const priorDigest = previousArticle?.digest;
        const resourceId =
          previousArticle?.digest === article.digest
            ? previousArticle.resourceId
            : createArticleResourceId(article.digest);
        if (!priorDigest) inserted++;
        else if (priorDigest !== article.digest) updated++;
        await tx.execute({
          sql: `INSERT OR IGNORE INTO resources(id,kind,visibility,owner_id) VALUES (?, 'knowledge-article', 'public', NULL)`,
          args: [resourceId],
        });
        await tx.execute({
          sql: `INSERT OR IGNORE INTO website_knowledge_article_versions(digest,canonical_url,title,published_at,language,body,fetched_at) VALUES (?,?,?,?,?,?,?)`,
          args: [
            article.digest,
            article.url,
            article.title,
            article.publishedAt,
            article.language,
            article.text,
            article.fetchedAt,
          ],
        });
        await tx.execute({
          sql: `INSERT INTO website_knowledge_articles(canonical_url,current_digest,current_resource_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(canonical_url) DO UPDATE SET current_digest=excluded.current_digest,current_resource_id=excluded.current_resource_id,updated_at=excluded.updated_at`,
          args: [article.url, article.digest, resourceId, completedAt],
        });
        if (previousArticle && previousArticle.digest !== article.digest)
          await this.revokeArticleGrants(tx, previousArticle.resourceId, completedAt);
      }
      for (const [url, article] of before) {
        if (current.has(url)) continue;
        removed++;
        await tx.execute({
          sql: "DELETE FROM website_knowledge_articles WHERE canonical_url = ?",
          args: [url],
        });
        await this.revokeArticleGrants(tx, article.resourceId, completedAt);
      }
      await tx.execute({
        sql: `INSERT INTO website_knowledge_syncs(site_id,completed_at,article_count,source_digest) VALUES (?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET completed_at=excluded.completed_at,article_count=excluded.article_count,source_digest=excluded.source_digest`,
        args: [WEBSITE_KNOWLEDGE_SITE_ID, completedAt, currentArticles.length, sourceDigest],
      });
      await tx.execute({
        sql: `UPDATE website_knowledge_sync_policy SET next_attempt_at=?,consecutive_failures=0,updated_at=? WHERE site_id=? AND enabled=1`,
        args: [
          new Date(Date.parse(completedAt) + 6 * 60 * 60 * 1000).toISOString(),
          completedAt,
          WEBSITE_KNOWLEDGE_SITE_ID,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO website_knowledge_sync_events(id,site_id,actor_principal_id,action,run_id,status,occurred_at,article_count,inserted_count,updated_count,removed_count,source_digest,failure_code)
              VALUES (?,?,?,?,?,'succeeded',?,?,?,?,?,?,NULL)`,
        args: [
          randomUUID(),
          WEBSITE_KNOWLEDGE_SITE_ID,
          context.caller.principalId,
          WEBSITE_KNOWLEDGE_SYNC_ACTION,
          context.runId ?? null,
          completedAt,
          currentArticles.length,
          inserted,
          updated,
          removed,
          sourceDigest,
        ],
      });
      return {
        result: {
          articleCount: deduplicatedArticles.size,
          inserted,
          updated,
          removed,
          completedAt,
        },
      } as const;
    });
    if ("rejected" in committed) throw committed.rejected;
    return committed.result;
  }

  /** Store the Owner's explicit opt-in and scope. Enabling does not itself start a crawl. */
  async setSyncEnabled(
    context: KnowledgeContext,
    enabled: boolean,
  ): Promise<WebsiteKnowledgeSyncPolicy> {
    await this.requireOwnerPrivate(context);
    if (typeof enabled !== "boolean") throw new Error("invalid_knowledge_sync_policy");
    const decision = await this.options.authorization.check(
      requestFor(context, WEBSITE_KNOWLEDGE_RESOURCE, WEBSITE_KNOWLEDGE_SYNC_ACTION),
    );
    if (decision.decision !== "ALLOW") throw new AccessDeniedError(decision);
    const now = new Date().toISOString();
    await this.options.db.transaction(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO website_knowledge_sync_policy(site_id,enabled,owner_principal_id,scope_json,next_attempt_at,consecutive_failures,updated_at)
              VALUES (?,?,?,?,?,0,?) ON CONFLICT(site_id) DO UPDATE SET enabled=excluded.enabled,owner_principal_id=excluded.owner_principal_id,scope_json=excluded.scope_json,next_attempt_at=excluded.next_attempt_at,consecutive_failures=0,updated_at=excluded.updated_at`,
        args: [
          WEBSITE_KNOWLEDGE_SITE_ID,
          enabled ? 1 : 0,
          context.caller.principalId,
          JSON.stringify(context.caller.scope),
          now,
          now,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO website_knowledge_sync_events(id,site_id,actor_principal_id,action,run_id,status,occurred_at,failure_code) VALUES (?,?,?,?,?,?,?,NULL)`,
        args: [
          randomUUID(),
          WEBSITE_KNOWLEDGE_SITE_ID,
          context.caller.principalId,
          WEBSITE_KNOWLEDGE_SYNC_ACTION,
          context.runId ?? null,
          enabled ? "enabled" : "disabled",
          now,
        ],
      });
    });
    return { enabled, nextAttemptAt: now, consecutiveFailures: 0 };
  }

  /** Called by the host's unref timer. No policy row means disabled after startup. */
  async refreshIfDue(signal?: AbortSignal): Promise<WebsiteKnowledgeSyncResult | undefined> {
    if (this.refreshRunning) return undefined;
    this.refreshRunning = true;
    try {
      return await this.refreshIfDueOnce(signal);
    } finally {
      this.refreshRunning = false;
    }
  }

  private async refreshIfDueOnce(
    signal?: AbortSignal,
  ): Promise<WebsiteKnowledgeSyncResult | undefined> {
    const policy = await this.options.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "SELECT enabled,owner_principal_id,scope_json,next_attempt_at,consecutive_failures FROM website_knowledge_sync_policy WHERE site_id=? LIMIT 1",
        args: [WEBSITE_KNOWLEDGE_SITE_ID],
      });
      const row = result.rows[0];
      if (
        !row ||
        Number(row.enabled) !== 1 ||
        Date.parse(stringColumn(row, "next_attempt_at")) > Date.now()
      )
        return undefined;
      let scope: CallerContext["scope"];
      try {
        scope = JSON.parse(stringColumn(row, "scope_json")) as CallerContext["scope"];
        validateScope(scope);
      } catch {
        return undefined;
      }
      return {
        context: {
          caller: { principalId: stringColumn(row, "owner_principal_id"), scope },
        } satisfies KnowledgeContext,
        failures: Number(row.consecutive_failures ?? 0),
      };
    });
    if (!policy) return undefined;
    try {
      return await this.syncSiteInternal(policy.context, signal, true);
    } catch (error) {
      const failures = Math.min(policy.failures + 1, 8);
      const delayMinutes = Math.min(6 * 60, 5 * 2 ** Math.min(failures - 1, 6));
      const now = new Date().toISOString();
      await this.options.db.transaction(async (tx) => {
        await tx.execute({
          sql: "UPDATE website_knowledge_sync_policy SET next_attempt_at=?,consecutive_failures=?,updated_at=? WHERE site_id=? AND enabled=1",
          args: [
            new Date(Date.now() + delayMinutes * 60_000).toISOString(),
            failures,
            now,
            WEBSITE_KNOWLEDGE_SITE_ID,
          ],
        });
      });
      if (signal?.aborted) return undefined;
      throw error;
    }
  }

  async getSyncPolicy(): Promise<WebsiteKnowledgeSyncPolicy | undefined> {
    return this.options.db.transaction(async (tx) => {
      const result = await tx.execute({
        sql: "SELECT enabled,next_attempt_at,consecutive_failures FROM website_knowledge_sync_policy WHERE site_id=? LIMIT 1",
        args: [WEBSITE_KNOWLEDGE_SITE_ID],
      });
      const row = result.rows[0];
      return row
        ? {
            enabled: Number(row.enabled) === 1,
            nextAttemptAt: stringColumn(row, "next_attempt_at"),
            consecutiveFailures: Number(row.consecutive_failures ?? 0),
          }
        : undefined;
    });
  }

  private async requireOwnerPrivate(context: KnowledgeContext): Promise<void> {
    validateScope(context.caller.scope);
    if (context.caller.scope.chatType !== "private")
      throw new Error("knowledge_owner_private_scope_required");
    const owner = await this.options.db.transaction(async (tx) =>
      tx.execute({
        sql: "SELECT kind FROM principals WHERE id=? LIMIT 1",
        args: [context.caller.principalId],
      }),
    );
    if (owner.rows[0]?.kind !== "owner") throw new Error("knowledge_owner_required");
  }

  private async recordSyncEvent(
    context: KnowledgeContext,
    status: "failed" | "denied",
    details: { failureCode: string },
  ): Promise<void> {
    const failureCode = /^[a-z_]{1,80}$/u.test(details.failureCode)
      ? details.failureCode
      : "knowledge_sync_failed";
    await this.options.db.transaction(async (tx) => {
      await tx.execute({
        sql: `INSERT INTO website_knowledge_sync_events(id,site_id,actor_principal_id,action,run_id,status,occurred_at,failure_code) VALUES (?,?,?,?,?,?,?,?)`,
        args: [
          randomUUID(),
          WEBSITE_KNOWLEDGE_SITE_ID,
          context.caller.principalId,
          WEBSITE_KNOWLEDGE_SYNC_ACTION,
          context.runId ?? null,
          status,
          new Date().toISOString(),
          failureCode,
        ],
      });
    });
  }

  private async revokeArticleGrants(
    tx: import("@libsql/client").Transaction,
    resourceId: string,
    at: string,
  ): Promise<void> {
    await tx.execute({
      sql: "UPDATE grants SET revoked_at = ? WHERE resource_id = ? AND revoked_at IS NULL",
      args: [at, resourceId],
    });
  }

  /** Returns current article version Resource IDs so the integrating layer can provision narrow grants. */
  async currentArticleResources(): Promise<
    readonly { resourceId: string; url: string; digest: string }[]
  > {
    return this.options.db.transaction(async (tx) => {
      const rows = await tx.execute({
        sql: `SELECT a.canonical_url,a.current_digest,a.current_resource_id FROM website_knowledge_articles a ORDER BY a.canonical_url LIMIT ?`,
        args: [MAX_ARTICLES],
      });
      return rows.rows.map((row) => ({
        resourceId: stringColumn(row, "current_resource_id"),
        url: stringColumn(row, "canonical_url"),
        digest: stringColumn(row, "current_digest"),
      }));
    });
  }

  async searchAuthorized(
    context: KnowledgeContext,
    query: string,
    limit = 5,
  ): Promise<WebsiteKnowledgeHit[]> {
    if (typeof query !== "string" || query.length > 500) throw new Error("invalid_knowledge_query");
    const terms = tokenizeText(query);
    if (!terms.size) return [];
    const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 5;
    const boundedLimit = Math.max(1, Math.min(MAX_HITS, requestedLimit));
    const siteRequest = requestFor(
      context,
      WEBSITE_KNOWLEDGE_RESOURCE,
      WEBSITE_KNOWLEDGE_READ_ACTION,
    );
    const siteDecision = await this.options.authorization.check(siteRequest);
    if (siteDecision.decision !== "ALLOW") throw new AccessDeniedError(siteDecision);
    const siteReceipt: AuthorizedReadReceipt = {
      request: siteRequest,
      decisionId: siteDecision.id,
      source: "content_source",
    };
    const metadata = await this.options.db.transaction(async (tx) =>
      tx.execute({
        sql: `SELECT a.canonical_url,a.current_digest,a.current_resource_id,v.title,v.published_at,v.language
            FROM website_knowledge_articles a JOIN website_knowledge_article_versions v ON v.digest=a.current_digest
            ORDER BY a.canonical_url LIMIT ?`,
        args: [MAX_ARTICLES],
      }),
    );
    const syncStatus = await this.options.db.transaction(async (tx) =>
      tx.execute({
        sql: "SELECT completed_at FROM website_knowledge_syncs WHERE site_id=? LIMIT 1",
        args: [WEBSITE_KNOWLEDGE_SITE_ID],
      }),
    );
    const syncedAt = syncStatus.rows[0] ? stringColumn(syncStatus.rows[0], "completed_at") : null;
    const allowed: Array<{ row: (typeof metadata.rows)[number]; receipt: AuthorizedReadReceipt }> =
      [];
    for (const row of metadata.rows) {
      const canonical = canonicalSiteUrl(stringColumn(row, "canonical_url"));
      if (!canonical) continue;
      const request = requestFor(
        context,
        stringColumn(row, "current_resource_id"),
        WEBSITE_KNOWLEDGE_READ_ACTION,
      );
      const decision = await this.options.authorization.check(request);
      if (decision.decision === "ALLOW")
        allowed.push({
          row,
          receipt: { request, decisionId: decision.id, source: "content_source" },
        });
    }
    const authorizedDigests = allowed.map(({ row }) => stringColumn(row, "current_digest"));
    if (!authorizedDigests.length) return [];
    const bodyRows = await this.options.db.transaction(async (tx) =>
      tx.execute({
        sql: `SELECT a.canonical_url,a.current_digest,a.current_resource_id,v.title,v.published_at,v.language,v.body,v.fetched_at
            FROM website_knowledge_articles a JOIN website_knowledge_article_versions v ON v.digest=a.current_digest
            WHERE a.current_resource_id IN (${allowed.map(() => "?").join(",")}) LIMIT ?`,
        args: [...allowed.map(({ row }) => stringColumn(row, "current_resource_id")), MAX_ARTICLES],
      }),
    );
    const receiptsByDigest = new Map(
      allowed.map(({ row, receipt }) => [stringColumn(row, "current_digest"), receipt]),
    );
    const scored: WebsiteKnowledgeHit[] = [];
    for (const row of bodyRows.rows) {
      const digest = stringColumn(row, "current_digest");
      const articleReceipt = receiptsByDigest.get(digest);
      const url = canonicalSiteUrl(stringColumn(row, "canonical_url"));
      if (!articleReceipt || !url) continue;
      const article: WebsiteArticle = {
        url,
        digest,
        title: stringColumn(row, "title"),
        publishedAt: optionalString(row, "published_at"),
        language: optionalString(row, "language"),
        fetchedAt: stringColumn(row, "fetched_at"),
        syncedAt,
        text: stringColumn(row, "body"),
      };
      const score = scoreArticle(article, terms);
      if (score <= 0) continue;
      scored.push({
        ...article,
        fetchedAt: article.fetchedAt ?? "",
        syncedAt,
        score,
        snippet: snippet(article.text, terms),
        receipt: { site: siteReceipt, article: articleReceipt },
      });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") ||
        a.url.localeCompare(b.url),
    );
    const hits = scored.slice(0, boundedLimit);
    for (const hit of hits) {
      await this.options.authorization.markDeliverySource(siteDecision.id, "content_source");
      await this.options.authorization.markDeliverySource(
        hit.receipt.article.decisionId,
        "content_source",
      );
    }
    await this.recheckAuthorized(context, hits);
    return hits.map((hit) => ({
      url: hit.url,
      digest: hit.digest,
      title: hit.title,
      publishedAt: hit.publishedAt,
      language: hit.language,
      fetchedAt: hit.fetchedAt,
      syncedAt: hit.syncedAt,
      score: hit.score,
      snippet: hit.snippet,
      receipt: hit.receipt,
    }));
  }

  /** Recheck version freshness and both site/article delivery grants before each provider call. */
  async recheckAuthorized(
    context: KnowledgeContext,
    hits: readonly WebsiteKnowledgeHit[],
  ): Promise<void> {
    for (const hit of hits) {
      const current = await this.options.db.transaction(async (tx) => {
        const row = await tx.execute({
          sql: "SELECT current_digest,current_resource_id FROM website_knowledge_articles WHERE canonical_url = ? LIMIT 1",
          args: [hit.url],
        });
        return row.rows[0]
          ? {
              digest: stringColumn(row.rows[0], "current_digest"),
              resourceId: stringColumn(row.rows[0], "current_resource_id"),
            }
          : undefined;
      });
      if (
        current?.digest !== hit.digest ||
        current.resourceId !== hit.receipt.article.request.resourceId
      )
        throw new KnowledgeSyncError("knowledge_article_version_stale");
      const reads = [hit.receipt.site, hit.receipt.article];
      const requests = [
        requestFor(context, WEBSITE_KNOWLEDGE_RESOURCE, WEBSITE_KNOWLEDGE_DELIVERY_ACTION),
        requestFor(
          context,
          hit.receipt.article.request.resourceId,
          WEBSITE_KNOWLEDGE_DELIVERY_ACTION,
        ),
      ];
      for (const action of requests) {
        const decision = await this.options.authorization.authorizeReadResultsAndAction(
          reads,
          action,
        );
        if (decision.decision !== "ALLOW") throw new AccessDeniedError(decision);
      }
    }
  }

  private async readDocument(url: string, signal?: AbortSignal) {
    const result = await fetchCanonicalSiteDocument(this.network, url, signal);
    if (new TextEncoder().encode(result.response.body).byteLength > 2_000_000)
      throw new KnowledgeSyncError("knowledge_document_too_large");
    return result;
  }
}
