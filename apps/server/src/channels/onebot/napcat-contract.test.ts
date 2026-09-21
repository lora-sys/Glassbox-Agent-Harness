import { describe, expect, it } from "vite-plus/test";
import { NAPCAT_CONTRACT_SNAPSHOT, NAPCAT_PROVIDER_SCHEMAS } from "./capabilities.ts";
import {
  NapCatContractError,
  payloadParams,
  readActionNameMap,
  returnKeys,
  topLevelKeys,
  verifyNapCatContract,
  type NapCatActionSource,
} from "./napcat-contract.ts";

/**
 * Builds a synthetic NapCat checkout whose contract matches the pinned snapshot.
 *
 * This lets the fail-closed verification run deterministically without a real checkout or
 * a git repository: every case below mutates exactly one part of this fixture.
 */
function syntheticCheckout(options: {
  dropAction?: string;
  dropServerOnly?: string;
  payloadOverride?: { action: string; params: readonly string[] };
  returnOverride?: { action: string; keys: readonly string[] };
  revision?: string;
}): { revision: string; routerSource: string; actionSources: NapCatActionSource[] } {
  const allowlisted = [...NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions].filter(
    (action) => action !== options.dropAction,
  );
  const serverOnly = [...NAPCAT_CONTRACT_SNAPSHOT.serverOnlyActions].filter(
    (action) => action !== options.dropServerOnly,
  );

  const entries: [string, string][] = [];
  const sources: NapCatActionSource[] = [];
  allowlisted.forEach((action, index) => {
    const ident = `A_${index}`;
    entries.push([ident, action]);
    const recorded = NAPCAT_PROVIDER_SCHEMAS[action]!;
    const payload =
      options.payloadOverride?.action === action
        ? options.payloadOverride.params
        : recorded.payload;
    const returned =
      options.returnOverride?.action === action ? options.returnOverride.keys : recorded.returned;
    const literal = (keys: readonly string[]): string =>
      `Type.Object({${keys.map((key) => `${key}: Type.String()`).join(",")}})`;
    sources.push({
      path: `packages/napcat-onebot/action/group/${ident}.ts`,
      source: [
        `const PayloadSchema = ${literal(payload)};`,
        `const ReturnSchema = ${literal(returned)};`,
        `class C${ident} extends OneBotAction {`,
        `  override actionName = ActionName.${ident};`,
        `  override payloadSchema = PayloadSchema;`,
        `  override returnSchema = ReturnSchema;`,
        `}`,
      ].join("\n"),
    });
  });
  serverOnly.forEach((action, index) => entries.push([`S_${index}`, action]));

  const routerSource = [
    "export const ActionName = {",
    ...entries.map(([ident, action]) => `  ${ident}: '${action}',`),
    "} as const;",
  ].join("\n");

  return {
    revision: options.revision ?? NAPCAT_CONTRACT_SNAPSHOT.commit,
    routerSource,
    actionSources: sources,
  };
}

describe("NapCat contract verification", () => {
  it("verifies a checkout whose contract matches the pinned snapshot", () => {
    const report = verifyNapCatContract(syntheticCheckout({}));
    expect(report.revision).toBe(NAPCAT_CONTRACT_SNAPSHOT.commit);
    expect(report.allowlisted).toBe(NAPCAT_CONTRACT_SNAPSHOT.allowlistedActions.length);
    expect(report.serverOnly).toBe(NAPCAT_CONTRACT_SNAPSHOT.serverOnlyActions.length);
    expect(report.schemaDigest).toBe(NAPCAT_CONTRACT_SNAPSHOT.providerSchemaDigest);
    // The synthetic router declares only classified actions, so nothing is unclassified.
    expect(report.unclassified).toBe(0);
  });

  it("fails closed when the checkout is not the pinned revision", () => {
    const error = (() => {
      try {
        verifyNapCatContract(syntheticCheckout({ revision: "0".repeat(40) }));
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(NapCatContractError);
    expect((error as NapCatContractError).problems[0]).toContain("not the pinned revision");
  });

  it("fails closed when an allowlisted action is missing from the provider", () => {
    const error = (() => {
      try {
        verifyNapCatContract(syntheticCheckout({ dropAction: "get_group_member_list" }));
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(NapCatContractError);
    expect((error as NapCatContractError).problems).toContain(
      "missing: allowlisted action get_group_member_list",
    );
  });

  it("fails closed when a server-only name is not a provider action", () => {
    const error = (() => {
      try {
        verifyNapCatContract(syntheticCheckout({ dropServerOnly: "bot_exit" }));
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(NapCatContractError);
    expect((error as NapCatContractError).problems).toContain("unknown: server-only name bot_exit");
  });

  it("fails closed when the allowlist permits an unsupported parameter", () => {
    const error = (() => {
      try {
        verifyNapCatContract(
          syntheticCheckout({
            payloadOverride: { action: "get_group_file_url", params: ["group_id"] },
          }),
        );
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(NapCatContractError);
    expect((error as NapCatContractError).problems).toContain(
      "unsupported: get_group_file_url:file_id",
    );
  });

  it("fails closed when the provider schema digest changes", () => {
    const error = (() => {
      try {
        verifyNapCatContract(
          syntheticCheckout({
            returnOverride: { action: "get_status", keys: ["online", "good"] },
          }),
        );
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(NapCatContractError);
    expect(
      (error as NapCatContractError).problems.some((problem) => problem.startsWith("changed:")),
    ).toBe(true);
  });

  it("fails closed when the provider action map is absent or empty", () => {
    expect(() => readActionNameMap("export const Other = {};")).toThrow(NapCatContractError);
    expect(() =>
      readActionNameMap("export const ActionName = {\n  Only: 'x',\n} as const;"),
    ).not.toThrow();
  });

  it("reads payload and return schemas without mistaking nested keys for parameters", () => {
    const source = [
      "const PayloadSchema = Type.Object({",
      "  group_id: Type.String({ description: '群号' }),",
      "  nested: Type.Object({ inner: Type.String() }),",
      "  count: Type.Number(),",
      "});",
      "const ReturnSchema = Type.Array(Type.Object({ messages: Type.Array(Type.Any()) }));",
    ].join("\n");
    expect(payloadParams(source)).toEqual(["group_id", "nested", "count"]);
    expect(returnKeys(source)).toEqual(["messages"]);
    // An inline payload schema and a shared named schema both resolve.
    expect(payloadParams("payloadSchema = Type.Object({ a: Type.Any() });")).toEqual(["a"]);
    expect(payloadParams("class X { override payloadSchema = Type.Object({}); }")).toEqual([]);
    // `Type.Any`, `Type.Null` and an absent override all mean no inspectable object.
    expect(returnKeys("const ReturnSchema = Type.Any();")).toEqual([]);
    expect(returnKeys("const ReturnSchema = Type.Null();")).toEqual([]);
    expect(returnKeys("class X {}")).toEqual([]);
    expect(topLevelKeys("Type.Object({ a: Type.String() })", 0)).toEqual(["a"]);
  });
});
