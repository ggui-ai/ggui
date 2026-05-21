/**
 * WelcomePage — Built-in onboarding ramp for FullscreenShell.
 *
 * Shows when the stack is empty and no custom initial screen is configured.
 * Three state-aware views based on connection status:
 * 1. NotConfigured — no wsEndpoint, shows MCP setup instructions
 * 2. AgentOffline — wsEndpoint set but not connected, shows troubleshooting
 * 3. AgentReady — connected but stack empty after grace period, shows onboarding
 *
 * Self-destructs: once the agent pushes UI, FullscreenShell replaces this with the real stack.
 */

import React, { useState, useCallback } from 'react';

export interface WelcomePageProps {
  connectionStatus: string;
}

interface AgentExample {
  emoji: string;
  label: string;
  detail: string;
  systemPrompt: string;
  mcpTools: string[];
}

const AGENT_EXAMPLES: AgentExample[] = [
  {
    emoji: '\u{1F354}', label: 'Restaurant ordering clerk', detail: 'menu, cart, checkout',
    systemPrompt: `You are a friendly restaurant clerk.\nHelp customers browse the menu, customize orders,\nadd items to cart, and complete checkout.`,
    mcpTools: ['ggui (UI generation)', 'menu-api (product catalog)', 'payments (Stripe checkout)'],
  },
  {
    emoji: '\u2708\uFE0F', label: 'Travel booking agent', detail: 'flights, hotels, itinerary',
    systemPrompt: `You are a travel booking assistant.\nSearch flights and hotels, compare prices,\nbuild itineraries, and handle reservations.`,
    mcpTools: ['ggui (UI generation)', 'flights-api (search & book)', 'hotels-api (availability)'],
  },
  {
    emoji: '\u{1F3E5}', label: 'Healthcare receptionist', detail: 'appointment, intake form',
    systemPrompt: `You are a healthcare receptionist.\nHelp patients schedule appointments, fill out\nintake forms, and check insurance eligibility.`,
    mcpTools: ['ggui (UI generation)', 'calendar (scheduling)', 'ehr-api (patient records)'],
  },
  {
    emoji: '\u{1F3E6}', label: 'Banking assistant', detail: 'balance, transfers, dashboard',
    systemPrompt: `You are a banking assistant.\nShow account balances, process transfers,\ndisplay transaction history, and track spending.`,
    mcpTools: ['ggui (UI generation)', 'banking-api (accounts & transfers)', 'plaid (aggregation)'],
  },
  {
    emoji: '\u{1F324}\uFE0F', label: 'Weather dashboard agent', detail: 'forecasts, maps, alerts',
    systemPrompt: `You are a weather assistant.\nShow current conditions, forecasts, radar maps,\nand severe weather alerts for any location.`,
    mcpTools: ['ggui (UI generation)', 'weather-api (forecasts & alerts)', 'geocoding (location)'],
  },
];

function NotConfigured() {
  return (
    <div style={styles.center}>
      <div style={styles.heroEmoji}>{'\u{1F50C}'}</div>
      <h2 style={styles.heroTitle}>Connect Your Agent</h2>
      <p style={styles.heroSub}>No agent configured for this app</p>

      <div style={styles.card}>
        <div style={styles.cardLabel}>OPTION 1 — MCP CONFIG</div>
        <pre style={styles.codeBlock}>
{`"mcpServers": {
  "ggui": {
    "url": "https://mcp.ggui.ai/v1"
  }
}`}
        </pre>
      </div>

      <div style={styles.card}>
        <div style={styles.cardLabel}>OPTION 2 — LINK LOCAL AGENT</div>
        <pre style={styles.codeBlock}>$ ggui link --url http://localhost:3000</pre>
      </div>
    </div>
  );
}

function AgentOffline() {
  return (
    <div style={styles.center}>
      <div style={styles.heroEmoji}>{'\u23F3'}</div>
      <h2 style={styles.heroTitle}>Waiting for Agent</h2>
      <p style={{ ...styles.heroSub, color: '#f5a623' }}>{'\u25CF'} Agent not responding</p>

      <div style={styles.card}>
        <p style={styles.checkItem}>{'\u2713'} Is your agent server running?</p>
        <p style={styles.checkItem}>{'\u2713'} Check <code style={styles.inlineCode}>localhost:6681/ggui/health</code></p>
        <p style={styles.checkItem}>{'\u2713'} Check your .env for GGUI_APP_ID</p>
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* clipboard not available */ });
  }, [text]);

  return (
    <button onClick={handleCopy} style={styles.copyButton}>
      {copied ? '\u2713 Copied' : 'Copy'}
    </button>
  );
}

