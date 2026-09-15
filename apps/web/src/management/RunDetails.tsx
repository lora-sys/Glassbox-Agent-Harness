import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ManagementApi } from "./api";
import type { ManagedRun, ManagedRunListItem, ManagedTraceEntry } from "./records-schema";
import { failureMessage, ManagementApiError } from "./errors";
import { PageControls, RecordTime, RunStatus, ScopeLabel } from "./RecordPrimitives";
import { useRecordPage } from "./useRecordPage";
import { EvaluationsPanel } from "./EvaluationsPanel";

type DetailView = "result" | "deliveries" | "trace" | "eval";
const detailLabels: Record<DetailView, string> = {
  result: "执行输出",
  deliveries: "回复投递",
  trace: "Trace",
  eval: "证据检查",
};

export function RunDetails({
  api,
  selected,
  back,
}: {
  api: ManagementApi;
  selected: ManagedRunListItem;
  back: () => void;
}) {
  const [run, setRun] = useState<ManagedRun | null>(null);
  const [view, setView] = useState<DetailView>("result");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const action = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (action.current) return;
      const currentGeneration = generation.current;
      setLoading(true);
      try {
        const result = await api.run(selected.id, controller.signal);
        if (result.conversationId !== selected.conversationId)
          throw new ManagementApiError("INVALID_RESPONSE");
        if (controller.signal.aborted || currentGeneration !== generation.current) return;
        setRun(result);
        setError("");
        if (["queued", "running", "cancelling"].includes(result.status))
          timer = setTimeout(() => {
            void read();
          }, 3000);
      } catch (error) {
        if (!controller.signal.aborted && currentGeneration === generation.current) {
          setRun(null);
          setError(failureMessage(error));
        }
      } finally {
        if (!controller.signal.aborted && currentGeneration === generation.current)
          setLoading(false);
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, selected.id, selected.conversationId, revision]);
  useEffect(() => () => action.current?.abort(), []);

  async function cancel() {
    if (!run || action.current || !["queued", "running"].includes(run.status)) return;
    const controller = new AbortController();
    action.current = controller;
    generation.current += 1;
    setCancelling(true);
    setActionError("");
    try {
      const result = await api.cancelRun(run.id, controller.signal);
      if (!controller.signal.aborted) setRun(result);
    } catch (error) {
      if (!controller.signal.aborted) setActionError(failureMessage(error));
    } finally {
      generation.current += 1;
      if (action.current === controller) action.current = null;
      if (!controller.signal.aborted) {
        setCancelling(false);
        setRevision((value) => value + 1);
      }
    }
  }

  return (
    <section className="mg-run-detail" aria-labelledby="run-detail-title">
      <button className="mg-back-link" onClick={back}>
        返回执行列表
      </button>
      <div className="mg-section-heading">
        <div>
          <p className="mg-eyebrow">Run</p>
          <h1 id="run-detail-title" ref={title} tabIndex={-1}>
            执行详情
          </h1>
          <code className="mg-run-identifier">{selected.id}</code>
        </div>
        <div className="mg-actions">
          <button
            className="mg-button mg-secondary"
            disabled={loading || cancelling}
            onClick={() => setRevision((value) => value + 1)}
          >
            {loading ? "读取中…" : "刷新详情"}
          </button>
          <button
            className="mg-button mg-danger-button"
            disabled={!run || cancelling || !["queued", "running"].includes(run.status)}
            onClick={() => {
              void cancel();
            }}
          >
            {cancelling ? "正在请求取消…" : "取消执行"}
          </button>
        </div>
      </div>
      {error ? (
        <p className="mg-notice mg-error" role="alert">
          {error} 当前执行信息已停止显示。
        </p>
      ) : null}
      {actionError ? (
        <p className="mg-notice mg-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {!run && loading ? (
        <p className="mg-empty" role="status">
          正在读取执行详情…
        </p>
      ) : null}
      {run ? (
        <>
          <div className="mg-run-summary" aria-busy={loading}>
            <div className="mg-run-state">
              <RunStatus status={run.status} />
              <ScopeLabel scope={selected.scope} />
              <span className="mg-small mg-muted">{selected.scope.connectionId}</span>
            </div>
            <dl className="mg-run-facts">
              <div>
                <dt>执行方式</dt>
                <dd>{run.executionRef}</dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>
                  <RecordTime value={run.createdAt} />
                </dd>
              </div>
              <div>
                <dt>最近更新</dt>
                <dd>
                  <RecordTime value={run.updatedAt} />
                </dd>
              </div>
              <div>
                <dt>会话</dt>
                <dd>
                  <code>{run.conversationId}</code>
                </dd>
              </div>
            </dl>
          </div>
          {run.status === "cancelling" ? (
            <p className="mg-notice" role="status">
              已请求取消，正在等待执行器停止。收到最终状态前，不表示取消已完成。
            </p>
          ) : null}
          {run.status === "interrupted" || run.status === "unknown" ? (
            <p className="mg-notice">执行结果尚未确认。查看 Trace 与投递记录后再决定后续操作。</p>
          ) : null}
          <nav className="mg-detail-nav" aria-label="执行详情栏目">
            {(Object.keys(detailLabels) as DetailView[]).map((item) => (
              <button
                key={item}
                aria-current={view === item ? "page" : undefined}
                className={view === item ? "is-active" : ""}
                onClick={() => setView(item)}
              >
                {detailLabels[item]}
              </button>
            ))}
          </nav>
          {view === "result" ? (
            <section className="mg-evidence-section" aria-labelledby="run-output-title">
              <div className="mg-record-heading">
                <h2 id="run-output-title">执行输出</h2>
                <span className="mg-small mg-muted">由服务器授权后提供</span>
              </div>
              {run.resultText === null ? (
                <p className="mg-empty">
                  当前没有可显示的输出。执行尚未结束或服务器未提供输出内容。
                </p>
              ) : (
                <pre className="mg-result-text">{run.resultText || "执行器返回了空文本。"}</pre>
              )}
            </section>
          ) : null}
          {view === "deliveries" ? <DeliveriesPanel key={run.id} api={api} runId={run.id} /> : null}
          {view === "trace" ? <TracePanel key={run.id} api={api} runId={run.id} /> : null}
          {view === "eval" ? <EvaluationsPanel key={run.id} api={api} runId={run.id} /> : null}
        </>
      ) : null}
    </section>
  );
}

