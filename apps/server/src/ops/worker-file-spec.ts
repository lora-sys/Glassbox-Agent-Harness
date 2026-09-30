const MAX_SPEC_LENGTH = 512;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const SAFE_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u;

function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > MAX_SPEC_LENGTH || /[:\\\0]/u.test(path)) return false;
  const parts = path.split("/");
  return parts.every(
    (part) =>
      part.length > 0 &&
      SAFE_PART.test(part) &&
      !part.startsWith(".") &&
      !/[. ]$/u.test(part) &&
      !WINDOWS_DEVICE_NAME.test(part) &&
      part !== "node_modules",
  );
}

/** Parses the closed Task Step reference for one relative WorkerFiles text path. */
export function parseWorkerTextFileSpec(specRef: string): { relativePath: string } | null {
  if (typeof specRef !== "string" || specRef.length > MAX_SPEC_LENGTH) return null;
  const prefix = "worker:text-file:";
  if (!specRef.startsWith(prefix)) return null;
  const relativePath = specRef.slice(prefix.length);
  if (!isSafeRelativePath(relativePath)) return null;
  return { relativePath };
}
