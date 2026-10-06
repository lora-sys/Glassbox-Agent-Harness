import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSnapshot,
  dependencySnapshotIdentity,
  dependencySnapshotLimits,
  runDependencySnapshot,
} from "../dependency-snapshot.mjs";

const repositoryLock = JSON.parse(
  readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
);
const validOptions = {
  sha: "0123456789abcdef0123456789abcdef01234567",
  ref: "refs/heads/main",
  jobId: "test-1-base",
  scanned: "2026-10-06T00:00:00.000Z",
  detectorUrl: "https://github.com/glassbox/Glassbox-Agent-Harness/actions/runs/1",
};
const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function syntheticLock() {
  return {
    name: "snapshot-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "snapshot-fixture",
        version: "1.0.0",
        dependencies: {
          real: "1.0.0",
          alias: "npm:@scope/real@1.0.0",
        },
        devDependencies: { tool: "1.0.0" },
      },
      "node_modules/real": {
        name: "real",
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/real/-/real-1.0.0.tgz",
        integrity,
        dependencies: { leaf: "1.0.0" },
      },
      "node_modules/real/node_modules/leaf": {
        name: "leaf",
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/leaf/-/leaf-1.0.0.tgz",
        integrity,
      },
      "node_modules/alias": {
        name: "@scope/real",
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/@scope/real/-/real-1.0.0.tgz",
        integrity,
      },
      "node_modules/tool": {
        name: "tool",
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/tool/-/tool-1.0.0.tgz",
        integrity,
      },
    },
  };
}

function eventFixture(overrides = {}) {
  const repository = { full_name: "glassbox/Glassbox-Agent-Harness" };
  return {
    repository,
    pull_request: {
      number: 41,
      state: "open",
      base: {
        sha: "1111111111111111111111111111111111111111",
        ref: "main",
        repo: repository,
      },
      head: {
        sha: "2222222222222222222222222222222222222222",
        ref: "feature/deps",
        repo: { full_name: "contributor/Glassbox-Agent-Harness" },
      },
    },
    ...overrides,
  };
}

function contentResponse(lock) {
  const bytes = Buffer.from(JSON.stringify(lock));
  return {
    type: "file",
    name: "package-lock.json",
    path: "package-lock.json",
    encoding: "base64",
    size: bytes.length,
    content: bytes.toString("base64"),
  };
}

function currentPull(event = eventFixture()) {
  return {
    state: "open",
    base: {
      sha: event.pull_request.base.sha,
      ref: event.pull_request.base.ref,
      repo: { full_name: "glassbox/Glassbox-Agent-Harness" },
    },
    head: {
      sha: event.pull_request.head.sha,
      ref: event.pull_request.head.ref,
      repo: { full_name: "contributor/Glassbox-Agent-Harness" },
    },
  };
}

function fakeFetch({
  lockAtSha = () => syntheticLock(),
  pullAt = () => currentPull(),
  beforeReply,
} = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, init });
    if (beforeReply) {
      const override = await beforeReply(parsed, init, requests.length);
      if (override) return override;
    }
    if (parsed.origin !== "https://api.github.com") throw new Error("unexpected host");
    if (parsed.pathname.endsWith("/dependency-graph/snapshots"))
      return Response.json(
        {
          id: 106700000 + requests.length,
          result: requests.length % 2 ? "SUCCESS" : "ACCEPTED",
        },
        { status: 201 },
      );
    if (parsed.pathname.includes("/pulls/"))
      return Response.json(pullAt(requests.length), { status: 200 });
    if (parsed.pathname.endsWith("/contents/package-lock.json")) {
      const sha = parsed.searchParams.get("ref");
      return Response.json(contentResponse(lockAtSha(sha)), { status: 200 });
    }
    throw new Error("unexpected API path");
  };
  return { fetchImpl, requests };
}

