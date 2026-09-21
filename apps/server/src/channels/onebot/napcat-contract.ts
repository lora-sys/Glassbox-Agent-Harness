/**
 * Fail-closed verification of the pinned NapCat action contract.
 *
 * Glassbox vendors no NapCat source. `capabilities.ts` records the pinned commit, license,
 * source paths and a deterministic digest of the provider contract Glassbox allowlists;
 * this module re-derives that contract from a real checkout and reports every drift.
 *
 * The parsing and comparison live here, free of filesystem and process access, so the
 * fail-closed behavior is directly testable. `scripts/verify-napcat-contract.mts` supplies
 * the checkout's revision, router source and action sources.
 */

import {
  NAPCAT_CONTRACT_SNAPSHOT,
  napCatProviderSchemaDigest,
  unsupportedNapCatContract,
  type NapCatProviderSchema,
} from "./capabilities.ts";

/** A fail-closed contract problem. Thrown so callers can inspect every reason. */
export class NapCatContractError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`NapCat contract verification failed (${problems.length} problem(s))`);
    this.name = "NapCatContractError";
    this.problems = problems;
  }
}

function fail(message: string): never {
  throw new NapCatContractError([message]);
}

/** Reads the `ActionName` identifier → provider string map from the pinned router. */
export function readActionNameMap(routerSource: string): Map<string, string> {
  const start = routerSource.indexOf("export const ActionName = {");
  if (start < 0) fail("router.ts no longer declares `export const ActionName = {`");
  // The map closes on a column-zero `}` (the file uses `} as const;`).
  const terminator = /\n\}/u.exec(routerSource.slice(start));
  if (!terminator) fail("router.ts ActionName map is not terminated");
  const body = routerSource.slice(start, start + terminator.index);
  const map = new Map<string, string>();
  for (const match of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*'([^']*)'\s*,/gmu)) {
    map.set(match[1]!, match[2]!);
  }
  if (map.size === 0) fail("router.ts ActionName map parsed to zero entries");
  return map;
}

/**
 * Extracts the top-level keys of a `Type.Object({ ... })` literal starting at `from`.
 *
 * Only depth-1 keys are returned, so a nested object cannot be mistaken for a parameter.
 */
export function topLevelKeys(source: string, from: number): readonly string[] {
  const open = source.indexOf("{", from);
  if (open < 0) fail("expected a Type.Object literal");
  const keys: string[] = [];
  let depth = 0;
  let index = open;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return keys;
    } else if (depth === 1 && /[A-Za-z_$]/u.test(char)) {
      const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/u.exec(source.slice(index));
      if (match) {
        // Skip the type expression so a nested `{` is not read as a parameter name.
        keys.push(match[1]!);
        let scan = index + match[0].length;
        let inner = 0;
        while (scan < source.length) {
          const next = source[scan]!;
          if (next === "{" || next === "(" || next === "[") inner += 1;
          else if (next === "}" || next === ")" || next === "]") {
            if (inner === 0) break;
            inner -= 1;
          } else if (next === "," && inner === 0) break;
          scan += 1;
        }
        index = scan;
        continue;
      }
    }
    index += 1;
  }
  fail("unterminated Type.Object literal");
}

/**
 * Reads the payload parameter names declared by one action source file.
 *
 * A file may declare a shared `const PayloadSchema = Type.Object({...})`, an inline
 * `payloadSchema = Type.Object({...})`, or no override at all (the provider accepts no
 * parameters). All three are supported.
 */
export function payloadParams(source: string): readonly string[] {
  const shared = "PayloadSchema = Type.Object(";
  const sharedAt = source.indexOf(shared);
  if (sharedAt >= 0) return topLevelKeys(source, sharedAt + shared.length);
  const inline = "payloadSchema = Type.Object(";
  const inlineAt = source.indexOf(inline);
  if (inlineAt >= 0) return topLevelKeys(source, inlineAt + inline.length);
  return [];
}

/**
 * Reads the top-level keys of the return schema declared by one action source file.
 *
 * Covers the inline shapes the provider uses — `Type.Object({...})`,
 * `Type.Array(Type.Object({...}))` (the element keys), and a named `…ReturnSchema` const.
 * A named imported schema, `Type.Any`, `Type.Null` or an absent override all mean the
 * provider returns no inspectable object, recorded as an empty list.
 */
