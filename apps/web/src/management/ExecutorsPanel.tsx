import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { PublicExecutor, PublicModelProfile } from "@glassbox/contracts";
import type { ManagementApi } from "./api";
import { buildExecutorSave, executorDraftFor } from "./executor-schema";
import type { ExecutorDraft } from "./executor-schema";
import { failureMessage } from "./errors";
import { RecordTime } from "./RecordPrimitives";

export function ExecutorsPanel({ api }: { api: ManagementApi }) {
  const [executor, setExecutor] = useState<PublicExecutor | null>(null);
  const [models, setModels] = useState<PublicModelProfile[]>([]);
  const [draft, setDraft] = useState<ExecutorDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [modelError, setModelError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [checkError, setCheckError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [pending, setPending] = useState<"save" | "check" | null>(null);
  const [revision, setRevision] = useState(0);
  const action = useRef<AbortController | null>(null);
  const draftRef = useRef<ExecutorDraft | null>(null);
  const currentExecutor = useRef<PublicExecutor | null>(null);
  const generation = useRef(0);
  const dirty =
    draft !== null &&
    executor !== null &&
    JSON.stringify(draft) !== JSON.stringify(executorDraftFor(executor));
  const selectedModel = models.find((model) => model.id === draft?.modelProfileId);
  const checking = pending === "check" || executor?.checking === true;
  const busy = loading || pending !== null || executor?.checking === true;

  useEffect(() => {
    const controller = new AbortController();
    const currentGeneration = generation.current;
    setLoading(true);
    void Promise.allSettled([api.executors(controller.signal), api.models(controller.signal)]).then(
      ([executors, profiles]) => {
        if (controller.signal.aborted || currentGeneration !== generation.current) return;
        if (executors.status === "fulfilled") {
          const next = executors.value[0] ?? null;
          const draftChanged =
            draftRef.current &&
            currentExecutor.current &&
            JSON.stringify(draftRef.current) !==
              JSON.stringify(executorDraftFor(currentExecutor.current));
          setExecutor(next);
          currentExecutor.current = next;
          setLoadError("");
          if (!draftChanged) {
            const nextDraft = next ? executorDraftFor(next) : null;
            setDraft(nextDraft);
            draftRef.current = nextDraft;
          }
        } else {
          setExecutor(null);
          setLoadError(failureMessage(executors.reason));
        }
        if (profiles.status === "fulfilled") {
          setModels(profiles.value.filter((profile) => profile.protocol === "anthropic-messages"));
          setModelError("");
        } else {
          setModels([]);
          setModelError("模型配置读取失败，请刷新后再选择配置来源。");
        }
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [api, revision]);
  useEffect(() => () => action.current?.abort(), []);
  useEffect(() => {
    if (!executor?.checking || pending !== null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = (await api.executors(controller.signal))[0] ?? null;
        if (controller.signal.aborted) return;
        const draftChanged =
          draftRef.current &&
          currentExecutor.current &&
          JSON.stringify(draftRef.current) !==
            JSON.stringify(executorDraftFor(currentExecutor.current));
        setExecutor(next);
        currentExecutor.current = next;
        setLoadError("");
        if (!draftChanged) {
          const nextDraft = next ? executorDraftFor(next) : null;
          setDraft(nextDraft);
          draftRef.current = nextDraft;
        }
        if (next?.checking)
          timer = setTimeout(() => {
            void read();
          }, 2000);
      } catch (error) {
        if (!controller.signal.aborted) {
          setExecutor(null);
          setLoadError(failureMessage(error));
        }
      }
    };
    timer = setTimeout(() => {
      void read();
    }, 2000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, executor?.checking, pending]);

  function update(field: keyof ExecutorDraft, value: string) {
    if (!draft) return;
    const next = { ...draft, [field]: value } as ExecutorDraft;
    if (field === "credentialSource" && value === "local-claude") next.modelProfileId = "";
    setDraft(next);
    draftRef.current = next;
    setSavedMessage("");
    setSaveError("");
  }
  function accept(next: PublicExecutor) {
    setExecutor(next);
    currentExecutor.current = next;
    const nextDraft = executorDraftFor(next);
    setDraft(nextDraft);
    draftRef.current = nextDraft;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !executor || action.current || busy) return;
    setSaveError("");
    setSavedMessage("");
    let input;
    try {
      input = buildExecutorSave(draft);
    } catch (error) {
      setSaveError(failureMessage(error));
      return;
    }
    const controller = new AbortController();
    action.current = controller;
    generation.current += 1;
    setPending("save");
    try {
      const next = await api.saveExecutor(input, controller.signal);
      if (!controller.signal.aborted) {
        accept(next);
        setSavedMessage("执行器配置已保存。保存不会调用模型，群聊支持需要重新检查。");
      }
    } catch (error) {
      if (!controller.signal.aborted) setSaveError(failureMessage(error));
    } finally {
      generation.current += 1;
      if (action.current === controller) action.current = null;
      if (!controller.signal.aborted) {
        setPending(null);
        setRevision((value) => value + 1);
      }
    }
  }
  async function check() {
    if (!executor || busy || dirty || action.current || !executor.executableDetected) return;
    const controller = new AbortController();
    action.current = controller;
    generation.current += 1;
    setPending("check");
    setCheckError("");
    try {
      const next = await api.checkClaudeExecutor(controller.signal);
      if (!controller.signal.aborted) {
        accept(next);
        if (next.lastCheck?.status !== "passed")
          setCheckError("执行器检查未通过。请检查本机安装、凭据来源、模型名称和服务可用性。");
      }
    } catch (error) {
      if (!controller.signal.aborted) setCheckError(failureMessage(error));
    } finally {
      generation.current += 1;
      if (action.current === controller) action.current = null;
      if (!controller.signal.aborted) {
        setPending(null);
        setRevision((value) => value + 1);
      }
    }
  }
  return (
    <section className="mg-executors" aria-labelledby="executors-title">
      <div className="mg-section-heading">
        <div>
          <p className="mg-eyebrow">本机执行</p>
          <h1 id="executors-title">本机执行器</h1>
          <p className="mg-muted">
            用已安装的 Claude Code 执行个人助理任务。配置来源和可用性检查分别管理。
          </p>
        </div>
        <button
          className="mg-button mg-secondary"
          disabled={loading || pending !== null}
          onClick={() => setRevision((value) => value + 1)}
        >
          {loading ? "读取中…" : "刷新状态"}
        </button>
      </div>
      {loadError ? (
        <p className="mg-notice mg-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {!executor && loading ? (
        <p className="mg-empty" role="status">
          正在读取本机执行器…
        </p>
      ) : null}
      {!executor && !loading && !loadError ? (
        <p className="mg-empty">服务器尚未提供本机执行器配置。</p>
      ) : null}
      {executor && draft ? (
        <div className="mg-executor-layout">
          <div className="mg-executor-settings">
            <div className="mg-record-heading">
              <div>
                <h2>Claude Code</h2>
                <p className="mg-small mg-muted">默认个人助理执行方式</p>
              </div>
              <span className="mg-tag">
                {pending === "save" ? "保存中" : dirty ? "尚未保存" : "已保存"}
              </span>
            </div>
            <form
              onSubmit={(event) => {
                void save(event);
              }}
              aria-busy={pending === "save"}
            >
              <fieldset className="mg-fieldset" disabled={busy}>
                <div className="mg-form-grid">
                  <label className="mg-field mg-span-two" htmlFor="executor-source">
                    凭据来源
                    <select
                      id="executor-source"
                      value={draft.credentialSource}
                      onChange={(event) => update("credentialSource", event.target.value)}
                      aria-describedby="executor-source-help"
                    >
                      <option value="local-claude">本机已有 Claude 配置</option>
                      <option value="model-profile">已保存的 Anthropic 模型配置</option>
                    </select>
                    <span className="mg-field-help" id="executor-source-help">
                      服务端只提取凭据、服务地址和模型配置，不应用本机的 hooks、skills
                      或权限设置。浏览器不读取 Claude 密钥。
                    </span>
                  </label>
                  {draft.credentialSource === "model-profile" ? (
                    <label className="mg-field mg-span-two" htmlFor="executor-profile">
                      Anthropic 模型配置
                      <select
                        id="executor-profile"
                        required
                        value={draft.modelProfileId}
                        onChange={(event) => update("modelProfileId", event.target.value)}
                        aria-describedby="executor-profile-help"
                      >
                        <option value="">请选择模型配置</option>
                        {draft.modelProfileId && !selectedModel ? (
                          <option value={draft.modelProfileId}>
                            {draft.modelProfileId} · 当前列表未找到
                          </option>
                        ) : null}
                        {models.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label} · {model.model}
                            {model.credentialConfigured ? "" : " · 未配置凭据"}
                          </option>
                        ))}
                      </select>
                      <span className="mg-field-help" id="executor-profile-help">
                        这里只显示 anthropic-messages 配置。缺少凭据时，执行器检查不能通过。
                      </span>
                      {modelError ? (
                        <span className="mg-field-help" role="status">
                          {modelError}
                        </span>
                      ) : null}
                    </label>
                  ) : null}
                  <label className="mg-field mg-span-two" htmlFor="executor-model">
                    模型名称覆盖
                    <input
                      id="executor-model"
                      value={draft.model}
                      onChange={(event) => update("model", event.target.value)}
                      maxLength={256}
                      placeholder="留空使用来源配置的模型"
                      aria-describedby="executor-model-help"
                    />
                    <span className="mg-field-help" id="executor-model-help">
                      仅在需要指定其他模型时填写，留空不覆盖来源配置。
                    </span>
                  </label>
                </div>
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
                  className="mg-button mg-secondary"
                  type="button"
                  disabled={busy || !dirty}
                  onClick={() => {
                    accept(executor);
                    setSaveError("");
                    setSavedMessage("");
                  }}
                >
                  放弃更改
                </button>
                <button className="mg-button" type="submit" disabled={busy}>
                  {pending === "save" ? "正在保存…" : "保存配置"}
                </button>
              </div>
            </form>
          </div>
          <aside className="mg-executor-check" aria-labelledby="executor-check-title">
            <p className="mg-eyebrow">可用性检查</p>
            <h2 id="executor-check-title">检查后用于群聊</h2>
            <dl className="mg-facts">
              <div>
                <dt>本机安装</dt>
                <dd>{executor.executableDetected ? "已发现 Claude Code" : "未发现 Claude Code"}</dd>
              </div>
              <div>
                <dt>默认工具</dt>
                <dd>不开放工具</dd>
              </div>
              <div>
                <dt>群聊支持</dt>
                <dd>
                  {checking
                    ? "检查进行中"
                    : executor.groupSupported && executor.executableDetected
                      ? "可用于已配置的群聊"
                      : "尚不可用于群聊"}
                </dd>
              </div>
              <div>
                <dt>最近检查</dt>
                <dd>
                  {executor.lastCheck ? (
                    <>
                      <span>
                        {executor.lastCheck.status === "passed" ? "检查通过" : "检查失败"}
                      </span>
                      <br />
                      <RecordTime value={executor.lastCheck.checkedAt} />
                    </>
                  ) : (
                    "尚未检查"
                  )}
                </dd>
              </div>
            </dl>
            {executor.lastCheck?.status === "failed" ? (
              <p className="mg-notice mg-error">最近一次检查失败。修正配置后再次检查。</p>
            ) : null}
            <p className="mg-small mg-muted mg-check-explanation">
              检查会使用已保存的配置，启动本机 Claude Code
              并发出一次模型请求，可能产生少量费用。检查不会发送 QQ 消息。
            </p>
            <button
              className="mg-button"
              disabled={busy || dirty || !executor.executableDetected}
              onClick={() => {
                void check();
              }}
            >
              {checking ? "正在调用模型检查…" : "调用模型检查"}
            </button>
            {dirty ? <p className="mg-field-help">请先保存配置，再检查执行器。</p> : null}
            {checking ? (
              <p className="mg-small mg-muted" role="status">
                正在等待本机执行器返回。离开此页不保证终止已开始的检查。
              </p>
            ) : null}
            {checkError ? (
              <p className="mg-notice mg-error" role="alert">
                {checkError}
              </p>
            ) : null}
          </aside>
        </div>
      ) : null}
      <div className="mg-executor-other">
        <div>
          <h2>Codex</h2>
          <p className="mg-muted">
            可通过现有工作区使用。接入个人助理 Run 的适配仍在进行，此处暂不提供 Codex 配置和检查。
          </p>
        </div>
        <a className="mg-inline-link" href="/">
          打开工作区
        </a>
      </div>
    </section>
  );
}
