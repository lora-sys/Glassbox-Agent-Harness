import { CliError, isRecord } from "./errors.ts";

const credentialFields = new Set([
  "apikey",
  "secret",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "credentialslot",
  "credentials",
  "credential",
  "password",
  "clientsecret",
  "token",
  "managementtoken",
]);

/** Defense in depth. The server must already return public configuration views. */
export function publicOutput(input: unknown, secrets: readonly string[] = []): unknown {
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 50_000 || depth > 40) throw new CliError("INVALID_RESPONSE");
    if (typeof value === "string") {
      return secrets.reduce(
        (text, secret) => (secret ? text.replaceAll(secret, "[redacted]") : text),
        value,
      );
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (isRecord(value))
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !credentialFields.has(key.replace(/[_-]/gu, "").toLowerCase()))
          .map(([key, item]) => [key, visit(item, depth + 1)]),
      );
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    throw new CliError("INVALID_RESPONSE");
  };
  return visit(input, 0);
}
