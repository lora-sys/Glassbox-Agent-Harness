import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useManagementData } from "../adapter";
import { PageHeader } from "../primitives/PageHeader";
import {
  parseLiveConversations,
  parseLiveRuns,
  parseLiveTrace,
  type LiveConversation,
  type LivePage,
  type LiveRun,
  type LiveTraceRecord,
} from "../adapter/live-contract";

type Kind = "conversations" | "runs" | "trace";
type LiveItem = LiveConversation | LiveRun | LiveTraceRecord;
const labels: Record<Kind, string> = {
  conversations: "会话",
  runs: "运行记录",
  trace: "追踪",
};

async function loadPage<T>(
  path: string,
  token: string,
  parse: (value: unknown) => LivePage<T>,
): Promise<LivePage<T>> {
  const response = await fetch(`/manage/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`服务器返回 ${response.status}，无法读取 /manage/${path.split("?")[0]}`);
  return parse(await response.json());
}

export const LiveRecordsPage: React.FC<{
  kind: Kind;
  runId?: string;
  onNavigate: (pageId: string, extra?: Record<string, unknown>) => void;
}> = ({ kind, runId, onNavigate }) => {
  const { token } = useManagementData();
  const [cursor, setCursor] = React.useState<string | null>(null);
  React.useEffect(() => setCursor(null), [kind, runId]);
  const path = kind === "trace" ? (runId ? `runs/${encodeURIComponent(runId)}/trace` : null) : kind;
  const queryPath = path && cursor ? `${path}?cursor=${encodeURIComponent(cursor)}` : path;
  const query = useQuery<LivePage<LiveItem>>({
    queryKey: ["management", "live", kind, runId, cursor, token],
    enabled: Boolean(token && queryPath),
    queryFn: async (): Promise<LivePage<LiveItem>> => {
      if (!token || !queryPath) throw new Error("管理凭据或 Run ID 缺失");
      if (kind === "conversations") return loadPage(queryPath, token, parseLiveConversations);
      if (kind === "runs") return loadPage(queryPath, token, parseLiveRuns);
      return loadPage(queryPath, token, parseLiveTrace);
    },
  });
  const page = query.data;
  const items = page?.items ?? [];

  return (
    <div className="liveRecordsPage">
      <PageHeader
        title={labels[kind]}
        description="服务器当前记录；仅展示 /manage 已提供的字段"
        customPill={{ text: "实时数据", variant: "teal" }}
      />
      {kind === "trace" && !runId && <p>请先从运行记录中选择一个 Run。</p>}
      {query.isPending && queryPath && <p role="status">正在读取服务器记录…</p>}
      {query.isError && (
        <p role="alert">
          {query.error instanceof Error ? query.error.message : "无法读取服务器记录"}
        </p>
      )}
      {query.isSuccess && items.length === 0 && <p>这一页没有记录。</p>}
      {query.isSuccess &&
        kind === "conversations" &&
        (items as LiveConversation[]).map((item) => (
          <article className="liveRecord" key={item.id}>
            <h2>{item.id}</h2>
            <p>
              Agent {item.agentId} · Principal {item.principalId}
            </p>
            <p>
              {item.scope.chatType === "group" ? "群聊" : "私聊"} · {item.scope.chatId} · 建立于{" "}
              {item.createdAt}
            </p>
            <button type="button" onClick={() => onNavigate("runs")}>
              查看运行记录
            </button>
          </article>
        ))}
      {query.isSuccess &&
        kind === "runs" &&
        (items as LiveRun[]).map((item) => (
          <article className="liveRecord" key={item.id}>
            <h2>{item.id}</h2>
            <p>
              状态：{item.status} · 会话：{item.conversationId}
            </p>
            <p>
              执行器：{item.executionRef} · 创建于 {item.createdAt}
            </p>
            {item.resultText && <p className="liveRecordResult">{item.resultText}</p>}
            <button type="button" onClick={() => onNavigate("trace", { runId: item.id })}>
              查看追踪
            </button>
          </article>
        ))}
      {query.isSuccess &&
        kind === "trace" &&
        (items as LiveTraceRecord[]).map((item) => (
          <article className="liveRecord" key={item.seq}>
            <h2>
              #{item.seq} · {item.ts}
            </h2>
            <p>{item.provenance}</p>
            <pre>{JSON.stringify(item.event, null, 2)}</pre>
          </article>
        ))}
      {query.isSuccess && page?.nextCursor && (
        <button type="button" onClick={() => setCursor(page.nextCursor)}>
          下一页
        </button>
      )}
    </div>
  );
};

export const LiveUnavailablePage: React.FC<{ title: string; endpoint: string }> = ({
  title,
  endpoint,
}) => (
  <div className="liveRecordsPage">
    <PageHeader
      title={title}
      description="当前服务器未提供这个管理数据端点"
      capabilityState="后续"
      customPill={{ text: "在线不可用", variant: "warn" }}
    />
    <p role="status">
      <code>{endpoint}</code> 尚未实现。此页的设计样例只在设计预览模式中显示。
    </p>
  </div>
);
