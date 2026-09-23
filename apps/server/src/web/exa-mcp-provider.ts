import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertPublicWebUrl, type ResolveWebHost } from "./network-guard.js";
import type { ExaRawResult, ExaResponse } from "./exa-provider.js";

const MCP_URL = new URL("https://mcp.exa.ai/mcp");
const SEARCH_RESULT_LIMIT = 10;
const FETCH_CHAR_LIMIT = 20_000;

interface McpResult {
  isError?: boolean;
  content: readonly { type: string; text?: string }[];
}

export interface ExaMcpCaller {
  call(name: "web_search_exa" | "web_fetch_exa", args: Record<string, unknown>): Promise<McpResult>;
}

/** One provider call gets one short-lived MCP session. No session or provider state crosses Runs. */
export class HostedExaMcpCaller implements ExaMcpCaller {
  async call(
    name: "web_search_exa" | "web_fetch_exa",
    args: Record<string, unknown>,
  ): Promise<McpResult> {
    const client = new Client({ name: "glassbox-web", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(MCP_URL);
    try {
      await client.connect(transport);
      const result = await client.callTool({ name, arguments: args });
      const content = Array.isArray(result.content) ? result.content : [];
      return {
        isError: result.isError === true,
        content: content.flatMap((item: unknown) =>
          item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string"
            ? [{ type: "text", text: item.text }]
            : [],
        ),
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

function resultText(result: McpResult): string {
  return result.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .slice(0, 100_000);
}

function failureStatus(text: string): "quota_exhausted" | "failed" {
  return /rate limit|quota|too many requests|429/iu.test(text) ? "quota_exhausted" : "failed";
}

/** The hosted MCP formats search results as Title, URL, Published, Author, Highlights blocks. */
export function parseExaMcpSearch(text: string): ExaRawResult[] {
  const results: ExaRawResult[] = [];
  for (const block of text.split(/\n\s*---\s*\n/u)) {
    const title = /^Title:\s*(.*)$/imu.exec(block)?.[1]?.trim();
    const url = /^URL:\s*(https?:\/\/\S+)$/imu.exec(block)?.[1]?.trim();
    const publishedDate = /^Published:\s*(.*)$/imu.exec(block)?.[1]?.trim();
    const highlights = block
      .split(/\nHighlights:\s*\n/iu)[1]
      ?.trim()
      .split(/\n+/u)
      .filter(Boolean);
    if (!url) continue;
    results.push({
      title: title && title !== "N/A" ? title : url,
      url,
      ...(publishedDate && publishedDate !== "N/A" ? { publishedDate } : {}),
      ...(highlights ? { highlights } : {}),
    });
  }
  return results;
}

export class ExaMcpProvider {
  constructor(
    private readonly caller: ExaMcpCaller = new HostedExaMcpCaller(),
    private readonly resolveHost?: ResolveWebHost,
    private readonly syntheticDnsCidrs: readonly string[] = [],
  ) {}

  async search(input: { query: string; maxResults: number }): Promise<ExaResponse> {
    try {
      const result = await this.caller.call("web_search_exa", {
        query: input.query,
        numResults: Math.max(1, Math.min(SEARCH_RESULT_LIMIT, input.maxResults)),
        objective: `Find public sources that directly answer this query: ${input.query}`.slice(
          0,
          4096,
        ),
      });
      const text = resultText(result);
      if (result.isError) return { status: failureStatus(text), results: [] };
      return { status: "ready", results: parseExaMcpSearch(text) };
    } catch {
      return { status: "failed", results: [] };
    }
  }

  async contents(url: string): Promise<ExaResponse> {
    const target = await assertPublicWebUrl(url, this.resolveHost, this.syntheticDnsCidrs);
    try {
      const result = await this.caller.call("web_fetch_exa", {
        urls: [target.href],
        maxCharacters: FETCH_CHAR_LIMIT,
      });
      const text = resultText(result);
      if (result.isError) return { status: failureStatus(text), results: [] };
      if (/^No content found/iu.test(text)) return { status: "ready", results: [] };
      return { status: "ready", results: [{ url: target.href, text }] };
    } catch {
      return { status: "failed", results: [] };
    }
  }
}
