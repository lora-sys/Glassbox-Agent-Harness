/**
 * @file apps/web/src/management/pages/PiPage.tsx
 * Page 7: PI (PI Engine & Models)
 *
 * Implements Section 20 of DESIGN.md:
 * - PI is model-centric execution core.
 * - Prohibits Codex Admin, Claude Code Admin, or multi-runtime policy UI.
 * - Preserves honest cost/quota state (never $0.00).
 */
import React, { useState } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { DataTable, type Column } from '../primitives/DataTable';
import { SettingsGroup, SettingsField } from '../primitives/SettingsGroup';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { Notice } from '../primitives/Tabs';
import { useManagementPiModels } from '../adapter';
import type { PiModelProjection } from '../types';

interface PiPageProps {
  onNavigate: (pageId: string) => void;
}

export const PiPage: React.FC<PiPageProps> = () => {
  const { data: res } = useManagementPiModels();
  const [models, setModels] = useState<PiModelProjection[]>(res?.data || []);
  const [feedback, setFeedback] = useState<string | null>(null);

  React.useEffect(() => {
    if (res?.data) setModels(res.data);
  }, [res?.data]);

  const defaultModel = models.find((m) => m.isDefault) || models[0];

  const handleSetDefault = (modelId: string) => {
    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        isDefault: m.id === modelId,
      }))
    );
    setFeedback(`已将 [${modelId}] 设为默认 PI 执行核心。`);
  };

  const columns: Column<PiModelProjection>[] = [
    {
      key: 'name',
      header: '模型配置与提供方',
      render: (m) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EntityMark kind="pi" size="sm" />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--ink)' }}>
              {m.name} {m.isDefault && <span style={{ color: 'var(--brand)', fontSize: 11 }}>(默认)</span>}
            </div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>
              {m.provider} · 上下文 {m.contextWindowTokens.toLocaleString()} tokens
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'state',
      header: '实现状态',
      render: (m) => <StatusBadge state={m.capabilityState} />,
    },
    {
      key: 'temp',
      header: '默认温度',
      render: (m) => <span className="mono">{m.temperature}</span>,
    },
    {
      key: 'tokens',
      header: '今日 Token',
      render: (m) => <span className="mono">{m.tokensToday.toLocaleString()}</span>,
    },
    {
      key: 'cost',
      header: '预估费用',
      render: (m) => (
        <span style={{ color: 'var(--metadata)' }}>
          {m.costStatus === 'unpriced' ? '成本不可用' : '未知'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      render: (m) => (
        <button
          type="button"
          className="btn secondary sm"
          disabled={m.isDefault}
          onClick={() => handleSetDefault(m.id)}
        >
          {m.isDefault ? '当前默认' : '设为默认'}
        </button>
      ),
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="PI 执行核心"
        description="PI 是 Personal Agent 的执行大脑。管理 PI 支持的模型清单、默认执行核心、采样参数及可用会话池。"
        capabilityState="已实现"
        customPill={{ text: 'PI 主路径', variant: 'ok' }}
      />

      {feedback && (
        <Notice variant="warn">
          {feedback}
          <button
            type="button"
            style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            onClick={() => setFeedback(null)}
          >
            关闭
          </button>
        </Notice>
      )}

      {/* Model Inventory Table */}
      <div>
        <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 14 }}>模型清单与运行计量</div>
        <DataTable
          data={models}
          columns={columns}
          keyExtractor={(m) => m.id}
        />
      </div>

      {/* PI Configuration Settings */}
      {defaultModel && (
        <SettingsGroup title="PI 核心采样与运行参数" subtitle="针对当前默认模型调整推理参数与上下文约束">
          <SettingsField
            id="pi-default-model"
            label="默认核心模型"
            description="主 Agent 推理与工具编排采用的核心语言模型"
          >
            <select
              id="pi-default-model"
              className="filterSelect"
              value={defaultModel.id}
              onChange={(e) => handleSetDefault(e.target.value)}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.provider})
                </option>
              ))}
            </select>
          </SettingsField>

          <SettingsField
            id="pi-temp"
            label="采样温度 (Temperature)"
            description="控制模型输出随机度与确定性"
          >
            <input
              id="pi-temp"
              type="number"
              min="0"
              max="1"
              step="0.1"
              defaultValue={defaultModel.temperature}
              className="filterInput"
              style={{ width: 100 }}
            />
          </SettingsField>

          <SettingsField
            id="pi-kit-profile"
            label="Lora PI Kit 运行 Profile"
            description="指定 Pi 容器装载的外部扩展与环境包"
          >
            <span className="mono" style={{ fontSize: 12, background: 'var(--sidebar)', padding: '4px 8px', borderRadius: 4 }}>
              lora-pi-kit:p3-closed-loop (v1.0.0-snapshot)
            </span>
          </SettingsField>
        </SettingsGroup>
      )}
    </div>
  );
};
