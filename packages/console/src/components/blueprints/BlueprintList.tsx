/**
 * Grouped list of blueprint variants — top-level surface for
 * `/admin/variants`. Groups by `contractHash`, surfaces a variant
 * count + intent peek per group, and renders each variant via
 * {@link BlueprintVariantCard}.
 *
 * The "intent" in the group header reads `contract.intent` when
 * present (per the `DataContract` shape), falling back to a hash
 * prefix. This is operator UX — the contract is the actual identity,
 * but humans navigate better by intent text than 64-hex strings.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-variants-list` on the root.
 *   - `data-ggui-variants-group` on each contract section.
 *   - `data-ggui-variants-group-hash={contractHash}` for identity.
 *   - `data-ggui-variants-group-count={n}` so specs can assert grouping
 *     without scraping inner DOM.
 */
import { useMemo, useState, type ReactElement } from 'react';
import type { Blueprint } from '@ggui-ai/protocol';
import { StatusBadge } from '../../brand/StatusBadge.js';
import {
  BlueprintVariantCard,
} from './BlueprintVariantCard.js';
import {
  blueprintMatchesFilters,
  type VariantFilters,
} from './BlueprintFilterBar.js';

export interface BlueprintListProps {
  readonly blueprints: readonly Blueprint[];
  readonly filters: VariantFilters;
  readonly onPreview: (blueprintId: string) => void;
  readonly onSetDefault: (blueprintId: string) => void;
  readonly onDelete: (blueprintId: string) => void;
  readonly onOpenContract: (contractHash: string) => void;
  readonly onGenerate: (contractHash: string) => void;
}

interface ContractGroup {
  readonly contractHash: string;
  readonly intent: string;
  readonly blueprints: readonly Blueprint[];
}

/**
 * Pure grouping helper — exported so the test can exercise the
 * grouping logic in isolation. Returns groups in stable creation-order
 * by their first blueprint's `createdAt` desc.
 */
export function groupBlueprintsByContract(
  blueprints: readonly Blueprint[],
): readonly ContractGroup[] {
  const buckets = new Map<string, Blueprint[]>();
  for (const bp of blueprints) {
    const existing = buckets.get(bp.contractHash);
    if (existing) {
      existing.push(bp);
    } else {
      buckets.set(bp.contractHash, [bp]);
    }
  }
  return Array.from(buckets.entries())
    .map<ContractGroup>(([contractHash, bps]) => {
      // Stable within-group order — operator-default first, then
      // validatorScore desc, then createdAt desc. Mirrors the
      // matcher's deterministic fallback ladder so the UI reads like
      // the matcher would pick.
      const sorted = [...bps].sort((a, b) => {
        const aDef = a.isOperatorDefault === true ? 1 : 0;
        const bDef = b.isOperatorDefault === true ? 1 : 0;
        if (aDef !== bDef) return bDef - aDef;
        const aScore = a.validatorScore ?? -1;
        const bScore = b.validatorScore ?? -1;
        if (aScore !== bScore) return bScore - aScore;
        return b.createdAt.localeCompare(a.createdAt);
      });
      // Intent fallback: contract.intent when present, else hash prefix.
      const first = sorted[0];
      const intent =
        first !== undefined && typeof first.contract === 'object' &&
        first.contract !== null &&
        'intent' in first.contract &&
        typeof (first.contract as { intent?: unknown }).intent === 'string'
          ? ((first.contract as { intent: string }).intent)
          : `(contract ${contractHash.slice(0, 10)}…)`;
      return { contractHash, intent, blueprints: sorted };
    })
    .sort((a, b) => {
      // Outer group order — newest-touched contract first.
      const aMax = a.blueprints[0]?.createdAt ?? '';
      const bMax = b.blueprints[0]?.createdAt ?? '';
      return bMax.localeCompare(aMax);
    });
}

export function BlueprintList({
  blueprints,
  filters,
  onPreview,
  onSetDefault,
  onDelete,
  onOpenContract,
  onGenerate,
}: BlueprintListProps): ReactElement {
  const groups = useMemo(() => groupBlueprintsByContract(blueprints), [
    blueprints,
  ]);

  if (blueprints.length === 0) {
    return (
      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">empty</span>
          <span className="ggui-card__num">VAR / 00</span>
        </div>
        <div className="ggui-card__body">
          <p className="ggui-body" style={{ margin: 0 }}>
            No blueprints for this app yet.
          </p>
          <p className="ggui-muted" style={{ margin: '8px 0 0' }}>
            Generate one via the per-contract page, or wait for an
            agent to render a contract through{' '}
            <code className="ggui-code">ggui_handshake</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-ggui-variants-list aria-label="blueprint variants">
      {groups.map((group) => (
        <ContractGroupCard
          key={group.contractHash}
          group={group}
          filters={filters}
          onPreview={onPreview}
          onSetDefault={onSetDefault}
          onDelete={onDelete}
          onOpenContract={onOpenContract}
          onGenerate={onGenerate}
        />
      ))}
    </div>
  );
}

function ContractGroupCard({
  group,
  filters,
  onPreview,
  onSetDefault,
  onDelete,
  onOpenContract,
  onGenerate,
}: {
  readonly group: ContractGroup;
  readonly filters: VariantFilters;
  readonly onPreview: (blueprintId: string) => void;
  readonly onSetDefault: (blueprintId: string) => void;
  readonly onDelete: (blueprintId: string) => void;
  readonly onOpenContract: (contractHash: string) => void;
  readonly onGenerate: (contractHash: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(true);
  const visible = group.blueprints.filter((bp) =>
    blueprintMatchesFilters(bp, filters),
  );
  return (
    <section
      data-ggui-variants-group
      data-ggui-variants-group-hash={group.contractHash}
      data-ggui-variants-group-count={visible.length}
      className="ggui-stack"
      style={{ marginBottom: 24 }}
    >
      <header
        className="ggui-stack__head"
        style={{ alignItems: 'center', gap: 12 }}
      >
        <button
          type="button"
          aria-expanded={expanded}
          data-ggui-variants-group-toggle
          onClick={() => setExpanded((v) => !v)}
          className="ggui-stack__num"
          style={{
            background: 'transparent',
            border: 'none',
            font: 'inherit',
            cursor: 'pointer',
            color: 'inherit',
            padding: 0,
          }}
        >
          {expanded ? '▾' : '▸'} VAR
        </button>
        <span className="ggui-stack__label">{group.intent}</span>
        <StatusBadge tone="ink">
          {visible.length}
          {visible.length !== group.blueprints.length
            ? ` / ${group.blueprints.length}`
            : ''}{' '}
          variant{visible.length === 1 ? '' : 's'}
        </StatusBadge>
        <code
          className="ggui-code"
          style={{ marginLeft: 'auto', fontSize: '0.75rem' }}
        >
          {group.contractHash.slice(0, 16)}…
        </code>
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          data-ggui-variants-group-open
          onClick={() => onOpenContract(group.contractHash)}
        >
          open →
        </button>
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          data-ggui-variants-group-generate
          onClick={() => onGenerate(group.contractHash)}
        >
          generate variant +
        </button>
      </header>
      {expanded ? (
        visible.length === 0 ? (
          <p
            className="ggui-muted"
            style={{ margin: 0, padding: 12 }}
          >
            No variants in this group match the active filters.
          </p>
        ) : (
          <ul className="ggui-stack__list">
            {visible.map((bp, index) => (
              <BlueprintVariantCard
                key={bp.blueprintId}
                blueprint={bp}
                index={index}
                onPreview={onPreview}
                onSetDefault={onSetDefault}
                onDelete={onDelete}
              />
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