export function returnKeys(source: string): readonly string[] {
  const arrayObject = "ReturnSchema = Type.Array(Type.Object(";
  const arrayAt = source.indexOf(arrayObject);
  if (arrayAt >= 0) return topLevelKeys(source, arrayAt + arrayObject.length);
  const object = "ReturnSchema = Type.Object(";
  const objectAt = source.indexOf(object);
  if (objectAt >= 0) return topLevelKeys(source, objectAt + object.length);
  return [];
}

/** One action source file from a checkout, as read from disk. */
export interface NapCatActionSource {
  path: string;
  source: string;
}

export interface NapCatCheckoutInput {
  /** The checkout revision, as reported by `git rev-parse HEAD`. */
  revision: string;
  /** Contents of `packages/napcat-onebot/action/router.ts`. */
  routerSource: string;
  /** Every `.ts` file under `packages/napcat-onebot/action/`. */
  actionSources: readonly NapCatActionSource[];
}

export interface NapCatContractReport {
  revision: string;
  allowlisted: number;
  serverOnly: number;
  providerActions: number;
  unclassified: number;
  schemaDigest: string;
}

/**
 * Re-derives the allowlisted provider contract from a checkout and compares it to the pin.
 *
 * Fails closed on: a checkout that is not the pinned revision; an allowlisted action the
 * provider no longer declares (`missing`); a server-only name that is not a provider action
 * (`unknown`); an allowlisted parameter the provider never accepts (`unsupported`); and any
 * recomputed digest that no longer matches the pinned snapshot (`changed`).
 *
 * Unclassified provider actions are counted, not failed: Glassbox deliberately exposes a
 * small domain Tool surface over a large provider.
 */
export function verifyNapCatContract(input: NapCatCheckoutInput): NapCatContractReport {
  if (input.revision !== NAPCAT_CONTRACT_SNAPSHOT.commit) {
    fail(
      `checkout is not the pinned revision:\n  expected ${NAPCAT_CONTRACT_SNAPSHOT.commit}\n  observed ${input.revision}`,
    );
  }

  const actionNameMap = readActionNameMap(input.routerSource);
  const providerActions = new Set(actionNameMap.values());

  // Map each provider action string back to the file that declares it, so the payload and
  // return schemas are read from the same class that owns the action name.
  const declaredBy = new Map<string, string>();
  for (const file of input.actionSources) {
    for (const match of file.source.matchAll(
      /override actionName = ActionName\.([A-Za-z0-9_]+)/gu,
    )) {
      const value = actionNameMap.get(match[1]!);
      if (value) declaredBy.set(value, file.source);
    }
  }

  const problems: string[] = [];
  const allowlisted = new Set(NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions);
  const serverOnly = new Set(NAPCAT_CONTRACT_SNAPSHOT.serverOnlyActions);

  // `missing`: an allowlisted action the provider no longer declares. `unknown`: a
  // server-only name that is not a provider action at all, so it protects nothing.
  for (const action of allowlisted) {
    if (!providerActions.has(action)) problems.push(`missing: allowlisted action ${action}`);
  }
  for (const action of serverOnly) {
    if (!providerActions.has(action)) problems.push(`unknown: server-only name ${action}`);
  }
  const unclassified = [...providerActions].filter(
    (action) => !allowlisted.has(action) && !serverOnly.has(action),
  );

  // Re-derive the provider payload and return schemas for every allowlisted action.
  const observedSchemas: Record<string, NapCatProviderSchema> = {};
  for (const action of allowlisted) {
    const source = declaredBy.get(action);
    if (source === undefined) {
      problems.push(`unsupported: no declaring file found for allowlisted action ${action}`);
      continue;
    }
    observedSchemas[action] = { payload: payloadParams(source), returned: returnKeys(source) };
  }

  for (const violation of unsupportedNapCatContract(observedSchemas)) {
    problems.push(`unsupported: ${violation}`);
  }

  const schemaDigest = napCatProviderSchemaDigest(observedSchemas);
  if (schemaDigest !== NAPCAT_CONTRACT_SNAPSHOT.providerSchemaDigest) {
    problems.push(
      `changed: provider schema digest drift\n  pinned   ${NAPCAT_CONTRACT_SNAPSHOT.providerSchemaDigest}\n  observed ${schemaDigest}`,
    );
  }

  if (problems.length > 0) throw new NapCatContractError(problems);

  return {
    revision: input.revision,
    allowlisted: allowlisted.size,
    serverOnly: serverOnly.size,
    providerActions: providerActions.size,
    unclassified: unclassified.length,
    schemaDigest,
  };
}
