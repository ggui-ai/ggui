/**
 * Per-contract variant detail — `/admin/variants/:contractHash`.
 *
 * Drills into one `(appId, contractHash)` group: pretty-prints the
 * canonical contract, lists every variant under it with metadata +
 * preview, and offers an A/B comparison surface (pick any two
 * variants → render side-by-side at equal size).
 *
 * Fetches via `ggui_ops_list_blueprints({contractHash})` for the
 * indexed list path (the handler dispatches through
 * `BlueprintStore.list` when only `contractHash` is set, skipping the
 * search seam — sub-ms latency).
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-variant-detail` on the section root.
 *   - `data-ggui-variant-detail-hash={contractHash}`.
 *   - `data-ggui-variant-detail-contract` on the contract `<pre>` block.
 *   - `data-ggui-variant-compare-set={n}` on the comparison wrapper
 *     so specs can assert how many variants are mounted in compare.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';
import { navigateTo } from '../router.js';
import { BlueprintComparison } from '../components/blueprints/BlueprintComparison.js';
import { BlueprintPreview } from '../components/blueprints/BlueprintPreview.js';
import { BlueprintVariantCard } from '../components/blueprints/BlueprintVariantCard.js';
import {
  callOpsDeleteBlueprint,
  callOpsListBlueprints,
  callOpsUpdateBlueprint,
  OpsCallError,
} from '../components/blueprints/opsClient.js';

type DetailState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly blueprints: readonly Blueprint[] }
  | { readonly kind: 'error'; readonly message: string };

export interface BlueprintVariantDetailProps {
  readonly contractHash: string;
}

export function BlueprintVariantDetail({
  contractHash,
}: BlueprintVariantDetailProps): ReactElement {
  const [state, setState] = useState<DetailState>({ kind: 'loading' });
  const [compareIds, setCompareIds] = useState<readonly string[]>([]);
  const [compareActive, setCompareActive] = useState(false);

  const refresh = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setState({ kind: 'loading' });
      try {
        const res = await callOpsListBlueprints({ contractHash }, signal);
        setState({ kind: 'ready', blueprints: res.blueprints });
      } catch (err) {
        if (signal?.aborted) return;
        const message =
          err instanceof OpsCallError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setState({ kind: 'error', message });
      }
    },
    [contractHash],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // Sort variants — same deterministic order BlueprintList uses,
  // pulled out so the detail view reads the same as the parent.
  const sortedBlueprints = useMemo(() => {
    if (state.kind !== 'ready') return [];
    return [...state.blueprints].sort((a, b) => {
      const aDef = a.isOperatorDefault === true ? 1 : 0;
      const bDef = b.isOperatorDefault === true ? 1 : 0;
      if (aDef !== bDef) return bDef - aDef;
      const aScore = a.validatorScore ?? -1;
      const bScore = b.validatorScore ?? -1;
      if (aScore !== bScore) return bScore - aScore;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [state]);

  // Take the contract off the first variant — every variant in this
  // group shares the same contract (`contractHash` is content-keyed)
  // so picking the first is fine. Falls back to undefined when
  // nothing's loaded.
  const contract: DataContract | undefined = sortedBlueprints[0]?.contract;

  const compareBlueprints = useMemo(() => {
    if (!compareActive) return [];
    return sortedBlueprints.filter((bp) => compareIds.includes(bp.blueprintId));
  }, [sortedBlueprints, compareIds, compareActive]);

  const handlePreview = useCallback((blueprintId: string) => {
    navigateTo(`/preview/${encodeURIComponent(blueprintId)}`);
  }, []);

  const handleSetDefault = useCallback(
    async (blueprintId: string): Promise<void> => {
      try {
        await callOpsUpdateBlueprint({
          blueprintId,
          isOperatorDefault: true,
        });
        await refresh();
      } catch (err) {
        const message =
          err instanceof OpsCallError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setState({ kind: 'error', message });
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (blueprintId: string): Promise<void> => {
      try {
        await callOpsDeleteBlueprint({ blueprintId });
        setCompareIds((prev) => prev.filter((id) => id !== blueprintId));
        await refresh();
      } catch (err) {
        const message =
          err instanceof OpsCallError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setState({ kind: 'error', message });
      }
    },
    [refresh],
  );

  const handleCompareToggle = useCallback((blueprintId: string) => {
    setCompareIds((prev) => {
      if (prev.includes(blueprintId)) {
        return prev.filter((id) => id !== blueprintId);
      }
      return [...prev, blueprintId];
    });
  }, []);

  return (
    <section
      className="ggui-section"
      data-ggui-variant-detail
      data-ggui-variant-detail-hash={contractHash}
    >
      <SectionHead
        num="01 / contract"
        title="One contract — many variants."
        mute={`hash ${contractHash.slice(0, 16)}…`}
        intro={
          <>
            Every variant the server has for this contract, grouped
            under the canonical{' '}
            <code className="ggui-code">contractHash</code>. Pick two
            with the &quot;add to compare&quot; toggle, hit Compare
            selected, and read aesthetics side-by-side.
          </>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          onClick={() => navigateTo('/admin/variants')}
        >
          ← all variants
        </button>{' '}
        <button
          type="button"
          className="ggui-btn"
          data-ggui-variant-detail-generate
          onClick={() =>
            navigateTo(
              `/admin/variants/${encodeURIComponent(contractHash)}/generate`,
            )
          }
        >
          generate new variant +
        </button>
      </div>

      {state.kind === 'error' ? (
        <div className="ggui-card" style={{ marginBottom: 20 }}>
          <div className="ggui-card__head">
            <span className="ggui-card__title">error</span>
            <span className="ggui-card__num">ERR / 01</span>
          </div>
          <div className="ggui-card__body">
            <p className="ggui-body">
              <StatusBadge tone="signal">error</StatusBadge> Couldn&apos;t
              load variants — {state.message}.
            </p>
            <button
              type="button"
              className="ggui-btn ggui-btn--ghost"
              onClick={() => {
                void refresh();
              }}
            >
              retry →
            </button>
          </div>
        </div>
      ) : null}

      {contract ? (
        <div className="ggui-card" style={{ marginBottom: 20 }}>
          <div className="ggui-card__head">
            <span className="ggui-card__title">contract</span>
            <span className="ggui-card__num">CTR / 01</span>
          </div>
          <div className="ggui-card__body">
            <pre
              data-ggui-variant-detail-contract
              className="ggui-code"
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 280,
                overflow: 'auto',
                padding: 12,
                background: 'var(--ggui-paper2, #ebe9e1)',
                borderRadius: 4,
                margin: 0,
                fontSize: '0.75rem',
              }}
            >
              {JSON.stringify(contract, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}

      {state.kind === 'loading' ? (
        <p className="ggui-body">Loading variants…</p>
      ) : sortedBlueprints.length === 0 ? (
        <div className="ggui-card">
          <div className="ggui-card__head">
            <span className="ggui-card__title">empty</span>
            <span className="ggui-card__num">VAR / 00</span>
          </div>
          <div className="ggui-card__body">
            <p className="ggui-body">
              No variants registered for this contract.
            </p>
            <p className="ggui-muted">
              Click &quot;generate new variant&quot; above to author the
              first one.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div
            data-ggui-variant-compare-controls
            style={{
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              marginBottom: 16,
            }}
          >
            <StatusBadge tone="ink">
              {compareIds.length} selected
            </StatusBadge>
            <button
              type="button"
              className="ggui-btn"
              data-ggui-variant-compare-run
              disabled={compareIds.length < 2}
              onClick={() => setCompareActive(true)}
            >
              compare selected →
            </button>
            {compareActive ? (
              <button
                type="button"
                className="ggui-btn ggui-btn--ghost"
                data-ggui-variant-compare-clear
                onClick={() => {
                  setCompareActive(false);
                  setCompareIds([]);
                }}
              >
                exit compare
              </button>
            ) : null}
          </div>

          {compareActive && compareBlueprints.length >= 2 ? (
            <div
              data-ggui-variant-compare-set={compareBlueprints.length}
              style={{ marginBottom: 24 }}
            >
              <BlueprintComparison blueprints={compareBlueprints} height={420} />
            </div>
          ) : (
            <div
              className="ggui-stack"
              style={{ marginBottom: 24 }}
              aria-label="variants and preview"
            >
              {sortedBlueprints.map((bp, index) => (
                <article
                  key={bp.blueprintId}
                  data-ggui-variant-detail-row
                  data-ggui-variant-detail-row-id={bp.blueprintId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
                    gap: 16,
                    padding: 12,
                    borderBottom: '1px solid var(--ggui-line2, #d6d4cb)',
                  }}
                >
                  <ul
                    className="ggui-stack__list"
                    style={{ listStyle: 'none', margin: 0, padding: 0 }}
                  >
                    <BlueprintVariantCard
                      blueprint={bp}
                      index={index}
                      onPreview={handlePreview}
                      onSetDefault={(id) => {
                        void handleSetDefault(id);
                      }}
                      onDelete={(id) => {
                        void handleDelete(id);
                      }}
                      compareSelected={compareIds.includes(bp.blueprintId)}
                      onCompareToggle={handleCompareToggle}
                    />
                  </ul>
                  <BlueprintPreview blueprint={bp} height={240} />
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
