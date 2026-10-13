import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const reviewedReleases = new Map([
  [
    "0.3.2",
    {
      coreName: "@voidzero-dev/vite-plus-core",
      coreTarball:
        "https://registry.npmjs.org/@voidzero-dev/vite-plus-core/-/vite-plus-core-0.3.2.tgz",
      bundledVite: "8.3.0",
      advisories: [
        "GHSA-mv48-hcvh-8jj8",
        "GHSA-353f-5xf4-qw67",
        "GHSA-c27g-q93r-2cwf",
        "GHSA-fx2h-pf6j-xcff",
      ],
    },
  ],
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function requireMatch(condition, message) {
  if (!condition) throw new Error(message);
}

export function verifyVitePlusAlias(repositoryRoot = process.cwd()) {
  const root = resolve(repositoryRoot);
  const manifest = readJson(resolve(root, "package.json"));
  const lock = readJson(resolve(root, "package-lock.json"));
  const version = manifest.devDependencies?.["vite-plus"];
  const release = reviewedReleases.get(version);

  requireMatch(release, "vite-plus " + String(version) + " has no reviewed advisory mapping");

  const alias = "npm:" + release.coreName + "@" + version;
  requireMatch(
    manifest.overrides?.vite === alias,
    "root Vite override does not match the reviewed Vite+ alias",
  );
  requireMatch(
    manifest.overrides?.["@glassbox/web"]?.vite === alias,
    "web workspace Vite override does not match the reviewed Vite+ alias",
  );
  requireMatch(
    lock.packages?.[""]?.devDependencies?.["vite-plus"] === version,
    "package-lock root does not pin the reviewed vite-plus version",
  );

  const vitePlusEntries = Object.entries(lock.packages ?? {}).filter(
    ([path]) => path === "node_modules/vite-plus" || path.endsWith("/node_modules/vite-plus"),
  );
  requireMatch(
    vitePlusEntries.length === 1 &&
      vitePlusEntries[0]?.[0] === "node_modules/vite-plus" &&
      vitePlusEntries[0]?.[1]?.version === version,
    "package-lock must contain only the reviewed vite-plus release",
  );

  const viteEntries = Object.entries(lock.packages ?? {}).filter(
    ([path]) => path === "node_modules/vite" || path.endsWith("/node_modules/vite"),
  );
  const viteAlias = viteEntries[0]?.[1];
  requireMatch(
    viteEntries.length === 1 &&
      viteEntries[0]?.[0] === "node_modules/vite" &&
      viteAlias?.name === release.coreName &&
      viteAlias.version === version &&
      viteAlias.resolved === release.coreTarball,
    "package-lock Vite entry is not the reviewed Vite+ core package",
  );

  const separatelyInstalledLaunchEditors = Object.keys(lock.packages ?? {}).filter(
    (path) => path === "node_modules/launch-editor" || path.endsWith("/node_modules/launch-editor"),
  );
  requireMatch(
    separatelyInstalledLaunchEditors.length === 0,
    "a separate launch-editor package is present; review the GHSA exception before continuing",
  );

  return {
    vitePlusVersion: version,
    bundledVite: release.bundledVite,
    advisories: [...release.advisories],
  };
}

function main() {
  try {
    const result = verifyVitePlusAlias();
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        "allow-ghsas=" + result.advisories.join(",") + "\n",
      );
    }
    console.log(
      "Verified vite-plus " +
        result.vitePlusVersion +
        ", core alias and bundled Vite " +
        result.bundledVite +
        "; no separate Vite or launch-editor package is locked.",
    );
  } catch (error) {
    console.error(
      "Vite+ alias review failed: " + (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