function runPullRequest(overrides = {}) {
  const event = overrides.event ?? eventFixture();
  const api = fakeFetch(overrides);
  return {
    event,
    api,
    run: () =>
      runDependencySnapshot({
        event,
        eventName: "pull_request_target",
        githubSha: event.pull_request.head.sha,
        githubRef: "refs/heads/main",
        runId: "9001",
        runAttempt: "1",
        token: "never-print-token",
        repository: "glassbox/Glassbox-Agent-Harness",
        fetchImpl: api.fetchImpl,
      }),
  };
}

test("repository lock snapshot covers every registry install location and complete edges", () => {
  const snapshot = buildSnapshot(repositoryLock, validOptions);
  const resolved = snapshot.manifests["package-lock.json"].resolved;
  const expectedRegistryLocations = Object.entries(repositoryLock.packages).filter(
    ([location, entry]) => location && !entry.link && entry.resolved?.startsWith("https://"),
  ).length;
  assert.equal(snapshot.diagnostics.registryLocationCount, expectedRegistryLocations);
  assert.ok(snapshot.diagnostics.resolvedPackageCount > 0);
  assert.ok(snapshot.diagnostics.dependencyEdgeCount > 0);
  assert.ok(snapshot.diagnostics.workspacePackageCount >= 4);
  assert.ok(snapshot.diagnostics.missingOptionalDependencyCount > 0);
  assert.equal(JSON.parse(JSON.stringify(snapshot)).diagnostics, undefined);
  for (const [location, entry] of Object.entries(repositoryLock.packages)) {
    if (!location || entry.link || !entry.resolved?.startsWith("https://")) continue;
    const matching = Object.entries(snapshot.diagnostics.locationsByPackageUrl).filter(
      ([, locations]) => locations.includes(location),
    );
    assert.equal(
      matching.length,
      1,
      `registry install location missing or duplicated: ${location}`,
    );
    assert.ok(resolved[matching[0][0]]);
  }
  for (const dependency of Object.values(resolved)) {
    for (const child of dependency.dependencies)
      assert.ok(resolved[child], `missing edge target ${child}`);
    assert.ok(["direct", "indirect"].includes(dependency.relationship));
    assert.ok(["runtime", "development"].includes(dependency.scope));
  }
});

test("npm alias records canonical package identity and install alias", () => {
  const snapshot = buildSnapshot(repositoryLock, validOptions);
  const resolved = snapshot.manifests["package-lock.json"].resolved;
  const vite = repositoryLock.packages["node_modules/vite"];
  const encodedName = encodeURIComponent(vite.name).replace(/%2F/giu, "/");
  const target = `pkg:npm/${encodedName}@${encodeURIComponent(vite.version)}`;
  assert.ok(resolved[target]);
  assert.equal(resolved[`pkg:npm/vite@${encodeURIComponent(vite.version)}`], undefined);
  assert.equal(resolved[target].metadata.install_aliases, "vite");
  assert.equal(resolved[target].metadata.source_type, "registry");
});

test("invalid alias identity, unknown source, and missing required edge fail closed", () => {
  const alias = syntheticLock();
  alias.packages[""].dependencies.real = "npm:@scope/other@1.0.0";
  assert.throws(() => buildSnapshot(alias, validOptions), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:alias-name-mismatch",
  });

  const unboundAlias = syntheticLock();
  unboundAlias.packages[""].dependencies.alias = "1.0.0";
  assert.throws(() => buildSnapshot(unboundAlias, validOptions), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:alias-identity-mismatch",
  });

  const source = syntheticLock();
  source.packages["node_modules/real"].resolved = "git+https://example.com/real.git";
  assert.throws(() => buildSnapshot(source, validOptions), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:unsupported-source",
  });

  for (const resolved of [
    "https://registry.npmjs.org:444/real/-/real-1.0.0.tgz",
    "https://user:secret@registry.npmjs.org/real/-/real-1.0.0.tgz",
  ]) {
    const altered = syntheticLock();
    altered.packages["node_modules/real"].resolved = resolved;
    assert.throws(() => buildSnapshot(altered, validOptions), {
      code: "DEPENDENCY_SNAPSHOT_INVALID:unsupported-source",
    });
  }

  const missing = syntheticLock();
  missing.packages["node_modules/real"].dependencies.missing = "1.0.0";
  assert.throws(() => buildSnapshot(missing, validOptions), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:unresolved-required-dependency",
  });
});

