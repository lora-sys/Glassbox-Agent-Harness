import test from "node:test";
import assert from "node:assert/strict";
import {
  createGitHubDelivery,
  REQUIRED_CHECK_NAMES,
  REQUIRED_MERGED_CHECK_NAMES,
} from "../lib/github-delivery.mjs";

const head = "a".repeat(40);
const mergeCommit = "e".repeat(40);
const pullRequestUrl = "https://github.com/acme/product/pull/42";

function review(id, state, login, commitId, submittedAt) {
  return {
    id,
    state,
    user: { login },
    commit_id: commitId,
    submitted_at: submittedAt,
  };
}

function viewData(overrides = {}) {
  return {
    number: 42,
    url: pullRequestUrl,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    headRefOid: head,
    mergeCommit: null,
    author: { login: "author" },
    reviews: [
      review(1, "APPROVED", "author", head, "2026-10-05T10:00:00Z"),
      review(2, "APPROVED", "reviewer", "b".repeat(40), "2026-10-05T11:00:00Z"),
      review(3, "APPROVED", "reviewer", head, "2026-10-05T12:00:00Z"),
    ],
    statusCheckRollup: [
      ...REQUIRED_CHECK_NAMES.map((name) => ({
        __typename: "CheckRun",
        name,
        status: "COMPLETED",
        conclusion: "SUCCESS",
      })),
      {
        __typename: "StatusContext",
        context: "external/ignored",
        state: "SUCCESS",
      },
    ],
    ...overrides,
  };
}

function checkRuns(commit, names = REQUIRED_CHECK_NAMES) {
  return names.map((name, index) => ({
    id: 100 + index,
    name,
    head_sha: commit,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
    created_at: `2026-10-06T00:00:${String(index).padStart(2, "0")}Z`,
    started_at: `2026-10-06T00:00:${String(index).padStart(2, "0")}Z`,
  }));
}

function mockExec({
  remote = "git@github.com:acme/product.git",
  view = viewData(),
  mergeError,
  reviewOutput,
  checkRunPages,
  statusPages = [[]],
  apiErrorEndpoint,
} = {}) {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if (file === "git") return callback(null, { stdout: remote, stderr: "" });
    if (file === "gh" && args[0] === "pr" && args[1] === "view")
      return callback(null, { stdout: JSON.stringify(view), stderr: "" });
    if (file === "gh" && args[0] === "api") {
      const endpoint = args.at(-1);
      if (apiErrorEndpoint && endpoint.includes(apiErrorEndpoint))
        return callback(Object.assign(new Error("API unavailable"), { code: "ETIMEDOUT" }));
      if (endpoint.includes("/check-runs?")) {
        const sha = endpoint.split("/commits/")[1].split("/")[0];
        const pages =
          typeof checkRunPages === "function"
            ? checkRunPages(sha)
            : (checkRunPages ?? [{ check_runs: checkRuns(sha) }]);
        return callback(null, { stdout: JSON.stringify(pages), stderr: "" });
      }
      if (endpoint.includes("/statuses?"))
        return callback(null, {
          stdout: JSON.stringify(statusPages),
          stderr: "",
        });
      return callback(null, {
        stdout: reviewOutput ?? JSON.stringify([view.reviews]),
        stderr: "",
      });
    }
    if (file === "gh" && args[0] === "pr" && args[1] === "merge") {
      if (mergeError) return callback(mergeError, { stdout: "", stderr: "" });
      return callback(null, { stdout: "Squashed and merged", stderr: "" });
    }
    return callback(new Error("unexpected invocation"));
  };
  return { calls, execFileImpl };
}

