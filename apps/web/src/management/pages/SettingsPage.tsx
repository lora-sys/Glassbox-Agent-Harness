/**
 * @file apps/web/src/management/pages/SettingsPage.tsx
 * Page 11: 设置 (Settings)
 *
 * Implements Section 27 of DESIGN.md:
 * - Native accessible form controls
 * - Configurable unknown pricing behavior
 * - Explicit local draft semantics
 */
import React, { useState } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { SettingsGroup, SettingsField } from '../primitives/SettingsGroup';
import { Notice } from '../primitives/Tabs';
import { useManagementSettings } from '../adapter';
import type { SettingsProjection } from '../types';

interface SettingsPageProps {
  onNavigate: (pageId: string) => void;
}

export const SettingsPage: React.FC<SettingsPageProps> = () => {
  const { data: res } = useManagementSettings();
  const [settings, setSettings] = useState<SettingsProjection>(
    res?.data || {
      retentionDays: 30,
      unknownPricingDisplay: 'show_unknown',
      defaultChannelPolicy: 'strict_allowlist',
      autoReviewOnWorkerDone: true,
      colorBlindMode: false,
      enableTraceKeyboardShortcuts: true,
      isLocalDraftDirty: false,
    }
  );

  const [feedback, setFeedback] = useState<string | null>(null);

  React.useEffect(() => {
    if (res?.data) setSettings(res.data);
  }, [res?.data]);

  const updateSetting = <K extends keyof SettingsProjection>(key: K, val: SettingsProjection[K]) => {
    setSettings((prev) => ({
      ...prev,
      [key]: val,
      isLocalDraftDirty: true,
    }));
  };

  const handleSave = () => {
    setSettings((prev) => ({ ...prev, isLocalDraftDirty: false }));
    setFeedback('[本地设计草稿] 设置已保存在浏览器临时会话中，未持久化至服务端配置。');
  };

  const handleReset = () => {
    if (res?.data) {
      setSettings({ ...res.data, isLocalDraftDirty: false });
      setFeedback('[本地设计草稿] 已重置回初始设计配置，未连接服务端。');
    }
  };

  return (
    <div className="pageContainer">
      <PageHeader
        title="系统设置 (Settings)"
        description="管理管理控制台的本地呈现偏好、追踪快捷键、未知计费展示策略与数据留存周期。"
        capabilityState="已实现"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            {settings.isLocalDraftDirty && (
              <button type="button" className="btn secondary sm" onClick={handleReset}>
                放弃修改
              </button>
            )}
            <button
              type="button"
              className="btn primary sm"
              disabled={!settings.isLocalDraftDirty}
              onClick={handleSave}
            >
              保存设置草稿
            </button>
          </div>
        }
      />

      {feedback && (
        <Notice variant="info">
          {feedback}
          <button
            type="button"
            style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => setFeedback(null)}
          >
            确定
          </button>
        </Notice>
      )}

      {/* Pricing & Data Display */}
      <SettingsGroup title="计费与数据真实性策略" subtitle="控制未定价模型与缺失遥测字段的呈现形式">
        <SettingsField
          id="setting-unknown-price"
          label="未知模型费用展示形式"
          description="系统严禁将未定价模型显示为 $0.00，以防向用户传递误导性确定性"
        >
          <select
            id="setting-unknown-price"
            className="filterSelect"
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
          description="本地 SQLite/Turso 与 R2 存储日志的滚动归档天数"
        >
          <input
            id="setting-retention"
            type="number"
            min="7"
            max="365"
            className="filterInput"
            style={{ width: 100 }}
            value={settings.retentionDays}
            onChange={(e) => updateSetting('retentionDays', Number(e.target.value))}
          />
        </SettingsField>
      </SettingsGroup>

      {/* Interaction & Accessibility */}
      <SettingsGroup title="交互与无障碍配置" subtitle="视口辅助与键盘快捷键">
        <SettingsField
          id="setting-shortcuts"
          label="启用 Trace 键盘快捷键"
          description="支持在追踪页面使用 j/k (下一项/上一项), e (展开载荷), / (全局搜索)"
        >
          <input
            id="setting-shortcuts"
            type="checkbox"
            style={{ width: 18, height: 18, cursor: 'pointer' }}
            checked={settings.enableTraceKeyboardShortcuts}
            onChange={(e) => updateSetting('enableTraceKeyboardShortcuts', e.target.checked)}
          />
        </SettingsField>

        <SettingsField
          id="setting-colorblind"
          label="色弱兼容辅助模式"
          description="强化图表线型 (实线/虚线/点线) 与多重几何图元标记，降低对色相依赖"
        >
          <input
            id="setting-colorblind"
            type="checkbox"
            style={{ width: 18, height: 18, cursor: 'pointer' }}
            checked={settings.colorBlindMode}
            onChange={(e) => updateSetting('colorBlindMode', e.target.checked)}
          />
        </SettingsField>
      </SettingsGroup>
    </div>
  );
};
