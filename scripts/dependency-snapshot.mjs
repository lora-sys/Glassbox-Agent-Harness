import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.npmmirror.com"]);
const DETECTOR_NAME = "glassbox-npm-lockfile-v3";
const DETECTOR_VERSION = "0.1.0";
const CORRELATOR = "glassbox-npm-lockfile-v3:package-lock.json";
const MAX_LOCK_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_PACKAGES = 50_000;
const API_TIMEOUT_MS = 20_000;

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code) {
  const error = new Error(code);
  error.code = `DEPENDENCY_SNAPSHOT_INVALID:${code}`;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
  return value;
}

function installNameFromPath(location) {
  const marker = location.lastIndexOf("node_modules/");
  if (marker < 0) return undefined;
  const parts = location.slice(marker + "node_modules/".length).split("/");
  if (!parts[0]) fail("invalid-install-location");
  return parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function validName(name) {
  if (
    typeof name !== "string" ||
    !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/u.test(name) ||
    name.includes("..")
  )
    fail("invalid-package-name");
  return name;
}

function packageUrl(name, version) {
  return `pkg:npm/${encodeURIComponent(validName(name)).replace(/%2F/giu, "/")}@${encodeURIComponent(requiredString(version, "missing-version"))}`;
}

function validateIntegrity(value) {
  requiredString(value, "missing-integrity");
  const expectedBytes = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
  const tokens = value.trim().split(/\s+/u);
  if (!tokens.length) fail("invalid-integrity");
  for (const token of tokens) {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/u.exec(token);
    if (!match) fail("invalid-integrity");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length !== expectedBytes[match[1]] || bytes.toString("base64") !== match[2])
      fail("invalid-integrity-digest");
  }
}

function validateTarball(urlText, name, version) {
  let url;
  try {
    url = new URL(requiredString(urlText, "missing-resolved"));
  } catch {
    fail("bad-resolved-url");
  }
  if (
    url.protocol !== "https:" ||
    !REGISTRY_HOSTS.has(url.hostname.toLowerCase()) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("unsupported-source");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    fail("bad-resolved-encoding");
  }
  const marker = pathname.lastIndexOf("/-/");
  if (marker < 0 || pathname.slice(0, marker).replace(/^\/+/, "") !== name)
    fail("resolved-name-mismatch");
  if (pathname.slice(marker + 3) !== `${name.split("/").at(-1)}-${version}.tgz`)
    fail("resolved-version-mismatch");
}

function safePackageLocation(location) {
  if (
    typeof location !== "string" ||
    !location ||
    location.startsWith("/") ||
    location.includes("\\") ||
    location.split("/").some((part) => !part || part === "." || part === "..") ||
    path.posix.normalize(location) !== location
  )
    fail("invalid-package-location");
}

function validateDependencyMap(entry, field, location) {
  if (!Object.hasOwn(entry, field)) return {};
  const map = entry[field];
  if (!isRecord(map)) fail(`invalid-${field}:${location}`);
  for (const [name, spec] of Object.entries(map)) {
    validName(name);
    requiredString(spec, `invalid-${field}-spec:${location}`);
  }
  return map;
}

function validateLock(lock) {
  if (!isRecord(lock)) fail("invalid-lock-root");
  const allowedRootKeys = new Set(["name", "version", "lockfileVersion", "requires", "packages"]);
  if (Object.keys(lock).some((key) => !allowedRootKeys.has(key))) fail("unknown-lock-root-field");
  if (lock.lockfileVersion !== 3 || !isRecord(lock.packages) || !isRecord(lock.packages[""]))
    fail("expected-lockfile-v3");
  const locations = Object.entries(lock.packages);
  if (locations.length > MAX_PACKAGES) fail("too-many-packages");
  for (const [location, entry] of locations) {
    if (!isRecord(entry)) fail("invalid-package-entry");
    if (location) safePackageLocation(location);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ])
      validateDependencyMap(entry, field, location || "root");
    if (Object.hasOwn(entry, "peerDependenciesMeta")) {
      if (!isRecord(entry.peerDependenciesMeta)) fail("invalid-peer-dependencies-meta");
      for (const [name, metadata] of Object.entries(entry.peerDependenciesMeta)) {
        validName(name);
        if (!isRecord(metadata) || Object.keys(metadata).some((key) => key !== "optional"))
          fail("invalid-peer-dependencies-meta-entry");
        if (Object.hasOwn(metadata, "optional") && typeof metadata.optional !== "boolean")
          fail("invalid-peer-dependencies-meta-entry");
      }
    }
    if (Object.hasOwn(entry, "link") && typeof entry.link !== "boolean") fail("invalid-link-flag");
    if (entry.link && Object.keys(entry).some((key) => !["resolved", "link"].includes(key)))
      fail("invalid-link-entry");
  }
}

