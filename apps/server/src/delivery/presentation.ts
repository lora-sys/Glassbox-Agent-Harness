import { Lexer, type Token } from "marked";

function record(token: Token): Record<string, unknown> {
  return token as unknown as Record<string, unknown>;
}

function children(token: Token): Token[] {
  const value = record(token).tokens;
  return Array.isArray(value) ? (value as Token[]) : [];
}

function textValue(token: Token): string {
  const value = record(token).text;
  return typeof value === "string" ? value : "";
}

function renderInline(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if (token.type === "br") return "\n";
      if (token.type === "image") return textValue(token);
      if (token.type === "link") {
        const nested = children(token);
        const label = nested.length > 0 ? renderInline(nested) : textValue(token);
        const href = record(token).href;
        return typeof href === "string" && /^https:\/\//iu.test(href)
          ? `${label || "链接"} ${href}`
          : label;
      }
      const nested = children(token);
      if (nested.length > 0) return renderInline(nested);
      if (token.type === "html") return textValue(token).replace(/<[^>]*>/gu, "");
      return (
        textValue(token) || (typeof record(token).raw === "string" ? String(record(token).raw) : "")
      );
    })
    .join("");
}

function renderBlocks(tokens: readonly Token[]): string {
  const blocks: string[] = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "code") {
      blocks.push(textValue(token));
      continue;
    }
    if (token.type === "list") {
      const value = record(token);
      const ordered = value.ordered === true;
      const start = typeof value.start === "number" ? value.start : 1;
      const items = Array.isArray(value.items) ? value.items : [];
      blocks.push(
        items
          .map((item, index) => {
            const itemRecord = item as Record<string, unknown>;
            const itemTokens = Array.isArray(itemRecord.tokens)
              ? (itemRecord.tokens as Token[])
              : [];
            const content = renderBlocks(itemTokens)
              .replace(/\n{2,}/gu, "\n")
              .trim();
            return `${ordered ? `${start + index}.` : "•"} ${content}`;
          })
          .join("\n"),
      );
      continue;
    }
    if (token.type === "blockquote") {
      blocks.push(renderBlocks(children(token)));
      continue;
    }
    const nested = children(token);
    blocks.push(nested.length > 0 ? renderInline(nested) : textValue(token));
  }
  return blocks.filter(Boolean).join("\n\n");
}

export function renderQqPlainText(markdown: string): string {
  const rendered = renderBlocks(Lexer.lex(markdown, { gfm: true }));
  return rendered
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
