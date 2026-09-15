import { useCallback, useEffect, useRef, useState } from "react";
import type { RunEvalCheck, RunEvalView } from "@glassbox/contracts";
import type { ManagementApi } from "./api";
import { failureMessage } from "./errors";
import { PageControls, RecordTime } from "./RecordPrimitives";
import { useRecordPage } from "./useRecordPage";

const checkLabels: Record<RunEvalCheck, string> = {
  run_terminal: "执行已结束",
  trace_index: "Trace 索引",
  terminal_event: "终止事件",
  ack_delivery: "接收回执",
  result_delivery: "结果投递",
  result_delivery_event: "投递事件",
};
const verdictLabels = { pass: "通过", fail: "未通过", unknown: "无法判断" } as const;

export function EvaluationsPanel({ api, runId }: { api: ManagementApi; runId: string }) {
  const [checking, setChecking] = useState(false);
  const load = useCallback(
    (cursor: string | undefined, signal: AbortSignal) => api.evaluations(runId, { cursor }, signal),
    [api, runId],
  );
  const page = useRecordPage(load, { active: !checking });
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<RunEvalView | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (page.error) setLatest(null);
  }, [page.error]);

  async function evaluate() {
    if (request.current || checking) return;
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    setError("");
    setLatest(null);
    try {
      const evaluation = await api.evaluateRun(runId, controller.signal);
      if (!controller.signal.aborted) setLatest(evaluation);
    } catch (error) {
      if (!controller.signal.aborted) setError(failureMessage(error));
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) {
        setChecking(false);
        page.refresh();
      }
    }
  }
  return (
    <section className="mg-evidence-section" aria-labelledby="eval-title">
      <div className="mg-record-heading">
        <div>
          <h2 id="eval-title">执行证据检查</h2>
          <p className="mg-small mg-muted">run-integrity-v1</p>
        </div>
        <button
          className="mg-button"
          disabled={checking || page.loading}
          onClick={() => {
            void evaluate();
          }}
        >
          {checking ? "正在检查证据…" : "检查当前证据"}
        </button>
      </div>
      <p className="mg-notice mg-channel-boundary">
        检查已保存的 Run、Trace 和投递记录，不会调用模型或发送 QQ 消息。检查通过不代表真实 QQ 或
        Claude Code 验收通过。
      </p>
      {error ? (
        <p className="mg-notice mg-error" role="alert">
          {error}
        </p>
      ) : null}
      {latest ? (
        <div className="mg-latest-evaluation">
          <p className="mg-eyebrow">本次检查结果</p>
          <EvaluationRecord evaluation={latest} />
        </div>
      ) : null}
      <div className="mg-record-heading">
        <h3>已保存的检查</h3>
        <button
          className="mg-text-button"
          disabled={page.loading || checking}
          onClick={page.refresh}
        >
          {page.loading ? "读取中…" : "刷新记录"}
        </button>
      </div>
      {page.error ? (
        <p className="mg-notice mg-error" role="alert">
          {page.error}
        </p>
      ) : null}
      {!page.data && page.loading ? (
        <p className="mg-empty" role="status">
          正在读取检查记录…
        </p>
      ) : null}
      {page.data?.items.length === 0 ? (
        <p className="mg-empty">这一页没有已保存的证据检查。</p>
      ) : null}
      <div className="mg-eval-list">
        {page.data?.items
          .filter((evaluation) => evaluation.id !== latest?.id)
          .map((evaluation) => (
            <EvaluationRecord key={evaluation.id} evaluation={evaluation} />
          ))}
      </div>
      <PageControls
        page={page.page}
        loading={page.loading || checking}
        nextCursor={page.data?.nextCursor}
        previous={page.previous}
        next={page.next}
        first={page.first}
      />
    </section>
  );
}

function EvaluationRecord({ evaluation }: { evaluation: RunEvalView }) {
  const assessment = evaluation.assessment;
  return (
    <article className="mg-eval-record">
      <div className="mg-delivery-heading">
        <div>
          <strong>
            {assessment
              ? `完整性检查${verdictLabels[assessment.verdict]}`
              : evaluation.passed
                ? "历史检查记录为通过"
                : "历史检查记录为未通过"}
          </strong>
          <code className="mg-record-id">{evaluation.id}</code>
        </div>
        <RecordTime value={evaluation.createdAt} />
      </div>
      <p className="mg-small mg-muted">
        评分器 {evaluation.scorerVersion} · 输入 token {evaluation.inputTokens ?? "未提供"} · 输出
        token {evaluation.outputTokens ?? "未提供"} · 耗时{" "}
        {evaluation.durationMs === null ? "未提供" : `${evaluation.durationMs} ms`}
      </p>
      {assessment ? (
        <div className="mg-eval-scores">
          {assessment.scores.map((score) => (
            <details key={score.id} className="mg-record-disclosure">
              <summary>
                <span>{checkLabels[score.id]}</span>
                <span
                  className={`mg-record-status mg-record-status-${score.value === "pass" ? "good" : score.value === "fail" ? "bad" : "muted"}`}
                >
                  {verdictLabels[score.value]}
                </span>
              </summary>
              <dl className="mg-score-evidence">
                <div>
                  <dt>预期</dt>
                  <dd>{score.expected}</dd>
                </div>
                <div>
                  <dt>观察结果</dt>
                  <dd>{score.observed}</dd>
                </div>
                <div>
                  <dt>依据</dt>
                  <dd>{score.reason}</dd>
                </div>
                {score.traceSequence !== null ? (
                  <div>
                    <dt>Trace 序号</dt>
                    <dd>{score.traceSequence}</dd>
                  </div>
                ) : null}
              </dl>
            </details>
          ))}
        </div>
      ) : (
        <details className="mg-record-disclosure">
          <summary>查看历史检查记录</summary>
          <pre className="mg-result-text">{evaluation.observed}</pre>
        </details>
      )}
      <p className="mg-small mg-muted">
        Trace {evaluation.traceRef} · 事件范围 {evaluation.traceStart} 至 {evaluation.traceEnd}
        ，结束位置不含在内。
      </p>
    </article>
  );
}