function resolveLink(location, entry, packages) {
  if (!entry.link) return location;
  const resolved = requiredString(entry.resolved, "bad-link");
  safePackageLocation(resolved);
  if (!packages[resolved] || packages[resolved].link) fail("unsupported-link");
  return resolved;
}

function ancestorNodeModules(parent) {
  const roots = [];
  let current = parent;
  while (current) {
    if (path.posix.basename(current) !== "node_modules") roots.push(`${current}/node_modules`);
    current = path.posix.dirname(current);
    if (current === ".") current = "";
  }
  roots.push("node_modules");
  return [...new Set(roots)];
}

function aliasTarget(spec) {
  if (!spec.startsWith("npm:")) return undefined;
  const target = spec.slice(4);
  const separator = target.lastIndexOf("@");
  return validName(separator > 0 ? target.slice(0, separator) : target);
}

function createPackageRecord(location, packages, workspaceLocations) {
  const entry = packages[location];
  const resolvedLocation = resolveLink(location, entry, packages);
  const actual = packages[resolvedLocation];
  if (!actual || actual.link) fail("missing-link-target");
  const workspace = workspaceLocations.has(resolvedLocation);
  if (
    !workspace &&
    !resolvedLocation.startsWith("node_modules/") &&
    !resolvedLocation.includes("/node_modules/")
  )
    fail("unsupported-package-location");
  const name = validName(
    Object.hasOwn(actual, "name")
      ? requiredString(actual.name, "missing-package-name")
      : requiredString(installNameFromPath(resolvedLocation), "missing-package-name"),
  );
  const version = requiredString(
    actual.version,
    workspace ? "bad-workspace-metadata" : "missing-version",
  );
  if (workspace) {
    return {
      location,
      resolvedLocation,
      name,
      version,
      url: packageUrl(name, version),
      kind: "workspace",
      resolved: `workspace:${resolvedLocation}`,
      integrity: undefined,
      entry: actual,
      installName: installNameFromPath(location),
    };
  }
  const installName = installNameFromPath(resolvedLocation);
  if (!installName) fail("missing-install-name");
  validateTarball(actual.resolved, name, version);
  validateIntegrity(actual.integrity);
  return {
    location,
    resolvedLocation,
    name,
    version,
    url: packageUrl(name, version),
    kind: "registry",
    resolved: actual.resolved,
    integrity: actual.integrity,
    entry: actual,
    installName,
  };
}

function assertAliasIdentity(depName, spec, record, installName, aliasBindings) {
  const alias = aliasTarget(spec);
  if (alias && alias !== record.name) fail("alias-name-mismatch");
  if (
    installName !== record.name &&
    alias !== record.name &&
    !aliasBindings.has(`${installName}\u0000${record.name}`)
  )
    fail("alias-identity-mismatch");
  if (alias && depName !== installName) fail("alias-install-name-mismatch");
}

function dependencyFields(entry, includeDev) {
  const fields = [
    ["dependencies", entry.dependencies ?? {}],
    ["optionalDependencies", entry.optionalDependencies ?? {}],
    ["peerDependencies", entry.peerDependencies ?? {}],
  ];
  if (includeDev) fields.push(["devDependencies", entry.devDependencies ?? {}]);
  return fields;
}

