import { useState, type CSSProperties } from 'react';
import type { Incident, IncidentSeverity, IncidentStatus, IncidentTimelineProps } from './types';

const severityColors: Record<IncidentSeverity, { bg: string; text: string; dot: string }> = {
  minor: {
    bg: 'var(--ggui-color-warning-50, #fffbeb)',
    text: 'var(--ggui-color-warning-700, #b45309)',
    dot: 'var(--ggui-color-warning-500, #f59e0b)',
  },
  major: {
    bg: 'var(--ggui-color-error-50, #fef2f2)',
    text: 'var(--ggui-color-error-700, #b91c1c)',
    dot: 'var(--ggui-color-error-500, #ef4444)',
  },
  critical: {
    bg: 'var(--ggui-color-error-100, #fee2e2)',
    text: 'var(--ggui-color-error-800, #991b1b)',
    dot: 'var(--ggui-color-error-700, #b91c1c)',
  },
};

const statusLabels: Record<IncidentStatus, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};

function getDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTime(date: string | Date): string {
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function getWorstSeverity(incidents: Incident[]): IncidentSeverity | null {
  if (incidents.some(i => i.severity === 'critical')) return 'critical';
  if (incidents.some(i => i.severity === 'major')) return 'major';
  if (incidents.some(i => i.severity === 'minor')) return 'minor';
  return null;
}

function DaySquare({ severity }: { severity: IncidentSeverity | null }) {
  const color = severity
    ? severityColors[severity].dot
    : 'var(--ggui-color-success-500, #22c55e)';

  const style: CSSProperties = {
    width: '12px',
    height: '12px',
    borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
    backgroundColor: color,
    flexShrink: 0,
  };

  return <div style={style} />;
}

function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  const colors = severityColors[severity];
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: 'var(--ggui-font-size-xs, 12px)',
    fontWeight: 500,
    padding: '2px 8px',
    borderRadius: 'var(--ggui-shape-radius-full, 9999px)',
    backgroundColor: colors.bg,
    color: colors.text,
    textTransform: 'capitalize',
  };

  return <span style={style}>{severity}</span>;
}

function StatusLabel({ status }: { status: IncidentStatus }) {
  const isResolved = status === 'resolved';
  const style: CSSProperties = {
    fontSize: 'var(--ggui-font-size-xs, 12px)',
    color: isResolved
      ? 'var(--ggui-color-success-600, #16a34a)'
      : 'var(--ggui-color-onSurfaceVariant, #52525b)',
    fontWeight: isResolved ? 500 : 400,
  };

  return <span style={style}>{statusLabels[status]}</span>;
}

