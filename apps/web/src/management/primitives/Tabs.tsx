/**
 * @file apps/web/src/management/primitives/Tabs.tsx
 */
import React from 'react';

export interface TabItem {
  id: string;
  label: string;
  badge?: string | number;
}

interface TabsProps {
  tabs: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  activeId,
  onChange,
  className = '',
}) => {
  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const nextIdx = (index + 1) % tabs.length;
      onChange(tabs[nextIdx].id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prevIdx = (index - 1 + tabs.length) % tabs.length;
      onChange(tabs[prevIdx].id);
    }
  };

  return (
    <div className={`inspectorTabs ${className}`} role="tablist">
      {tabs.map((tab, idx) => {
        const isActive = activeId === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`inspectorTab ${isActive ? 'active' : ''}`}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span style={{ marginLeft: 6, fontSize: 10, opacity: 0.8 }}>({tab.badge})</span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export const MasterDetail: React.FC<{ master: React.ReactNode; detail: React.ReactNode }> = ({
  master,
  detail,
}) => (
  <div className="masterDetailLayout">
    <div className="masterContent">{master}</div>
    {detail}
  </div>
);

export const EmptyState: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ title, description, action }) => (
  <div
    style={{
      padding: '48px 24px',
      textAlign: 'center',
      background: 'var(--surface)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--radius-md)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 12,
    }}
  >
    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
    {description && (
      <div style={{ fontSize: 13, color: 'var(--metadata)', maxWidth: 400 }}>{description}</div>
    )}
    {action && <div style={{ marginTop: 8 }}>{action}</div>}
  </div>
);

export const Notice: React.FC<{
  variant?: 'info' | 'warn' | 'error';
  title?: string;
  children: React.ReactNode;
}> = ({ variant = 'info', title, children }) => {
  const bg = variant === 'warn' ? 'var(--brand-subtle)' : variant === 'error' ? 'var(--danger-subtle)' : 'var(--sidebar)';
  const border = variant === 'warn' ? 'rgba(180, 83, 9, 0.2)' : variant === 'error' ? 'rgba(220, 38, 38, 0.2)' : 'var(--line)';
  const color = variant === 'warn' ? 'var(--brand)' : variant === 'error' ? 'var(--danger)' : 'var(--body)';

  return (
    <div
      style={{
        padding: '12px 14px',
        backgroundColor: bg,
        border: `1px solid ${border}`,
        borderRadius: 'var(--radius-sm)',
        fontSize: 12,
        color,
      }}
      role="alert"
    >
      {title && <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>}
      <div>{children}</div>
    </div>
  );
};
