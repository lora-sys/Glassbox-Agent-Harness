import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { MODEL_PROTOCOLS } from "@glassbox/contracts";
import type { ModelProtocol, PublicModelProfile } from "@glassbox/contracts";
import type { ManagementApi } from "./api";
import { failureMessage, ManagementApiError } from "./errors";
import { buildModelSave, emptyModelDraft } from "./schema";
import type { ModelDraft } from "./schema";

function draftFor(profile: PublicModelProfile): ModelDraft {
  const { credentialConfigured: _configured, ...values } = profile;
  return { ...values, apiKey: "", clearApiKey: false };
}

export function ModelsPanel({ api }: { api: ManagementApi }) {
  const [profiles, setProfiles] = useState<PublicModelProfile[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const saveRequest = useRef<AbortController | null>(null);
  const formTitle = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    void api
      .models(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setProfiles(result);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(failureMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, revision]);

  useEffect(() => () => saveRequest.current?.abort(), []);

  const previous = profiles?.find((profile) => profile.id === editingId);
  const dirty =
    draft !== null &&
    JSON.stringify(draft) !== JSON.stringify(previous ? draftFor(previous) : emptyModelDraft());

  function edit(profile?: PublicModelProfile) {
    setDraft(profile ? draftFor(profile) : emptyModelDraft());
    setEditingId(profile?.id ?? null);
    setSaveError("");
    setSavedMessage("");
    requestAnimationFrame(() => formTitle.current?.focus());
  }

  function change<K extends keyof ModelDraft>(field: K, value: ModelDraft[K]) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
    setSavedMessage("");
    setSaveError("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || saving || loading || saveRequest.current) return;
    setSaveError("");
    setSavedMessage("");
    let body;
    try {
      if (editingId === null && profiles?.some((profile) => profile.id === draft.id.trim())) {
        setSaveError("这个配置标识已存在，请从列表中选择编辑。");
        return;
      }
      body = buildModelSave(draft, previous);
    } catch (error) {
      setSaveError(failureMessage(error));
      return;
    }
    const controller = new AbortController();
    saveRequest.current = controller;
    setSaving(true);
    try {
      const profile = await api.saveModel(body, controller.signal);
      if (controller.signal.aborted) return;
      setProfiles((current) => [
        ...(current ?? []).filter((item) => item.id !== profile.id),
        profile,
      ]);
      setEditingId(profile.id);
      setDraft(draftFor(profile));
      setSavedMessage("已保存到服务器。CLI 可以读取这份配置，模型连接尚未验证。");
    } catch (error) {
      if (!controller.signal.aborted) {
        setSaveError(failureMessage(error));
        if (error instanceof ManagementApiError && error.code === "TIMEOUT")
          setRevision((value) => value + 1);
      }
    } finally {
      if (saveRequest.current === controller) saveRequest.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  return (
    <section aria-labelledby="models-title">
      <div className="mg-section-heading">
        <div>
          <p className="mg-eyebrow">模型配置</p>
          <h1 id="models-title">连接你使用的模型</h1>
          <p className="mg-muted">WebUI 和 CLI 读取同一份服务器配置。保存不会发起模型请求。</p>
        </div>
        <div className="mg-actions">
          <button
            className="mg-button mg-secondary"
            disabled={loading || saving}
            onClick={() => setRevision((value) => value + 1)}
          >
            {loading ? "刷新中…" : "刷新列表"}
          </button>
          <button
            className="mg-button"
            disabled={saving || loading || profiles === null || dirty}
            onClick={() => edit()}
          >
            新增配置
          </button>
        </div>
      </div>
      {loadError ? (
        <p className="mg-notice mg-error" role="alert">
          {loadError}
          {profiles !== null ? " 下方保留上次读取的配置。" : ""}
        </p>
      ) : null}
      <div className="mg-model-layout">
        <div className="mg-panel mg-profile-panel" aria-busy={loading}>
          <div className="mg-panel-heading">
            <h2>已保存的配置</h2>
            {profiles !== null ? <span className="mg-count">{profiles.length}</span> : null}
          </div>
          {profiles === null && loading ? (
            <p className="mg-empty" role="status">
              正在读取模型配置…
            </p>
          ) : null}
          {profiles?.length === 0 ? (
            <div className="mg-empty">
              <h3>还没有模型配置</h3>
              <p>添加 API 地址、模型名称和凭据后，可供后续执行任务选择。</p>
            </div>
          ) : null}
          {profiles ? (
            <ul className="mg-profile-list">
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <button
                    className={`mg-profile${editingId === profile.id ? " is-selected" : ""}`}
                    aria-pressed={editingId === profile.id}
                    disabled={saving || dirty}
                    onClick={() => edit(profile)}
                  >
                    <span className="mg-profile-top">
                      <strong>{profile.label}</strong>
                      <span className="mg-tag">
                        {profile.credentialConfigured ? "已配置密钥" : "无密钥"}
                      </span>
                    </span>
                    <span className="mg-profile-model">{profile.model}</span>
                    <span className="mg-muted mg-small">{profile.protocol}</span>
                    <span className="mg-profile-address">{profile.baseUrl}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="mg-panel mg-editor">
          {draft ? (
            <form
              onSubmit={(event) => {
                void save(event);
              }}
              aria-busy={saving}
            >
              <div className="mg-panel-heading">
                <h2 ref={formTitle} tabIndex={-1}>
                  {editingId ? "编辑配置" : "新增模型配置"}
                </h2>
                <span className="mg-tag">
                  {saving ? "保存中" : dirty ? "尚未保存" : editingId ? "已保存" : "草稿"}
                </span>
              </div>
              <fieldset disabled={saving} className="mg-fieldset">
                <div className="mg-form-grid">
                  <label className="mg-field" htmlFor="model-label">
                    显示名称
                    <input
                      id="model-label"
                      value={draft.label}
                      onChange={(event) => change("label", event.target.value)}
                      maxLength={120}
                      required
                      placeholder="我的日常模型"
                    />
                  </label>
                  <label className="mg-field" htmlFor="model-id">
                    配置标识
                    <input
                      id="model-id"
                      value={draft.id}
                      onChange={(event) => change("id", event.target.value)}
                      maxLength={80}
                      readOnly={editingId !== null}
                      required
                      pattern={"[a-zA-Z0-9][a-zA-Z0-9_\\-]*"}
                      aria-describedby="model-id-help"
                      placeholder="daily-model"
                    />
                    <span id="model-id-help" className="mg-field-help">
                      用于 CLI 和执行配置，使用字母、数字、下划线或连字符。
                    </span>
                  </label>
                  <label className="mg-field" htmlFor="model-protocol">
                    API 协议
                    <select
                      id="model-protocol"
                      value={draft.protocol}
                      onChange={(event) => change("protocol", event.target.value as ModelProtocol)}
                    >
                      {MODEL_PROTOCOLS.map((protocol) => (
                        <option key={protocol} value={protocol}>
                          {protocol}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="mg-field" htmlFor="model-name">
                    模型名称
                    <input
                      id="model-name"
                      value={draft.model}
                      onChange={(event) => change("model", event.target.value)}
                      required
                      maxLength={256}
                      placeholder="提供商支持的模型名称"
                    />
                  </label>
                  <label className="mg-field mg-span-two" htmlFor="model-url">
                    API 地址
                    <input
                      id="model-url"
                      type="url"
                      value={draft.baseUrl}
                      onChange={(event) => change("baseUrl", event.target.value)}
                      required
                      maxLength={2048}
                      placeholder="https://api.example.com/v1"
                      aria-describedby="model-url-help"
                    />
                    <span className="mg-field-help" id="model-url-help">
                      使用 HTTPS，或本机模型服务的 HTTP
                      地址。修改服务器来源时，需要替换或清除原密钥。
                    </span>
                  </label>
                  <label className="mg-field mg-span-two" htmlFor="model-key">
                    {previous?.credentialConfigured ? "替换 API 密钥" : "API 密钥"}
                    <input
                      id="model-key"
                      type="password"
                      autoComplete="new-password"
                      value={draft.apiKey}
                      onChange={(event) => change("apiKey", event.target.value)}
                      disabled={draft.clearApiKey}
                      maxLength={16384}
                      placeholder={
                        previous?.credentialConfigured
                          ? "留空保留已保存的密钥"
                          : "本机免密模型可以留空"
                      }
                      aria-describedby="model-key-help"
                    />
                    <span id="model-key-help" className="mg-field-help">
                      密钥只提交给本机服务器。页面不会读取已保存的密钥。
                    </span>
                  </label>
                </div>
                {previous?.credentialConfigured ? (
                  <label className="mg-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.clearApiKey}
                      onChange={(event) => {
                        change("clearApiKey", event.target.checked);
                        if (event.target.checked) change("apiKey", "");
                      }}
                    />
                    清除已保存的 API 密钥
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
                  disabled={saving}
                  onClick={() => {
                    setDraft(null);
                    setEditingId(null);
                    setSaveError("");
                    setSavedMessage("");
                  }}
                >
                  {dirty ? "放弃更改" : "关闭编辑"}
                </button>
                <button type="submit" className="mg-button" disabled={saving || loading}>
                  {saving ? "正在保存…" : "保存配置"}
                </button>
              </div>
            </form>
          ) : (
            <div className="mg-empty mg-editor-empty">
              <div className="mg-placeholder-symbol" aria-hidden="true">
                +
              </div>
              <h2>选择一份配置</h2>
              <p>点击左侧的已保存配置进行编辑，或新增一个模型连接。</p>
              <p className="mg-muted mg-small">保存状态与模型连接验证分开记录。</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
