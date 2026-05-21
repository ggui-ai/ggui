import { useState } from 'react';
import { Container, Stack, Row, Text, Icon } from '@ggui-ai/design/primitives';

// ── Types ───────────────────────────────────────────────────────────

interface OAuthConsentScreenProps {
  serviceId: string;
  serviceName: string;
  serviceIcon: string;
  scopes: string[];
  scopeLabels?: Record<string, string>;
  reason?: string;
  appName?: string;
  brandColor?: string;
  onGrant?: (data: { serviceId: string; mode: 'once' | 'always' }) => void;
  onDeny?: (data: { serviceId: string }) => void;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULT_BRAND = '#FF6B35';

const DEFAULT_SCOPE_LABELS: Record<string, string> = {
  'restaurants:read': 'View restaurants',
  'orders:read': 'View your orders',
  'orders:write': 'Place orders',
  'rides:read': 'View ride history',
  'rides:write': 'Request rides',
  'drivers:read': 'View driver info',
  'listings:read': 'View property listings',
  'bookings:read': 'View your bookings',
  'bookings:write': 'Make reservations',
  'host:read': 'View host dashboard',
  'profile:read': 'View your profile',
};

// ── Component ───────────────────────────────────────────────────────

export default function OAuthConsentScreen({
  serviceId,
  serviceName,
  serviceIcon,
  scopes,
  scopeLabels,
  reason,
  appName,
  brandColor,
  onGrant,
  onDeny,
}: OAuthConsentScreenProps) {
  const [state, setState] = useState<'idle' | 'granting' | 'granted' | 'denied'>('idle');
  const color = brandColor || DEFAULT_BRAND;
  const labels = { ...DEFAULT_SCOPE_LABELS, ...scopeLabels };

  const handleGrant = (mode: 'once' | 'always') => {
    setState('granting');
    setTimeout(() => {
      setState('granted');
      onGrant?.({ serviceId, mode });
    }, 600);
  };

  const handleDeny = () => {
    setState('denied');
    onDeny?.({ serviceId });
  };

  // ── Success state ───────────────────────────────────────────────
  if (state === 'granted') {
    return (
      <Container style={styles.overlay}>
        <div style={styles.card}>
          <Stack style={{ alignItems: 'center', padding: '32px 24px', gap: 16 }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: '#E8F5E9',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: '#2E7D32', display: 'inline-flex' }}>
                <Icon name="check" size={32} />
              </span>
            </div>
            <Text style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a' }}>
              Connected!
            </Text>
            <Text style={{ fontSize: 14, color: '#666', textAlign: 'center' }}>
              {serviceName} is now connected. The agent can proceed.
            </Text>
          </Stack>
        </div>
      </Container>
    );
  }

