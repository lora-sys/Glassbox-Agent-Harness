import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { digest, fail } from "./core.mjs";

const REQUIRED_CHECK_NAMES = Object.freeze([
  "Code and test hygiene (ubuntu-latest)",
  "Browser and live management protocol",
  "Dependency hygiene",
  "Secret hygiene",
  "Pull request dependency review",
  "Pull request title hygiene",
  "Text encoding and line-ending portability",
]);
const REQUIRED_MERGED_CHECK_NAMES = Object.freeze(
  REQUIRED_CHECK_NAMES.filter(
    (name) => name !== "Pull request dependency review" && name !== "Pull request title hygiene",
  ),
);
const VIEW_FIELDS = [
  "number",
  "url",
  "state",
  "mergedAt",
  "isDraft",
  "mergeable",
  "headRefOid",
  "baseRefOid",
  "author",
  "mergeCommit",
  "statusCheckRollup",
].join(",");

function repoFromRemote(remote) {
  const value = remote.trim();
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      value,
    );
  if (!match) fail("GITHUB_REPO", "origin 必须是 github.com 上的 owner/repo 仓库。");
  return `${match[1]}/${match[2]}`;
}

function repoFromPullRequestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("GITHUB_PR_URL", "Pull request URL 无效。");
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match
  )
    fail("GITHUB_PR_URL", "Pull request URL 必须是 github.com 的标准 PR 地址。");
  if (!Number.isSafeInteger(Number(match[3])))
    fail("GITHUB_PR_URL", "Pull request 编号超出有效范围。");
  return {
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
}

function reviewCommit(review) {
  if (typeof review?.commit_id === "string") return review.commit_id;
  if (typeof review?.commit === "string") return review.commit;
  return review?.commit?.oid;
}

function selectIndependentReview(reviews, headCommit, authorLogin) {
  const latestByReviewer = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const login = review?.user?.login ?? review?.author?.login;
    const submittedAt = review?.submitted_at ?? review?.submittedAt;
    if (
      reviewCommit(review) !== headCommit ||
      typeof login !== "string" ||
      !["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state) ||
      typeof submittedAt !== "string" ||
      !Number.isFinite(Date.parse(submittedAt))
    )
      continue;
    const previous = latestByReviewer.get(login.toLowerCase());
    if (
      !previous ||
      submittedAt > previous.submitted_at ||
      (submittedAt === previous.submitted_at && Number(review.id ?? 0) > Number(previous.id ?? 0))
    )
      latestByReviewer.set(login.toLowerCase(), {
        ...review,
        id: review.id ?? null,
        user: { login },
        submitted_at: submittedAt,
      });
  }
  const latest = [...latestByReviewer.values()];
  const active = latest.filter((review) => review.state !== "DISMISSED");
  const changesRequested = active.filter((review) => review.state === "CHANGES_REQUESTED");
  if (changesRequested.length)
    return {
      status: "CHANGES_REQUESTED",
      commit: headCommit,
      reviewer: null,
      submittedAt: null,
      evidenceId: digest(
        JSON.stringify(
          changesRequested.map((review) => ({
            id: review.id,
            commit: headCommit,
            reviewer: review.user.login,
            submittedAt: review.submitted_at,
            state: review.state,
          })),
        ),
      ),
    };
  const eligible = active
    .filter((review) => review.user.login.toLowerCase() !== authorLogin.toLowerCase())
    .filter((review) => review.state === "APPROVED")
    .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  const selected = eligible[0];
  return selected
    ? {
        status: "PASS",
        commit: headCommit,
        reviewer: selected.user.login,
        submittedAt: selected.submitted_at,
        evidenceId: digest(
          JSON.stringify({
            id: selected.id,
            commit: headCommit,
            reviewer: selected.user.login,
            submittedAt: selected.submitted_at,
            state: selected.state,
          }),
        ),
      }
    : { status: "MISSING", commit: null, reviewer: null, submittedAt: null };
}

function parsePages(stdout, label, isPage) {
  let pages;
  try {
    pages = JSON.parse(stdout);
  } catch {
    fail("GITHUB_CHECKS", `${label} 分页响应无效。`);
  }
  if (!Array.isArray(pages) || pages.some((page) => !isPage(page)) || pages.length > 10000)
    fail("GITHUB_CHECKS", `${label} 分页不完整。`);
  return pages;
}

