/**
 * @file apps/web/src/management/primitives/DetailRail.tsx
 */
import React, { useEffect, useRef } from 'react';

interface DetailRailProps {
  isOpen: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}

export const DetailRail: React.FC<DetailRailProps> = ({
  isOpen,
  title,
  subtitle,
  onClose,
  children,
  actions,
}) => {
  const railRef = useRef<HTMLElement>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      triggerElementRef.current = document.activeElement as HTMLElement;
      railRef.current?.focus();
    } else if (triggerElementRef.current) {
      triggerElementRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <aside
      ref={railRef}
      className="detailRail"
      tabIndex={-1}
      role="region"
      aria-label={`${title} Details`}
    >
      <div className="detailRailHeader">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="detailRailClose"
          onClick={onClose}
          aria-label="关闭详情面板"
        >
          ✕
        </button>
      </div>
      <div className="detailRailBody">
        {children}
        {actions && <div className="detailSection">{actions}</div>}
      </div>
    </aside>
  );
};

export const DetailSection: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => (
  <div className="detailSection">
    <div className="detailSectionTitle">{title}</div>
    {children}
  </div>
);

export const PairRow: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({
  label,
  value,
  mono = false,
}) => (
  <div className="pairRow">
    <span>{label}</span>
    <span className={mono ? 'mono' : ''}>{value}</span>
  </div>
);
