import { useEffect, useState } from "react";
import type { ManagementApi } from "./api";
import { failureMessage } from "./errors";
import type { DoctorCheck, ServiceStatus } from "./schema";

const capabilityLabels: Record<keyof ServiceStatus["capabilities"], string> = {
  modelConfiguration: "模型配置",
  channels: "消息渠道",
  conversations: "会话",
  runs: "任务",
  trace: "运行证据",
  eval: "Eval 验收",
};
const checkLabels = { detected: "已发现", missing: "未发现", error: "检查失败" };

export function Overview({
  api,
  initialStatus,
  openModels,
}: {
  api: ManagementApi;
  initialStatus: ServiceStatus;
  openModels: () => void;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState("");
  const [doctorError, setDoctorError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setStatusError("");
    setDoctorError("");
    void Promise.allSettled([api.status(controller.signal), api.doctor(controller.signal)]).then(
      ([service, doctor]) => {
        if (controller.signal.aborted) return;
        if (service.status === "fulfilled") setStatus(service.value);
        else setStatusError(failureMessage(service.reason));
        if (doctor.status === "fulfilled") setChecks(doctor.value);
        else setDoctorError(failureMessage(doctor.reason));
        setLoading(false);
      },
    );
    return () => controller.abort();
  }, [api, revision]);

  const platform =
    { win32: "Windows", darwin: "macOS", linux: "Linux" }[status.platform] ?? status.platform;
  return (
    <section aria-labelledby="overview-title">
      <div className="mg-section-heading">
        <div>
          <p className="mg-eyebrow">本机管理</p>
          <h1 id="overview-title">管理中心</h1>
          <p className="mg-muted">查看服务状态，配置同一个 Personal Agent 的执行入口。</p>
        </div>
        <button
          className="mg-button mg-secondary"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {loading ? "检查中…" : "刷新状态"}
        </button>
      </div>
      {statusError ? (
        <p className="mg-notice mg-error" role="alert">
          {statusError} 服务信息保留上次读取的结果。
        </p>
      ) : null}
      <div className="mg-overview-grid">
        <article className="mg-panel">
          <div className="mg-panel-heading">
            <h2>Glassbox 服务</h2>
            <span
              className={`mg-tag ${statusError ? "mg-tag-warning" : loading ? "" : "mg-tag-success"}`}
            >
              {statusError ? "状态未知" : loading ? "正在检查" : "管理 API 可访问"}
            </span>
          </div>
          <dl className="mg-facts">
            <div>
              <dt>运行平台</dt>
              <dd>{platform}</dd>
            </div>
            <div>
              <dt>服务版本</dt>
              <dd>{status.version}</dd>
            </div>
            <div>
              <dt>默认执行方式</dt>
              <dd>{status.defaultExecution}</dd>
            </div>
            <div>
              <dt>配置来源</dt>
              <dd>与 CLI 共用本机服务器</dd>
            </div>
          </dl>
        </article>
        <article className="mg-panel mg-model-summary">
          <p className="mg-eyebrow">模型与执行</p>
          <h2>使用你自己的模型提供商</h2>
          <p className="mg-muted">
            配置 API 协议、模型名称和凭据。已安装的本机执行器在下方单独检查。
          </p>
          <button className="mg-button" onClick={openModels}>
            管理模型配置
          </button>
          <p className="mg-small mg-muted">配置保存成功不代表已经通过模型调用测试。</p>
        </article>
      </div>
      <div className="mg-panel mg-doctor">
        <div className="mg-panel-heading">
          <div>
            <h2>本机执行器检查</h2>
            <p className="mg-muted mg-small">发现可执行文件不代表已登录，也不代表实际执行通过。</p>
          </div>
        </div>
        {doctorError ? (
          <p className="mg-notice mg-error" role="alert">
            {doctorError}
            {checks ? " 下方保留上次检查结果。" : ""}
          </p>
        ) : null}
        {loading && checks === null ? (
          <p className="mg-empty" role="status">
            正在检查本机环境…
          </p>
        ) : null}
        {checks?.length === 0 ? <p className="mg-empty">服务器没有返回诊断项目。</p> : null}
        {checks ? (
          <ul className="mg-check-list">
            {checks.map((check) => (
              <li key={check.id}>
                <div>
                  <strong>{check.label}</strong>
                  <p className="mg-muted mg-small">{check.message}</p>
                </div>
                <span
                  className={`mg-tag ${check.status === "detected" ? "mg-tag-success" : "mg-tag-warning"}`}
                >
                  {checkLabels[check.status]}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="mg-panel">
        <div className="mg-panel-heading">
          <h2>服务器已接入的管理能力</h2>
        </div>
        <ul className="mg-capability-list">
          {Object.entries(capabilityLabels).map(([key, label]) => (
            <li key={key}>
              <span>{label}</span>
              <span className="mg-muted">
                {statusError
                  ? "待重新确认"
                  : status.capabilities[key as keyof ServiceStatus["capabilities"]]
                    ? "已接入"
                    : "尚未接入"}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