test("readRemote resolves origin, fixed workflow checks, and independent approval on exact head", async () => {
  const { calls, execFileImpl } = mockExec();
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  const remote = await delivery.readRemote();
  assert.deepEqual(remote.repo, "acme/product");
  assert.deepEqual(remote.pr, { number: 42, url: pullRequestUrl });
  assert.equal(remote.headCommit, head);
  assert.equal(remote.review.status, "PASS");
  assert.equal(remote.review.reviewer, "reviewer");
  assert.equal(remote.review.commit, head);
  assert.match(remote.review.evidenceId, /^[a-f0-9]{64}$/);
  assert.equal(remote.pullRequestUrl, pullRequestUrl);
  assert.equal(remote.repoIdentity, "acme/product");
  assert.deepEqual(remote.requiredCheckNames, [...REQUIRED_CHECK_NAMES]);
  assert.deepEqual(
    remote.checks.map(({ name, commit, status }) => ({ name, commit, status })),
    REQUIRED_CHECK_NAMES.map((name) => ({
      name,
      commit: head,
      status: "SUCCESS",
    })),
  );
  assert.equal(calls[0].file, "git");
  assert.deepEqual(calls[0].args, ["remote", "get-url", "origin"]);
  assert.equal(calls[1].file, "gh");
  assert.equal(calls[1].options.shell, undefined);
  assert.equal(calls[1].args[0], "pr");
  assert.equal(calls[1].args[2], pullRequestUrl);
  assert.deepEqual(calls[2].args, [
    "api",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
    "repos/acme/product/pulls/42/reviews?per_page=100",
  ]);
  assert.deepEqual(calls[3].args.slice(0, 5), [
    "api",
    "--hostname",
    "github.com",
    "--paginate",
    "--slurp",
  ]);
  assert.equal(calls[3].args[5], `repos/acme/product/commits/${head}/check-runs?per_page=100`);
  assert.equal(calls[3].options.timeout, 60000);
  assert.equal(calls[3].options.maxBuffer, 4 * 1024 * 1024);
});

test("readRemote rejects a PR from another repository before calling gh", async () => {
  const { calls, execFileImpl } = mockExec({
    remote: "https://github.com/acme/other.git",
  });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  await assert.rejects(delivery.readRemote(), { code: "GITHUB_REPO_MISMATCH" });
  assert.equal(calls.length, 1);
});

test("unsupported origins and noncanonical PR URLs fail closed", async () => {
  const invalidUrls = [
    "https://github.enterprise.test/acme/product/pull/42",
    "https://github.com/acme/product/issues/42",
    "https://github.com/acme/product/pull/42?tab=files",
  ];
  for (const url of invalidUrls)
    assert.throws(() => createGitHubDelivery({ pullRequestUrl: url, cwd: "/repo" }));

  const { execFileImpl } = mockExec({
    remote: "https://git.example.test/acme/product.git",
  });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  await assert.rejects(delivery.readRemote(), { code: "GITHUB_REPO" });

  const { calls: foreignCalls, execFileImpl: foreignExec } = mockExec();
  const foreign = createGitHubDelivery({
    pullRequestUrl: "https://github.com/acme/other/pull/42",
    cwd: "/repo",
    execFileImpl: foreignExec,
  });
  await assert.rejects(foreign.readRemote(), { code: "GITHUB_REPO_MISMATCH" });
  assert.equal(foreignCalls.length, 1);
});

test("self approval and approval from an older commit are not independent review evidence", async () => {
  const onlyInvalid = viewData({
    reviews: [
      review(1, "APPROVED", "author", head, "2026-10-05T10:00:00Z"),
      review(2, "APPROVED", "reviewer", "c".repeat(40), "2026-10-05T11:00:00Z"),
    ],
  });
  const { execFileImpl } = mockExec({ view: onlyInvalid });
  const remote = await createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  }).readRemote();
  assert.deepEqual(remote.review, {
    status: "MISSING",
    commit: null,
    reviewer: null,
    submittedAt: null,
  });
});

test("a current-head changes-requested review supersedes that reviewer's earlier approval", async () => {
  const changed = viewData({
    reviews: [
      review(1, "APPROVED", "reviewer", head, "2026-10-05T12:00:00Z"),
      review(2, "CHANGES_REQUESTED", "reviewer", head, "2026-10-05T13:00:00Z"),
    ],
  });
  const { execFileImpl } = mockExec({ view: changed });
  const remote = await createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  }).readRemote();
  assert.equal(remote.review.status, "CHANGES_REQUESTED");
});

test("readRemote exposes an already merged PR as MERGED for one-shot recovery", async () => {
  const { execFileImpl } = mockExec({
    view: viewData({
      state: "CLOSED",
      mergedAt: "2026-10-06T01:00:00Z",
      mergeCommit: { oid: "e".repeat(40) },
    }),
  });
  const remote = await createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  }).readRemote();
  assert.equal(remote.state, "MERGED");
  assert.equal(remote.mergeCommit, "e".repeat(40));
});