function stableSnapshotGraph(lock) {
  validateLock(lock);
  const packages = lock.packages;
  const aliasBindings = new Set();
  for (const entry of Object.values(packages)) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [dependency, spec] of Object.entries(entry[field] ?? [])) {
        const alias = aliasTarget(spec);
        if (alias) aliasBindings.add(`${dependency}\u0000${alias}`);
      }
    }
  }
  const workspaceLocations = new Set(
    Object.entries(packages)
      .filter(([, entry]) => entry.link)
      .map(([location, entry]) => resolveLink(location, entry, packages)),
  );
  const records = new Map();
  for (const [location, entry] of Object.entries(packages))
    if (location && !entry.link)
      records.set(location, createPackageRecord(location, packages, workspaceLocations));
  for (const [location, entry] of Object.entries(packages)) {
    if (!entry.link) continue;
    const target = resolveLink(location, entry, packages);
    const record = records.get(target);
    if (!record || record.kind !== "workspace") fail("link-not-workspace");
    records.set(location, {
      ...record,
      location,
      resolvedLocation: target,
      installName: installNameFromPath(location),
    });
  }
  for (const record of records.values()) {
    if (
      record.kind === "registry" &&
      record.installName !== record.name &&
      !aliasBindings.has(`${record.installName}\u0000${record.name}`)
    )
      fail("alias-identity-mismatch");
  }

  const byUrl = new Map();
  const locationsByUrl = new Map();
  const edges = new Map();
  const direct = new Set();
  const runtimeSeeds = new Set();
  const developmentSeeds = new Set();
  const registryLocations = [];
  for (const [location, record] of records) {
    const prior = byUrl.get(record.url);
    if (
      prior &&
      (prior.kind !== record.kind ||
        prior.name !== record.name ||
        prior.version !== record.version ||
        prior.integrity !== record.integrity ||
        prior.resolved !== record.resolved)
    )
      fail("conflicting-purl-identity");
    const node = prior ?? {
      url: record.url,
      kind: record.kind,
      name: record.name,
      version: record.version,
      integrity: record.integrity,
      resolved: record.resolved,
      aliases: new Set(),
      locations: new Set(),
    };
    node.locations.add(location);
    const matchingLocations = locationsByUrl.get(record.url) ?? [];
    matchingLocations.push(location);
    locationsByUrl.set(record.url, matchingLocations);
    if (record.installName && record.installName !== record.name)
      node.aliases.add(record.installName);
    byUrl.set(record.url, node);
    if (record.kind === "registry") registryLocations.push(location);
  }

  const omittedOptional = new Set();
  const find = (parent, dependency, spec, optional) => {
    validName(dependency);
    const resolved = ancestorNodeModules(parent)
      .map((root) => `${root}/${dependency}`)
      .find((candidate) => Object.hasOwn(packages, candidate));
    if (!resolved) {
      if (optional) {
        omittedOptional.add(`${parent}:${dependency}`);
        return undefined;
      }
      fail("unresolved-required-dependency");
    }
    const target = resolveLink(resolved, packages[resolved], packages);
    const record = records.get(target);
    if (!record) fail("dependency-target-omitted");
    assertAliasIdentity(dependency, spec, record, installNameFromPath(resolved), aliasBindings);
    return target;
  };

  for (const [location, record] of records) {
    const entry = record.entry;
    const outgoing = new Set();
    for (const [field, dependencies] of dependencyFields(entry, record.kind === "workspace")) {
      for (const [dependency, spec] of Object.entries(dependencies)) {
        const optionalPeer =
          field === "peerDependencies" &&
          entry.peerDependenciesMeta?.[dependency]?.optional === true;
        const target = find(
          record.resolvedLocation,
          dependency,
          spec,
          field === "optionalDependencies" || optionalPeer,
        );
        if (target) outgoing.add(records.get(target).url);
      }
    }
    edges.set(location, outgoing);
    if (record.kind !== "workspace") continue;
    for (const [field, dependencies] of dependencyFields(entry, true)) {
      for (const [dependency, spec] of Object.entries(dependencies)) {
        const optionalPeer =
          field === "peerDependencies" &&
          entry.peerDependenciesMeta?.[dependency]?.optional === true;
        const target = find(
          record.resolvedLocation,
          dependency,
          spec,
          field === "optionalDependencies" || optionalPeer,
        );
        if (!target) continue;
        direct.add(records.get(target).url);
        (field === "devDependencies" ? developmentSeeds : runtimeSeeds).add(target);
      }
    }
  }

  const root = packages[""];
  for (const [field, dependencies] of dependencyFields(root, true)) {
    for (const [dependency, spec] of Object.entries(dependencies)) {
      const optionalPeer =
        field === "peerDependencies" && root.peerDependenciesMeta?.[dependency]?.optional === true;
      const target = find("", dependency, spec, field === "optionalDependencies" || optionalPeer);
      if (!target) continue;
      direct.add(records.get(target).url);
      (field === "devDependencies" ? developmentSeeds : runtimeSeeds).add(target);
    }
  }

  const closure = (seeds) => {
    const seen = new Set();
    const todo = [...seeds];
    while (todo.length) {
      const location = todo.pop();
      if (seen.has(location)) continue;
      seen.add(location);
      for (const childUrl of edges.get(location) ?? []) {
        for (const other of locationsByUrl.get(childUrl) ?? [])
          if (!seen.has(other)) todo.push(other);
      }
    }
    return seen;
  };
  const runtimeLocations = closure(runtimeSeeds);
  const developmentLocations = closure(developmentSeeds);
  const scopeByUrl = new Map();
  for (const [location, record] of records) {
    const prior = scopeByUrl.get(record.url);
    if (runtimeLocations.has(location) || prior === "runtime")
      scopeByUrl.set(record.url, "runtime");
    else if (developmentLocations.has(location) || !prior)
      scopeByUrl.set(record.url, "development");
  }

  const resolved = {};
  for (const node of [...byUrl.values()].sort((left, right) =>
    compareStrings(left.url, right.url),
  )) {
    const dependencies = new Set();
    for (const location of node.locations)
      for (const child of edges.get(location) ?? []) dependencies.add(child);
    const metadata = { source_type: node.kind, resolved: node.resolved };
    if (node.integrity) metadata.integrity = node.integrity;
    if (node.aliases.size)
      metadata.install_aliases = [...node.aliases].sort(compareStrings).join(",");
    resolved[node.url] = {
      package_url: node.url,
      relationship: direct.has(node.url) ? "direct" : "indirect",
      scope: scopeByUrl.get(node.url) ?? "development",
      dependencies: [...dependencies].sort(compareStrings),
      metadata,
    };
  }
  for (const location of registryLocations)
    if (!resolved[records.get(location).url]) fail("registry-coverage-incomplete");

  return {
    resolved,
    diagnostics: {
      registryLocationCount: registryLocations.length,
      resolvedPackageCount: Object.keys(resolved).length,
      workspacePackageCount: [...byUrl.values()].filter((node) => node.kind === "workspace").length,
      dependencyEdgeCount: Object.values(resolved).reduce(
        (count, node) => count + node.dependencies.length,
        0,
      ),
      directPackageCount: Object.values(resolved).filter((node) => node.relationship === "direct")
        .length,
      runtimePackageCount: Object.values(resolved).filter((node) => node.scope === "runtime")
        .length,
      developmentPackageCount: Object.values(resolved).filter(
        (node) => node.scope === "development",
      ).length,
      missingOptionalDependencyCount: omittedOptional.size,
      locationsByPackageUrl: Object.fromEntries(
        [...byUrl].map(([url, node]) => [url, [...node.locations].sort(compareStrings)]),
      ),
    },
  };
}

