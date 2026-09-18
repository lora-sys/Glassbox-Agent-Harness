/**
 * @file apps/web/src/management/access/ManagementAuth.tsx
 *
 * Implements the system invariants from AGENTS.md & active P3 plan:
 * 1. Authorization before data exposure.
 * 2. Never authorize from a URL query parameter (e.g. ?auth=owner is rejected).
 * 3. Never default to verified Owner in live mode.
 * 4. Design preview may display public deterministic fixtures only when clearly labeled as design data.
 * 5. URL flags must never grant access to live protected data.
 * 6. Live mode must fail closed when authentication or an endpoint is unavailable.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { isValidManagementToken } from '../adapter/validators';

interface ManagementAuthProps {
  mode: 'design' | 'live';
  token: string | null;
  onTokenSubmit: (token: string, persist: boolean) => Promise<{ success: boolean; error?: string; status?: number }>;
  onSwitchToDesign: () => void;
  children: React.ReactNode;
}

export const ManagementAuth: React.FC<ManagementAuthProps> = ({
  mode,
  token,
  onTokenSubmit,
  onSwitchToDesign,
  children,
}) => {
  const [tokenInput, setTokenInput] = useState('');
  const [persistToken, setPersistToken] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [authError, setAuthError] = useState<{ message: string; status?: number } | null>(null);
  const [isLiveAuthorized, setIsLiveAuthorized] = useState<boolean>(false);

  // When switching modes or when token changes, re-evaluate authorization
  const verifyCurrentToken = useCallback(async (tokenToVerify: string) => {
    setIsVerifying(true);
    setAuthError(null);
    try {
      const res = await onTokenSubmit(tokenToVerify, persistToken);
      if (res.success) {
        setIsLiveAuthorized(true);
        setAuthError(null);
      } else {
        setIsLiveAuthorized(false);
        setAuthError({
          message: res.error || '管理凭据校验失败',
          status: res.status || 401,
        });
      }
    } catch (err) {
      setIsLiveAuthorized(false);
      setAuthError({
        message: err instanceof Error ? err.message : '无法连接 Glassbox 服务端',
        status: 500,
      });
    } finally {
      setIsVerifying(false);
    }
  }, [onTokenSubmit, persistToken]);

  useEffect(() => {
    if (mode === 'live') {
      if (token && isValidManagementToken(token)) {
        verifyCurrentToken(token);
      } else {
        setIsLiveAuthorized(false);
      }
    } else {
      // Design mode is public presentation preview; no live secrets exposed
      setIsLiveAuthorized(false);
      setAuthError(null);
    }
  }, [mode, token, verifyCurrentToken]);

  // --------------------------------------------------------------------------
  // Mode 1: Design Preview Mode (Deterministic Fixtures, Clearly Labeled)
  // --------------------------------------------------------------------------
  if (mode === 'design') {
    return <>{children}</>;
  }

  // --------------------------------------------------------------------------
  // Mode 2: Live Server Mode — Enforce Real Token Authentication & Fail-Closed
  // --------------------------------------------------------------------------

  // If live mode is verified and authorized, render live content
  if (isLiveAuthorized) {
    return <>{children}</>;
  }

  // Live Mode: Verification in progress
  if (isVerifying) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--canvas)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>
            校验所有者管理凭据中...
          </div>
          <span style={{ fontSize: 12, color: 'var(--metadata)' }}>
            正在向 /manage/status 发起 Bearer 鉴权校验，安全默认关闭
          </span>
        </div>
      </div>
    );
  }

  // Live Mode: Auth Rejected / Denied / Server Error
  if (authError) {
    const isForbidden = authError.status === 403;
    const isUnauthorized = authError.status === 401;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
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
            maxWidth: 480,
            boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          }}
        >
          <div
            style={{
              display: 'inline-block',
              padding: '4px 8px',
              borderRadius: 4,
              background: 'var(--danger-subtle)',
              color: 'var(--danger)',
              fontSize: 12,
              fontWeight: 700,
              marginBottom: 12,
            }}
          >
            {isForbidden ? 'DENY (403 Forbidden)' : isUnauthorized ? 'DENY (401 Unauthorized)' : 'FAIL CLOSED'}
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--ink)', margin: '0 0 8px 0' }}>
            {isForbidden
              ? '访问被拒绝 · 本地/来源受限'
              : isUnauthorized
              ? '所有者凭据无效或未授权'
              : '无法连接 Glassbox 实时服务端'}
          </h2>
          <p style={{ fontSize: 13, color: 'var(--secondary)', margin: '0 0 20px 0', lineHeight: 1.5 }}>
            {isForbidden
              ? 'Glassbox /manage 管理接口仅允许来自本机回环地址 (127.0.0.1) 及受信任 Origin 访问。当前请求已被服务端拦截。'
              : isUnauthorized
              ? '提供的 Management Token 未能通过服务端 timingSafeEqual 校验。系统已阻止加载受保护的主体与控制面数据。'
              : `实时模式已执行安全闭锁 (Fail-Closed)：${authError.message}。严禁静默回退至设计数据掩盖故障。`}
          </p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setAuthError(null);
                setIsLiveAuthorized(false);
              }}
            >
              重新输入 Token
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={onSwitchToDesign}
            >
              切换至设计数据预览
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Live Mode: Prompt for Token
  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanToken = tokenInput.trim();
    if (!isValidManagementToken(cleanToken)) {
      setAuthError({
        message: 'Token 格式无效：必须为 43 位 base64url 编码字符串。',
        status: 400,
      });
      return;
    }
    verifyCurrentToken(cleanToken);
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: 'var(--canvas)',
        padding: 24,
        textAlign: 'center',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius-md)',
          padding: 32,
          maxWidth: 480,
          boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
          textAlign: 'left',
        }}
      >
        <div
          style={{
            display: 'inline-block',
            padding: '4px 8px',
            borderRadius: 4,
            background: 'var(--brand-subtle)',
            color: 'var(--brand)',
            fontSize: 12,
            fontWeight: 700,
            marginBottom: 12,
          }}
        >
          实时模式需要所有者凭据 (Live Mode Auth)
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--ink)', margin: '0 0 8px 0' }}>
          输入 Glassbox Management Token
        </h2>
        <p style={{ fontSize: 13, color: 'var(--secondary)', margin: '0 0 16px 0', lineHeight: 1.5 }}>
          实时管理模式直连服务端 <code>/manage/*</code> 受保护接口。
          根据系统不变量：<strong>URL 参数严禁用于自动授权，严禁默认信任 Owner 身份</strong>。
          请输入服务端 <code>management-token</code> 文件中生成的 43 位密钥。
        </p>

        <form onSubmit={handleFormSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label
              htmlFor="mgmt-token-input"
              style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}
            >
              Management Token (43 位 base64url)
            </label>
            <input
              id="mgmt-token-input"
              type="password"
              className="filterInput"
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 13 }}
              placeholder="例如：aB9_xK1234567890abcdefghijklmnopqrstuvwxyz"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              autoComplete="off"
              required
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 18, fontSize: 12, color: 'var(--secondary)' }}>
            <input
              id="persist-token"
              type="checkbox"
              checked={persistToken}
              onChange={(e) => setPersistToken(e.target.checked)}
            />
            <label htmlFor="persist-token">在当前浏览器会话中记住此凭据</label>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn secondary"
              onClick={onSwitchToDesign}
            >
              返回设计数据预览
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={!tokenInput.trim()}
            >
              验证并连接实时接口
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
