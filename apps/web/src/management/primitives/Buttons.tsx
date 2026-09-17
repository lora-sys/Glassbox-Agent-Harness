/**
 * @file apps/web/src/management/primitives/Buttons.tsx
 */
import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'sm' | 'md';
  children: React.ReactNode;
}

export const PrimaryButton: React.FC<ButtonProps> = ({
  size = 'md',
  className = '',
  children,
  ...props
}) => (
  <button
    type="button"
    className={`btn primary ${size === 'sm' ? 'sm' : ''} ${className}`}
    {...props}
  >
    {children}
  </button>
);

export const SecondaryButton: React.FC<ButtonProps> = ({
  size = 'md',
  className = '',
  children,
  ...props
}) => (
  <button
    type="button"
    className={`btn secondary ${size === 'sm' ? 'sm' : ''} ${className}`}
    {...props}
  >
    {children}
  </button>
);

export const DangerButton: React.FC<ButtonProps> = ({
  size = 'md',
  className = '',
  children,
  ...props
}) => (
  <button
    type="button"
    className={`btn danger ${size === 'sm' ? 'sm' : ''} ${className}`}
    {...props}
  >
    {children}
  </button>
);