function normalizeWorkflowChecks(checkRunPages, commit, requiredNames) {
  const matches = new Map(requiredNames.map((name) => [name, []]));
  for (const run of checkRunPages.flatMap((page) => page.check_runs)) {
    if (!matches.has(run.name)) continue;
    if (run.head_sha !== commit) fail("GITHUB_CHECKS", "Check run 不属于目标 commit。");
    if (run.app?.slug !== "github-actions") continue;
    const startedAt = run.started_at ?? run.created_at;
    if (
      !Number.isSafeInteger(run.id) ||
      typeof startedAt !== "string" ||
      !Number.isFinite(Date.parse(startedAt))
    )
      fail("GITHUB_CHECKS", "GitHub Actions check run 缺少可排序的创建证据。");
    matches.get(run.name).push({
      name: run.name,
      commit,
      checkRunId: run.id,
      startedAt,
      status:
        run.status === "completed" && run.conclusion === "success"
          ? "SUCCESS"
          : (run.conclusion?.toUpperCase() ?? run.status?.toUpperCase() ?? "UNKNOWN"),
    });
  }
  return requiredNames.map((name) => {
    const candidates = matches.get(name);
    if (!candidates.length) fail("GITHUB_CHECKS", `缺少 GitHub Actions 检查 ${name}。`);
    candidates.sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.checkRunId - a.checkRunId,
    );
    return candidates[0];
  });
}

