/**
 * @file apps/web/src/management/pages/IdentityPage.tsx
 * Page 4: 身份与访问 (Identity & Access)
 */
import React, { useState } from 'react';
import { PageHeader, SectionHeader } from '../primitives/PageHeader';
import { SummaryBar } from '../primitives/SummaryBar';
import { FilterBar } from '../primitives/FilterBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { useManagementPrincipals, useManagementData } from '../adapter';
import type { PrincipalProjection, ResourceRelationshipProjection } from '../types';

const mockResourceRelationships: ResourceRelationshipProjection[] = [
  {
    id: 'rel-1',
    resource: 'workspace://glassbox-main',
    ownerPrincipal: 'owner_primary',
    relation: 'owner',
    provenance: '系统初始化配置，根所有权不可撤销',
  },
  {
    id: 'rel-2',
    resource: 'r2://artifacts/task-218/*',
    ownerPrincipal: 'worker_herdr_04',
    relation: 'delegate',
    provenance: '派生自 Task task-218 执行委托，仅在运行期间生效',
  },
  {
    id: 'rel-3',
    resource: 'conversation://conv_qq_group_test',
    ownerPrincipal: 'visitor_guest_99',
    relation: 'reader',
    provenance: 'QQ 8839210 群公开交互记录，脱敏后只读',
  },
];

interface IdentityPageProps {
  onNavigate: (pageId: string, extraSearch?: Record<string, unknown>) => void;
  selectedId?: string;
  onSelectId?: (id: string | null) => void;
}

