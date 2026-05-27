/**
 * ConsentOverlay — inline-styled OAuth consent modal for shell components.
 *
 * Rendered by BaseShell when the platform sends an `auth_required` system message.
 * Both ChatShell and AgentShell get consent handling automatically through BaseShell.
 *
 * Includes two card variants:
 *   - ConsentCard — standard OAuth popup flow (Google, GitHub, etc.)
 *   - ClaudePassthroughCard — manual code paste flow for Claude.ai account linking
 *
 * No Tailwind, no external CSS — all inline styles for universal portability.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemPayload } from '@ggui-ai/protocol';
import {
  CLAUDE_AI_CLIENT_ID,
  CLAUDE_AI_OAUTH,
  CLAUDE_AI_SERVICE_ID,
} from '@ggui-ai/protocol';

export interface ConsentRequest {
  serviceId: string;
  displayName: string;
  scopes: string[];
  consentUrl?: string;
  message: string;
  appId?: string;
  renderId?: string;
}

export interface ConsentOverlayProps {
  requests: ConsentRequest[];
  onDismiss: (serviceId: string) => void;
}

/** Convert a SystemPayload (auth_required) to a ConsentRequest. */
export function systemPayloadToConsentRequest(payload: SystemPayload): ConsentRequest {
  return {
    serviceId: payload.serviceId,
    displayName: payload.displayName ?? payload.serviceId,
    scopes: payload.scopes ?? [],
    consentUrl: payload.consentUrl,
    message: payload.message ?? `This agent needs access to your ${payload.displayName ?? payload.serviceId} account.`,
    appId: payload.appId,
    renderId: payload.renderId,
  };
}

function openOAuthPopup(url: string, name = 'ggui-oauth') {
  const w = 500;
  const h = 600;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  return window.open(
    url,
    name,
    `width=${w},height=${h},left=${left},top=${top},popup=yes,toolbar=no,menubar=no,location=yes,status=no`,
  );
}

function ConsentCard({
  request: req,
  onDismiss,
}: {
  request: ConsentRequest;
  onDismiss: (serviceId: string) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const fallbackUrlRef = useRef<string | null>(null);

  const openOrFallback = useCallback((url: string) => {
    const popup = openOAuthPopup(url);
    if (!popup || popup.closed) {
      fallbackUrlRef.current = url;
      setPopupBlocked(true);
      window.open(url, '_blank');
    }
  }, []);

  const handleAllow = useCallback(async (mode: 'once' | 'always') => {
    setConnecting(true);
    setPopupBlocked(false);

    if (req.consentUrl) {
      // Proxy path — consentUrl is pre-constructed
      const url = new URL(req.consentUrl);
      url.searchParams.set('mode', mode);
      openOrFallback(url.toString());
    } else if (req.appId && req.renderId) {
      // request-credential path — no consentUrl, construct via /api/oauth/connect
      try {
        const resp = await fetch('/api/oauth/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            serviceId: req.serviceId,
            mode,
            appId: req.appId,
            renderId: req.renderId,
          }),
        });
        if (resp.ok) {
          const { url } = await resp.json();
          if (url) openOrFallback(url);
        } else {
          console.error('[consent] Failed to get consent URL:', resp.status);
          setConnecting(false);
        }
      } catch (err) {
        console.error('[consent] Error getting consent URL:', err);
        setConnecting(false);
      }
    }
  }, [req.consentUrl, req.appId, req.renderId, req.serviceId, openOrFallback]);

  const handleDeny = useCallback(async () => {
    // Persist denied grant so the agent's polling stops immediately
    if (req.appId && req.renderId) {
      fetch('/api/oauth/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceId: req.serviceId,
          mode: 'denied',
          appId: req.appId,
          renderId: req.renderId,
        }),
      }).catch(() => {});
    }
    onDismiss(req.serviceId);
  }, [req.serviceId, req.appId, req.renderId, onDismiss]);

  return (
    <div style={styles.card}>
      {/* Service icon */}
      <div style={styles.iconContainer}>
        <svg style={{ width: 28, height: 28 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
        </svg>
      </div>

      {/* Service name */}
      <div style={styles.title}>{req.displayName}</div>
      <div style={styles.subtitle}>wants to connect to your account</div>
      <div style={styles.message}>{req.message}</div>

      {/* Scopes */}
      {req.scopes.length > 0 && (
        <div style={styles.scopesContainer}>
          <div style={styles.scopesLabel}>Permissions requested</div>
          {req.scopes.map((scope) => (
            <div key={scope} style={styles.scopeItem}>{scope}</div>
          ))}
        </div>
      )}

      {/* Buttons */}
      <div style={styles.buttonGroup}>
        <button
          onClick={() => handleAllow('once')}
          disabled={connecting}
          style={{ ...styles.buttonPrimary, opacity: connecting ? 0.6 : 1 }}
        >
          {connecting ? 'Connecting...' : 'Allow Once'}
        </button>
        <button
          onClick={() => handleAllow('always')}
          disabled={connecting}
          style={{ ...styles.buttonSecondary, opacity: connecting ? 0.6 : 1 }}
        >
          Always Allow
        </button>
        <button
          onClick={handleDeny}
          disabled={connecting}
          style={styles.buttonDeny}
        >
          Deny
        </button>
      </div>

      {/* Popup blocked fallback */}
      {popupBlocked && fallbackUrlRef.current && (
        <div style={styles.fallback}>
          Popup was blocked.{' '}
          <a
            href={fallbackUrlRef.current}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.fallbackLink}
          >
            Click here to connect
          </a>
        </div>
      )}

      {/* Trust indicator */}
      <div style={styles.trust}>
        <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
        <span>Secured by ggui credential proxy</span>
      </div>
    </div>
  );
}

