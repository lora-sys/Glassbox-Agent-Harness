/**
 * @file apps/web/src/management/primitives/SettingsGroup.tsx
 */
import React from 'react';

interface SettingsFieldProps {
  id: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}

export const SettingsField: React.FC<SettingsFieldProps> = ({
  id,
  label,
  description,
  children,
}) => (
  <div
    className="settingsField"
    style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 16,
      padding: '12px 0',
      borderBottom: '1px solid var(--line)',
    }}
  >
    <div style={{ flex: 1 }}>
      <label
        htmlFor={id}
        style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink)', cursor: 'pointer', display: 'block' }}
      >
        {label}
      </label>
      {description && (
        <p style={{ fontSize: 11, color: 'var(--metadata)', margin: '2px 0 0 0' }}>
          {description}
        </p>
      )}
    </div>
    <div>{children}</div>
  </div>
);

interface SettingsGroupProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  className?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({
  title,
  subtitle,
  children,
  className = '',
}) => (
  <section
    className={`settingsGroup ${className}`}
    style={{
      background: 'var(--surface)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--radius-md)',
      padding: '16px 20px',
      marginBottom: 16,
    }}
  >
    <h3 style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>{title}</h3>
    {subtitle && (
      <p style={{ fontSize: 12, color: 'var(--metadata)', margin: '4px 0 12px 0' }}>{subtitle}</p>
    )}
    <div>{children}</div>
  </section>
);
