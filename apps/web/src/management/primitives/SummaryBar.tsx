/**
 * @file apps/web/src/management/primitives/SummaryBar.tsx
 */
import React from 'react';

export interface SummaryItemData {
  label: string;
  value: React.ReactNode;
  meta?: React.ReactNode;
  mono?: boolean;
}

interface SummaryBarProps {
  items: SummaryItemData[];
  className?: string;
}

export const SummaryBar: React.FC<SummaryBarProps> = ({ items, className = '' }) => (
  <div className={`summaryBar ${className}`}>
    {items.map((item, idx) => (
      <div key={idx} className="summaryItem">
        <span className="summaryItemLabel">{item.label}</span>
        <span className={`summaryItemValue ${item.mono ? 'mono' : ''}`}>{item.value}</span>
        {item.meta && <span className="summaryItemMeta">{item.meta}</span>}
      </div>
    ))}
  </div>
);
