import { posix } from "node:path";
import { digest, fail } from "./core.mjs";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ID_LENGTH = 64;
const MAX_PATH_LENGTH = 4096;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ROLE_ORDER = new Map([
  ["coverage", 0],
  ["task-worker", 1],
  ["media", 2],
]);

function invalid() {
  fail("DELIVERY_BUNDLE", "Delivery bundle manifest is invalid.");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function normalizedPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    /^[a-z]:/iu.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    posix.normalize(value) !== value
  )
    invalid();
  return value;
}

/** Validate the exact manifest shape and return frozen, role-ordered entries. */
export function validateDeliveryBundle(value) {
  if (
    !exactKeys(value, ["schemaVersion", "suites"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.suites) ||
    ![2, 3].includes(value.suites.length)
  )
    invalid();

  const entries = value.suites.map((entry) => {
    if (!exactKeys(entry, ["id", "role", "path", "sha256"])) invalid();
    if (
      typeof entry.id !== "string" ||
      entry.id.length === 0 ||
      entry.id.length > MAX_ID_LENGTH ||
      !ID.test(entry.id) ||
      !ROLE_ORDER.has(entry.role) ||
      entry.id !== entry.role ||
      typeof entry.sha256 !== "string" ||
      !SHA256.test(entry.sha256)
    )
      invalid();
    return {
      id: entry.id,
      role: entry.role,
      path: normalizedPath(entry.path),
      sha256: entry.sha256,
    };
  });

  if (
    new Set(entries.map((entry) => entry.id)).size !== entries.length ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length ||
    new Set(entries.map((entry) => entry.role)).size !== entries.length ||
    !entries.some((entry) => entry.role === "coverage") ||
    !entries.some((entry) => entry.role === "task-worker")
  )
    invalid();

  entries.sort((left, right) => ROLE_ORDER.get(left.role) - ROLE_ORDER.get(right.role));
  for (const entry of entries) Object.freeze(entry);
  return Object.freeze({
    schemaVersion: 1,
    suites: Object.freeze(entries),
  });
}

/** Parse a raw manifest; its exact UTF-8 bytes define the approval digest. */
export function parseDeliveryBundle(text, expectedSha256) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) invalid();
  const manifestSha256 = digest(text);
  if (
    expectedSha256 !== undefined &&
    (typeof expectedSha256 !== "string" ||
      !SHA256.test(expectedSha256) ||
      expectedSha256 !== manifestSha256)
  )
    invalid();

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalid();
  }
  const bundle = validateDeliveryBundle(value);
  return Object.freeze({ ...bundle, manifestSha256 });
}
