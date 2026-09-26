/** Browser and web tools are opt-in per QQ group. */
export const WEB_CAPABILITIES = [
  "web.search",
  "web.fetch",
  "browser.read",
  "browser.interact",
] as const;

export type WebCapability = (typeof WEB_CAPABILITIES)[number];

export const DEFAULT_WEB_CAPABILITY_POLICY: Partial<Record<WebCapability, boolean>> = {};

export function isWebCapabilityEnabled(
  policy: Partial<Record<WebCapability, boolean>> | undefined,
  capability: WebCapability,
): boolean {
  return policy?.[capability] === true;
}