export function buildSnapshot(lock, { sha, ref, jobId, scanned, detectorUrl }) {
  const revision = requiredString(sha, "missing-sha");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(revision)) fail("invalid-sha");
  const branchRef = requiredString(ref, "missing-ref");
  if (!/^refs\/(?:heads\/[A-Za-z0-9._/-]+|pull\/[1-9]\d*\/head)$/u.test(branchRef))
    fail("invalid-ref");
  if (branchRef.includes("..") || branchRef.endsWith("/") || branchRef.includes("//"))
    fail("invalid-ref");
  const timestamp = requiredString(scanned, "missing-scanned");
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp)
    fail("invalid-scanned");
  let detector;
  try {
    detector = new URL(requiredString(detectorUrl, "missing-detector-url"));
  } catch {
    fail("invalid-detector-url");
  }
  if (detector.protocol !== "https:" || detector.username || detector.password)
    fail("invalid-detector-url");
  const graph = stableSnapshotGraph(lock);
  const snapshot = {
    version: 0,
    sha: revision.toLowerCase(),
    ref: branchRef,
    job: {
      id: requiredString(jobId, "missing-job-id"),
      correlator: CORRELATOR,
    },
    detector: {
      name: DETECTOR_NAME,
      version: DETECTOR_VERSION,
      url: detector.href,
    },
    scanned: timestamp,
    manifests: {
      "package-lock.json": {
        name: "package-lock.json",
        file: { source_location: "package-lock.json" },
        metadata: { lockfile_version: "3" },
        resolved: graph.resolved,
      },
    },
  };
  Object.defineProperty(snapshot, "diagnostics", {
    enumerable: false,
    value: graph.diagnostics,
  });
  return snapshot;
}