test("incomplete paginated review data cannot produce an approval", async () => {
  const { execFileImpl } = mockExec({ reviewOutput: "{" });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  await assert.rejects(delivery.readRemote(), { code: "GITHUB_REVIEW_DATA" });
});

test("readMergedChecks binds complete workflow checks to the verified merge commit", async () => {
  const { calls, execFileImpl } = mockExec({
    view: viewData({
      state: "CLOSED",
      mergedAt: "2026-10-06T01:00:00Z",
      mergeCommit: { oid: mergeCommit },
    }),
  });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  const result = await delivery.readMergedChecks(mergeCommit);
  assert.equal(result.commit, mergeCommit);
  assert.deepEqual(result.requiredCheckNames, [...REQUIRED_MERGED_CHECK_NAMES]);
  assert.deepEqual(
    result.checks.map(({ name, commit, status }) => ({ name, commit, status })),
    REQUIRED_MERGED_CHECK_NAMES.map((name) => ({
      name,
      commit: mergeCommit,
      status: "SUCCESS",
    })),
  );
  assert.equal(result.checks.length, 5);
  assert.deepEqual(result.statusContexts, []);
  const callsForMerge = calls.filter(({ args }) =>
    args.at(-1)?.includes(`/commits/${mergeCommit}/`),
  );
  assert.equal(callsForMerge.length, 2);
  assert.ok(callsForMerge.some(({ args }) => args.at(-1).endsWith("/check-runs?per_page=100")));
  assert.ok(callsForMerge.some(({ args }) => args.at(-1).endsWith("/statuses?per_page=100")));
});

test("readMergedChecks refuses wrong SHA, stale run SHA, missing CI, and API pagination failures", async () => {
  const mergedView = viewData({
    state: "CLOSED",
    mergedAt: "2026-10-06T01:00:00Z",
    mergeCommit: { oid: mergeCommit },
  });
  const makeDelivery = (options = {}) =>
    createGitHubDelivery({
      pullRequestUrl,
      cwd: "/repo",
      ...mockExec({ view: mergedView, ...options }),
    });

  await assert.rejects(makeDelivery().readMergedChecks(head), {
    code: "GITHUB_MERGED_COMMIT",
  });

  const stalePages = (sha) =>
    sha === mergeCommit
      ? [
          {
            check_runs: checkRuns(mergeCommit).map((run, index) =>
              index === 0 ? { ...run, head_sha: head } : run,
            ),
          },
        ]
      : [{ check_runs: checkRuns(sha) }];
  await assert.rejects(makeDelivery({ checkRunPages: stalePages }).readMergedChecks(mergeCommit), {
    code: "GITHUB_CHECKS",
  });

  await assert.rejects(
    makeDelivery({
      checkRunPages: (sha) =>
        sha === mergeCommit
          ? [{ check_runs: checkRuns(mergeCommit).slice(1) }]
          : [{ check_runs: checkRuns(sha) }],
    }).readMergedChecks(mergeCommit),
    { code: "GITHUB_CHECKS" },
  );

  await assert.rejects(
    makeDelivery({ apiErrorEndpoint: "/statuses?" }).readMergedChecks(mergeCommit),
    { code: "ETIMEDOUT" },
  );
});

test("commit statuses cannot substitute for GitHub Actions job checks", async () => {
  const mergedView = viewData({
    state: "CLOSED",
    mergedAt: "2026-10-06T01:00:00Z",
    mergeCommit: { oid: mergeCommit },
  });
  const { execFileImpl } = mockExec({
    view: mergedView,
    checkRunPages: [{ check_runs: [] }],
    statusPages: [
      REQUIRED_MERGED_CHECK_NAMES.map((context) => ({
        context,
        state: "success",
      })),
    ],
  });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  await assert.rejects(delivery.readMergedChecks(mergeCommit), {
    code: "GITHUB_CHECKS",
  });
});