test("required integrity, lock schema, and API response size are bounded", async () => {
  assert.equal(dependencySnapshotLimits.maxLockBytes, 1024 * 1024);
  assert.equal(dependencySnapshotLimits.maxApiBytes, 5 * 1024 * 1024);
  assert.equal(dependencySnapshotLimits.maxPackages, 50_000);
  assert.equal(dependencySnapshotLimits.apiTimeoutMs, 20_000);
  const noIntegrity = syntheticLock();
  delete noIntegrity.packages["node_modules/real"].integrity;
  assert.throws(() => buildSnapshot(noIntegrity, validOptions), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:missing-integrity",
  });
  assert.throws(() => buildSnapshot({ ...syntheticLock(), lockfileVersion: 2 }, validOptions), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:expected-lockfile-v3",
  });

  const { run, api } = runPullRequest({
    beforeReply: async (url) => {
      if (url.pathname.includes("/pulls/"))
        return new Response(Buffer.alloc(dependencySnapshotLimits.maxApiBytes + 1), {
          status: 200,
        });
      return undefined;
    },
  });
  await assert.rejects(run(), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:api-response-too-large",
  });
  assert.equal(
    api.requests.some(({ init }) => init.method === "POST"),
    false,
  );

  const oversizedLock = runPullRequest({
    beforeReply: async (url) => {
      if (!url.pathname.endsWith("/contents/package-lock.json")) return undefined;
      return Response.json(
        {
          ...contentResponse(syntheticLock()),
          size: dependencySnapshotLimits.maxLockBytes + 1,
        },
        { status: 200 },
      );
    },
  });
  await assert.rejects(oversizedLock.run(), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:invalid-lock-content-response",
  });
  assert.equal(
    oversizedLock.api.requests.some(({ init }) => init.method === "POST"),
    false,
  );
});

test("both exact PR locks validate before any submission and unexpected redirects fail closed", async () => {
  const event = eventFixture();
  const invalidHead = syntheticLock();
  invalidHead.packages["node_modules/real"].resolved = "file:../real.tgz";
  const invalid = runPullRequest({
    event,
    lockAtSha: (sha) => (sha === event.pull_request.head.sha ? invalidHead : syntheticLock()),
  });
  await assert.rejects(invalid.run(), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:unsupported-source",
  });
  assert.equal(
    invalid.api.requests.some(({ init }) => init.method === "POST"),
    false,
  );

  const redirect = runPullRequest({
    event,
    beforeReply: async (url) => {
      if (!url.pathname.includes("/pulls/")) return undefined;
      const response = Response.json(currentPull(event), { status: 200 });
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: "https://attacker.example/collect" },
      });
      return response;
    },
  });
  await assert.rejects(redirect.run(), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:github-api-redirect-rejected",
  });
  assert.ok(redirect.api.requests.every(({ url }) => url.origin === "https://api.github.com"));
  assert.equal(
    redirect.api.requests.some(({ init }) => init.method === "POST"),
    false,
  );
});

test("a changed PR base or head between fetch and submit prevents submission", async () => {
  const event = eventFixture();
  const changed = runPullRequest({
    event,
    pullAt: (requestNumber) => {
      const pull = currentPull(event);
      if (requestNumber > 1) pull.head.sha = "3333333333333333333333333333333333333333";
      return pull;
    },
  });
  await assert.rejects(changed.run(), {
    code: "DEPENDENCY_SNAPSHOT_INVALID:pull-request-binding-changed",
  });
  assert.equal(
    changed.api.requests.some(({ init }) => init.method === "POST"),
    false,
  );
});

