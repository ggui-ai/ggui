import { useState, useEffect, useMemo, useCallback } from 'react';
import type { CommandPaletteProps, Command } from './types';
import { Spinner } from '../primitives/Spinner';
import { Icon } from '../primitives/Icon';
import { colors } from '../tokens/colors';
import { radius, shadow, zIndex } from '../tokens/spacing';
import { fontSize, fontWeight } from '../tokens/typography';

/**
 * CommandPalette - A searchable command menu (like Cmd+K)
 */
export function CommandPalette({
  open,
  onClose,
  commands,
  onSelect,
  placeholder = 'Search commands...',
  recentIds = [],
  loading,
  style,
  className,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Filter and group commands
  const filteredCommands = useMemo(() => {
    const filtered = query
      ? commands.filter(
          (cmd) =>
            cmd.label.toLowerCase().includes(query.toLowerCase()) ||
            cmd.description?.toLowerCase().includes(query.toLowerCase())
        )
      : commands;

    // Group by group name
    const groups = new Map<string, Command[]>();

    // Add recent commands first if no query
    if (!query && recentIds.length > 0) {
      const recentCommands = recentIds
        .map((id) => commands.find((c) => c.id === id))
        .filter(Boolean) as Command[];
      if (recentCommands.length > 0) {
        groups.set('Recent', recentCommands);
      }
    }

    filtered.forEach((cmd) => {
      const group = cmd.group || 'Commands';
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      // Don't duplicate if already in recent
      if (!query && recentIds.includes(cmd.id) && groups.has('Recent')) {
        return;
      }
      groups.get(group)!.push(cmd);
    });

    return groups;
  }, [commands, query, recentIds]);

  // Flatten for keyboard navigation
  const flatCommands = useMemo(() => {
    const flat: Command[] = [];
    filteredCommands.forEach((cmds) => flat.push(...cmds));
    return flat;
  }, [filteredCommands]);

  // Reset selection on query change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  // Handle escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatCommands.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = flatCommands[selectedIndex];
        if (selected && !selected.disabled) {
          onSelect(selected);
          onClose();
        }
      }
    },
    [flatCommands, selectedIndex, onSelect, onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  let currentIndex = 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: zIndex.modal,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
    >
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
        }}
      />

      {/* Palette */}
      <div
        role="dialog"
        className={className}
        style={{
          position: 'relative',
          width: '560px',
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: '60vh',
          backgroundColor: colors.white,
          borderRadius: radius.xl,
          boxShadow: shadow['2xl'],
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          ...style,
        }}
      >
        {/* Search input */}
        <div style={{ padding: '12px', borderBottom: `1px solid ${colors.gray[200]}` }}>
          <div style={{ position: 'relative' }}>
            <Icon
              name="search"
              size={18}
              tone="subtle"
              style={{
                position: 'absolute',
                left: '12px',
                top: '50%',
                transform: 'translateY(-50%)',
              }}
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              autoFocus
              style={{
                width: '100%',
                padding: '12px 12px 12px 42px',
                border: 'none',
                fontSize: fontSize.base,
                outline: 'none',
                backgroundColor: 'transparent',
              }}
            />
          </div>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '32px' }}>
              <Spinner size={24} />
            </div>
          ) : flatCommands.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: colors.gray[500] }}>
              No commands found
            </div>
          ) : (
            Array.from(filteredCommands.entries()).map(([group, cmds]) => (
              <div key={group} style={{ marginBottom: '8px' }}>
                <div
                  style={{
                    padding: '8px 12px',
                    fontSize: fontSize.xs,
                    fontWeight: fontWeight.semibold,
                    color: colors.gray[500],
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {group}
                </div>
                {cmds.map((cmd) => {
                  const index = currentIndex++;
                  const isSelected = index === selectedIndex;

                  return (
                    <button
                      key={cmd.id}
                      onClick={() => {
                        if (!cmd.disabled) {
                          onSelect(cmd);
                          onClose();
                        }
                      }}
                      disabled={cmd.disabled}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        width: '100%',
                        padding: '10px 12px',
                        border: 'none',
                        borderRadius: radius.md,
                        backgroundColor: isSelected ? colors.gray[100] : 'transparent',
                        color: cmd.disabled ? colors.gray[400] : colors.gray[900],
                        textAlign: 'left',
                        cursor: cmd.disabled ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {cmd.icon && (
                        <span style={{ display: 'flex', color: colors.gray[500] }}>
                          {cmd.icon}
                        </span>
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: fontSize.sm }}>{cmd.label}</div>
                        {cmd.description && (
                          <div style={{ fontSize: fontSize.xs, color: colors.gray[500] }}>
                            {cmd.description}
                          </div>
                        )}
                      </div>
                      {cmd.shortcut && (
                        <kbd
                          style={{
                            padding: '2px 6px',
                            backgroundColor: colors.gray[100],
                            borderRadius: radius.sm,
                            fontSize: fontSize.xs,
                            color: colors.gray[500],
                            fontFamily: 'inherit',
                          }}
                        >
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          style={{
            padding: '8px 12px',
            borderTop: `1px solid ${colors.gray[200]}`,
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            fontSize: fontSize.xs,
            color: colors.gray[500],
          }}
        >
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