async function boundedBytes(response, limit) {
  if (!response?.body || typeof response.body[Symbol.asyncIterator] !== "function")
    fail("invalid-api-response-body");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) fail("api-response-too-large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function validateRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
    fail("invalid-repository");
  return repository;
}

function validateSha(value, code = "invalid-sha") {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/iu.test(value)) fail(code);
  return value.toLowerCase();
}

function validateBranch(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    /[\s~^:?*[\\]/u.test(value) ||
    value.endsWith(".") ||
    value.endsWith("/")
  )
    fail("invalid-branch-ref");
  return value;
}

function apiUrl(pathname) {
  let url;
  try {
    url = new URL(pathname, API_ORIGIN);
  } catch {
    fail("invalid-api-path");
  }
  if (url.origin !== API_ORIGIN || url.protocol !== "https:") fail("invalid-api-host");
  return url;
}

async function githubRequest({ pathname, token, fetchImpl, method = "GET", body }) {
  const url = apiUrl(pathname);
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": API_VERSION,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    fail("github-api-transport");
  }
  if (response?.redirected || (response?.url && new URL(response.url).origin !== API_ORIGIN))
    fail("github-api-redirect-rejected");
  const bytes = await boundedBytes(response, MAX_RESPONSE_BYTES);
  if (!response.ok) fail(`github-api-status-${response.status}`);
  let json;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("invalid-api-json");
  }
  return json;
}

async function readLockAt({ repository, sha, token, fetchImpl }) {
  const query = new URLSearchParams({ ref: validateSha(sha) });
  const response = await githubRequest({
    pathname: `/repos/${repository}/contents/package-lock.json?${query}`,
    token,
    fetchImpl,
  });
  if (
    !isRecord(response) ||
    response.type !== "file" ||
    response.path !== "package-lock.json" ||
    response.name !== "package-lock.json" ||
    response.encoding !== "base64" ||
    !Number.isSafeInteger(response.size) ||
    response.size < 1 ||
    response.size > MAX_LOCK_BYTES ||
    typeof response.content !== "string"
  )
    fail("invalid-lock-content-response");
  const base64 = response.content.replace(/[\r\n]/gu, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64))
    fail("invalid-lock-base64");
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length !== response.size ||
    bytes.length > MAX_LOCK_BYTES ||
    bytes.toString("base64") !== base64
  )
    fail("invalid-lock-size");
  let lock;
  try {
    lock = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("invalid-lock-json");
  }
  validateLock(lock);
  return lock;
}