/** Create a fixed-argv GitHub delivery adapter for one reviewed pull request. */
export function createGitHubDelivery({ pullRequestUrl, cwd, execFileImpl = execFile } = {}) {
  if (typeof cwd !== "string" || !cwd) fail("GITHUB_CWD", "必须提供仓库工作目录。");
  const pr = repoFromPullRequestUrl(pullRequestUrl);
  const run = promisify(execFileImpl);

  async function readCheckRunPages(repo, commit) {
    const { stdout } = await run(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--paginate",
        "--slurp",
        `repos/${repo}/commits/${commit}/check-runs?per_page=100`,
      ],
      { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 60000 },
    );
    const pages = parsePages(
      stdout,
      "Check run",
      (page) =>
        page !== null &&
        typeof page === "object" &&
        Array.isArray(page.check_runs) &&
        page.check_runs.every(
          (entry) =>
            typeof entry?.name === "string" &&
            typeof entry?.head_sha === "string" &&
            typeof entry?.status === "string",
        ),
    );
    if (pages.reduce((count, page) => count + page.check_runs.length, 0) > 10000)
      fail("GITHUB_CHECKS", "check run 数量超出安全读取上限。");
    return pages;
  }

  async function readStatusPages(repo, commit) {
    const { stdout } = await run(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--paginate",
        "--slurp",
        `repos/${repo}/commits/${commit}/statuses?per_page=100`,
      ],
      { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 60000 },
    );
    const pages = parsePages(
      stdout,
      "Commit status",
      (page) =>
        Array.isArray(page) &&
        page.every(
          (entry) => typeof entry?.context === "string" && typeof entry?.state === "string",
        ),
    );
    if (pages.reduce((count, page) => count + page.length, 0) > 10000)
      fail("GITHUB_CHECKS", "commit status 数量超出安全读取上限。");
    return pages;
  }

  async function inspect() {
    const { stdout: remoteOutput } = await run("git", ["remote", "get-url", "origin"], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    const repo = repoFromRemote(remoteOutput);
    if (repo.toLowerCase() !== pr.repo.toLowerCase())
      fail("GITHUB_REPO_MISMATCH", "Pull request 与 origin 仓库不一致。");
    const { stdout } = await run("gh", ["pr", "view", pr.url, "--json", VIEW_FIELDS], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60000,
    });
    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      fail("GITHUB_PR_DATA", "gh 未返回有效的 pull request 数据。");
    }
    const headCommit = data?.headRefOid;
    const baseCommit = data?.baseRefOid;
    if (!/^[a-f0-9]{40}$/i.test(headCommit ?? "") || !/^[a-f0-9]{40}$/i.test(baseCommit ?? ""))
      fail("GITHUB_PR_DATA", "Pull request 缺少有效的 base 或 head commit。");
    if (data.number !== pr.number || data.url?.replace(/\/$/, "") !== pr.url)
      fail("GITHUB_PR_DATA", "gh 返回的 pull request 与请求地址不一致。");
    const authorLogin = data.author?.login;
    if (typeof authorLogin !== "string" || !authorLogin)
      fail("GITHUB_PR_DATA", "Pull request 缺少作者身份。");
    const { stdout: reviewOutput } = await run(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        "--paginate",
        "--slurp",
        `repos/${repo}/pulls/${pr.number}/reviews?per_page=100`,
      ],
      { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 60000 },
    );
    let reviewPages;
    try {
      reviewPages = JSON.parse(reviewOutput);
    } catch {
      fail("GITHUB_REVIEW_DATA", "gh 未返回完整的分页 review 数据。");
    }
    if (
      !Array.isArray(reviewPages) ||
      reviewPages.some((page) => !Array.isArray(page)) ||
      reviewPages.reduce((count, page) => count + page.length, 0) > 10000
    )
      fail("GITHUB_REVIEW_DATA", "review 分页不完整或超出安全读取上限。");
    const reviews = reviewPages.flat();
    if (
      reviews.some(
        (review) =>
          !Number.isSafeInteger(review?.id) ||
          !["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(
            review?.state,
          ) ||
          typeof review?.commit_id !== "string" ||
          typeof review?.user?.login !== "string" ||
          (review?.submitted_at === null
            ? review.state !== "PENDING"
            : typeof review?.submitted_at !== "string" ||
              !Number.isFinite(Date.parse(review.submitted_at))),
      )
    )
      fail("GITHUB_REVIEW_DATA", "review 数据缺少判断当前 head 所需字段。");
    const mergeCommit = data.mergeCommit?.oid ?? null;
    if (mergeCommit !== null && !/^[a-f0-9]{40}$/i.test(mergeCommit))
      fail("GITHUB_PR_DATA", "Pull request 的 merge commit 无效。");
    if (data.state === "CLOSED" && data.mergedAt && mergeCommit === null)
      fail("GITHUB_PR_DATA", "已合并的 pull request 缺少 merge commit。");
    const checks = normalizeWorkflowChecks(
      await readCheckRunPages(repo, headCommit),
      headCommit,
      REQUIRED_CHECK_NAMES,
    );
    return {
      repo,
      repoIdentity: repo,
      authorLogin,
      baseCommit,
      pullRequestUrl: pr.url,
      pr: { number: pr.number, url: pr.url },
      headCommit,
      state: data.state === "CLOSED" && data.mergedAt ? "MERGED" : data.state,
      mergeCommit,
      draft: data.isDraft,
      mergeable: data.mergeable === "MERGEABLE",
      checks,
      requiredCheckNames: REQUIRED_CHECK_NAMES,
      review: selectIndependentReview(reviews, headCommit, authorLogin),
    };
  }

  return {
    pullRequestUrl: pr.url,
    repoIdentity: pr.repo,
    requiredCheckNames: REQUIRED_CHECK_NAMES,
    async readRemote() {
      return inspect();
    },
    async readMergedChecks(mergeCommit) {
      if (!/^[a-f0-9]{40}$/i.test(mergeCommit ?? ""))
        fail("GITHUB_MERGED_COMMIT", "合并后的检查必须绑定完整 merge commit SHA。");
      const current = await inspect();
      if (current.state !== "MERGED" || current.mergeCommit !== mergeCommit)
        fail("GITHUB_MERGED_COMMIT", "PR 尚未合并到指定的 merge commit。");
      const checkRunPages = await readCheckRunPages(current.repo, mergeCommit);
      const statusPages = await readStatusPages(current.repo, mergeCommit);
      const checks = normalizeWorkflowChecks(
        checkRunPages,
        mergeCommit,
        REQUIRED_MERGED_CHECK_NAMES,
      );
      return {
        commit: mergeCommit,
        checks,
        statusContexts: statusPages.flat().map((status) => ({
          context: status.context,
          state: status.state,
        })),
        requiredCheckNames: REQUIRED_MERGED_CHECK_NAMES,
      };
    },
    async mergeExactHead(commit) {
      if (!/^[a-f0-9]{40}$/i.test(commit ?? ""))
        fail("GITHUB_MERGE_COMMIT", "合并必须绑定完整 commit SHA。");
      let current;
      try {
        current = await inspect();
      } catch (error) {
        return {
          status: "UNKNOWN",
          commit,
          code: error?.code ?? "GITHUB_READ_FAILED",
        };
      }
      if (current.headCommit.toLowerCase() !== commit.toLowerCase())
        return { status: "REJECTED", commit, currentHead: current.headCommit };
      if (
        current.state !== "OPEN" ||
        current.draft !== false ||
        current.mergeable !== true ||
        current.review.status === "CHANGES_REQUESTED" ||
        REQUIRED_CHECK_NAMES.some(
          (name) =>
            current.checks.filter((check) => check.name === name).length !== 1 ||
            current.checks.find((check) => check.name === name)?.status !== "SUCCESS",
        )
      )
        return { status: "REJECTED", commit, code: "REMOTE_GATE" };
      try {
        await run("gh", ["pr", "merge", pr.url, "--squash", "--match-head-commit", commit], {
          cwd,
          maxBuffer: 4 * 1024 * 1024,
          timeout: 120000,
        });
        return { status: "MERGED", commit };
      } catch {
        return {
          status: "UNKNOWN",
          commit,
          code: "GITHUB_MERGE_RESULT_UNKNOWN",
        };
      }
    },
  };
}

export { REQUIRED_CHECK_NAMES, REQUIRED_MERGED_CHECK_NAMES };
