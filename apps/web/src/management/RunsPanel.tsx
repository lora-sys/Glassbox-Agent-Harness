import { useCallback, useState } from "react";
import type { ManagementApi } from "./api";
import type { ManagedConversation, ManagedRunListItem } from "./records-schema";
import { PageControls, RecordTime, RunStatus, ScopeLabel } from "./RecordPrimitives";
import { useRecordPage } from "./useRecordPage";
import { RunDetails } from "./RunDetails";

export function RunsPanel({
  api,
  conversation,
  clearConversation,
}: {
  api: ManagementApi;
  conversation: ManagedConversation | null;
  clearConversation: () => void;
}) {
  const [selected, setSelected] = useState<ManagedRunListItem | null>(null);
  const load = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      api.runs({ cursor, ...(conversation ? { conversationId: conversation.id } : {}) }, signal),
    [api, conversation],
  );
  const page = useRecordPage(load, { pollMs: 5000, active: selected === null });
  if (selected)
    return (
      <RunDetails
        api={api}
        selected={selected}
        back={() => {
          setSelected(null);
          page.refresh();
        }}
      />
    );
  return (
    <section aria-labelledby="runs-title">
      <div className="mg-section-heading">
        <div>
          <p className="mg-eyebrow">执行与证据</p>
          <h1 id="runs-title">执行记录</h1>
          <p className="mg-muted">
            检查任务状态、回复投递和 Trace。执行完成与 QQ 投递确认分别记录。
          </p>
        </div>
        <button className="mg-button mg-secondary" disabled={page.loading} onClick={page.refresh}>
          {page.loading ? "刷新中…" : "刷新执行"}
        </button>
      </div>
      {conversation ? (
        <div className="mg-context-strip">
          <div>
            <ScopeLabel scope={conversation.scope} />
            <code>{conversation.id}</code>
          </div>
          <button className="mg-text-button" onClick={clearConversation}>
            查看全部会话的执行
          </button>
        </div>
      ) : null}
      {page.error ? (
        <p className="mg-notice mg-error" role="alert">
          {page.error}
        </p>
      ) : null}
      <div className="mg-record-surface" aria-busy={page.loading}>
        <div className="mg-record-heading">
          <h2>{conversation ? "此会话的执行" : "执行记录"}</h2>
          <span className="mg-small mg-muted">按创建时间排列</span>
        </div>
        {!page.data && page.loading ? (
          <p className="mg-empty" role="status">
            正在读取执行记录…
          </p>
        ) : null}
        {page.data?.items.length === 0 ? (
          <div className="mg-empty">
            <h3>这一页没有可读取的执行</h3>
            <p>有效的 QQ 消息进入队列后，执行记录会显示在这里。</p>
          </div>
        ) : null}
        {page.data?.items.length ? (
          <div className="mg-record-table-wrap">
            <table className="mg-record-table">
              <thead>
                <tr>
                  <th>执行状态</th>
                  <th>来源</th>
                  <th>执行方式</th>
                  <th>创建时间</th>
                  <th>
                    <span className="mg-visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((run) => (
                  <tr key={run.id}>
                    <td data-label="执行状态">
                      <RunStatus status={run.status} />
                      <code className="mg-record-id">{run.id}</code>
                    </td>
                    <td data-label="来源">
                      <ScopeLabel scope={run.scope} />
                      <span className="mg-small mg-muted">{run.scope.connectionId}</span>
                    </td>
                    <td data-label="执行方式">
                      <span className="mg-record-primary">{run.executionRef}</span>
                    </td>
                    <td data-label="创建时间">
                      <RecordTime value={run.createdAt} />
                    </td>
                    <td>
                      <button
                        className="mg-text-button"
                        onClick={() => setSelected(run)}
                        aria-label={`查看执行 ${run.id}`}
                      >
                        查看证据
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <PageControls
          page={page.page}
          loading={page.loading}
          nextCursor={page.data?.nextCursor}
          previous={page.previous}
          next={page.next}
          first={page.first}
        />
      </div>
    </section>
  );
}
