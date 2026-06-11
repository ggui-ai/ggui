/**
 * Per-variant card row in the blueprint list.
 *
 * Renders one {@link Blueprint} as a `ggui-stack__entry` row with:
 *
 *   - persona badge (from `variance.persona`)
 *   - source badge (`llm` → the engine's generator slug; `user` /
 *     `curated` → the provenance kind)
 *   - validatorScore badge (color-coded — high score = `live`, mid =
 *     `draft`, sub-threshold = `signal`)
 *   - operator-default star (★) when `isOperatorDefault === true`
 *   - createdBy badge (`agent` vs `operator`)
 *   - three action buttons: preview, set-as-default, delete
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-variant-card` on the row root.
 *   - `data-ggui-variant-id={blueprintId}` for row identity.
 *   - `data-ggui-variant-default={'true'|'false'}` so specs can assert
 *     the default flag transition without parsing the star glyph.
 *   - `data-ggui-variant-action="preview"` / `"set-default"` /
 *     `"delete"` on the three buttons.
 */
import type { ReactElement } from 'react';
import type { Blueprint, BlueprintSource } from '@ggui-ai/protocol';
import { StatusBadge } from '../../brand/StatusBadge.js';
import { DRAFT_VALIDATOR_THRESHOLD } from './BlueprintFilterBar.js';

export interface BlueprintVariantCardProps {
  readonly blueprint: Blueprint;
  readonly index: number;
  readonly onPreview: (blueprintId: string) => void;
  readonly onSetDefault: (blueprintId: string) => void;
  readonly onDelete: (blueprintId: string) => void;
  /** When true, this variant is one of the operator's compare picks.
   *  Surfaces a checkmark accent + the role="presentation" on the row
   *  background so specs can detect the active comparison set. */
  readonly compareSelected?: boolean;
  readonly onCompareToggle?: (blueprintId: string) => void;
}

/** Color tone for a validatorScore. Mirrors the brand kit's three-tone
 *  semantic palette: pass (live), partial (draft), sub-threshold
 *  (signal). Surface in the badge color + the data-attr so browser
 *  specs can read either. */
function toneForScore(score: number): 'live' | 'draft' | 'signal' {
  if (score >= DRAFT_VALIDATOR_THRESHOLD) return 'live';
  if (score >= 0.5) return 'draft';
  return 'signal';
}

/** Badge label for a variant's provenance. `llm`-sourced rows carry the
 *  engine's generator slug; `user` / `curated` rows have no engine
 *  provenance, so the kind itself is the truthful label. */
function sourceLabel(source: BlueprintSource): string {
  return source.kind === 'llm' ? source.generator : source.kind;
}

export function BlueprintVariantCard({
  blueprint,
  index,
  onPreview,
  onSetDefault,
  onDelete,
  compareSelected,
  onCompareToggle,
}: BlueprintVariantCardProps): ReactElement {
  const isDefault = blueprint.isOperatorDefault === true;
  const persona = blueprint.variance.persona;
  const score = blueprint.validatorScore;
  return (
    <li
      data-ggui-variant-card
      data-ggui-variant-id={blueprint.blueprintId}
      data-ggui-variant-default={isDefault ? 'true' : 'false'}
      data-ggui-variant-compare-selected={compareSelected ? 'true' : 'false'}
      className="ggui-stack__entry"
      style={
        compareSelected
          ? { outline: '2px solid var(--ggui-ink, #292929)' }
          : undefined
      }
    >
      <div className="ggui-stack__entry-head">
        <span className="ggui-stack__entry-num">
          {`VAR / ${String(index + 1).padStart(2, '0')}`}
        </span>
        <span className="ggui-stack__entry-title">
          {isDefault ? <span aria-label="operator default">★ </span> : null}
          {persona && persona.length > 0 ? persona : '(no persona)'}
        </span>
        {persona ? (
          <StatusBadge tone="ink">persona: {persona}</StatusBadge>
        ) : null}
        <StatusBadge tone="ink">{sourceLabel(blueprint.source)}</StatusBadge>
        {typeof score === 'number' ? (
          <StatusBadge tone={toneForScore(score)}>
            score {score.toFixed(2)}
          </StatusBadge>
        ) : null}
        <StatusBadge tone={blueprint.createdBy === 'operator' ? 'live' : 'draft'}>
          by {blueprint.createdBy}
        </StatusBadge>
      </div>
      <div className="ggui-stack__entry-meta">
        <code className="ggui-code">{blueprint.blueprintId}</code>
        <span style={{ marginLeft: 12 }}>
          created {formatTimestamp(blueprint.createdAt)}
        </span>
        {blueprint.codeHash ? (
          <span style={{ marginLeft: 12 }}>
            hash <code className="ggui-code">{shorten(blueprint.codeHash)}</code>
          </span>
        ) : (
          <span style={{ marginLeft: 12 }}>
            <StatusBadge tone="signal">no code</StatusBadge>
          </span>
        )}
      </div>
      {blueprint.variance.seedPrompt ? (
        <p
          className="ggui-muted"
          style={{ margin: '8px 0 0', fontStyle: 'italic' }}
        >
          &ldquo;{blueprint.variance.seedPrompt}&rdquo;
        </p>
      ) : null}
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginTop: 12,
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          data-ggui-variant-action="preview"
          onClick={() => onPreview(blueprint.blueprintId)}
        >
          preview →
        </button>
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          data-ggui-variant-action="set-default"
          disabled={isDefault}
          onClick={() => onSetDefault(blueprint.blueprintId)}
          title={
            isDefault
              ? 'Already the operator default for this contract'
              : 'Pin as the operator default for this contract'
          }
        >
          {isDefault ? '★ default' : 'set as default'}
        </button>
        {onCompareToggle ? (
          <button
            type="button"
            className="ggui-btn ggui-btn--ghost"
            data-ggui-variant-action="compare-toggle"
            onClick={() => onCompareToggle(blueprint.blueprintId)}
          >
            {compareSelected ? '✓ in compare' : 'add to compare'}
          </button>
        ) : null}
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          data-ggui-variant-action="delete"
          onClick={() => onDelete(blueprint.blueprintId)}
        >
          delete ✕
        </button>
      </div>
    </li>
  );
}

function formatTimestamp(iso: string): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  } catch {
    return iso;
  }
}

function shorten(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}
