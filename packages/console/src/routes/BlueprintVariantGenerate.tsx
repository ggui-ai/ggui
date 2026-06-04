/**
 * Generate-variant form — `/admin/variants/:contractHash/generate`.
 *
 * Pre-populates the contract from the URL `contractHash` by fetching
 * any existing variant in the group (every variant in a group shares
 * the same contract because `contractHash` is content-keyed), so the
 * operator can fork from a known-good shape without retyping JSON.
 *
 * Submit calls `ggui_ops_generate_blueprint`. On success, navigates
 * to the new variant's preview. On failure, the error surfaces inline
 * in the form.
 *
 * When the group is empty (operator typed a hash that doesn't exist
 * yet, or arrived from a clipboard link), the page renders a "no
 * contract found" state — the form needs a real contract shape to
 * submit, and we don't have a free-form contract editor in v1.
 */
import { useEffect, useState, type ReactElement } from 'react';
import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import { SectionHead } from '../brand/SectionHead.js';
import { StatusBadge } from '../brand/StatusBadge.js';
import { navigateTo } from '../router.js';
import { BlueprintGenerateForm } from '../components/blueprints/BlueprintGenerateForm.js';
import {
  callOpsGenerateBlueprint,
  callOpsListBlueprints,
  OpsCallError,
} from '../components/blueprints/opsClient.js';

type PageState =
  | { readonly kind: 'loading' }
  | {
      readonly kind: 'ready';
      readonly contract: DataContract;
      readonly variantCount: number;
    }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message: string };

export interface BlueprintVariantGenerateProps {
  readonly contractHash: string;
}

export function BlueprintVariantGenerate({
  contractHash,
}: BlueprintVariantGenerateProps): ReactElement {
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await callOpsListBlueprints(
          { contractHash },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (res.blueprints.length === 0) {
          setState({ kind: 'empty' });
          return;
        }
        const first = res.blueprints[0] as Blueprint;
        setState({
          kind: 'ready',
          contract: first.contract,
          variantCount: res.blueprints.length,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        const message =
          err instanceof OpsCallError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        setState({ kind: 'error', message });
      }
    })();
    return () => controller.abort();
  }, [contractHash]);

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / generate"
        title="Author a new variant."
        mute={`hash ${contractHash.slice(0, 16)}…`}
        intro={
          <>
            Forks the contract from an existing variant in this group
            and dispatches it through{' '}
            <code className="ggui-code">ggui_ops_generate_blueprint</code>{' '}
            with your persona + context + seed prompt. The new blueprint
            persists under the same{' '}
            <code className="ggui-code">contractHash</code>.
          </>
        }
      />

      <div style={{ marginBottom: 16 }}>
        <button
          type="button"
          className="ggui-btn ggui-btn--ghost"
          onClick={() =>
            navigateTo(
              `/admin/variants/${encodeURIComponent(contractHash)}`,
            )
          }
        >
          ← contract detail
        </button>
      </div>

      {state.kind === 'loading' ? (
        <p className="ggui-body">Loading contract…</p>
      ) : state.kind === 'error' ? (
        <div className="ggui-card">
          <div className="ggui-card__head">
            <span className="ggui-card__title">error</span>
            <span className="ggui-card__num">ERR / 01</span>
          </div>
          <div className="ggui-card__body">
            <p className="ggui-body">
              <StatusBadge tone="signal">error</StatusBadge>{' '}
              Couldn&apos;t load contract — {state.message}.
            </p>
            <button
              type="button"
              className="ggui-btn ggui-btn--ghost"
              onClick={() => navigateTo('/admin/variants')}
            >
              ← all variants
            </button>
          </div>
        </div>
      ) : state.kind === 'empty' ? (
        <div className="ggui-card">
          <div className="ggui-card__head">
            <span className="ggui-card__title">empty</span>
            <span className="ggui-card__num">VAR / 00</span>
          </div>
          <div className="ggui-card__body">
            <p className="ggui-body">
              No variant exists for hash{' '}
              <code className="ggui-code">{contractHash}</code> yet.
            </p>
            <p className="ggui-muted">
              The generate form needs an existing variant to fork the
              contract from. Either trigger a render from an agent first
              (which will mint the initial variant), or navigate back
              and pick a contract with at least one variant.
            </p>
            <button
              type="button"
              className="ggui-btn ggui-btn--ghost"
              onClick={() => navigateTo('/admin/variants')}
            >
              ← all variants
            </button>
          </div>
        </div>
      ) : (
        <BlueprintGenerateForm
          contract={state.contract}
          contractHash={contractHash}
          onSubmit={async (input) => {
            try {
              const result = await callOpsGenerateBlueprint(input);
              // Navigate to the new variant's preview surface.
              navigateTo(
                `/preview/${encodeURIComponent(result.blueprintId)}`,
              );
              return { blueprintId: result.blueprintId };
            } catch (err) {
              const message =
                err instanceof OpsCallError
                  ? err.message
                  : err instanceof Error
                    ? err.message
                    : String(err);
              return { error: message };
            }
          }}
          onCancel={() =>
            navigateTo(
              `/admin/variants/${encodeURIComponent(contractHash)}`,
            )
          }
        />
      )}
    </section>
  );
}