function strictEvent(event, eventName, githubSha, githubRef) {
  if (!isRecord(event) || !isRecord(event.repository)) fail("invalid-github-event");
  const repository = validateRepository(event.repository.full_name);
  if (eventName === "push") {
    const sha = validateSha(event.after);
    if (
      sha !== validateSha(githubSha) ||
      githubRef !== "refs/heads/main" ||
      event.ref !== githubRef
    )
      fail("push-event-binding-mismatch");
    return { kind: "push", repository, sha, ref: githubRef };
  }
  if (eventName !== "pull_request_target" || !isRecord(event.pull_request))
    fail("unsupported-event");
  const pull = event.pull_request;
  const number = pull.number;
  if (!Number.isSafeInteger(number) || number < 1 || !isRecord(pull.base) || !isRecord(pull.head))
    fail("invalid-pull-request-event");
  const baseSha = validateSha(pull.base.sha);
  const headSha = validateSha(pull.head.sha);
  const baseRef = validateBranch(pull.base.ref);
  const headRef = validateBranch(pull.head.ref);
  if (baseRef !== "main" || pull.base.repo?.full_name !== repository)
    fail("unsafe-base-repository");
  if (
    !isRecord(pull.head.repo) ||
    validateRepository(pull.head.repo.full_name) !== pull.head.repo.full_name
  )
    fail("unsafe-head-repository");
  if (pull.state !== "open") fail("pull-request-not-open");
  return {
    kind: "pull_request_target",
    repository,
    number,
    baseSha,
    headSha,
    baseRef,
    headRef,
    headRepository: pull.head.repo.full_name,
  };
}

async function currentPullBinding({
  repository,
  number,
  token,
  fetchImpl,
  baseSha,
  headSha,
  baseRef,
  headRef,
  headRepository,
}) {
  const pull = await githubRequest({
    pathname: `/repos/${repository}/pulls/${number}`,
    token,
    fetchImpl,
  });
  if (
    !isRecord(pull) ||
    pull.state !== "open" ||
    pull.base?.repo?.full_name !== repository ||
    pull.base?.ref !== baseRef ||
    validateSha(pull.base?.sha, "pull-request-binding-changed") !== baseSha ||
    validateSha(pull.head?.sha, "pull-request-binding-changed") !== headSha ||
    pull.head?.ref !== headRef ||
    !isRecord(pull.head.repo) ||
    pull.head.repo.full_name !== headRepository
  )
    fail("pull-request-binding-changed");
}

async function submitSnapshot({ repository, token, fetchImpl, snapshot }) {
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) fail("snapshot-payload-too-large");
  const result = await githubRequest({
    pathname: `/repos/${repository}/dependency-graph/snapshots`,
    token,
    fetchImpl,
    method: "POST",
    body: snapshot,
  });
  if (
    !isRecord(result) ||
    (!(typeof result.id === "string" && /^[1-9]\d*$/u.test(result.id)) &&
      !(Number.isSafeInteger(result.id) && result.id > 0)) ||
    !["SUCCESS", "ACCEPTED"].includes(result.result)
  )
    fail("invalid-snapshot-accepted-response");
  return String(result.id);
}

function snapshotIdentity({ sha, ref, runId, attempt, label, repository }) {
  const now = new Date().toISOString();
  return {
    sha,
    ref,
    jobId: `dependency-snapshot-${runId}-${attempt}-${label}`,
    scanned: now,
    detectorUrl: `https://github.com/${repository}/actions/runs/${runId}`,
  };
}

