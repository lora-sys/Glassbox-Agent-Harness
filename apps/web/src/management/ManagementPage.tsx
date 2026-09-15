import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createManagementApi, isManagementToken, takeFragmentToken } from "./api";
import { failureMessage } from "./errors";
import type { ServiceStatus } from "./schema";
import { ModelsPanel } from "./ModelsPanel";
import { ChannelsPanel } from "./ChannelsPanel";
import { ConversationsPanel } from "./ConversationsPanel";
import { RunsPanel } from "./RunsPanel";
import { ExecutorsPanel } from "./ExecutorsPanel";
import type { ManagedConversation } from "./records-schema";
import { Overview } from "./Overview";
import { clearManagementAccess, readManagementAccess, saveManagementAccess } from "./access";
import { useManagementAccess } from "./useManagementAccess";
import "./management.css";

export function ManagementPage() {
  const storedToken = useManagementAccess();
  const [session, setSession] = useState<{ token: string; status: ServiceStatus } | null>(null);
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<
    "overview" | "models" | "channels" | "conversations" | "runs" | "executors"
  >("overview");
  const [conversationFilter, setConversationFilter] = useState<ManagedConversation | null>(null);
  const [modelsVisited, setModelsVisited] = useState(false);
  const [channelsVisited, setChannelsVisited] = useState(false);
  const loginRequest = useRef<AbortController | null>(null);
  const fragmentToken = useRef<string | null | undefined>(undefined);
  const api = useMemo(() => (session ? createManagementApi(session.token) : null), [session]);

  const connect = useCallback(async (value: string) => {
    const token = value.trim();
    if (!isManagementToken(token)) {
      setError("请输入本机服务器提供的完整管理密钥。");
      return;
    }
    loginRequest.current?.abort();
    const controller = new AbortController();
    loginRequest.current = controller;
    setConnecting(true);
    setError("");
    try {
      const status = await createManagementApi(token).status(controller.signal);
      if (controller.signal.aborted) return;
      saveManagementAccess(token);
      setSession({ token, status });
      setPassword("");
      fragmentToken.current = null;
    } catch (caught) {
      if (!controller.signal.aborted) setError(failureMessage(caught));
    } finally {
      if (!controller.signal.aborted) setConnecting(false);
    }
  }, []);

  useEffect(() => {
    const title = document.title;
    document.title = "Glassbox 管理中心";
    if (fragmentToken.current === undefined)
      fragmentToken.current =
        takeFragmentToken(window.location, window.history) ?? readManagementAccess();
    if (fragmentToken.current) void connect(fragmentToken.current);
    return () => {
      loginRequest.current?.abort();
      document.title = title;
    };
  }, [connect]);

  useEffect(() => {
    if (session && storedToken !== session.token) {
      setSession(null);
      setPassword("");
      setError("管理访问凭据已清理或更换，请重新连接。");
      setModelsVisited(false);
      setChannelsVisited(false);
      setConversationFilter(null);
    }
  }, [session, storedToken]);

  function openModels() {
    setModelsVisited(true);
    setView("models");
  }
  function disconnect() {
    try {
      clearManagementAccess();
    } catch (caught) {
      setError(failureMessage(caught));
      return;
    }
    loginRequest.current?.abort();
    fragmentToken.current = null;
    setSession(null);
    setPassword("");
    setError("");
    setConnecting(false);
    setView("overview");
    setModelsVisited(false);
    setChannelsVisited(false);
    setConversationFilter(null);
  }

  return (
    <div className="management-page" lang="zh-CN">
      <a className="mg-skip-link" href="#management-main">
        跳到主要内容
      </a>
      <aside className="mg-sidebar">
        <button className="mg-brand" onClick={() => setView("overview")}>
          <span className="mg-brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <path d="m16 3 12 7v13l-12 7L4 23V10Z" />
              <path d="m4 10 12 7 12-7M16 17v13M10 7l12 7v6l-6 4" />
            </svg>
          </span>
          <span>
            Glassbox<span className="mg-brand-caption">Personal Agent</span>
          </span>
        </button>
        <nav aria-label="管理导航">
          <button
            className={`mg-nav-item${view === "overview" ? " is-active" : ""}`}
            aria-current={view === "overview" ? "page" : undefined}
            onClick={() => setView("overview")}
            disabled={!session}
          >
            概览
          </button>
          <button
            className={`mg-nav-item${view === "models" ? " is-active" : ""}`}
            aria-current={view === "models" ? "page" : undefined}
            onClick={openModels}
            disabled={!session}
          >
            模型配置
          </button>
          <button
            className={`mg-nav-item${view === "executors" ? " is-active" : ""}`}
            aria-current={view === "executors" ? "page" : undefined}
            disabled={!session}
            onClick={() => setView("executors")}
          >
            本机执行器
          </button>
          <button
            className={`mg-nav-item${view === "channels" ? " is-active" : ""}`}
            aria-current={view === "channels" ? "page" : undefined}
            onClick={() => {
              setChannelsVisited(true);
              setView("channels");
            }}
            disabled={!session}
          >
            消息渠道
          </button>
          <button
            className={`mg-nav-item${view === "conversations" ? " is-active" : ""}`}
            aria-current={view === "conversations" ? "page" : undefined}
            disabled={!session}
            onClick={() => setView("conversations")}
          >
            会话
          </button>
          <button
            className={`mg-nav-item${view === "runs" ? " is-active" : ""}`}
            aria-current={view === "runs" ? "page" : undefined}
            disabled={!session}
            onClick={() => {
              setConversationFilter(null);
              setView("runs");
            }}
          >
            执行与证据
          </button>
          <a className="mg-nav-item" href="/">
            工作区
          </a>
        </nav>
        <div className="mg-sidebar-footer">
          <span className="mg-small mg-muted">
            {session ? "当前标签页已持有管理访问凭据" : "等待连接本机服务"}
          </span>
          {session ? (
            <button className="mg-text-button" onClick={disconnect}>
              断开管理连接
            </button>
          ) : null}
        </div>
      </aside>
      <main id="management-main" className="mg-main" tabIndex={-1}>
        {session && error ? (
          <p className="mg-notice mg-error" role="alert">
            {error}
          </p>
        ) : null}
        {session && api ? (
          <>
            <div hidden={view !== "overview"}>
              <Overview api={api} initialStatus={session.status} openModels={openModels} />
            </div>
            {modelsVisited ? (
              <div hidden={view !== "models"}>
                <ModelsPanel api={api} />
              </div>
            ) : null}
            {channelsVisited ? (
              <div hidden={view !== "channels"}>
                <ChannelsPanel api={api} active={view === "channels"} />
              </div>
            ) : null}
            {view === "executors" ? <ExecutorsPanel api={api} /> : null}
            {view === "conversations" ? (
              <ConversationsPanel
                api={api}
                openConversation={(conversation) => {
                  setConversationFilter(conversation);
                  setView("runs");
                }}
              />
            ) : null}
            {view === "runs" ? (
              <RunsPanel
                key={conversationFilter?.id ?? "all"}
                api={api}
                conversation={conversationFilter}
                clearConversation={() => setConversationFilter(null)}
              />
            ) : null}
          </>
        ) : (
          <div className="mg-login-layout">
            <div className="mg-login-intro">
              <p className="mg-eyebrow">本机访问</p>
              <h1>连接 Glassbox 管理中心</h1>
              <p className="mg-muted">
                配置模型和 QQ 渠道，检查本机执行环境，并返回工作区查看执行过程。
              </p>
              <div className="mg-login-note">
                <strong>与 CLI 使用同一份配置</strong>
                <p>
                  管理密钥保存在当前标签页的会话存储中，退出时删除。模型 API 密钥不保存在浏览器。
                </p>
              </div>
            </div>
            <form
              className="mg-panel mg-login-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!connecting) void connect(password);
              }}
              aria-busy={connecting}
            >
              <h2>本机管理密钥</h2>
              <p className="mg-muted mg-small">
                使用本机服务器提供的管理密钥。这里不填写模型 API 密钥。
              </p>
              <label className="mg-field" htmlFor="management-key">
                管理密钥
                <input
                  id="management-key"
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  maxLength={256}
                  spellCheck={false}
                  disabled={connecting}
                  aria-describedby={error ? "management-login-error" : undefined}
                />
              </label>
              {error ? (
                <p id="management-login-error" className="mg-notice mg-error" role="alert">
                  {error}
                </p>
              ) : null}
              <button className="mg-button" type="submit" disabled={connecting}>
                {connecting ? "正在验证连接…" : "连接管理中心"}
              </button>
              {connecting ? (
                <p className="mg-small mg-muted" role="status">
                  正在读取本机服务器状态。
                </p>
              ) : null}
              <a className="mg-inline-link" href="/">
                返回工作区
              </a>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