export const IdentityPage: React.FC<IdentityPageProps> = ({
  onNavigate,
  selectedId: propSelectedId,
  onSelectId,
}) => {
  const { data: res, isLoading, isError, error } = useManagementPrincipals();
  const { mode } = useManagementData();
  const isLive = mode === 'live' || res?.source === 'api';
  const principals = res?.data || [];
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(
    propSelectedId !== undefined ? propSelectedId : 'owner_primary'
  );
  const [search, setSearch] = useState('');

  React.useEffect(() => {
    if (propSelectedId !== undefined) {
      setLocalSelectedId(propSelectedId);
    }
  }, [propSelectedId]);

  const effectiveId = propSelectedId !== undefined ? propSelectedId : localSelectedId;

  // Safe selection: if an ID is provided, ONLY match if found; otherwise null.
  const selectedPrincipal = React.useMemo(() => {
    if (propSelectedId !== undefined) {
      if (!propSelectedId) return null;
      return principals.find((p) => p.id === propSelectedId) ?? null;
    }
    if (!effectiveId) return null;
    return principals.find((p) => p.id === effectiveId) ?? null;
  }, [principals, propSelectedId, effectiveId]);

  const handleSelectPrincipal = (id: string | null) => {
    setLocalSelectedId(id);
    onSelectId?.(id);
  };

  const filtered = principals.filter(
    (p) =>
      p.userDisplayName.toLowerCase().includes(search.toLowerCase()) ||
      p.id.toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading) {
    return (
      <div className="pageContainer">
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--metadata)' }}>
          加载身份数据中...
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="pageContainer">
        <PageHeader
          title="身份与访问 (Identity & Access)"
          description="审查多渠道映射链条：ChannelIdentity → User → Principal。确保身份解析与鉴权边界严密无死角。"
          capabilityState="已实现"
        />
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--danger)' }} role="alert">
          <strong>主体数据加载失败</strong>: {error instanceof Error ? error.message : '无法获取主体列表'}
        </div>
      </div>
    );
  }

  const columns: Column<PrincipalProjection>[] = [
    {
      key: 'principal',
      header: '主体标识 (Principal)',
      render: (p) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <EntityMark kind="principal" size="sm" />
          <div>
            <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{p.userDisplayName}</div>
            <div className="mono" style={{ fontSize: 11, color: 'var(--metadata)' }}>{p.id}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: '角色类型',
      render: (p) => {
        let variant: 'ok' | 'warn' | 'bad' | 'neutral' | 'teal' = 'neutral';
        if (p.role === 'owner') variant = 'ok';
        else if (p.role === 'worker') variant = 'teal';
        else if (p.role === 'visitor') variant = 'warn';
        return <StatusBadge variant={variant}>{p.role.toUpperCase()}</StatusBadge>;
      },
    },
    {
      key: 'channels',
      header: '绑定渠道身份',
      render: (p) => (
        <span style={{ fontSize: 12 }}>
          {p.channelIdentities.length} 个渠道映射
        </span>
      ),
    },
    {
      key: 'delegation',
      header: '委派边界',
      render: (p) => <span className="mono" style={{ fontSize: 11 }}>{p.delegationLimit}</span>,
    },
    {
      key: 'lastActive',
      header: '最后活跃',
      render: (p) => <span style={{ fontSize: 12, color: 'var(--metadata)' }}>{p.lastActiveAt}</span>,
    },
  ];

  return (
    <div className="pageContainer">
      <PageHeader
        title="身份与访问 (Identity & Access)"
        description="审查多渠道映射链条：ChannelIdentity → User → Principal。确保身份解析与鉴权边界严密无死角。"
        capabilityState="已实现"
        customPill={{ text: isLive ? '实时接口' : '设计数据', variant: isLive ? 'ok' : 'neutral' }}
      />

      {/* Summary Bar */}
      <SummaryBar
        items={[
          {
            label: '认证主体数',
            value: principals.length,
            meta: '有效 Principal',
          },
          {
            label: '渠道映射数',
            value: principals.reduce((sum, p) => sum + p.channelIdentities.length, 0),
            meta: 'ChannelIdentity 映射',
          },
          {
            label: '活动授权数',
            value: principals.reduce((sum, p) => sum + p.activeGrants.length, 0),
            meta: '显式 Grant 集合',
          },
          {
            label: '委派边界',
            value: '严格受限',
            meta: 'worker ⊆ caller',
          },
        ]}
      />

      {/* Identity Resolution Chain */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 16px',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>
          三层身份解析链条 (Identity Resolution Chain)
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, flexWrap: 'wrap' }}>
          <div style={{ padding: '6px 12px', background: 'var(--sidebar)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <strong>1. ChannelIdentity</strong>
            <div style={{ fontSize: 10, color: 'var(--metadata)' }}>外部渠道来源标识 (QQ/Web)</div>
          </div>
          <span style={{ color: 'var(--metadata)' }}>➔</span>
          <div style={{ padding: '6px 12px', background: 'var(--sidebar)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <strong>2. User</strong>
            <div style={{ fontSize: 10, color: 'var(--metadata)' }}>Glassbox 归属用户档案</div>
          </div>
          <span style={{ color: 'var(--metadata)' }}>➔</span>
          <div style={{ padding: '6px 12px', background: 'var(--sidebar)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}>
            <strong>3. Principal</strong>
            <div style={{ fontSize: 10, color: 'var(--metadata)' }}>有效鉴权主体 (执行策略判定)</div>
          </div>
        </div>
      </div>

      <FilterBar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="搜索主体 ID、用户名或渠道..."
        resultCount={filtered.length}
      />

      <MasterDetail
        master={
          <DataTable
            data={filtered}
            columns={columns}
            keyExtractor={(p) => p.id}
            selectedId={selectedPrincipal?.id}
            onRowClick={(p) => handleSelectPrincipal(p.id)}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedPrincipal}
            title={selectedPrincipal?.userDisplayName || '主体详情'}
            subtitle={selectedPrincipal?.id}
            onClose={() => handleSelectPrincipal(null)}
            actions={
              selectedPrincipal ? (
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => onNavigate('permissions', { testPrincipal: selectedPrincipal.id })}
                >
                  以此主体测试 (模拟)
                </button>
              ) : null
            }
          >
            {selectedPrincipal && (
              <>
                <DetailSection title="渠道身份映射链条">
                  {selectedPrincipal.channelIdentities.map((ch, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '8px 10px',
                        background: 'var(--sidebar)',
                        borderRadius: 'var(--radius-sm)',
                        border: '1px solid var(--line)',
                        marginBottom: 6,
                        fontSize: 11,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <strong>{ch.channel}</strong>
                        <span style={{ color: ch.isVerified ? 'var(--success)' : 'var(--metadata)' }}>
                          {ch.isVerified ? '已认证' : '未认证'}
                        </span>
                      </div>
                      <div className="mono" style={{ color: 'var(--ink)' }}>{ch.identity}</div>
                      <div style={{ color: 'var(--metadata)', marginTop: 2 }}>绑定于: {ch.boundAt}</div>
                    </div>
                  ))}
                </DetailSection>

                <DetailSection title="有效授权列表 (Active Grants)">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {selectedPrincipal.activeGrants.map((grant, idx) => (
                      <div
                        key={idx}
                        className="mono"
                        style={{
                          fontSize: 11,
                          padding: '4px 6px',
                          background: 'var(--sidebar)',
                          border: '1px solid var(--line)',
                          borderRadius: 4,
                        }}
                      >
                        {grant}
                      </div>
                    ))}
                  </div>
                </DetailSection>

                <DetailSection title="安全说明与委派约束">
                  <PairRow label="委派上限" value={selectedPrincipal.delegationLimit} mono />
                  <p style={{ fontSize: 12, color: 'var(--secondary)', lineHeight: 1.5, margin: '8px 0 0 0' }}>
                    {selectedPrincipal.notes}
                  </p>
                </DetailSection>
              </>
            )}
          </DetailRail>
        }
      />

      {/* Resource Relationships Provenance Section */}
      <div style={{ marginTop: 24 }}>
        <SectionHeader
          title="资源所有权与委派关系 (Resource Relationships)"
          subtitle="严格审查资源所属主体与其授权来源，确保委派历史可追溯"
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
              marginTop: 12,
              fontSize: 12,
            }}
          >
            资源所有权追溯接口暂不可用 (P3 目标：需要细粒度资源注册表)
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            {mockResourceRelationships.map((rel) => (
              <div
                key={rel.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 14px',
                  background: 'var(--surface)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--ink)' }}>
                    <span className="mono">{rel.resource}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--metadata)', marginTop: 2 }}>
                    归属主体: <span className="mono">{rel.ownerPrincipal}</span> · 溯源说明: {rel.provenance}
                  </div>
                </div>
                <StatusBadge
                  variant={rel.relation === 'owner' ? 'ok' : rel.relation === 'delegate' ? 'teal' : 'neutral'}
                  className="sm"
                >
                  {rel.relation === 'owner' ? '所有者 (Owner)' : rel.relation === 'delegate' ? '受托委派 (Delegate)' : '只读 (Reader)'}
                </StatusBadge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
