import {
  assertPublicWebRedirect,
  assertPublicWebUrl,
  dohResolveWebHost,
  type ResolveWebHost,
} from "../web/network-guard.js";

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

/** Download a Provider output URL without allowing private targets or unchecked redirects. */
export async function downloadPublicMediaOutput(
  input: string,
  options: {
    fetcher?: typeof fetch;
    resolveHost?: ResolveWebHost;
    maxBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<Buffer> {
  const fetcher = options.fetcher ?? fetch;
  const resolver = options.resolveHost ?? dohResolveWebHost;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES)
    throw new Error("media_output_invalid_limit");

  let current = await assertPublicWebUrl(input, resolver);
  if (current.protocol !== "https:") throw new Error("media_output_invalid_url");
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const response = await fetcher(current, {
      method: "GET",
      redirect: "manual",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS)
        throw new Error("media_output_redirect_limit");
      current = await assertPublicWebRedirect(current.href, location, resolver);
      if (current.protocol !== "https:") throw new Error("media_output_invalid_url");
      continue;
    }
    if (!response.ok || !response.body) throw new Error("media_output_download_failed");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await response.body.cancel();
      throw new Error("media_output_too_large");
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("media_output_too_large");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (total === 0) throw new Error("media_output_download_failed");
    return Buffer.concat(chunks, total);
  }
  throw new Error("media_output_redirect_limit");
}
