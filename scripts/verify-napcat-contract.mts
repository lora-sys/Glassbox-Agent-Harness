/**
 * Verifies the pinned NapCat action contract against a real NapCat checkout.
 *
 * Thin CLI wrapper: it reads the checkout and delegates every parsing and comparison
 * decision to `apps/server/src/channels/onebot/napcat-contract.ts`, which fails closed on
 * a wrong revision, a missing allowlisted action, an unknown server-only name, an
 * unsupported allowlisted parameter, or a changed contract digest.
 *
 * Usage:
 *   tsx scripts/verify-napcat-contract.mts <path-to-NapCatQQ-checkout>
 *   NAPCAT_CHECKOUT=<path> tsx scripts/verify-napcat-contract.mts
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NAPCAT_CONTRACT_SNAPSHOT } from "../apps/server/src/channels/onebot/capabilities.ts";
import {
  NapCatContractError,
  verifyNapCatContract,
  type NapCatActionSource,
} from "../apps/server/src/channels/onebot/napcat-contract.ts";

const ACTION_DIR = join("packages", "napcat-onebot", "action");

function readActionSources(root: string): NapCatActionSource[] {
  const dir = join(root, ACTION_DIR);
  const out: NapCatActionSource[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push({ path: full, source: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return out;
}

function main(): void {
  const root = process.argv[2] ?? process.env.NAPCAT_CHECKOUT;
  if (!root) {
    process.stderr.write(
      "usage: tsx scripts/verify-napcat-contract.mts <path-to-NapCatQQ-checkout>\n" +
        "   or: NAPCAT_CHECKOUT=<path> tsx scripts/verify-napcat-contract.mts\n",
    );
    process.exit(1);
  }
  if (!existsSync(join(root, ACTION_DIR))) {
    process.stderr.write(`not a NapCat checkout (no ${ACTION_DIR}): ${root}\n`);
    process.exit(1);
  }

  try {
    const report = verifyNapCatContract({
      revision: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      routerSource: readFileSync(join(root, ACTION_DIR, "router.ts"), "utf8"),
      actionSources: readActionSources(root),
    });
    process.stdout.write(
      `NapCat contract verified.\n` +
        `  provider            ${NAPCAT_CONTRACT_SNAPSHOT.provider}\n` +
        `  revision            ${report.revision}\n` +
        `  checkout            ${relative(process.cwd(), root) || "."}${sep}\n` +
        `  allowlisted actions ${report.allowlisted}\n` +
        `  server-only actions ${report.serverOnly}\n` +
        `  provider actions    ${report.providerActions}\n` +
        `  unclassified        ${report.unclassified} (expected: Glassbox exposes a subset)\n` +
        `  schema digest       ${report.schemaDigest}\n`,
    );
  } catch (error) {
    if (error instanceof NapCatContractError) {
      process.stderr.write(
        `${error.message}:\n` +
          error.problems.map((problem) => `  - ${problem}`).join("\n") +
          `\n\nCheckout: ${root}\n`,
      );
      process.exit(1);
    }
    throw error;
  }
}

main();