function ExampleCard({ ex }: { ex: AgentExample }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ marginBottom: 6 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ ...styles.exampleRow, cursor: 'pointer', marginBottom: 0 }}
      >
        <span style={styles.exampleEmoji}>{ex.emoji}</span>
        <span style={styles.exampleLabel}>{ex.label}</span>
        <span style={styles.exampleDetail}>{ex.detail}</span>
        <span style={{ marginLeft: 'auto', color: '#555', fontSize: 12 }}>{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>
      {expanded && (
        <div style={styles.expandedCard}>
          <div style={styles.expandedSection}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={styles.cardLabel}>SYSTEM PROMPT</div>
              <CopyButton text={ex.systemPrompt} />
            </div>
            <pre style={styles.codeBlock}>{ex.systemPrompt}</pre>
          </div>
          <div style={styles.expandedSection}>
            <div style={styles.cardLabel}>MCP TOOLS</div>
            {ex.mcpTools.map((tool) => (
              <div key={tool} style={styles.mcpTool}>{tool}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentReady() {
  return (
    <div style={styles.center}>
      <h2 style={styles.heroTitle}>{'What kind of agent\ndo you want to build?'}</h2>
      <p style={styles.heroSub}>
        Open <code style={styles.inlineCode}>src/index.ts</code> and set your agent&apos;s system prompt.
      </p>

      <pre style={styles.codeBlock}>
{`// src/index.ts
const systemPrompt = \`
  You are a friendly McDonald's clerk.
  Help customers order food, suggest
  combos, and show the menu.
\`;`}
      </pre>

      <div style={styles.section}>
        <div style={styles.sectionLabel}>Need inspiration?</div>
        {AGENT_EXAMPLES.map((ex) => (
          <ExampleCard key={ex.label} ex={ex} />
        ))}
      </div>

      <div style={styles.saveHint}>
        Save your file &rarr; your agent takes over &rarr; this page disappears.
      </div>
    </div>
  );
}

export function WelcomePage({ connectionStatus }: WelcomePageProps) {
  // State detection from connectionStatus only:
  // - 'disconnected' → could be not configured or agent offline, show offline state
  // - 'connecting' → agent offline / trying to connect
  // - 'connected' → agent is live but stack is empty, show onboarding
  if (connectionStatus === 'connected') {
    return <div style={styles.container}><AgentReady /></div>;
  }
  if (connectionStatus === 'connecting') {
    return <div style={styles.container}><AgentOffline /></div>;
  }
  // disconnected — show not configured (most common case for ggui dev first run)
  return <div style={styles.container}><NotConfigured /></div>;
}

/* ── Inline styles (matches FullscreenShell dark theme) ── */

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'absolute', inset: 0,
    background: '#0f0f1a',
    color: '#e0e0e0',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    overflow: 'auto',
  },
  center: {
    maxWidth: 540,
    margin: '0 auto',
    padding: '40px 24px',
  },
  heroEmoji: {
    fontSize: 40,
    textAlign: 'center' as const,
    marginBottom: 12,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: 700,
    color: '#fff',
    textAlign: 'center' as const,
    margin: '0 0 10px',
    lineHeight: 1.3,
    whiteSpace: 'pre-line' as const,
  },
  heroSub: {
    fontSize: 13,
    color: '#666',
    textAlign: 'center' as const,
    margin: '0 0 28px',
  },
  card: {
    background: '#12121f',
    border: '1px solid #1e1e35',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
  },
  cardLabel: {
    fontSize: 11,
    color: '#5ba3f5',
    fontWeight: 600,
    marginBottom: 8,
  },
  codeBlock: {
    background: '#0d0d18',
    border: '1px solid #1e1e35',
    borderRadius: 8,
    padding: 12,
    fontFamily: "'SF Mono', Monaco, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.7,
    color: '#c8d6e5',
    margin: 0,
    overflowX: 'auto' as const,
    whiteSpace: 'pre' as const,
  },
  inlineCode: {
    fontFamily: "'SF Mono', Monaco, Consolas, monospace",
    color: '#5ba3f5',
    background: '#1a1a2e',
    padding: '2px 6px',
    borderRadius: 4,
    fontSize: 12,
  },
  checkItem: {
    fontSize: 12,
    color: '#aaa',
    lineHeight: 2,
    margin: 0,
  },
  section: {
    marginTop: 28,
    marginBottom: 24,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#555',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  exampleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: '#12121f',
    border: '1px solid #1e1e35',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 6,
  },
  exampleEmoji: {
    fontSize: 18,
    flexShrink: 0,
  },
  exampleLabel: {
    fontSize: 13,
    color: '#ddd',
    fontWeight: 500,
  },
  exampleDetail: {
    fontSize: 11,
    color: '#555',
    marginLeft: 8,
  },
  expandedCard: {
    background: '#12121f',
    border: '1px solid #1e1e35',
    borderTop: 'none',
    borderRadius: '0 0 8px 8px',
    padding: '12px 14px',
  },
  expandedSection: {
    marginBottom: 10,
  },
  copyButton: {
    background: '#1e1e35',
    border: '1px solid #2a2a4a',
    borderRadius: 4,
    padding: '3px 10px',
    color: '#5ba3f5',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  mcpTool: {
    fontSize: 12,
    color: '#aaa',
    padding: '4px 0',
    borderBottom: '1px solid #1a1a2e',
  },
  saveHint: {
    textAlign: 'center' as const,
    padding: '14px 20px',
    background: '#12121f',
    border: '1px dashed #2a2a4a',
    borderRadius: 10,
    fontSize: 13,
    color: '#888',
  },
};
