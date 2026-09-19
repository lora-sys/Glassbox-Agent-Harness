/**
 * @file apps/web/src/management/pages/SettingsPage.tsx
 * Page 11: 设置 (Settings)
 *
 * Implements Section 27 of DESIGN.md & Section 21 of DESIGN_EVAL.md:
 * - Six frozen groups: 通用, PI 核心, 渠道默认值, Trace 与证据, 任务协作, 告警与通知.
 * - Manages stable defaults only: product truth (Tasks, Conversations, Grants) is never edited here.
 * - Native accessible form controls, labeled with matching htmlFor / id.
 * - Explicit local draft semantics backed by sessionStorage with truthful feedback.
 * - Narrow-screen stacking and no horizontal overflow.
 */
import React, { useState, useEffect } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { SettingsGroup, SettingsField } from '../primitives/SettingsGroup';
import { StatusBadge } from '../primitives/StatusBadge';
import { Notice } from '../primitives/Tabs';
import { usePreferences, useManagementSettings, useManagementData, DEFAULT_PREFERENCES } from '../adapter';
import type { SettingsProjection } from '../types';

interface SettingsPageProps {
  onNavigate: (pageId: string) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = () => {
  const { data: res, isLoading, isError, error } = useManagementSettings();
  const { mode } = useManagementData();
  const isLive = mode === 'live' || res?.source === 'api';
  const { settings: sessionSettings, saveSettings, resetSettings } = usePreferences();

  const activeSettings = isLive && res?.data ? res.data : sessionSettings;
  const [settings, setSettings] = useState<SettingsProjection>(activeSettings);
  const [retentionInput, setRetentionInput] = useState<string>(() => String(activeSettings.retentionDays));
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (isLive && res?.data) {
      setSettings(res.data);
      setRetentionInput(String(res.data.retentionDays));
    } else if (!isLive) {
      setSettings(sessionSettings);
      setRetentionInput(String(sessionSettings.retentionDays));
    }
  }, [isLive, res?.data, sessionSettings]);

  if (isLive && isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载系统设置中...
        </div>
      </div>
    );
  }

  if (isLive && (isError || !res?.data)) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="系统设置 (Settings)"
          description="管理管理控制台的本地呈现偏好、追踪快捷键、未知计费展示策略与数据留存周期。系统配置仅管理稳定默认值，不可在此篡改任务真理与授权记录。"
          capabilityState="已实现"
          customPill={{ text: '实时接口', variant: 'ok' }}
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>设置数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取服务端系统设置'}
        </div>
      </div>
    );
  }

  const trimmedRetention = retentionInput.trim();
  let retentionError: string | null = null;
  if (!isLive) {
    if (trimmedRetention === '') {
      retentionError = '留存天数不能为空，请输入 7 至 365 之间的有效天数。';
    } else {
      const parsed = Number(trimmedRetention);
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 7 || parsed > 365) {
        retentionError = '留存天数必须为 7 至 365 之间的整数。';
      }
    }
  }

  const isSaveDisabled = isLive || !settings.isLocalDraftDirty || !!retentionError;

  const updateSetting = <K extends keyof SettingsProjection>(
    key: K,
    val: SettingsProjection[K]
  ) => {
    if (isLive) return;
    setSettings((prev) => ({
      ...prev,
      [key]: val,
      isLocalDraftDirty: true,
    }));
  };

  const handleSave = () => {
    if (isLive) return;
    if (retentionError) return;
    const finalRetention = Number(retentionInput.trim());
    saveSettings({ ...settings, retentionDays: finalRetention, isLocalDraftDirty: false });
    setSettings((prev) => ({ ...prev, retentionDays: finalRetention, isLocalDraftDirty: false }));
    setFeedback('[本地设计草稿] 设置已保存在浏览器临时会话中，未持久化至服务端配置。');
  };

  const handleReset = () => {
    if (isLive) return;
    resetSettings();
    setSettings({ ...DEFAULT_PREFERENCES, isLocalDraftDirty: false });
    setRetentionInput(String(DEFAULT_PREFERENCES.retentionDays));
    setFeedback('[本地设计草稿] 已重置回初始设计配置，未连接服务端。');
  };

  return (
    <div className="pageContainer">
      <PageHeader
        title="系统设置 (Settings)"
        description="管理管理控制台的本地呈现偏好、追踪快捷键、未知计费展示策略与数据留存周期。系统配置仅管理稳定默认值，不可在此篡改任务真理与授权记录。"
        capabilityState="已实现"
        customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {settings.isLocalDraftDirty && !isLive && (
              <span className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>
                (有未保存草稿)
              </span>
            )}
            <button
              type="button"
              className="btn secondary sm"
              disabled={isLive}
              aria-disabled={isLive}
              onClick={handleReset}
              title={isLive ? '实时模式下服务端设置修改为 P3 目标，当前为只读模式' : undefined}
            >
              {isLive ? '只读 (P3)' : '恢复默认设置'}
            </button>
            <button
              type="button"
              className="btn primary sm"
              disabled={isSaveDisabled}
              aria-disabled={isSaveDisabled}
              onClick={handleSave}
              title={isLive ? '实时模式下服务端设置修改为 P3 目标，当前为只读模式' : undefined}
            >
              {isLive ? '只读 (P3)' : '保存设置草稿'}
            </button>
          </div>
        }
      />

      {isLive && (
        <Notice variant="info">
          服务端系统设置持久化接口为 P3 目标。当前实时模式已加载只读服务端配置，禁止在本地模拟篡改或保存设置。
        </Notice>
      )}

      {feedback && (
        <Notice variant="info">
          {feedback}
          <button
            type="button"
            style={{
              marginLeft: 12,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
            onClick={() => setFeedback(null)}
          >
            确定
          </button>
        </Notice>
      )}

      {/* 1. 通用 (General) */}
      <SettingsGroup title="通用配置 (General)" subtitle="界面呈现、本地语言与展示偏好">
        <SettingsField
          id="setting-language"
          label="界面语言 (Language)"
          description="管理控制台默认语言与区域文化格式 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-language" className="filterSelect" defaultValue="zh-CN" disabled aria-disabled="true">
              <option value="zh-CN">简体中文 (zh-CN)</option>
              <option value="en-US">English (en-US)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>

        <SettingsField
          id="setting-density"
          label="排版密度 (Density)"
          description="数据表格与列表边距紧凑程度 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-density" className="filterSelect" defaultValue="comfortable" disabled aria-disabled="true">
              <option value="comfortable">标准模式 (Comfortable)</option>
              <option value="compact">紧凑模式 (Compact)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>

        <SettingsField
          id="setting-currency"
          label="计费货币单位 (Cost Currency)"
          description="Token 预估费用展示单位 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-currency" className="filterSelect" defaultValue="USD" disabled aria-disabled="true">
              <option value="USD">美元 (USD $)</option>
              <option value="CNY">人民币 (CNY ¥)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>
      </SettingsGroup>

      {/* 2. PI 核心 (PI Core) */}
      <SettingsGroup title="PI 核心执行配置 (PI Core)" subtitle="主 Agent 执行引擎模型与 Profile">
        <SettingsField
          id="setting-pi-model"
          label="默认执行核心模型"
          description="系统冷启动与未指定模型时调用的主要语言模型 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-pi-model" className="filterSelect" defaultValue="claude-3-5-sonnet" disabled aria-disabled="true">
              <option value="claude-3-5-sonnet">Claude 3.5 Sonnet (默认执行核心)</option>
              <option value="gpt-4o">GPT-4o (多模态与快响应)</option>
              <option value="deepseek-chat">DeepSeek Chat (V3)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>

        <SettingsField
          id="setting-pi-profile"
          label="Lora PI Kit 运行时 Profile"
          description="当前环境装载的外部扩展与环境包 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <output
              id="setting-pi-profile"
              className="mono"
              style={{ fontSize: 12, background: 'var(--sidebar)', padding: '4px 8px', borderRadius: 4, display: 'inline-block' }}
            >
              lora-pi-kit:p3-closed-loop
            </output>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>

        <SettingsField
          id="setting-pi-compat"
          label="PI 引擎严格兼容检查"
          description="检测到不兼容的 PI SDK 版本时强制进入只读防护模式 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-pi-compat" className="filterSelect" defaultValue="strict" disabled aria-disabled="true">
              <option value="strict">严格模式 (Strict - 推荐)</option>
              <option value="permissive">宽容模式 (Permissive)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>
      </SettingsGroup>

      {/* 3. 渠道默认值 (Channel Defaults) */}
      <SettingsGroup title="渠道默认值配置 (Channel Defaults)" subtitle="外部协议网关入站准则与默认隔离策略">
        <SettingsField
          id="setting-channel-policy"
          label="默认渠道入站策略"
          description="新接入渠道未配置独立规则时的缺省安全限制"
        >
          <select
            id="setting-channel-policy"
            className="filterSelect"
            disabled={isLive}
            aria-disabled={isLive}
            value={settings.defaultChannelPolicy}
            onChange={(e) => updateSetting('defaultChannelPolicy', e.target.value as any)}
          >
            <option value="strict_allowlist">白名单与 Owner 直通 (Strict Allowlist)</option>
            <option value="owner_only">仅所有者私聊直通 (Owner Only)</option>
          </select>
        </SettingsField>

        <SettingsField
          id="setting-qq-activation"
          label="QQ 群聊激活规则"
          description="群消息激活 Agent 的默认触发判定 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-qq-activation" className="filterSelect" defaultValue="mention_only" disabled aria-disabled="true">
              <option value="mention_only">显式 @Agent 激活 (推荐)</option>
              <option value="all_messages">全量入站审查 (All Messages)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>

        <SettingsField
          id="setting-event-dedupe"
          label="重复事件幂等去重"
          description="根据 message_id 自动抑制外部通道重放事件 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-event-dedupe" className="filterSelect" defaultValue="enabled" disabled aria-disabled="true">
              <option value="enabled">启用去重抑制 (Enabled)</option>
              <option value="disabled">关闭去重 (Disabled)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>
      </SettingsGroup>

      {/* 4. Trace 与证据 (Trace & Evidence) */}
      <SettingsGroup title="Trace 与证据策略 (Trace & Evidence)" subtitle="控制未定价模型呈现、日志留存天数与屏幕脱敏">
        <SettingsField
          id="setting-unknown-price"
          label="未知模型费用展示形式"
          description="系统严禁将未定价模型显示为 $0.00，以防向用户传递误导性确定性"
        >
          <select
            id="setting-unknown-price"
            className="filterSelect"
            disabled={isLive}
            aria-disabled={isLive}
            value={settings.unknownPricingDisplay}
            onChange={(e) => updateSetting('unknownPricingDisplay', e.target.value as any)}
          >
            <option value="show_unknown">显示为「成本不可用 / 未知」</option>
            <option value="hide_cost">隐藏费用列</option>
          </select>
        </SettingsField>

        <SettingsField
          id="setting-retention"
          label="Trace 证据留存周期 (天)"
          description="本地 SQLite/Turso 与 R2 存储日志的滚动归档天数 (7 至 365 天)"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input
              id="setting-retention"
              type="number"
              min="7"
              max="365"
              className="filterInput"
              disabled={isLive}
              readOnly={isLive}
              aria-disabled={isLive}
              style={{
                width: 100,
                borderColor: retentionError ? 'var(--danger)' : undefined,
                cursor: isLive ? 'not-allowed' : undefined,
              }}
              value={retentionInput}
              aria-invalid={retentionError ? 'true' : 'false'}
              aria-describedby={retentionError ? 'setting-retention-error' : undefined}
              onChange={(e) => {
                if (isLive) return;
                const rawVal = e.target.value;
                setRetentionInput(rawVal);
                setSettings((prev) => ({ ...prev, isLocalDraftDirty: true }));
              }}
            />
            {retentionError && (
              <div
                id="setting-retention-error"
                role="alert"
                style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}
              >
                {retentionError}
              </div>
            )}
          </div>
        </SettingsField>

        <SettingsField
          id="setting-shortcuts"
          label="启用 Trace 键盘快捷键"
          description="支持在追踪页面使用 j/k (下一项/上一项), e (展开载荷), / (全局搜索)"
        >
          <input
            id="setting-shortcuts"
            type="checkbox"
            disabled={isLive}
            aria-disabled={isLive}
            style={{ width: 18, height: 18, cursor: isLive ? 'not-allowed' : 'pointer' }}
            checked={settings.enableTraceKeyboardShortcuts}
            onChange={(e) => updateSetting('enableTraceKeyboardShortcuts', e.target.checked)}
          />
        </SettingsField>

        <SettingsField
          id="setting-sanitize"
          label="敏感信息屏幕过滤 (Secret Screening)"
          description="界面展示时自动遮罩密钥、Token 与内部敏感文件路径 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-sanitize" className="filterSelect" defaultValue="enabled" disabled aria-disabled="true">
              <option value="enabled">开启屏幕脱敏遮罩 (Screen Redacted)</option>
              <option value="disabled">显示原始未脱敏文本 (需高权限)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>
      </SettingsGroup>

      {/* 5. 任务协作 (Task Collaboration) */}
      <SettingsGroup title="任务协作配置 (Task Collaboration)" subtitle="Herdr 宿主交互、任务验收与重连策略">
        <SettingsField
          id="setting-auto-review"
          label="Worker 完成自动转入验收"
          description="当 Herdr Worker 上报 done 状态时，Glassbox 自动生成待办关注事项"
        >
          <input
            id="setting-auto-review"
            type="checkbox"
            disabled={isLive}
            aria-disabled={isLive}
            style={{ width: 18, height: 18, cursor: isLive ? 'not-allowed' : 'pointer' }}
            checked={settings.autoReviewOnWorkerDone}
            onChange={(e) => updateSetting('autoReviewOnWorkerDone', e.target.checked)}
          />
        </SettingsField>

        <SettingsField
          id="setting-herdr-timeout"
          label="Herdr 心跳滞后判定阈值"
          description="心跳超出此时间标记为 STALE 观测状态 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-herdr-timeout" className="filterSelect" defaultValue="30s" disabled aria-disabled="true">
              <option value="15s">15 秒 (严密)</option>
              <option value="30s">30 秒 (默认)</option>
              <option value="60s">60 秒 (宽容)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>

        <SettingsField
          id="setting-reconnect"
          label="断线自愈重连机制"
          description="宿主连接断开后的重试退避方案 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-reconnect" className="filterSelect" defaultValue="exponential" disabled aria-disabled="true">
              <option value="exponential">指数退避重试 (Exponential Backoff)</option>
              <option value="linear">线性间隔重试 (Linear)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>
      </SettingsGroup>

      {/* 6. 告警与通知 (Alerts & Notifications) */}
      <SettingsGroup title="告警与无障碍辅助 (Alerts & Accessibility)" subtitle="无障碍视觉辅助模式与高风险事件通知">
        <SettingsField
          id="setting-colorblind"
          label="色弱兼容辅助模式"
          description="强化图表线型 (实线/虚线/点线) 与多重几何图元标记，降低对色相依赖"
        >
          <input
            id="setting-colorblind"
            type="checkbox"
            disabled={isLive}
            aria-disabled={isLive}
            style={{ width: 18, height: 18, cursor: isLive ? 'not-allowed' : 'pointer' }}
            checked={settings.colorBlindMode}
            onChange={(e) => updateSetting('colorBlindMode', e.target.checked)}
          />
        </SettingsField>

        <SettingsField
          id="setting-notify-review"
          label="任务待办与验收通知"
          description="有新的 Worker 提交待验收结果时即时通知 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-notify-review" className="filterSelect" defaultValue="enabled" disabled aria-disabled="true">
              <option value="enabled">启用通知 (Enabled)</option>
              <option value="disabled">静音 (Disabled)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>

        <SettingsField
          id="setting-notify-auth"
          label="越权与门禁拦截告警"
          description="发生 DENY 拦截或未授权尝试时记录高优先级告警 (暂未支持配置)"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <select id="setting-notify-auth" className="filterSelect" defaultValue="enabled" disabled aria-disabled="true">
              <option value="enabled">启用拦截告警 (Enabled)</option>
              <option value="disabled">关闭告警 (Disabled)</option>
            </select>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
            <span style={{ fontSize: 11, color: 'var(--metadata)', whiteSpace: 'nowrap' }}>暂未支持配置</span>
          </div>
        </SettingsField>
      </SettingsGroup>
    </div>
  );
};
