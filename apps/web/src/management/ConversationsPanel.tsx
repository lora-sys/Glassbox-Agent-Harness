import { useCallback } from "react";
import type { ManagementApi } from "./api";
import type { ManagedConversation } from "./records-schema";
import { PageControls, RecordTime, ScopeLabel } from "./RecordPrimitives";
import { useRecordPage } from "./useRecordPage";

export function ConversationsPanel({
  api,
  openConversation,
}: {
  api: ManagementApi;
  openConversation: (conversation: ManagedConversation) => void;
}) {
  const load = useCallback(
    (cursor: string | undefined, signal: AbortSignal) => api.conversations({ cursor }, signal),
    [api],
  );
  const page = useRecordPage(load, { pollMs: 10000 });
  return (
    <section aria-labelledby="conversations-title">
      <div className="mg-section-heading">
        <div>
          <p className="mg-eyebrow">同一个 Personal Agent</p>
          <h1 id="conversations-title">会话</h1>
          <p className="mg-muted">
            按渠道、群聊和私聊保留独立会话。这里只显示服务器允许读取的会话入口。
          </p>
        </div>
        <button className="mg-button mg-secondary" disabled={page.loading} onClick={page.refresh}>
          {page.loading ? "刷新中…" : "刷新会话"}
        </button>
      </div>
      {page.error ? (
        <p className="mg-notice mg-error" role="alert">
          {page.error}
        </p>
      ) : null}
      <div className="mg-record-surface" aria-busy={page.loading}>
        <div className="mg-record-heading">
          <h2>会话记录</h2>
          <span className="mg-small mg-muted">按创建时间排列</span>
        </div>
        {!page.data && page.loading ? (
          <p className="mg-empty" role="status">
            正在读取会话…
          </p>
        ) : null}
        {page.data?.items.length === 0 ? (
          <div className="mg-empty">
            <h3>这一页没有可读取的会话</h3>
            <p>连接 QQ 后，Owner 的有效消息会创建会话。列表不会读取完整聊天内容。</p>
          </div>
        ) : null}
        {page.data?.items.length ? (
          <div className="mg-record-table-wrap">
            <table className="mg-record-table">
              <thead>
                <tr>
                  <th>会话来源</th>
                  <th>渠道与发送者</th>
                  <th>创建时间</th>
                  <th>
                    <span className="mg-visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.data.items.map((conversation) => (
                  <tr key={conversation.id}>
                    <td data-label="会话来源">
                      <ScopeLabel scope={conversation.scope} />
                      <code className="mg-record-id">{conversation.id}</code>
                      {conversation.scope.threadId ? (
                        <span className="mg-small mg-muted">
                          子会话 {conversation.scope.threadId}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="渠道与发送者">
                      <span className="mg-record-primary">{conversation.scope.connectionId}</span>
                      <span className="mg-small mg-muted">
                        发送者 {conversation.scope.senderId}
                      </span>
                    </td>
                    <td data-label="创建时间">
                      <RecordTime value={conversation.createdAt} />
                    </td>
                    <td>
                      <button
                        className="mg-text-button"
                        onClick={() => openConversation(conversation)}
                        aria-label={`查看${conversation.scope.chatType === "group" ? "群聊" : "私聊"} ${conversation.scope.chatId} 的执行`}
                      >
                        查看执行
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
