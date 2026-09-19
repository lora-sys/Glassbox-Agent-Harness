/**
 * @file apps/web/src/management/primitives/StatusBadge.tsx
 */
import React from 'react';
import type { CapabilityState } from '../types';

export type BadgeVariant = 'ok' | 'warn' | 'bad' | 'neutral' | 'teal' | 'info';

interface StatusBadgeProps {
  variant?: BadgeVariant;
  state?: CapabilityState;
  children?: React.ReactNode;
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  variant = 'neutral',
  state,
  children,
  className = '',
}) => {
  // If a standard CapabilityState is passed, automatically determine styling
  let resolvedVariant: string = variant === 'info' ? 'neutral' : variant;
  let text = children;

  if (state) {
    text = state;
    switch (state) {
      case '已实现':
        resolvedVariant = 'ok';
        break;
      case 'P3 目标':
        resolvedVariant = 'warn';
        break;
      case '设计数据':
        resolvedVariant = 'neutral';
        break;
      case '后续':
        resolvedVariant = 'teal';
        break;
      case '未知':
        resolvedVariant = 'bad';
        break;
      case '—':
        resolvedVariant = 'neutral';
        break;
    }
  }

  return (
    <span className={`capabilityBadge ${resolvedVariant} ${className}`} role="status">
      {text}
    </span>
  );
};
