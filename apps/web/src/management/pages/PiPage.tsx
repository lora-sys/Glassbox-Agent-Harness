/**
 * @file apps/web/src/management/pages/PiPage.tsx
 * Page 7: PI (PI Engine & Models)
 *
 * Implements Section 20 of DESIGN.md & Section 17 of DESIGN_EVAL.md:
 * - PI is model-centric execution core.
 * - Strictly rejects Codex Admin, Claude Code Admin, or multi-runtime policy UI.
 * - Preserves honest cost/quota state (never $0.00 or fake zeros).
 * - Full frozen composition: PI Engine, Lora PI Kit, model cards/inventory,
 *   configuration profiles, usage table, session health, and resilience cases.
 */
import React, { useState, useEffect } from 'react';
import { PageHeader, SectionHeader } from '../primitives/PageHeader';
import { SummaryBar } from '../primitives/SummaryBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { SettingsGroup, SettingsField } from '../primitives/SettingsGroup';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { Notice } from '../primitives/Tabs';
import { useManagementPiModels, usePreferences, useManagementData } from '../adapter';
import { mockPiProfilesData, mockPiSessionHealthData } from '../fixtures/pi';
import type {
  PiModelProjection,
  PiProfileProjection,
  PiSessionHealthProjection,
} from '../types';

interface PiPageProps {
  onNavigate: (pageId: string) => void;
}

interface ModelUsageRow {
  modelId: string;
  runs: number;
  successRate: string;
  input: number;
  output: number;
  cache: number;
  reasoning: number;
  totalTokens: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  costDisplay: string;
}

const mockUsageRows: ModelUsageRow[] = [
  {
    modelId: 'claude-3-5-sonnet',
    runs: 142,
    successRate: '98.6%',
    input: 85000,
    output: 39000,
    cache: 16500,
    reasoning: 0,
    totalTokens: 124000,
    p50LatencyMs: 680,
    p95LatencyMs: 1420,
    costDisplay: '成本不可用 (未定价)',
  },
  {
    modelId: 'gpt-4o',
    runs: 48,
    successRate: '97.9%',
    input: 31000,
    output: 11500,
    cache: 10000,
    reasoning: 0,
    totalTokens: 42500,
    p50LatencyMs: 510,
    p95LatencyMs: 980,
    costDisplay: '成本不可用 (未定价)',
  },
  {
    modelId: 'deepseek-chat',
    runs: 16,
    successRate: '87.5%',
    input: 14000,
    output: 4000,
    cache: 0,
    reasoning: 12000,
    totalTokens: 18000,
    p50LatencyMs: 920,
    p95LatencyMs: 2400,
    costDisplay: '成本不可用 (未定价)',
  },
];

