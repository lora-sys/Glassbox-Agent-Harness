import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { PublicChannelProfile, PublicModelProfile } from "@glassbox/contracts";
import type { ManagementApi } from "./api";
import { buildChannelSave, channelDraftFor, emptyChannelDraft } from "./channel-schema";
import type { ChannelDraft } from "./channel-schema";
import { failureMessage } from "./errors";

const connectionLabels = {
  disconnected: "未连接",
  connecting: "正在连接",
  connected: "已连接",
  error: "连接错误",
} as const;

export function ChannelsPanel({ api, active = true }: { api: ManagementApi; active?: boolean }) {
  const [channels, setChannels] = useState<PublicChannelProfile[] | null>(null);
  const [models, setModels] = useState<PublicModelProfile[]>([]);
  const [modelError, setModelError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<ChannelDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "connect" | "disconnect" | null>(null);
  const [saveError, setSaveError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const mutation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const formTitle = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    const read = async () => {
      const currentGeneration = generation.current;
      try {
        if (mutation.current) return;
        const result = await api.channels(controller.signal);
        if (!controller.signal.aborted && currentGeneration === generation.current) {
          setChannels(result);
          setLoadError("");
        }
      } catch (error) {
        if (!controller.signal.aborted && currentGeneration === generation.current)
          setLoadError(failureMessage(error));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => {
            void read();
          }, 5000);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, revision, active]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void api
      .models(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setModels(result);
          setModelError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setModelError("模型配置读取失败。可以刷新重试，本机执行选项仍可配置。");
      });
    return () => controller.abort();
  }, [api, revision, active]);

  useEffect(() => () => mutation.current?.abort(), []);

  const previous = channels?.find((channel) => channel.id === editingId);
  const dirty =
    draft !== null &&
    JSON.stringify(draft) !==
      JSON.stringify(previous ? channelDraftFor(previous) : emptyChannelDraft());
  const channelActive =
    previous?.connectionState === "connected" || previous?.connectionState === "connecting";
  const busy = pending !== null || loading;
  const stale = Boolean(loadError);

  function edit(channel?: PublicChannelProfile) {
    setDraft(channel ? channelDraftFor(channel) : emptyChannelDraft());
    setEditingId(channel?.id ?? null);
    setSaveError("");
    setSavedMessage("");
    setActionError("");
    setActionMessage("");
    requestAnimationFrame(() => formTitle.current?.focus());
  }

  function change<K extends keyof ChannelDraft>(field: K, value: ChannelDraft[K]) {
    setDraft((current) => (current ? { ...current, [field]: value } : null));
    setSavedMessage("");
    setSaveError("");
  }

  function accept(channel: PublicChannelProfile) {
    setChannels((current) => [
      ...(current ?? []).filter((item) => item.id !== channel.id),
      channel,
    ]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || busy || mutation.current || stale || channelActive) return;
    setSaveError("");
    setSavedMessage("");
    let input;
    try {
      if (!editingId && channels?.some((channel) => channel.id === draft.id.trim())) {
        setSaveError("这个渠道标识已存在，请从列表中选择编辑。");
        return;
      }
      input = buildChannelSave(draft, previous);
    } catch (error) {
      setSaveError(failureMessage(error));
      return;
    }
    const controller = new AbortController();
    mutation.current = controller;
    generation.current += 1;
    setPending("save");
    try {
      const channel = await api.saveChannel(input, controller.signal);
      if (controller.signal.aborted) return;
      accept(channel);
      setEditingId(channel.id);
      setDraft(channelDraftFor(channel));
      setSavedMessage("配置已保存。点击“连接 QQ”后才会连接本机 OneBot 服务。");
    } catch (error) {
      if (!controller.signal.aborted) setSaveError(failureMessage(error));
    } finally {
      generation.current += 1;
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) {
        setPending(null);
        setRevision((value) => value + 1);
      }
    }
  }

  async function connectionAction(action: "connect" | "disconnect") {
    if (
      !previous ||
      busy ||
      stale ||
      mutation.current ||
      (action === "connect" && (dirty || !previous.tokenConfigured))
    )
      return;
    const controller = new AbortController();
    mutation.current = controller;
    generation.current += 1;
    setPending(action);
    setActionError("");
    setActionMessage("");
    try {
      const channel = await (action === "connect"
        ? api.connectChannel(previous.id, controller.signal)
        : api.disconnectChannel(previous.id, controller.signal));
      if (controller.signal.aborted) return;
      accept(channel);
      if (action === "disconnect") {
        if (channel.connectionState === "disconnected") setActionMessage("QQ 连接已断开。");
        else setActionError("服务器尚未确认断开，请刷新连接状态。");
      } else if (
        channel.connectionState === "connected" ||
        channel.connectionState === "connecting"
      )
        setActionMessage("连接操作已提交，当前状态会自动刷新。");
      else setActionError(channel.lastError ?? "QQ 连接未建立，请检查本机服务后重试。");
    } catch (error) {
      if (!controller.signal.aborted) setActionError(failureMessage(error));
    } finally {
      generation.current += 1;
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) {
        setPending(null);
        setRevision((value) => value + 1);
      }
    }
  }

  return (
    <section className="mg-channels" aria-labelledby="channels-title">
      <div className="mg-section-heading">
        <div>
          <p className="mg-eyebrow">消息渠道</p>
          <h1 id="channels-title">连接你的 QQ 助理</h1>
          <p className="mg-muted">
            在允许的群里 @ 机器人，或由 Owner 私聊。首版处理文字消息，暂不支持图片、语音和文件。
          </p>
        </div>
        <div className="mg-actions">
          <button
            className="mg-button mg-secondary"
            disabled={busy}
            onClick={() => setRevision((value) => value + 1)}
          >
            {loading ? "刷新中…" : "刷新状态"}
          </button>
          <button
            className="mg-button"
            disabled={busy || stale || channels === null || dirty}
            onClick={() => edit()}
          >
            新增渠道
          </button>
        </div>
      </div>
      <p className="mg-notice mg-channel-boundary">
        首次 Owner QQ 号必须由持有本机管理密钥的人在此配置。群消息里的自报身份和群号不会绑定
        Owner。群聊不加载 Owner 的私人资料。
      </p>
      {loadError ? (
        <p className="mg-notice mg-error" role="alert">
          {loadError} 当前显示的是上次读取的状态，请刷新后再操作。
        </p>
      ) : null}
      <div className="mg-model-layout">
        <div className="mg-panel mg-profile-panel" aria-busy={loading}>
          <div className="mg-panel-heading">
            <h2>已保存的渠道</h2>
            {channels ? <span className="mg-count">{channels.length}</span> : null}
          </div>
          {channels === null && loading ? (
            <p className="mg-empty" role="status">
              正在读取渠道配置…
            </p>
          ) : null}
          {channels?.length === 0 ? (
            <div className="mg-empty">
              <h3>还没有 QQ 渠道</h3>
              <p>先在本机配置 NapCat 的 OneBot 正向 WebSocket 服务，再新增渠道。</p>
            </div>
          ) : null}
          {channels ? (
            <ul className="mg-profile-list">
              {channels.map((channel) => (
                <li key={channel.id}>
                  <button
                    className={`mg-profile${editingId === channel.id ? " is-selected" : ""}`}
                    aria-pressed={editingId === channel.id}
                    disabled={busy || dirty || stale}
                    onClick={() => edit(channel)}
                  >
                    <span className="mg-profile-top">
                      <strong>{channel.label}</strong>
                      <span className="mg-tag">{connectionLabels[channel.connectionState]}</span>
                    </span>
                    <span className="mg-profile-model">QQ {channel.botId}</span>
                    <span className="mg-muted mg-small">
                      {channel.tokenConfigured ? "token 已配置" : "尚未配置 token"}
                    </span>
                    <span className="mg-profile-address">{channel.endpoint}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="mg-panel mg-editor">
          {draft ? (
            <>
              <div className="mg-panel-heading">
                <h2 ref={formTitle} tabIndex={-1}>
                  {editingId ? "编辑 QQ 渠道" : "新增 QQ 渠道"}
                </h2>
                <span className="mg-tag">
                  {pending === "save"
                    ? "保存中"
                    : dirty
                      ? "尚未保存"
                      : editingId
                        ? "已保存"
                        : "草稿"}
                </span>
              </div>
              {previous ? (
                <div className="mg-connection-summary">
                  <dl className="mg-facts">
                    <div>
                      <dt>连接状态</dt>
                      <dd role="status">
                        {stale ? "状态待刷新" : connectionLabels[previous.connectionState]}
                      </dd>
                    </div>
                    <div>
                      <dt>服务重启后</dt>
                      <dd>{previous.autoConnect ? "自动连接" : "保持断开"}</dd>
                    </div>
                  </dl>
                  <div className="mg-actions">
                    <button
                      className="mg-button"
                      disabled={
                        busy || stale || channelActive || dirty || !previous.tokenConfigured
                      }
                      onClick={() => {
                        void connectionAction("connect");
                      }}
                    >
                      {pending === "connect" ? "正在请求连接…" : "连接 QQ"}
                    </button>
                    <button
                      className="mg-button mg-secondary"
                      disabled={
                        busy ||
                        stale ||
                        (previous.connectionState === "disconnected" && !previous.autoConnect)
                      }
                      onClick={() => {
                        void connectionAction("disconnect");
                      }}
                    >
                      {pending === "disconnect" ? "正在断开…" : "断开连接"}
                    </button>
                  </div>
                  {!previous.tokenConfigured ? (
                    <p className="mg-field-help">配置并保存 token 后才能连接。</p>
                  ) : null}
                  {channelActive ? (
                    <p className="mg-field-help">修改配置前，请先断开 QQ 连接。</p>
                  ) : null}
                  {previous.lastError ? (
                    <p className="mg-notice mg-error" role="alert">
                      {previous.lastError}
                    </p>
                  ) : null}
                  {actionError ? (
                    <p className="mg-notice mg-error" role="alert">
                      {actionError}
                    </p>
                  ) : null}
                  {actionMessage ? (
                    <p className="mg-notice" role="status">
                      {actionMessage}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <form
                onSubmit={(event) => {
                  void save(event);
                }}
                aria-busy={pending === "save"}
              >
                <fieldset className="mg-fieldset" disabled={busy || channelActive || stale}>
                  <div className="mg-form-grid">
                    <h3 className="mg-form-section mg-span-two">连接与身份</h3>
                    <label className="mg-field" htmlFor="channel-label">
                      显示名称
                      <input
                        id="channel-label"
                        value={draft.label}
                        onChange={(event) => change("label", event.target.value)}
                        required
                        maxLength={120}
                        placeholder="我的 QQ 助理"
                      />
                    </label>
                    <label className="mg-field" htmlFor="channel-id">
                      渠道标识
                      <input
                        id="channel-id"
                        value={draft.id}
                        onChange={(event) => change("id", event.target.value)}
                        required
                        readOnly={editingId !== null}
                        maxLength={96}
                        pattern={"[A-Za-z0-9][A-Za-z0-9_\\-]*"}
                        placeholder="qq-personal"
                        aria-describedby="channel-id-help"
                      />
                      <span className="mg-field-help" id="channel-id-help">
                        使用字母、数字、下划线或连字符。保存后保持不变。
                      </span>
                    </label>
                    <label className="mg-field mg-span-two" htmlFor="channel-endpoint">
                      OneBot WebSocket 地址
                      <input
                        id="channel-endpoint"
                        type="url"
                        value={draft.endpoint}
                        onChange={(event) => change("endpoint", event.target.value)}
                        required
                        maxLength={2048}
                        aria-describedby="channel-endpoint-help"
                      />
                      <span className="mg-field-help" id="channel-endpoint-help">
                        使用本机合并 API 和事件的正向 WebSocket 地址。不要在地址里填写
                        token。首次只允许回环地址。
                      </span>
                    </label>
                    <label className="mg-field" htmlFor="channel-bot">
                      机器人 QQ 号
                      <input
                        id="channel-bot"
                        inputMode="numeric"
                        value={draft.botId}
                        onChange={(event) => change("botId", event.target.value)}
                        required
                        maxLength={16}
                        pattern="[1-9][0-9]*"
                        aria-describedby="channel-bot-help"
                      />
                      <span className="mg-field-help" id="channel-bot-help">
                        必须与本机 OneBot 服务实际登录的 QQ 号一致。
                      </span>
                    </label>
                    <label className="mg-field" htmlFor="channel-owner">
                      Owner QQ 号
                      <input
                        id="channel-owner"
                        inputMode="numeric"
                        value={draft.ownerId}
                        onChange={(event) => change("ownerId", event.target.value)}
                        required
                        maxLength={16}
                        pattern="[1-9][0-9]*"
                        aria-describedby="channel-owner-help"
                      />
                      <span className="mg-field-help" id="channel-owner-help">
                        填写你自己的 QQ 号。首版只接受这个账号的消息，且不能与机器人相同。
                      </span>
                    </label>
                    <label className="mg-field mg-span-two" htmlFor="channel-groups">
                      允许的 QQ 群号
                      <input
                        id="channel-groups"
                        value={draft.groupIds}
                        onChange={(event) => change("groupIds", event.target.value)}
                        maxLength={600}
                        placeholder="123456789, 987654321"
                        aria-describedby="channel-groups-help"
                      />
                      <span className="mg-field-help" id="channel-groups-help">
                        用逗号或空格分隔，最多 32 个。留空只接受 Owner 私聊。群里需要 Owner 明确 @
                        机器人。
                      </span>
                    </label>
                    <h3 className="mg-form-section mg-span-two">执行与访问</h3>
                    <label className="mg-field mg-span-two" htmlFor="channel-execution">
                      执行方式
                      <select
                        id="channel-execution"
                        value={draft.executionRef}
                        onChange={(event) => change("executionRef", event.target.value)}
                        aria-describedby="channel-execution-help"
                      >
                        <option value="claude-code">本机 Claude Code</option>
                        <option value="codex">本机 Codex</option>
                        {draft.executionRef.startsWith("model:") &&
                        !models.some((model) => `model:${model.id}` === draft.executionRef) ? (
                          <option value={draft.executionRef}>
                            {draft.executionRef} · 当前列表未找到
                          </option>
                        ) : null}
                        {models.map((model) => (
                          <option key={model.id} value={`model:${model.id}`}>
                            {model.label} · {model.model}
                          </option>
                        ))}
                      </select>
                      <span className="mg-field-help" id="channel-execution-help">
                        默认使用本机 Claude
                        Code。服务端会检查执行方式能否用于当前渠道。模型列表来自“模型配置”。
                      </span>
                      {modelError ? (
                        <span className="mg-field-help" role="status">
                          {modelError}
                        </span>
                      ) : null}
                    </label>
                    <label className="mg-field mg-span-two" htmlFor="channel-token">
                      {previous?.tokenConfigured ? "替换 OneBot token" : "OneBot token"}
                      <input
                        id="channel-token"
                        type="password"
                        autoComplete="new-password"
                        value={draft.token}
                        onChange={(event) => change("token", event.target.value)}
                        disabled={draft.clearToken}
                        maxLength={4096}
                        placeholder={
                          previous?.tokenConfigured
                            ? "留空保留已保存的 token"
                            : "填写 OneBot 服务的访问 token"
                        }
                        aria-describedby="channel-token-help"
                      />
                      <span className="mg-field-help" id="channel-token-help">
                        已保存的 token 不会返回浏览器。更换服务来源时需要替换或清除 token。
                      </span>
                    </label>
                  </div>
                  {previous?.tokenConfigured ? (
                    <label className="mg-checkbox">
                      <input
                        type="checkbox"
                        checked={draft.clearToken}
                        onChange={(event) => {
                          change("clearToken", event.target.checked);
                          if (event.target.checked) change("token", "");
                        }}
                      />
                      清除已保存的 token
                    </label>
                  ) : null}
                </fieldset>
                {saveError ? (
                  <p className="mg-notice mg-error" role="alert">
                    {saveError}
                  </p>
                ) : null}
                {savedMessage ? (
                  <p className="mg-notice mg-success" role="status">
                    {savedMessage}
                  </p>
                ) : null}
                <div className="mg-form-footer">
                  <button
                    type="button"
                    className="mg-button mg-secondary"
                    disabled={pending !== null}
                    onClick={() => {
                      setDraft(null);
                      setEditingId(null);
                      setSaveError("");
                      setSavedMessage("");
                    }}
                  >
                    {dirty ? "放弃更改" : "关闭编辑"}
                  </button>
                  <button
                    type="submit"
                    className="mg-button"
                    disabled={busy || channelActive || stale}
                  >
                    {pending === "save" ? "正在保存…" : "保存配置"}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="mg-empty mg-editor-empty">
              <h2>选择或新增一个 QQ 渠道</h2>
              <p>保存渠道后再连接。连接和断开不会发送聊天消息，也不会启动模型。</p>
              <p>连接成功后，只接受配置的 Owner 私聊和允许群里的 Owner @ 消息。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
