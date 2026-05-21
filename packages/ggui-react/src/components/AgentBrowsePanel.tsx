/**
 * AgentBrowsePanel — Slide-up marketplace panel for browsing agent listings.
 *
 * Displays a searchable list of agents with a "Featured" horizontal scroll
 * section and an "All Agents" vertical list. Each card shows the agent's
 * icon, name, description, category, and visibility badge.
 *
 * Uses inline styles with CSS variable fallbacks (same pattern as GguiNavigator).
 */

import { type CSSProperties, useCallback, useMemo, useState } from 'react';
import type { AgentListingItem } from '@ggui-ai/shared';

export interface AgentBrowsePanelProps {
  /** Agent listings to display */
  listings: AgentListingItem[];
  /** Callback when an agent card is selected */
  onSelect?: (agent: AgentListingItem) => void;
  /** Callback to close the panel */
  onClose?: () => void;
  /** Bottom offset in px (above the nav bar) */
  bottomOffset?: number;
}

const FONT_FAMILY = "var(--ggui-font-family-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif)";

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function SearchIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={1}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function DefaultAgentIcon() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="m10 14 2 2 4-4" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const panelStyle = (bottomOffset: number): CSSProperties => ({
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: bottomOffset,
  maxHeight: '70%',
  background: 'var(--ggui-color-neutral-50, #ffffff)',
  borderTopLeftRadius: 16,
  borderTopRightRadius: 16,
  boxShadow: '0 -4px 30px rgba(0, 0, 0, 0.12)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 30,
  fontFamily: FONT_FAMILY,
});

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 16px 12px',
  flexShrink: 0,
};

const headerTitleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 700,
  color: 'var(--ggui-color-neutral-900, #111827)',
  letterSpacing: '-0.01em',
};

const closeButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  borderRadius: 14,
  border: 'none',
  background: 'var(--ggui-color-neutral-100, #f3f4f6)',
  cursor: 'pointer',
  color: 'var(--ggui-color-neutral-500, #6b7280)',
  padding: 0,
};

const searchWrapperStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  margin: '0 16px 12px',
  padding: '8px 12px',
  background: 'var(--ggui-color-neutral-50, #f9fafb)',
  border: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
  borderRadius: 12,
  flexShrink: 0,
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  border: 'none',
  background: 'none',
  outline: 'none',
  fontSize: 14,
  color: 'var(--ggui-color-neutral-900, #111827)',
  fontFamily: FONT_FAMILY,
};

const scrollAreaStyle: CSSProperties = {
  flex: 1,
  overflow: 'auto',
  minHeight: 0,
};

const sectionLabelStyle: CSSProperties = {
  padding: '12px 16px 8px',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--ggui-color-neutral-500, #6b7280)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

// Featured section — horizontal scroll
const featuredScrollStyle: CSSProperties = {
  display: 'flex',
  gap: 10,
  padding: '0 16px 12px',
  overflowX: 'auto',
  scrollbarWidth: 'none',
};

const featuredCardStyle: CSSProperties = {
  flexShrink: 0,
  width: 140,
  padding: 12,
  borderRadius: 12,
  background: 'var(--ggui-color-neutral-50, #f9fafb)',
  border: '1px solid var(--ggui-color-neutral-100, #f3f4f6)',
  cursor: 'pointer',
  transition: 'border-color 0.15s, box-shadow 0.15s',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 8,
  textAlign: 'center',
};

const agentIconStyle: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 10,
  background: 'var(--ggui-color-primary-50, #f0f9ff)',
  color: 'var(--ggui-color-primary-600, #0284c7)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
  flexShrink: 0,
};

const agentNameStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ggui-color-neutral-800, #1f2937)',
  lineHeight: 1.3,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  width: '100%',
};

// List item row
const listItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 16px',
  cursor: 'pointer',
  transition: 'background 0.1s',
};

const listItemInfoStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const listItemNameStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--ggui-color-neutral-900, #111827)',
  lineHeight: 1.3,
};

const listItemDescStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--ggui-color-neutral-500, #6b7280)',
  lineHeight: 1.3,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const visibilityBadgeStyle = (visibility: string): CSSProperties => ({
  fontSize: 10,
  fontWeight: 600,
  padding: '2px 6px',
  borderRadius: 6,
  flexShrink: 0,
  background:
    visibility === 'public'
      ? 'var(--ggui-color-green-50, #f0fdf4)'
      : visibility === 'private'
        ? 'var(--ggui-color-neutral-100, #f3f4f6)'
        : 'var(--ggui-color-amber-50, #fffbeb)',
  color:
    visibility === 'public'
      ? 'var(--ggui-color-green-700, #15803d)'
      : visibility === 'private'
        ? 'var(--ggui-color-neutral-600, #4b5563)'
        : 'var(--ggui-color-amber-700, #b45309)',
});

const emptyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px 16px',
  color: 'var(--ggui-color-neutral-400, #9ca3af)',
  fontSize: 14,
  gap: 4,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentBrowsePanel({
  listings,
  onSelect,
  onClose,
  bottomOffset = 72,
}: AgentBrowsePanelProps) {
  const [search, setSearch] = useState('');

  const featured = useMemo(
    () => listings.filter((a) => a.featured && a.status === 'published'),
    [listings],
  );

  const filtered = useMemo(() => {
    const published = listings.filter((a) => a.status === 'published');
    if (!search.trim()) return published;
    const q = search.toLowerCase();
    return published.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.category?.toLowerCase().includes(q) ||
        a.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }, [listings, search]);

  const handleSelect = useCallback(
    (agent: AgentListingItem) => {
      onSelect?.(agent);
    },
    [onSelect],
  );

  return (
    <div style={panelStyle(bottomOffset)}>
      {/* Header */}
      <div style={headerStyle}>
        <span style={headerTitleStyle}>Agent Marketplace</span>
        {onClose && (
          <button type="button" style={closeButtonStyle} onClick={onClose} aria-label="Close">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Search */}
      <div style={searchWrapperStyle}>
        <span style={{ color: 'var(--ggui-color-neutral-400, #9ca3af)', display: 'inline-flex' }}>
          <SearchIcon />
        </span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search agents..."
          style={searchInputStyle}
        />
      </div>

      {/* Scrollable content */}
      <div style={scrollAreaStyle}>
        {/* Featured horizontal scroll */}
        {featured.length > 0 && !search.trim() && (
          <>
            <div style={sectionLabelStyle}>
              <span style={{ color: 'var(--ggui-color-amber-500, #f59e0b)', display: 'inline-flex' }}>
                <StarIcon />
              </span>
              Featured
            </div>
            <div style={featuredScrollStyle}>
              {featured.map((agent) => (
                <div
                  key={agent.id}
                  style={featuredCardStyle}
                  onClick={() => handleSelect(agent)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--ggui-color-primary-300, #7dd3fc)';
                    e.currentTarget.style.boxShadow = '0 2px 8px rgba(2, 132, 199, 0.1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--ggui-color-neutral-100, #f3f4f6)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  <div style={agentIconStyle}>
                    {agent.iconUrl ? (
                      <img src={agent.iconUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <DefaultAgentIcon />
                    )}
                  </div>
                  <div style={agentNameStyle}>{agent.name}</div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* All Agents list */}
        <div style={sectionLabelStyle}>All Agents</div>
        {filtered.length === 0 ? (
          <div style={emptyStyle}>
            <span>No agents found</span>
            {search.trim() && (
              <span style={{ fontSize: 12 }}>Try a different search term</span>
            )}
          </div>
        ) : (
          filtered.map((agent) => (
            <div
              key={agent.id}
              style={listItemStyle}
              onClick={() => handleSelect(agent)}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--ggui-color-neutral-50, #f9fafb)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '';
              }}
            >
              <div style={{ ...agentIconStyle, width: 36, height: 36, borderRadius: 8 }}>
                {agent.iconUrl ? (
                  <img src={agent.iconUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <DefaultAgentIcon />
                )}
              </div>
              <div style={listItemInfoStyle}>
                <div style={listItemNameStyle}>{agent.name}</div>
                {agent.description && <div style={listItemDescStyle}>{agent.description}</div>}
              </div>
              {agent.category && (
                <span style={{ fontSize: 10, color: 'var(--ggui-color-neutral-400, #9ca3af)', flexShrink: 0 }}>
                  {agent.category}
                </span>
              )}
              <span style={visibilityBadgeStyle(agent.visibility)}>
                {agent.visibility}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