export const PiPage: React.FC<PiPageProps> = () => {
  const { data: res, isLoading, isError, error } = useManagementPiModels();
  const { mode } = useManagementData();
  const isLive = mode === 'live' || res?.source === 'api';
  const { settings } = usePreferences();
  const [models, setModels] = useState<PiModelProjection[]>(res?.data || []);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [selectedModelId, setSelectedModelId] = useState<string>(() => {
    return (res?.data?.find((m) => m.isDefault) || res?.data?.[0])?.id || 'claude-3-5-sonnet';
  });
  const [temperatureDrafts, setTemperatureDrafts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (res?.data) {
      setModels(res.data);
      setSelectedModelId((prev) => {
        if (res.data.some((m) => m.id === prev)) return prev;
        return (res.data.find((m) => m.isDefault) || res.data[0])?.id || prev;
      });
    }
  }, [res?.data]);

  const defaultModel = models.find((m) => m.isDefault) || models[0];
  const selectedModel = models.find((m) => m.id === selectedModelId) || defaultModel;

  const currentTemperature =
    selectedModel && temperatureDrafts[selectedModel.id] !== undefined
      ? temperatureDrafts[selectedModel.id]
      : selectedModel?.temperature ?? 0.2;

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载 PI 模型数据中...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="PI 执行核心"
          description="PI 是 Personal Agent 的执行大脑。管理 PI 支持的模型清单、默认执行核心、采样参数及可用会话池。"
          capabilityState="已实现"
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>模型数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取模型列表'}
        </div>
      </div>
    );
  }

  const handleSetDefault = (modelId: string) => {
    if (isLive) return;
    setSelectedModelId(modelId);
    setModels((prev) =>
      prev.map((m) => ({
        ...m,
        isDefault: m.id === modelId,
      }))
    );
    setFeedback(`[设计模拟] 本地模拟将 [${modelId}] 设为默认 PI 执行核心（本地设计草稿，未持久化至服务端配置）。`);
  };

  const handleModelSelect = (modelId: string) => {
    setSelectedModelId(modelId);
  };

  const handleApplyTemperature = () => {
    if (isLive) return;
    if (!selectedModel) return;
    setModels((prev) =>
      prev.map((m) =>
        m.id === selectedModel.id ? { ...m, temperature: currentTemperature } : m
      )
    );
    setFeedback(
      `[设计模拟] 已在本地设计草稿中更新模型 [${selectedModel.name || selectedModel.id}] 采样温度为 ${currentTemperature}，此为浏览器本地设计草稿，未向服务端持久化任何配置。`
    );
  };

  const columns: Column<PiModelProjection>[] = [
    {
      key: 'name',
      header: '模型配置与提供方',
      render: (m) => {
        const isCurrentDefault = m.id === defaultModel?.id || Boolean(m.isDefault);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <EntityMark kind="pi" size="sm" />
            <div>
              <div style={{ fontWeight: 600, color: 'var(--ink)' }}>
                {m.name} {isCurrentDefault && <span style={{ color: 'var(--brand)', fontSize: 11 }}>(默认)</span>}
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>
                {m.provider} · 上下文 {m.contextWindowTokens != null ? `${m.contextWindowTokens.toLocaleString()} tokens` : '未知'}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: 'state',
      header: '实现状态',
      render: (m) => <StatusBadge state={m.capabilityState} />,
    },
    {
      key: 'temp',
      header: '默认温度',
      render: (m) => <span className="mono">{m.temperature != null ? m.temperature : '—'}</span>,
    },
    {
      key: 'tokens',
      header: '今日 Token',
      render: (m) => <span className="mono">{m.tokensToday != null ? m.tokensToday.toLocaleString() : '未知'}</span>,
    },
    ...(settings?.unknownPricingDisplay === 'hide_cost'
      ? []
      : [
          {
            key: 'cost',
            header: '预估费用',
            render: (m: PiModelProjection) => (
              <span style={{ color: 'var(--metadata)' }}>
                {m.costStatus === 'priced' && m.costTodayUsd !== null
                  ? `$${m.costTodayUsd.toFixed(2)}`
                  : m.costStatus === 'unpriced'
                  ? '成本不可用'
                  : '未知'}
              </span>
            ),
          },
        ]),
    {
      key: 'quota',
      header: '可用配额',
      render: (m) => (
        <span style={{ color: 'var(--metadata)' }}>
          {m.quota ?? '未知 (未上报)'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      render: (m) => {
        const isCurrentDefault = m.id === defaultModel?.id || Boolean(m.isDefault);
        return (
          <button
            type="button"
            className="btn secondary sm"
            disabled={isLive || isCurrentDefault}
            aria-disabled={isLive || isCurrentDefault}
            onClick={() => handleSetDefault(m.id)}
            title={isLive ? '实时模式下远程 PI 配置变更为 P3 目标，当前视图为只读' : undefined}
          >
            {isCurrentDefault ? '当前默认' : isLive ? '只读 (P3)' : '设为默认'}
          </button>
        );
      },
    },
  ];

  const profileColumns: Column<PiProfileProjection>[] = [
    {
      key: 'name',
      header: 'Profile 标识',
      render: (p) => <span className="mono" style={{ fontWeight: 600 }}>{p.name}</span>,
    },
    {
      key: 'description',
      header: '适用场景说明',
      render: (p) => <span style={{ fontSize: 12 }}>{p.description}</span>,
    },
    {
      key: 'preset',
      header: '装载预设',
      render: (p) => <span className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{p.preset}</span>,
    },
    {
      key: 'tools',
      header: '工具数',
      render: (p) => <span className="mono">{p.toolsCount} 项</span>,
    },
    {
      key: 'extensions',
      header: '扩展模块',
      render: (p) => <span className="mono">{p.extensionsLoaded} 个</span>,
    },
  ];

  const sessionColumns: Column<PiSessionHealthProjection>[] = [
    {
      key: 'sessionId',
      header: 'PI 会话 ID',
      render: (s) => <span className="mono" style={{ fontWeight: 600 }}>{s.sessionId}</span>,
    },
    {
      key: 'model',
      header: '执行核心',
      render: (s) => <span className="mono" style={{ fontSize: 12 }}>{s.modelId}</span>,
    },
    {
      key: 'channel',
      header: '接入渠道',
      render: (s) => <span style={{ fontSize: 12 }}>{s.channel}</span>,
    },
    {
      key: 'status',
      header: '会话状态',
      render: (s) => (
        <StatusBadge variant={s.status === 'active' ? 'ok' : s.status === 'idle' ? 'teal' : 'neutral'}>
          {s.status.toUpperCase()}
        </StatusBadge>
      ),
    },
    {
      key: 'lastActivity',
      header: '最近交互',
      render: (s) => <span className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{s.lastActivity}</span>,
    },
  ];

  const usageColumns: Column<ModelUsageRow>[] = [
    {
      key: 'modelId',
      header: '模型',
      render: (u) => <span className="mono" style={{ fontWeight: 600 }}>{u.modelId}</span>,
    },
    {
      key: 'runs',
      header: '24h 执行数',
      render: (u) => <span className="mono">{u.runs} 次</span>,
    },
    {
      key: 'success',
      header: '成功率',
      render: (u) => <span className="mono" style={{ color: 'var(--success)' }}>{u.successRate}</span>,
    },
    {
      key: 'input',
      header: 'Input Tokens',
      render: (u) => <span className="mono">{u.input.toLocaleString()}</span>,
    },
    {
      key: 'output',
      header: 'Output Tokens',
      render: (u) => <span className="mono">{u.output.toLocaleString()}</span>,
    },
    {
      key: 'cache',
      header: 'Cache Tokens',
      render: (u) => <span className="mono">{u.cache.toLocaleString()}</span>,
    },
    {
      key: 'total',
      header: '总 Token',
      render: (u) => <span className="mono" style={{ fontWeight: 600 }}>{u.totalTokens.toLocaleString()}</span>,
    },
    {
      key: 'p50',
      header: 'P50 延迟',
      render: (u) => <span className="mono">{u.p50LatencyMs} ms</span>,
    },
    {
      key: 'p95',
      header: 'P95 延迟',
      render: (u) => <span className="mono" style={{ color: 'var(--warn)' }}>{u.p95LatencyMs} ms</span>,
    },
    ...(settings?.unknownPricingDisplay === 'hide_cost'
      ? []
      : [
          {
            key: 'cost',
            header: '预估费用 (USD)',
            render: (u: ModelUsageRow) => (
              <span style={{ color: 'var(--metadata)' }}>{u.costDisplay}</span>
            ),
          },
        ]),
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="PI 执行核心"
        description="PI 是 Personal Agent 的执行大脑。管理 PI 支持的模型清单、默认执行核心、采样参数及可用会话池。"
        capabilityState="已实现"
        customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
      />

      {isLive && (
        <Notice variant="info">
          远程 PI 执行核心与采样参数配置变更为 P3 目标，当前实时视图仅供审查（只读）。
        </Notice>
      )}

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

      {/* SummaryBar */}
      <SummaryBar
        items={[
          {
            label: '默认执行核心',
            value: defaultModel ? defaultModel.name : '未配置',
            meta: '主 Agent 推理与工具编排采用的核心',
          },
          {
            label: '今日 Token 消耗',
            value: isLive ? '未知' : '184,500',
            meta: isLive ? '实时指标管道未连接 (P3 目标)' : '跨 3 个模型会话累计用量',
            mono: true,
          },
          {
            label: '活跃会话池',
            value: isLive
              ? '未知'
              : `${mockPiSessionHealthData.filter((s) => s.status === 'active').length} 活跃 / ${mockPiSessionHealthData.length} 总计`,
            meta: isLive ? 'SessionManager 监控未连接 (P3 目标)' : 'SessionManager 状态正常',
          },
          {
            label: 'Lora PI Kit 版本',
            value: isLive ? '未知' : 'v1.0.0-snapshot',
            meta: isLive ? '未上报分发 Profile (P3 目标)' : 'Profile: lora-pi-kit:p3-closed-loop',
            mono: true,
          },
        ]}
      />

      {/* PI Engine & Lora PI Kit Architectural Panels (DESIGN.md §20 + frozen v24 composition: P3 目标) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 12 }}>
        <div
          style={{
            padding: 14,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>PI Engine 运行时状态</span>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
          </div>
          <div style={{ fontSize: 11, color: 'var(--metadata)', lineHeight: 1.6 }}>
            {isLive ? (
              <>
                <div>集成模式: <strong>未知</strong> · 引擎版本: <span className="mono">未知</span></div>
                <div>ModelRuntime: 未知 · SessionManager: 未知 · ResourceLoader: 未知</div>
                <div>Extension API: 未知 · customTools: 未知 · 会话恢复: 未知</div>
                <div style={{ marginTop: 4 }}>实时模式下 PI 执行核心遥测未上报 (P3 目标)</div>
              </>
            ) : (
              <>
                <div>集成模式: <strong>Pi Agent Engine (主路径)</strong> · 引擎版本: <span className="mono">v0.8.4</span></div>
                <div>ModelRuntime: 正常 · SessionManager: 活跃 · ResourceLoader: 在线</div>
                <div>Extension API: 4 个模块就绪 · customTools: 8 项已注册 · 会话恢复: Enabled</div>
              </>
            )}
          </div>
        </div>

        <div
          style={{
            padding: 14,
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>Lora PI Kit 预设与挂钩</span>
            <StatusBadge state="P3 目标" className="sm">P3 目标</StatusBadge>
          </div>
          <div style={{ fontSize: 11, color: 'var(--metadata)', lineHeight: 1.6 }}>
            {isLive ? (
              <>
                <div>内置钩子: <strong>未知</strong> (P3 目标)</div>
                <div>激活预设: <strong>未知</strong> (P3 目标)</div>
                <div>环境检查: <strong>未知</strong> (P3 目标)</div>
                <div style={{ marginTop: 4 }}>实时模式下 Lora PI Kit 分发 Profile 未上报 (P3 目标)</div>
              </>
            ) : (
              <>
                <div>内置钩子: <span className="mono">glassbox-policy-bridge.ts</span> · <span className="mono">trace-hooks.ts</span></div>
                <div>激活预设: <span className="mono">owner-direct</span> · <span className="mono">visitor-direct</span> · <span className="mono">qq-group</span></div>
                <div>环境检查: doctor / install tooling 全部通过 · 兼容 Pi 引擎 &gt;= 0.8.0</div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Model Inventory Table */}
      <div>
        <SectionHeader
          title="模型清单与运行计量"
          subtitle="管理当前已发现的核心模型，控制采样参数与默认路由"
        />
        <div style={{ marginTop: 8 }}>
          <DataTable
            data={models}
            columns={columns}
            keyExtractor={(m) => m.id}
          />
        </div>
      </div>

      {/* PI Configuration Settings */}
      {selectedModel && (
        <SettingsGroup title="PI 核心采样与运行参数" subtitle="针对当前选中核心模型调整推理参数与上下文约束">
          <SettingsField
            id="pi-default-model"
            label="核心模型选择"
            description={
              isLive
                ? "选择模型以审查其采样参数与运行状态（实时模式仅供审查，配置修改为 P3 目标）"
                : "主 Agent 推理与工具编排采用的核心语言模型"
            }
          >
            <select
              id="pi-default-model"
              className="filterSelect"
              value={selectedModel.id}
              onChange={(e) => {
                const newId = e.target.value;
                handleModelSelect(newId);
                // Set default temperature per model if not custom edited
                if (!isLive && temperatureDrafts[newId] === undefined) {
                  const targetModel = models.find((m) => m.id === newId);
                  if (targetModel && typeof targetModel.temperature === 'number') {
                    setTemperatureDrafts((prev) => ({
                      ...prev,
                      [newId]: targetModel.temperature!,
                    }));
                  }
                }
              }}
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
            description={
              isLive
                ? "当前模型采样温度（实时模式为服务端只读配置，远程配置变更为 P3 目标）"
                : "控制模型输出随机度与确定性"
            }
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                id="pi-temp"
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={currentTemperature}
                disabled={isLive}
                readOnly={isLive}
                aria-disabled={isLive}
                onChange={(e) => {
                  if (isLive) return;
                  const val = parseFloat(e.target.value);
                  setTemperatureDrafts((prev) => ({
                    ...prev,
                    [selectedModel.id]: isNaN(val) ? 0 : val,
                  }));
                }}
                className="filterInput"
                style={{ width: 100 }}
              />
              <button
                type="button"
                className="btn secondary sm"
                disabled={isLive}
                aria-disabled={isLive}
                onClick={handleApplyTemperature}
                aria-label="应用温度参数"
                title={isLive ? '实时模式下远程 PI 配置变更为 P3 目标，当前视图为只读' : undefined}
              >
                {isLive ? '只读 (P3)' : '应用参数'}
              </button>
            </div>
          </SettingsField>

          <SettingsField
            id="pi-kit-profile"
            label="Lora PI Kit 运行 Profile"
            description="指定 Pi 容器装载的外部扩展与环境包"
          >
            <span
              id="pi-kit-profile"
              className="mono"
              style={{ fontSize: 12, background: 'var(--sidebar)', padding: '4px 8px', borderRadius: 4 }}
            >
              {isLive ? '未上报 (P3 目标)' : 'lora-pi-kit:p3-closed-loop (v1.0.0-snapshot)'}
            </span>
          </SettingsField>
        </SettingsGroup>
      )}

      {/* Configuration Profiles Table */}
      <div>
        <SectionHeader
          title="Lora PI Kit 环境 Profile 清单"
          subtitle="按需装配沙盒权限、工具集及扩展模块"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 8,
              fontSize: 12,
            }}
          >
            Profile 注册表接口暂不可用 (P3 目标：需要 Lora PI Kit 运行时注册表)
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <DataTable
              data={mockPiProfilesData}
              columns={profileColumns}
              keyExtractor={(p) => p.id}
            />
          </div>
        )}
      </div>

      {/* PI Session Health Pool */}
      <div>
        <SectionHeader
          title="PI 会话池健康状态 (Session Pool Health)"
          subtitle="当前活跃的 SessionManager 隔离通道与接入端映射"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 8,
              fontSize: 12,
            }}
          >
            会话池健康度接口暂不可用 (P3 目标：需要 SessionManager 监控上报)
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <DataTable
              data={mockPiSessionHealthData}
              columns={sessionColumns}
              keyExtractor={(s) => s.sessionId}
            />
          </div>
        )}
      </div>

      {/* Detailed Model Usage Metrics */}
      <div>
        <SectionHeader
          title="模型用量与延迟指标汇总 (Model Usage & Latency)"
          subtitle="遵循 DESIGN.md 第 20 节用量数据模式，真实反映 Token 与延迟分位数"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 8,
              fontSize: 12,
            }}
          >
            细粒度延迟与用量统计接口暂不可用 (P3 目标：需要遥测指标导出器)
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <DataTable
              data={mockUsageRows}
              columns={usageColumns}
              keyExtractor={(u) => u.modelId}
            />
          </div>
        )}
      </div>

      {/* PI Version Compatibility & Resilience Reference */}
      <div>
        <SectionHeader
          title="执行核心故障隔离与降级边界 (Resilience & Versioning)"
          subtitle="遵循 DESIGN_EVAL.md 第 17 节：多模型降级、暂态超时熔断与版本不兼容防护"
          capabilityState={isLive ? 'P3 目标' : '设计数据'}
        />
        {isLive ? (
          <div
            style={{
              padding: 24,
              background: 'var(--surface)',
              border: '1px solid var(--line)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              color: 'var(--metadata)',
              marginTop: 8,
              fontSize: 12,
            }}
          >
            执行核心降级与熔断状态遥测暂不可用 (P3 目标：需要 PI 运行时健康上报)
          </div>
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 10, marginTop: 8 }}>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>暂态超时自动熔断</strong>
              <StatusBadge variant="warn" className="sm">CIRCUIT_BREAK</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>
              DeepSeek Chat 出现网络抖动超时时，自动降级至默认核心 Claude 3.5 Sonnet，不中断用户对话。
            </div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>未知配额与未定价模型</strong>
              <StatusBadge variant="neutral" className="sm">DATA_HONESTY</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>
              模型配额缺失时诚实渲染为「未知 (未上报)」，未定价模型显示为「成本不可用」，绝不伪造 $0.00。
            </div>
          </div>
          <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>版本兼容性锁定</strong>
              <StatusBadge variant="ok" className="sm">PINNED</StatusBadge>
            </div>
            <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 4 }}>
              严格绑定 Lora PI Kit 分发版本，检测到上游 Pi SDK 破坏性改动时立即进入自检阻断，杜绝隐蔽运行时故障。
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};