// ── PKCE utilities (client-side) ──────────────────────────────────

function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── Claude.ai Passthrough Card ──────────────────────────────────────

function ClaudePassthroughCard({
  request: req,
  onDismiss,
}: {
  request: ConsentRequest;
  onDismiss: (serviceId: string) => void;
}) {
  const [step, setStep] = useState<'ready' | 'waiting' | 'exchanging' | 'done' | 'error'>('ready');
  const [pastedCode, setPastedCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const codeVerifierRef = useRef<string>('');
  const stateRef = useRef<string>('');

  // Generate PKCE + build authorize URL on mount
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  useEffect(() => {
    const verifier = generateCodeVerifier();
    codeVerifierRef.current = verifier;
    stateRef.current = crypto.randomUUID();

    generateCodeChallenge(verifier).then((challenge) => {
      const url = new URL(CLAUDE_AI_OAUTH.authorizeUrl);
      url.searchParams.set('client_id', CLAUDE_AI_CLIENT_ID);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', CLAUDE_AI_OAUTH.manualRedirectUrl);
      url.searchParams.set('scope', 'user:mcp_servers');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', stateRef.current);
      setAuthorizeUrl(url.toString());
    });
  }, []);

  const handleOpenClaude = useCallback(() => {
    if (authorizeUrl) {
      window.open(authorizeUrl, '_blank');
      setStep('waiting');
    }
  }, [authorizeUrl]);

  const handleExchange = useCallback(async () => {
    const code = pastedCode.trim();
    if (!code) return;

    setStep('exchanging');
    setErrorMsg('');

    try {
      const resp = await fetch('/api/oauth/claude-passthrough/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          codeVerifier: codeVerifierRef.current,
          state: stateRef.current,
          renderId: req.renderId,
          appId: req.appId,
        }),
      });

      if (resp.ok) {
        setStep('done');
        // Auto-dismiss after brief success state
        setTimeout(() => onDismiss(req.serviceId), 1500);
      } else {
        const data = await resp.json().catch(() => ({ error: 'Unknown error' }));
        setErrorMsg(data.error || 'Failed to connect. Please try again.');
        setStep('waiting');
      }
    } catch {
      setErrorMsg('Network error. Please try again.');
      setStep('waiting');
    }
  }, [pastedCode, req.renderId, req.appId, req.serviceId, onDismiss]);

  return (
    <div style={styles.card}>
      {/* Claude icon */}
      <div style={{ ...styles.iconContainer, backgroundColor: 'rgba(210, 130, 70, 0.08)', color: '#D28246' }}>
        <svg style={{ width: 28, height: 28 }} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h2v-2h-2v2zm2-4h-2V7h2v6z" />
        </svg>
      </div>

      <div style={styles.title}>Connect Claude Account</div>
      <div style={styles.subtitle}>Link your Claude.ai connectors</div>
      <div style={styles.message}>
        {req.message || 'This agent needs access to your Claude.ai connectors (Calendar, Gmail, etc.)'}
      </div>

      {step === 'done' ? (
        <div style={{ ...styles.message, color: '#16a34a', fontWeight: 500 }}>
          Connected successfully!
        </div>
      ) : (
        <>
          {/* Step 1: Open Claude */}
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#525252' }}>
              Step 1: Authorize on Claude.ai
            </div>
            <button
              onClick={handleOpenClaude}
              disabled={!authorizeUrl}
              style={{
                ...styles.buttonPrimary,
                backgroundColor: '#D28246',
                opacity: authorizeUrl ? 1 : 0.5,
              }}
            >
              Open Claude.ai →
            </button>
          </div>

          {/* Step 2: Paste code */}
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#525252' }}>
              Step 2: Paste the authorization code
            </div>
            <input
              type="text"
              value={pastedCode}
              onChange={(e) => setPastedCode(e.target.value)}
              placeholder="Paste code from Claude.ai here"
              disabled={step === 'exchanging'}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid #E5E5E5',
                fontSize: 14,
                fontFamily: 'monospace',
                outline: 'none',
                width: '100%',
                boxSizing: 'border-box',
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleExchange();
              }}
            />
          </div>

          {errorMsg && (
            <div style={{ ...styles.fallback, marginTop: 4 }}>
              {errorMsg}
            </div>
          )}

          {/* Buttons */}
          <div style={styles.buttonGroup}>
            <button
              onClick={handleExchange}
              disabled={!pastedCode.trim() || step === 'exchanging'}
              style={{
                ...styles.buttonPrimary,
                backgroundColor: '#D28246',
                opacity: pastedCode.trim() && step !== 'exchanging' ? 1 : 0.5,
              }}
            >
              {step === 'exchanging' ? 'Connecting...' : 'Connect'}
            </button>
            <button
              onClick={() => onDismiss(req.serviceId)}
              style={styles.buttonDeny}
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {/* Trust indicator */}
      <div style={styles.trust}>
        <svg style={{ width: 12, height: 12 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
        <span>Tokens encrypted with KMS — never stored in plaintext</span>
      </div>
    </div>
  );
}

export function ConsentOverlay({ requests, onDismiss }: ConsentOverlayProps) {
  if (requests.length === 0) return null;

  return (
    <div style={styles.backdrop}>
      <div style={styles.container}>
        {requests.map((req) =>
          req.serviceId === CLAUDE_AI_SERVICE_ID ? (
            <ClaudePassthroughCard key={req.serviceId} request={req} onDismiss={onDismiss} />
          ) : (
            <ConsentCard key={req.serviceId} request={req} onDismiss={onDismiss} />
          ),
        )}
      </div>
    </div>
  );
}

// TODO: Replace hardcoded colors with design system theme tokens (via appConfig.themeId)
// so ConsentOverlay automatically adapts to the app's configured theme.
const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 50,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    maxWidth: 400,
    width: '100%',
    margin: '0 16px',
    maxHeight: '80vh',
    overflowY: 'auto',
  },
  card: {
    borderRadius: 16,
    border: '1px solid #E5E5E5',
    backgroundColor: '#FFFFFF',
    padding: 24,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.15)',
    fontFamily: '"Pretendard Variable", "Pretendard", system-ui, -apple-system, sans-serif',
  },
  iconContainer: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 166, 244, 0.08)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#00A6F4',
  },
  title: {
    fontSize: 18,
    fontWeight: 600,
    color: '#0A0A0A',
  },
  subtitle: {
    fontSize: 14,
    color: '#737373',
    marginTop: -4,
  },
  message: {
    fontSize: 14,
    color: '#525252',
    textAlign: 'center',
    lineHeight: '1.5',
  },
  scopesContainer: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 4,
  },
  scopesLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: '#737373',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  scopeItem: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px',
    borderRadius: 8,
    backgroundColor: 'rgba(0, 166, 244, 0.05)',
    fontSize: 14,
    color: '#0A0A0A',
  },
  buttonGroup: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginTop: 8,
  },
  buttonPrimary: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '12px 0',
    borderRadius: 12,
    border: 'none',
    backgroundColor: '#00A6F4',
    color: '#FAFAFA',
    fontWeight: 500,
    fontSize: 15,
    cursor: 'pointer',
  },
  buttonSecondary: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '12px 0',
    borderRadius: 12,
    border: '1px solid #00A6F4',
    backgroundColor: 'transparent',
    color: '#00A6F4',
    fontWeight: 500,
    fontSize: 15,
    cursor: 'pointer',
  },
  buttonDeny: {
    padding: '10px 0',
    borderRadius: 12,
    border: '1px solid #E5E5E5',
    backgroundColor: 'transparent',
    color: '#737373',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  fallback: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: 'rgba(255, 185, 0, 0.08)',
    border: '1px solid rgba(255, 185, 0, 0.2)',
    padding: '8px 12px',
    textAlign: 'center',
    fontSize: 12,
    color: '#996F00',
  },
  fallbackLink: {
    textDecoration: 'underline',
    fontWeight: 500,
    color: '#996F00',
  },
  trust: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    fontSize: 11,
    color: '#A1A1A1',
  },
};