test("a rerun selects the latest GitHub Actions check run by start time", async () => {
  const mergedView = viewData({
    state: "CLOSED",
    mergedAt: "2026-10-06T01:00:00Z",
    mergeCommit: { oid: mergeCommit },
  });
  const latestChecks = checkRuns(mergeCommit, REQUIRED_MERGED_CHECK_NAMES);
  const first = latestChecks[0];
  const staleRun = {
    ...first,
    id: first.id + 1000,
    conclusion: "failure",
    started_at: "2026-10-05T23:59:00Z",
  };
  const latestRun = {
    ...first,
    id: first.id + 1001,
    started_at: "2026-10-06T00:01:00Z",
  };
  const { execFileImpl } = mockExec({
    view: mergedView,
    checkRunPages: (sha) =>
      sha === mergeCommit
        ? [{ check_runs: [staleRun, latestRun, ...latestChecks.slice(1)] }]
        : [{ check_runs: checkRuns(sha) }],
  });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  const result = await delivery.readMergedChecks(mergeCommit);
  assert.equal(result.checks[0].status, "SUCCESS");
  assert.equal(result.checks[0].checkRunId, latestRun.id);
});

test("a current-head changes request by any reviewer blocks another approval", async () => {
  const changed = viewData({
    reviews: [
      review(1, "APPROVED", "reviewer", head, "2026-10-05T12:00:00Z"),
      review(2, "CHANGES_REQUESTED", "reviewer-two", head, "2026-10-05T13:00:00Z"),
    ],
  });
  const { calls, execFileImpl } = mockExec({ view: changed });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  assert.equal((await delivery.readRemote()).review.status, "CHANGES_REQUESTED");
  assert.deepEqual(await delivery.mergeExactHead(head), {
    status: "REJECTED",
    commit: head,
    code: "REMOTE_GATE",
  });
  assert.equal(
    calls.some(({ file, args }) => file === "gh" && args[1] === "merge"),
    false,
  );
});

test("duplicate or missing workflow checks cannot produce a successful required check", async () => {
  const { execFileImpl } = mockExec({
    checkRunPages: (sha) => {
      const runs = checkRuns(sha);
      return [
        {
          check_runs: [
            ...runs,
            {
              ...runs[0],
              id: runs[0].id + 1000,
              status: "completed",
              conclusion: "failure",
              started_at: "2026-10-06T01:00:00Z",
            },
          ],
        },
      ];
    },
  });
  const remote = await createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  }).readRemote();
  assert.equal(remote.checks[0].status, "FAILURE");
});

test("mergeExactHead uses one exact-head argv invocation and never retries an unknown result", async () => {
  const { calls, execFileImpl } = mockExec({
    mergeError: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
  });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  assert.deepEqual(await delivery.mergeExactHead(head), {
    status: "UNKNOWN",
    commit: head,
    code: "GITHUB_MERGE_RESULT_UNKNOWN",
  });
  const merges = calls.filter(({ file, args }) => file === "gh" && args[1] === "merge");
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].args, [
    "pr",
    "merge",
    pullRequestUrl,
    "--squash",
    "--match-head-commit",
    head,
  ]);
  assert.equal(merges[0].options.shell, undefined);
});

test("mergeExactHead refuses a changed remote head without invoking merge", async () => {
  const { calls, execFileImpl } = mockExec({
    view: viewData({ headRefOid: "b".repeat(40) }),
  });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  const result = await delivery.mergeExactHead(head);
  assert.deepEqual(result, {
    status: "REJECTED",
    commit: head,
    currentHead: "b".repeat(40),
  });
  assert.equal(
    calls.some(({ file, args }) => file === "gh" && args[1] === "merge"),
    false,
  );
});

test("mergeExactHead refuses a failed remote gate without invoking merge", async () => {
  const { calls, execFileImpl } = mockExec({
    checkRunPages: (sha) => {
      const runs = checkRuns(sha);
      return [
        {
          check_runs: runs.map((run, index) =>
            index === 0 ? { ...run, conclusion: "failure" } : run,
          ),
        },
      ];
    },
  });
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  assert.deepEqual(await delivery.mergeExactHead(head), {
    status: "REJECTED",
    commit: head,
    code: "REMOTE_GATE",
  });
  assert.equal(
    calls.some(({ file, args }) => file === "gh" && args[1] === "merge"),
    false,
  );
});

test("mergeExactHead returns a confirmed success after one command", async () => {
  const { calls, execFileImpl } = mockExec();
  const delivery = createGitHubDelivery({
    pullRequestUrl,
    cwd: "/repo",
    execFileImpl,
  });
  assert.deepEqual(await delivery.mergeExactHead(head), {
    status: "MERGED",
    commit: head,
  });
  assert.equal(calls.filter(({ file, args }) => file === "gh" && args[1] === "merge").length, 1);
});
