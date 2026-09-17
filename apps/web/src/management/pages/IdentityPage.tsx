/**
 * @file apps/web/src/management/pages/IdentityPage.tsx
 * Page 4: 身份与访问 (Identity & Access)
 */
import React, { useState } from 'react';
import { PageHeader } from '../primitives/PageHeader';
import { FilterBar } from '../primitives/FilterBar';
import { DataTable, type Column } from '../primitives/DataTable';
import { MasterDetail } from '../primitives/Tabs';
import { DetailRail, DetailSection, PairRow } from '../primitives/DetailRail';
import { StatusBadge } from '../primitives/StatusBadge';
import { EntityMark } from '../primitives/EntityMark';
import { useManagementPrincipals } from '../adapter';
import type { PrincipalProjection } from '../types';

interface IdentityPageProps {
  onNavigate: (pageId: string) => void;
}

export const IdentityPage: React.FC<IdentityPageProps> = ({ onNavigate }) => {
  const { data: res } = useManagementPrincipals();
  const principals = res?.data || [];
  const [selectedId, setSelectedId] = useState<string | null>('owner_primary');
  const [search, setSearch] = useState('');

  const selectedPrincipal = principals.find((p) => p.id === selectedId);

  const filtered = principals.filter(
    (p) =>
      p.userDisplayName.toLowerCase().includes(search.toLowerCase()) ||
      p.id.toLowerCase().includes(search.toLowerCase())
  );

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
      />

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
            selectedId={selectedId || undefined}
            onRowClick={(p) => setSelectedId(p.id)}
          />
        }
        detail={
          <DetailRail
            isOpen={!!selectedPrincipal}
            title={selectedPrincipal?.userDisplayName || '主体详情'}
            subtitle={selectedPrincipal?.id}
            onClose={() => setSelectedId(null)}
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
    </div>
  );
};