function IncidentCard({
  incident,
  compact,
}: {
  incident: Incident;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const cardStyle: CSSProperties = {
    border: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
    borderRadius: 'var(--ggui-shape-radius-md, 8px)',
    overflow: 'hidden',
    backgroundColor: 'var(--ggui-color-surface, #ffffff)',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    cursor: compact ? 'default' : 'pointer',
    gap: '8px',
  };

  const titleStyle: CSSProperties = {
    fontSize: 'var(--ggui-font-size-sm, 14px)',
    fontWeight: 500,
    color: 'var(--ggui-color-onSurface, #18181b)',
    margin: 0,
    flex: 1,
    minWidth: 0,
  };

  return (
    <div style={cardStyle}>
      <div
        style={headerStyle}
        onClick={compact ? undefined : () => setExpanded(!expanded)}
        role={compact ? undefined : 'button'}
        tabIndex={compact ? undefined : 0}
        onKeyDown={compact ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
          <SeverityBadge severity={incident.severity} />
          <p style={titleStyle}>{incident.title}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
          <StatusLabel status={incident.status} />
          {!compact && (
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ggui-color-outline, #d4d4d8)"
              strokeWidth="2"
              style={{
                transform: expanded ? 'rotate(180deg)' : 'none',
                transition: 'transform 200ms cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          )}
        </div>
      </div>

      {/* Affected services */}
      {incident.affectedServices && incident.affectedServices.length > 0 && (
        <div style={{ padding: '0 16px 8px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
          {incident.affectedServices.map((service) => (
            <span
              key={service}
              style={{
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
                backgroundColor: 'var(--ggui-color-surfaceVariant, #f4f4f5)',
                color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              }}
            >
              {service}
            </span>
          ))}
        </div>
      )}

      {/* Update log (expandable) */}
      {!compact && expanded && incident.updates.length > 0 && (
        <div
          style={{
            borderTop: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
            padding: '12px 16px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {incident.updates.map((update) => (
              <div key={update.id} style={{ display: 'flex', gap: '8px', fontSize: '12px' }}>
                <span
                  style={{
                    color: 'var(--ggui-color-outline, #d4d4d8)',
                    flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatTime(update.timestamp)}
                </span>
                <span
                  style={{
                    fontWeight: 500,
                    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                    flexShrink: 0,
                    textTransform: 'capitalize',
                  }}
                >
                  {statusLabels[update.status]}
                </span>
                <span style={{ color: 'var(--ggui-color-onSurface, #18181b)' }}>
                  {update.message}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function IncidentTimeline({
  incidents,
  days = 14,
  emptyText = 'All systems operational',
  compact = false,
  style,
  className,
}: IncidentTimelineProps) {
  // Build day map: date key → incidents
  const now = new Date();
  const dayEntries: { date: Date; key: string; incidents: Incident[] }[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const key = getDayKey(date);

    const dayIncidents = incidents.filter((inc) => {
      const created = new Date(inc.createdAt);
      return getDayKey(created) === key;
    });

    dayEntries.push({ date, key, incidents: dayIncidents });
  }

  const hasAnyIncidents = incidents.length > 0;

  const containerStyle: CSSProperties = {
    fontFamily: 'var(--ggui-font-family-sans, Inter, system-ui, sans-serif)',
    ...style,
  };

  return (
    <div style={containerStyle} className={className}>
      {/* Uptime grid */}
      <div style={{ marginBottom: '24px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '8px',
          }}
        >
          <span
            style={{
              fontSize: 'var(--ggui-font-size-sm, 14px)',
              fontWeight: 500,
              color: 'var(--ggui-color-onSurface, #18181b)',
            }}
          >
            {days}-Day History
          </span>
          {!hasAnyIncidents && (
            <span
              style={{
                fontSize: 'var(--ggui-font-size-xs, 12px)',
                color: 'var(--ggui-color-success-600, #16a34a)',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <DaySquare severity={null} />
              {emptyText}
            </span>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: '3px',
            flexDirection: 'row-reverse',
            justifyContent: 'flex-end',
          }}
        >
          {dayEntries.map((entry) => {
            const severity = getWorstSeverity(entry.incidents);
            return (
              <div
                key={entry.key}
                title={`${formatDate(entry.date)}: ${entry.incidents.length === 0 ? 'No incidents' : `${entry.incidents.length} incident(s)`}`}
              >
                <DaySquare severity={severity} />
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '4px',
            fontSize: '10px',
            color: 'var(--ggui-color-outline, #d4d4d8)',
          }}
        >
          <span>{formatDate(dayEntries[dayEntries.length - 1]?.date ?? now)}</span>
          <span>Today</span>
        </div>
      </div>

      {/* Incident list by day */}
      {hasAnyIncidents && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {dayEntries
            .filter((e) => e.incidents.length > 0)
            .map((entry) => (
              <div key={entry.key}>
                <div
                  style={{
                    fontSize: 'var(--ggui-font-size-xs, 12px)',
                    fontWeight: 500,
                    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                    marginBottom: '8px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {formatDate(entry.date)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {entry.incidents.map((incident) => (
                    <IncidentCard
                      key={incident.id}
                      incident={incident}
                      compact={compact}
                    />
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
