/**
 * @file apps/web/src/management/primitives/PageHeader.tsx
 */
import React from 'react';
import { StatusBadge } from './StatusBadge';
import type { CapabilityState } from '../types';

interface PageHeaderProps {
  title: string;
  description: string;
  capabilityState?: CapabilityState;
  customPill?: { text: string; variant?: 'ok' | 'warn' | 'bad' | 'neutral' | 'teal' };
  actions?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  capabilityState = '已实现',
  customPill,
  actions,
}) => (
  <header className="pageHeader">
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
    <div className="pageHeaderActions">
      {customPill && (
        <span className={`capabilityBadge ${customPill.variant || 'neutral'}`}>
          {customPill.text}
        </span>
      )}
      <StatusBadge state={capabilityState} />
      {actions}
    </div>
  </header>
);

interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  capabilityState?: CapabilityState;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  subtitle,
  action,
  capabilityState,
}) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0' }}>
    <div>
      <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>{title}</h2>
      {subtitle && <p style={{ fontSize: 12, color: 'var(--metadata)', margin: '2px 0 0 0' }}>{subtitle}</p>}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {capabilityState && <StatusBadge state={capabilityState} />}
      {action}
    </div>
  </div>
);
