/**
 * Blueprint variants list — `/admin/variants`.
 *
 * The operator's primary surface for the multi-variant blueprint
 * system. Fetches every variant in this app via
 * `ggui_ops_list_blueprints` (no filters → all variants under the
 * caller's `appId`), groups by `contractHash`, and renders each group
 * with the deterministic fallback-ladder ordering so the matcher's
 * pick reads first.
 *
 * Sibling pages:
 *
 *   - `/admin/blueprints` (legacy) — declared + cached registry view.
 *     The OG `Blueprints.tsx` page. NOT this surface — that one's
 *     about the operator-declared static catalog and the intent-keyed
 *     cache, which long predate the MVB variant model.
 *   - `/admin/variants/:contractHash` — per-contract detail (this
 *     file's click-through).
 *
 * Filter axes (see {@link BlueprintFilterBar}):
 *   - persona substring
 *   - generator slug
 *   - drafts-only toggle
 *
 * The browser sends an MCP JSON-RPC `tools/call` directly to `/ops`;
 * see `../components/blueprints/opsClient.ts` for the wire detail.
 * Same-origin auth via the `ggui_console_admin` cookie.
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { Blueprint } from '@ggui-ai/protocol';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';
import { navigateTo } from '../router.js';
import {
  BlueprintFilterBar,
  EMPTY_VARIANT_FILTERS,
  type VariantFilters,
} from '../components/blueprints/BlueprintFilterBar.js';
import { BlueprintList } from '../components/blueprints/BlueprintList.js';
import {
  callOpsDeleteBlueprint,
  callOpsListBlueprints,
  callOpsUpdateBlueprint,
  OpsCallError,
} from '../components/blueprints/opsClient.js';

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly blueprints: readonly Blueprint[] }
  | { readonly kind: 'error'; readonly message: string };

export function BlueprintVariants(): ReactElement {
  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [filters, setFilters] = useState<VariantFilters>(EMPTY_VARIANT_FILTERS);

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const res = await callOpsListBlueprints({}, signal);
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
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

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
      // No confirm dialog — the brand kit has no toast / modal
      // infrastructure yet, and the ops tool is idempotent, so worst
      // case the operator re-creates. When toast infra lands, gate
      // here.
      try {
        await callOpsDeleteBlueprint({ blueprintId });
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

  const handleOpenContract = useCallback((contractHash: string) => {
    navigateTo(`/admin/variants/${encodeURIComponent(contractHash)}`);
  }, []);

  const handleGenerate = useCallback((contractHash: string) => {
    navigateTo(
      `/admin/variants/${encodeURIComponent(contractHash)}/generate`,
    );
  }, []);

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / variants"
        title="Blueprint variants — N codes per contract."
        mute="Operator-pinned defaults · validatorScore · personas."
        intro={
          <>
            Every blueprint variant the server has for the current app,
            grouped by the contract they implement. The matcher picks
            among siblings in a group at handshake time — pin one as the
            operator default to fix the floor, or seed personas for the
            LLM selector (MVB-6) to choose from.
          </>
        }
      />

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

      <BlueprintFilterBar filters={filters} onChange={setFilters} />

      {state.kind === 'loading' ? (
        <div className="ggui-card">
          <div className="ggui-card__head">
            <span className="ggui-card__title">loading</span>
            <span className="ggui-card__num">VAR / 01</span>
          </div>
          <div className="ggui-card__body">
            <p className="ggui-body">Loading variants…</p>
          </div>
        </div>
      ) : state.kind === 'ready' ? (
        <BlueprintList
          blueprints={state.blueprints}
          filters={filters}
          onPreview={handlePreview}
          onSetDefault={(id) => {
            void handleSetDefault(id);
          }}
          onDelete={(id) => {
            void handleDelete(id);
          }}
          onOpenContract={handleOpenContract}
          onGenerate={handleGenerate}
        />
      ) : null}
    </section>
  );
}