const deliveryLabels = {
  pending: "等待投递",
  sending: "投递中",
  sent: "已确认送达",
  failed: "投递失败",
  unknown: "投递结果未知",
} as const;
const payloadLabels = { ack: "接收回执", result: "执行结果", text: "文字消息" } as const;
function DeliveriesPanel({ api, runId }: { api: ManagementApi; runId: string }) {
  const load = useCallback(
    (cursor: string | undefined, signal: AbortSignal) => api.deliveries(runId, { cursor }, signal),
    [api, runId],
  );
  const page = useRecordPage(load, { pollMs: 5000 });
  return (
    <section className="mg-evidence-section" aria-labelledby="deliveries-title">
      <div className="mg-record-heading">
        <h2 id="deliveries-title">回复投递</h2>
        <button className="mg-text-button" disabled={page.loading} onClick={page.refresh}>
          {page.loading ? "读取中…" : "刷新投递"}
        </button>
      </div>
      <p className="mg-muted mg-small">只有平台确认的投递显示为已送达。结果未知时不会自动重发。</p>
      {page.error ? (
        <p className="mg-notice mg-error" role="alert">
          {page.error}
        </p>
      ) : null}
      {!page.data && page.loading ? (
        <p className="mg-empty" role="status">
          正在读取投递记录…
        </p>
      ) : null}
      {page.data?.items.length === 0 ? <p className="mg-empty">这一页没有投递记录。</p> : null}
      <div className="mg-delivery-list">
        {page.data?.items.map((delivery) => (
          <article key={delivery.id} className="mg-delivery-row">
            <div className="mg-delivery-heading">
              <div>
                <strong>{payloadLabels[delivery.payloadKind]}</strong>
                <code className="mg-record-id">{delivery.id}</code>
              </div>
              <span
                className={`mg-record-status mg-record-status-${delivery.status === "sent" ? "good" : delivery.status === "failed" ? "bad" : "muted"}`}
              >
                {deliveryLabels[delivery.status]}
              </span>
            </div>
            {delivery.externalId ? (
              <p className="mg-small mg-muted">
                平台消息 ID <code>{delivery.externalId}</code>
              </p>
            ) : null}
            {delivery.status === "unknown" ? (
              <p className="mg-small mg-muted">
                服务器没有收到确定结果，不能据此判断消息是否已发送。
              </p>
            ) : null}
            <details className="mg-record-disclosure">
              <summary>查看已授权的投递内容</summary>
              <pre className="mg-result-text">{delivery.payloadText}</pre>
            </details>
          </article>
        ))}
      </div>
      <PageControls
        page={page.page}
        loading={page.loading}
        nextCursor={page.data?.nextCursor}
        previous={page.previous}
        next={page.next}
        first={page.first}
      />
    </section>
  );
}

