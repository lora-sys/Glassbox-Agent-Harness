import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyVitePlusAlias } from "../check-vite-plus-alias.mjs";

const coreName = "@voidzero-dev/vite-plus-core";
const version = "0.3.2";
const alias = "npm:" + coreName + "@" + version;
const tarball =
  "https://registry.npmjs.org/@voidzero-dev/vite-plus-core/-/vite-plus-core-" + version + ".tgz";

function fixture(t, { workspaceAlias = alias, viteEntry, packages = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vite-plus-alias-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    resolve(root, "package.json"),
    JSON.stringify({
      devDependencies: { "vite-plus": version },
      overrides: { vite: alias, "@glassbox/web": { vite: workspaceAlias } },
    }),
  );
  writeFileSync(
    resolve(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "": { devDependencies: { "vite-plus": version } },
        "node_modules/vite-plus": { version },
        "node_modules/vite": {
          name: coreName,
          version,
          resolved: tarball,
          ...viteEntry,
        },
        ...packages,
      },
    }),
  );
  return root;
}

test("accepts the exact reviewed Vite+ package alias", (t) => {
  const result = verifyVitePlusAlias(fixture(t));
  assert.deepEqual(result, {
    vitePlusVersion: version,
    bundledVite: "8.3.0",
    advisories: [
      "GHSA-mv48-hcvh-8jj8",
      "GHSA-353f-5xf4-qw67",
      "GHSA-c27g-q93r-2cwf",
      "GHSA-fx2h-pf6j-xcff",
    ],
  });
});

test("rejects an unreviewed Vite+ release", (t) => {
  const root = fixture(t);
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  manifest.devDependencies["vite-plus"] = "0.3.3";
  writeFileSync(resolve(root, "package.json"), JSON.stringify(manifest));
  assert.throws(() => verifyVitePlusAlias(root), /no reviewed advisory mapping/u);
});

test("rejects a Vite package that is not the canonical Vite+ core alias", (t) => {
  const root = fixture(t, { viteEntry: { name: "vite" } });
  assert.throws(() => verifyVitePlusAlias(root), /not the reviewed Vite\+ core package/u);
});

test("rejects a second standalone Vite installation", (t) => {
  const root = fixture(t, {
    packages: { "node_modules/plugin/node_modules/vite": { version: "5.4.8" } },
  });
  assert.throws(() => verifyVitePlusAlias(root), /not the reviewed Vite\+ core package/u);
});

test("rejects a separately installed launch-editor package", (t) => {
  const root = fixture(t, { packages: { "node_modules/launch-editor": { version: "2.8.2" } } });
  assert.throws(() => verifyVitePlusAlias(root), /separate launch-editor package/u);
});

test("rejects a mismatched workspace override", (t) => {
  const root = fixture(t, { workspaceAlias: "vite@8.3.0" });
  assert.throws(() => verifyVitePlusAlias(root), /web workspace Vite override/u);
});