  // ── Denied state ────────────────────────────────────────────────
  if (state === 'denied') {
    return (
      <Container style={styles.overlay}>
        <div style={styles.card}>
          <Stack style={{ alignItems: 'center', padding: '32px 24px', gap: 16 }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: '#FFEBEE',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ color: '#C62828', display: 'inline-flex' }}>
                <Icon name="x" size={32} />
              </span>
            </div>
            <Text style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a' }}>
              Access Denied
            </Text>
            <Text style={{ fontSize: 14, color: '#666', textAlign: 'center' }}>
              The agent won&apos;t be able to access {serviceName}.
            </Text>
          </Stack>
        </div>
      </Container>
    );
  }

  // ── Consent form ────────────────────────────────────────────────
  return (
    <Container style={styles.overlay}>
      <div style={styles.card}>
        {/* Service header */}
        <Stack style={{ alignItems: 'center', padding: '28px 24px 20px', gap: 14 }}>
          {/* Icon with colored ring */}
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 36,
              border: `3px solid ${color}`,
              padding: 3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <img
              src={serviceIcon}
              alt={serviceName}
              style={{
                width: 56,
                height: 56,
                borderRadius: 28,
                objectFit: 'cover',
              }}
            />
          </div>
          <Text style={{ fontSize: 20, fontWeight: 700, color: '#1a1a1a' }}>
            {serviceName}
          </Text>
          <Text style={{ fontSize: 14, color: '#666', textAlign: 'center' }}>
            wants to connect to your account
          </Text>
        </Stack>

        {/* Divider */}
        <div style={{ height: 1, backgroundColor: '#f0f0f0', margin: '0 24px' }} />

        {/* Reason */}
        {reason && (
          <div style={{ padding: '16px 24px 0' }}>
            <Text style={{ fontSize: 14, color: '#444', lineHeight: 1.5, textAlign: 'center' }}>
              &ldquo;{reason}&rdquo;
            </Text>
          </div>
        )}

        {/* Scopes */}
        <Stack style={{ padding: '16px 24px', gap: 10 }}>
          <Text style={{ fontSize: 12, fontWeight: 600, color: '#999', textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
            Permissions requested
          </Text>
          {scopes.map((scope) => (
            <Row key={scope} style={{ alignItems: 'center', gap: 10 }}>
              <span style={{ color, display: 'inline-flex' }}>
                <Icon name="shield" size={16} />
              </span>
              <Text style={{ fontSize: 14, color: '#333' }}>
                {labels[scope] || formatScope(scope)}
              </Text>
            </Row>
          ))}
        </Stack>

        {/* Divider */}
        <div style={{ height: 1, backgroundColor: '#f0f0f0', margin: '0 24px' }} />

        {/* Action buttons */}
        <Stack style={{ padding: '20px 24px', gap: 10 }}>
          {/* Allow Once — primary */}
          <button
            onClick={() => handleGrant('once')}
            disabled={state === 'granting'}
            style={{
              width: '100%',
              padding: '12px 16px',
              borderRadius: 10,
              border: 'none',
              backgroundColor: color,
              color: 'white',
              fontSize: 15,
              fontWeight: 700,
              cursor: state === 'granting' ? 'wait' : 'pointer',
              opacity: state === 'granting' ? 0.7 : 1,
              transition: 'opacity 0.15s ease',
            }}
          >
            {state === 'granting' ? 'Connecting...' : 'Allow Once'}
          </button>

          {/* Always Allow — secondary */}
          <button
            onClick={() => handleGrant('always')}
            disabled={state === 'granting'}
            style={{
              width: '100%',
              padding: '12px 16px',
              borderRadius: 10,
              border: `1.5px solid ${color}`,
              backgroundColor: 'transparent',
              color: color,
              fontSize: 15,
              fontWeight: 600,
              cursor: state === 'granting' ? 'wait' : 'pointer',
              opacity: state === 'granting' ? 0.7 : 1,
              transition: 'opacity 0.15s ease',
            }}
          >
            Always Allow
          </button>

          {/* Deny — text link */}
          <button
            onClick={handleDeny}
            disabled={state === 'granting'}
            style={{
              width: '100%',
              padding: '8px 16px',
              borderRadius: 10,
              border: 'none',
              backgroundColor: 'transparent',
              color: '#999',
              fontSize: 14,
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'color 0.15s ease',
            }}
          >
            Deny
          </button>
        </Stack>

        {/* Trust indicator */}
        <div
          style={{
            padding: '12px 24px 16px',
            borderTop: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <span style={{ color: '#bbb', display: 'inline-flex' }}>
            <Icon name="lock" size={12} />
          </span>
          <Text style={{ fontSize: 12, color: '#bbb' }}>
            {appName
              ? `${appName} will access ${serviceName} on your behalf`
              : `This app will access ${serviceName} on your behalf`}
          </Text>
        </div>
      </div>
    </Container>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatScope(scope: string): string {
  return scope
    .replace(/[_:]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const styles = {
  overlay: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    padding: 16,
  } as const,
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    boxShadow: '0 20px 60px rgba(0,0,0,0.15), 0 4px 20px rgba(0,0,0,0.1)',
    overflow: 'hidden',
  } as const,
};