test("PR snapshot submissions use stable refs and authenticated calls stay on api.github.com", async () => {
  const { run, api } = runPullRequest();
  const result = await run();
  assert.equal(result.acceptedCount, 2);
  const posts = api.requests.filter(({ init }) => init.method === "POST");
  assert.equal(posts.length, 2);
  assert.ok(posts.every(({ url }) => url.origin === "https://api.github.com"));
  assert.ok(
    posts.every(({ init }) => init.redirect === "error" && init.signal instanceof AbortSignal),
  );
  assert.ok(posts.every(({ init }) => init.headers.authorization === "Bearer never-print-token"));
  const submitted = posts.map(({ init }) => JSON.parse(init.body));
  assert.deepEqual(
    submitted.map((snapshot) => snapshot.ref),
    ["refs/heads/main", "refs/pull/41/head"],
  );
  assert.ok(
    submitted.every(
      (snapshot) => snapshot.job.correlator === dependencySnapshotIdentity.correlator,
    ),
  );
  assert.ok(
    submitted.every(
      (snapshot) => snapshot.detector.name === dependencySnapshotIdentity.detectorName,
    ),
  );
});

test("main push submits the current main lock and unsafe fork metadata is rejected before API access", async () => {
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pushEvent = {
    ref: "refs/heads/main",
    after: sha,
    repository: { full_name: "glassbox/Glassbox-Agent-Harness" },
  };
  const pushApi = fakeFetch();
  const pushed = await runDependencySnapshot({
    event: pushEvent,
    eventName: "push",
    githubSha: sha,
    githubRef: "refs/heads/main",
    runId: "9002",
    runAttempt: "1",
    token: "token",
    repository: "glassbox/Glassbox-Agent-Harness",
    fetchImpl: pushApi.fetchImpl,
  });
  assert.equal(pushed.acceptedCount, 1);
  const post = pushApi.requests.find(({ init }) => init.method === "POST");
  assert.equal(JSON.parse(post.init.body).sha, sha);
  assert.equal(JSON.parse(post.init.body).ref, "refs/heads/main");

  const unsafe = eventFixture();
  unsafe.pull_request.head.repo = null;
  const unsafeApi = fakeFetch();
  await assert.rejects(
    runDependencySnapshot({
      event: unsafe,
      eventName: "pull_request_target",
      githubSha: unsafe.pull_request.head.sha,
      githubRef: "refs/heads/main",
      runId: "9003",
      runAttempt: "1",
      token: "token",
      repository: "glassbox/Glassbox-Agent-Harness",
      fetchImpl: unsafeApi.fetchImpl,
    }),
    { code: "DEPENDENCY_SNAPSHOT_INVALID:unsafe-head-repository" },
  );
  assert.equal(unsafeApi.requests.length, 0);
});

test("workflow checks out trusted base scripts only and dependency review retries snapshots", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/dependency-snapshot.yml", import.meta.url),
    "utf8",
  );
  const hygiene = readFileSync(
    new URL("../../.github/workflows/hygiene-ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /pull_request_target:[\s\S]*opened[\s\S]*synchronize[\s\S]*reopened[\s\S]*ready_for_review/u,
  );
  assert.match(
    workflow,
    /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/u,
  );
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /sparse-checkout: scripts\/dependency-snapshot\.mjs/u);
  assert.doesNotMatch(workflow, /npm ci|npm install|pull_request\.head\.sha/u);
  assert.match(
    workflow,
    /submit-snapshots:[\s\S]*permissions:\n      contents: write\n      pull-requests: read/u,
  );
  assert.match(
    workflow,
    /- name: Check out trusted base workflow code only\n        uses: actions\/checkout@v7/u,
  );
  assert.match(hygiene, /retry-on-snapshot-warnings: true/u);
  assert.match(hygiene, /timeout: 180/u);
  assert.match(
    hygiene,
    /- name: Review dependency changes\n        uses: actions\/dependency-review-action@v5\n        with:\n          fail-on-severity: high/u,
  );
});