function TracePanel({ api, runId }: { api: ManagementApi; runId: string }) {
  const load = useCallback(
    (cursor: string | undefined, signal: AbortSignal) => api.trace(runId, { cursor }, signal),
    [api, runId],
  );
  const page = useRecordPage(load);
  return (
    <section className="mg-evidence-section" aria-labelledby="trace-title">
      <div className="mg-record-heading">
        <div>
          <h2 id="trace-title">Trace 证据</h2>
          <p className="mg-muted mg-small">按顺序读取服务器的脱敏投影。展开记录查看 JSON。</p>
        </div>
        <button className="mg-text-button" disabled={page.loading} onClick={page.refresh}>
          {page.loading ? "读取中…" : "刷新此页"}
        </button>
      </div>
      {page.data?.indexed ? (
        <dl className="mg-trace-index">
          <div>
            <dt>已索引事件</dt>
            <dd>{page.data.indexed.eventCount}</dd>
          </div>
          <div>
            <dt>已索引字节</dt>
            <dd>{page.data.indexed.byteOffset}</dd>
          </div>
          <div>
            <dt>证据引用</dt>
            <dd>
              <code>{page.data.indexed.traceRef}</code>
            </dd>
          </div>
        </dl>
      ) : null}
      {page.error ? (
        <p className="mg-notice mg-error" role="alert">
          {page.error}
        </p>
      ) : null}
      {!page.data && page.loading ? (
        <p className="mg-empty" role="status">
          正在读取 Trace…
        </p>
      ) : null}
      {page.data?.records.length === 0 ? (
        <p className="mg-empty">
          {page.data.indexed ? "这一页没有记录。" : "服务器尚未提供已索引的 Trace。"}
        </p>
      ) : null}
      <div className="mg-trace-list">
        {page.data?.records.map((entry) => (
          <TraceRecord key={entry.seq} entry={entry} />
        ))}
      </div>
      <PageControls
        page={page.page}
        loading={page.loading}
        nextCursor={page.data?.nextCursor}
        previous={page.previous}
        next={page.next}
        first={page.first}
      />
    </section>
  );
}
function TraceRecord({ entry }: { entry: ManagedTraceEntry }) {
  const [open, setOpen] = useState(false);
  const eventType =
    entry.event &&
    typeof entry.event === "object" &&
    "type" in entry.event &&
    typeof entry.event.type === "string"
      ? entry.event.type.slice(0, 160)
      : "event";
  const json = useMemo(() => (open ? JSON.stringify(entry, null, 2) : ""), [entry, open]);
  return (
    <details className="mg-trace-record" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="mg-trace-sequence">{entry.seq}</span>
        <span className="mg-trace-event">
          <strong>{eventType}</strong>
          <span>{entry.provenance}</span>
        </span>
        <RecordTime value={entry.ts} />
      </summary>
      {open ? <pre className="mg-trace-json">{json}</pre> : null}
    </details>
  );
}
