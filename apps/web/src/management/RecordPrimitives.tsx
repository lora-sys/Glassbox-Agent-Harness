import type { ManagedRunStatus, ManagedScope } from "./records-schema";

export const runStatusLabels: Record<ManagedRunStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  cancelling: "正在取消",
  cancelled: "已取消",
  succeeded: "执行完成",
  failed: "执行失败",
  interrupted: "执行中断",
  unknown: "结果未知",
};
export function RunStatus({ status }: { status: ManagedRunStatus }) {
  const tone =
    status === "succeeded"
      ? "good"
      : ["failed", "interrupted"].includes(status)
        ? "bad"
        : ["queued", "running", "cancelling"].includes(status)
          ? "active"
          : "muted";
  return (
    <span className={`mg-record-status mg-record-status-${tone}`}>
      <span aria-hidden="true" />
      {runStatusLabels[status]}
    </span>
  );
}
export function ScopeLabel({ scope }: { scope: ManagedScope }) {
  return (
    <span className="mg-scope-label">
      <span className="mg-scope-kind">{scope.chatType === "group" ? "群聊" : "私聊"}</span>
      <span>{scope.chatId}</span>
    </span>
  );
}
export function RecordTime({ value }: { value: string }) {
  return (
    <time dateTime={value} title={value}>
      {new Date(value).toLocaleString("zh-CN", { hour12: false })}
    </time>
  );
}
export function PageControls({
  page,
  loading,
  nextCursor,
  previous,
  next,
  first,
}: {
  page: number;
  loading: boolean;
  nextCursor: string | null | undefined;
  previous: () => void;
  next: () => void;
  first?: () => void;
}) {
  return (
    <div className="mg-page-controls">
      <span className="mg-muted mg-small">第 {page + 1} 页</span>
      <div className="mg-actions">
        {first && page > 0 ? (
          <button className="mg-text-button" disabled={loading} onClick={first}>
            回到首页
          </button>
        ) : null}
        <button
          className="mg-button mg-secondary"
          disabled={loading || page === 0}
          onClick={previous}
        >
          上一页
        </button>
        <button className="mg-button mg-secondary" disabled={loading || !nextCursor} onClick={next}>
          下一页
        </button>
      </div>
    </div>
  );
}
