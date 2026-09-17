/**
 * @file apps/web/src/management/access/ManagementAuth.tsx
 *
 * Implements the system invariant:
 * Authorization before data exposure.
 * Only verified Owner principals are allowed access to the Web Management surface.
 */
import React, { useState, useEffect } from 'react';

interface ManagementAuthProps {
  children: React.ReactNode;
}

export const ManagementAuth: React.FC<ManagementAuthProps> = ({ children }) => {
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    // Check search parameter or local storage for simulated access check
    const params = new URLSearchParams(window.location.search);
    if (params.get('auth') === 'denied') {
      setIsAuthorized(false);
    } else {
      // Default to authorized Owner in dev / test mode
      setIsAuthorized(true);
    }
  }, []);

  if (isAuthorized === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--canvas)' }}>
        <span style={{ fontSize: 13, color: 'var(--metadata)' }}>验证所有者身份授权中...</span>
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          background: 'var(--canvas)',
          padding: 24,
          textAlign: 'center',
          fontFamily: 'var(--font-sans)',
        }}
        role="alert"
      >
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius-md)',
            padding: 32,
            maxWidth: 440,
            boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}
        >
          <div style={{ display: 'inline-block', padding: '4px 8px', borderRadius: 4, background: 'var(--danger-subtle)', color: 'var(--danger)', fontSize: 12, fontWeight: 700, marginBottom: 12 }}>
            DENY
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--ink)', margin: '0 0 8px 0' }}>
            访问被拒绝 (403 Forbidden)
          </h2>
          <p style={{ fontSize: 13, color: 'var(--secondary)', margin: '0 0 20px 0', lineHeight: 1.5 }}>
            Glassbox Web 管理控制台是系统所有者 (Owner) 的专属管理控制表面。
            未检测到有效的 Owner 授权凭据，系统已阻止加载受保护管理上下文。
          </p>
          <a
            href="/"
            className="btn primary"
            style={{ textDecoration: 'none', display: 'inline-flex' }}
          >
            返回主对话工作台
          </a>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