export async function runDependencySnapshot({
  event,
  eventName,
  githubSha,
  githubRef,
  runId,
  runAttempt,
  token,
  repository,
  fetchImpl = fetch,
  log = () => {},
}) {
  const repo = validateRepository(repository);
  const authToken = requiredString(token, "missing-github-token");
  if (!/^\d+$/u.test(String(runId)) || !/^\d+$/u.test(String(runAttempt)))
    fail("invalid-workflow-run-id");
  const identity = strictEvent(event, eventName, githubSha, githubRef);
  if (identity.repository !== repo) fail("event-repository-mismatch");
  const snapshots = [];
  if (identity.kind === "push") {
    const lock = await readLockAt({
      repository: repo,
      sha: identity.sha,
      token: authToken,
      fetchImpl,
    });
    const snapshot = buildSnapshot(
      lock,
      snapshotIdentity({
        sha: identity.sha,
        ref: identity.ref,
        runId,
        attempt: runAttempt,
        label: "main",
        repository: repo,
      }),
    );
    snapshots.push(snapshot);
  } else {
    await currentPullBinding({
      repository: repo,
      number: identity.number,
      token: authToken,
      fetchImpl,
      baseSha: identity.baseSha,
      headSha: identity.headSha,
      baseRef: identity.baseRef,
      headRef: identity.headRef,
      headRepository: identity.headRepository,
    });
    const [baseLock, headLock] = await Promise.all([
      readLockAt({
        repository: repo,
        sha: identity.baseSha,
        token: authToken,
        fetchImpl,
      }),
      readLockAt({
        repository: repo,
        sha: identity.headSha,
        token: authToken,
        fetchImpl,
      }),
    ]);
    snapshots.push(
      buildSnapshot(
        baseLock,
        snapshotIdentity({
          sha: identity.baseSha,
          ref: `refs/heads/${identity.baseRef}`,
          runId,
          attempt: runAttempt,
          label: "base",
          repository: repo,
        }),
      ),
      buildSnapshot(
        headLock,
        snapshotIdentity({
          sha: identity.headSha,
          ref: `refs/pull/${identity.number}/head`,
          runId,
          attempt: runAttempt,
          label: "head",
          repository: repo,
        }),
      ),
    );
    await currentPullBinding({
      repository: repo,
      number: identity.number,
      token: authToken,
      fetchImpl,
      baseSha: identity.baseSha,
      headSha: identity.headSha,
      baseRef: identity.baseRef,
      headRef: identity.headRef,
      headRepository: identity.headRepository,
    });
  }

  const accepted = [];
  for (const snapshot of snapshots) {
    accepted.push(
      await submitSnapshot({
        repository: repo,
        token: authToken,
        fetchImpl,
        snapshot,
      }),
    );
  }
  for (const snapshot of snapshots) {
    log(
      `Submitted dependency snapshot for ${snapshot.ref} at ${snapshot.sha.slice(0, 12)} ` +
        `(${snapshot.diagnostics.registryLocationCount} registry locations, ` +
        `${snapshot.diagnostics.resolvedPackageCount} package identities).`,
    );
  }
  return { acceptedCount: accepted.length, snapshotIds: accepted };
}

async function main() {
  const eventPath = requiredString(process.env.GITHUB_EVENT_PATH, "missing-event-path");
  const eventBytes = await readFile(eventPath);
  if (eventBytes.length > MAX_RESPONSE_BYTES) fail("github-event-too-large");
  let event;
  try {
    event = JSON.parse(eventBytes.toString("utf8"));
  } catch {
    fail("invalid-github-event-json");
  }
  const result = await runDependencySnapshot({
    event,
    eventName: process.env.GITHUB_EVENT_NAME,
    githubSha: process.env.GITHUB_SHA,
    githubRef: process.env.GITHUB_REF,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY,
  });
  console.log(`Accepted ${result.acceptedCount} dependency snapshot(s).`);
}

export const dependencySnapshotLimits = Object.freeze({
  maxLockBytes: MAX_LOCK_BYTES,
  maxApiBytes: MAX_RESPONSE_BYTES,
  maxPackages: MAX_PACKAGES,
  apiTimeoutMs: API_TIMEOUT_MS,
});

export const dependencySnapshotIdentity = Object.freeze({
  correlator: CORRELATOR,
  detectorName: DETECTOR_NAME,
  detectorVersion: DETECTOR_VERSION,
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const code =
      typeof error?.code === "string" &&
      /^DEPENDENCY_SNAPSHOT_INVALID:[a-z0-9-]+$/u.test(error.code)
        ? error.code
        : "DEPENDENCY_SNAPSHOT_INVALID:unexpected-failure";
    console.error(`Dependency snapshot failed closed: ${code}`);
    process.exitCode = 1;
  });
}
