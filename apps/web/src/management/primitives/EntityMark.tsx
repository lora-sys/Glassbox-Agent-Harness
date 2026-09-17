/**
 * @file apps/web/src/management/primitives/EntityMark.tsx
 */
import React from 'react';

export type EntityKind = 'task' | 'run' | 'pi' | 'channel' | 'principal' | 'attention' | 'permission';

interface EntityMarkProps {
  kind: EntityKind;
  size?: 'sm' | 'md';
  className?: string;
}

export const EntityMark: React.FC<EntityMarkProps> = ({
  kind,
  size = 'md',
  className = '',
}) => {
  const sizeStyle: React.CSSProperties = {
    width: size === 'sm' ? 18 : 24,
    height: size === 'sm' ? 18 : 24,
    fontSize: size === 'sm' ? 10 : 12,
    fontWeight: 700,
    borderRadius: 4,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    fontFamily: 'var(--font-mono)',
  };

  let bg = '#111';
  let color = '#fff';
  let label = '';

  switch (kind) {
    case 'task':
      bg = '#2563eb';
      label = 'T';
      break;
    case 'run':
      bg = '#0d9488';
      label = 'R';
      break;
    case 'pi':
      bg = '#b45309';
      label = 'PI';
      break;
    case 'channel':
      bg = '#4f46e5';
      label = 'C';
      break;
    case 'principal':
      bg = '#475569';
      label = 'U';
      break;
    case 'attention':
      bg = '#dc2626';
      label = '!';
      break;
    case 'permission':
      bg = '#7c3aed';
      label = 'P';
      break;
  }

  return (
    <span
      className={`entityMark entity-${kind} ${className}`}
      style={{ ...sizeStyle, backgroundColor: bg, color }}
      aria-label={`${kind} indicator`}
    >
      {label}
    </span>
  );
};
