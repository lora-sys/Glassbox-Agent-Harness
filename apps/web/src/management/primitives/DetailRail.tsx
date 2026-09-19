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

let lastUserInteraction: { element: HTMLElement; timestamp: number } | null = null;

if (typeof window !== 'undefined') {
  const recordUserAction = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Navigation actions (sidebar, topbar, mobile drawer) should never be treated as rail opening triggers
    if (target.closest('.sidebarNav, .mobileDrawer, nav, .topbar, .navItem')) {
      return;
    }
    const interactive = target.closest(
      'tr, button, a, [role="row"], [role="button"], [role="option"], [tabindex]'
    ) as HTMLElement | null;
    if (interactive) {
      lastUserInteraction = {
        element: interactive,
        timestamp: Date.now(),
      };
    }
  };

  window.addEventListener('click', recordUserAction, true);
  window.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        recordUserAction(e);
      }
    },
    true
  );
}

export function isExplicitRailUserAction(
  interaction: { element?: HTMLElement | null; timestamp: number } | null,
  now = Date.now(),
  maxElapsedMs = 400,
  isElementAttached: (el: HTMLElement) => boolean = (el) =>
    typeof document !== 'undefined' ? document.contains(el) : true,
): boolean {
  if (!interaction) return false;
  if (now - interaction.timestamp >= maxElapsedMs) return false;
  if (interaction.element && !isElementAttached(interaction.element)) return false;
  return true;
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
  const isFirstMount = useRef(true);
  const prevOpenRef = useRef(isOpen);

  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      prevOpenRef.current = isOpen;
      return;
    }

    if (!prevOpenRef.current && isOpen) {
      const isExplicitUserAction = isExplicitRailUserAction(lastUserInteraction);

      if (isExplicitUserAction && lastUserInteraction) {
        triggerElementRef.current = lastUserInteraction.element;
        railRef.current?.focus();
      } else {
        // Async query data arrival or URL-driven open: do NOT steal focus!
        triggerElementRef.current = null;
      }
    } else if (prevOpenRef.current && !isOpen) {
      if (triggerElementRef.current && document.contains(triggerElementRef.current)) {
        triggerElementRef.current.focus();
        triggerElementRef.current = null;
      }
    }
    prevOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        // Do not close the rail when Escape originates from INPUT, TEXTAREA, SELECT, or contenteditable
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
            target.isContentEditable ||
            target.getAttribute?.('contenteditable') === 'true')
        ) {
          return;
        }

        // Guard against closing DetailRail if a higher overlay (Command Palette or Mobile Drawer) is open
        const topOverlay =
          document.querySelector('[role="dialog"][aria-label="Command Palette"]') ||
          document.querySelector('.mobileDrawer.open, .mobileDrawer[aria-hidden="false"]');
        if (topOverlay) {
          return;
        }
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
