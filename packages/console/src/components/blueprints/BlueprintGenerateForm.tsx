/**
 * Form to trigger `ggui_ops_generate_blueprint` for a contract.
 *
 * Inputs:
 *   - **contract** (read-only, pre-populated from URL). Surfaces as a
 *     `<pre>` block so the operator can visually confirm.
 *   - **persona** — free-form tag (e.g. `minimalist`). Operator UX:
 *     the handler will lowercase+trim before persistence.
 *   - **context** — JSON editor (textarea). Parsed on submit. Empty
 *     means no `context` carried.
 *   - **seedPrompt** — raw style hint, optional. Round-trip input
 *     for the LLM-driven variant selector.
 *   - **generator** — slug select. Empty means dispatch through the
 *     registry default.
 *   - **setAsOperatorDefault** — checkbox; when checked, the
 *     newly-minted blueprint pins as the default for its `(appId,
 *     contractHash)` group.
 *
 * Loading state: while in flight, the submit button disables and the
 * form prints a `pending` badge. On success, the parent navigates to
 * the new variant's preview; on failure, the error renders inline.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-variant-generate-form` on the form root.
 *   - `data-ggui-variant-generate-state="idle"|"pending"|"error"`
 *     so specs can assert the lifecycle without inspecting button
 *     copy.
 *   - `data-ggui-variant-generate-submit` on the submit button.
 */
import {
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type {
  DataContract,
  JsonValue,
  OpsGenerateBlueprintInput,
} from '@ggui-ai/protocol';
import { StatusBadge } from '../../brand/StatusBadge.js';
import { KNOWN_GENERATOR_SLUGS } from './BlueprintFilterBar.js';

export interface BlueprintGenerateFormProps {
  readonly contract: DataContract;
  readonly contractHash: string;
  readonly onSubmit: (
    input: OpsGenerateBlueprintInput,
  ) => Promise<{ readonly blueprintId: string } | { readonly error: string }>;
  readonly onCancel?: () => void;
  /** Slugs to surface in the generator select. Defaults to {@link
   *  KNOWN_GENERATOR_SLUGS}. */
  readonly generatorSlugs?: readonly string[];
}

type FormState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'error'; readonly message: string };

export function BlueprintGenerateForm({
  contract,
  contractHash,
  onSubmit,
  onCancel,
  generatorSlugs,
}: BlueprintGenerateFormProps): ReactElement {
  const [persona, setPersona] = useState('');
  const [seedPrompt, setSeedPrompt] = useState('');
  const [generator, setGenerator] = useState('');
  const [contextText, setContextText] = useState('');
  const [setAsOperatorDefault, setSetAsOperatorDefault] = useState(false);
  const [state, setState] = useState<FormState>({ kind: 'idle' });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    let context: Record<string, JsonValue> | undefined;
    if (contextText.trim().length > 0) {
      try {
        const parsed = JSON.parse(contextText) as unknown;
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setState({
            kind: 'error',
            message: 'context must be a JSON object (e.g. {"foo": "bar"})',
          });
          return;
        }
        // JSON.parse never emits `undefined` values (the JSON grammar
        // forbids it), so a parsed object is safe to type as
        // `Record<string, JsonValue>` even though the static `JsonObject`
        // alias is `JsonValue | undefined` to model TS interfaces with
        // optional properties.
        context = parsed as Record<string, JsonValue>;
      } catch (err) {
        setState({
          kind: 'error',
          message: `context JSON parse failed — ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        return;
      }
    }
    setState({ kind: 'pending' });
    const input: OpsGenerateBlueprintInput = {
      contract,
      ...(generator.length > 0 ? { generator } : {}),
      ...(persona.trim().length > 0 ? { persona: persona.trim() } : {}),
      ...(context !== undefined ? { context } : {}),
      ...(seedPrompt.trim().length > 0 ? { seedPrompt: seedPrompt.trim() } : {}),
      ...(setAsOperatorDefault ? { setAsOperatorDefault: true } : {}),
    };
    try {
      const result = await onSubmit(input);
      if ('error' in result) {
        setState({ kind: 'error', message: result.error });
      } else {
        // Parent navigates on success — keep the form pending so the
        // user can't double-submit before the route change lands.
      }
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const slugs = generatorSlugs ?? KNOWN_GENERATOR_SLUGS;
  return (
    <form
      data-ggui-variant-generate-form
      data-ggui-variant-generate-state={state.kind}
      className="ggui-form"
      onSubmit={handleSubmit}
    >
      <Section title="contract" num="GEN / 01">
        <p className="ggui-muted" style={{ margin: '0 0 8px' }}>
          Contract hash{' '}
          <code className="ggui-code">{contractHash.slice(0, 16)}…</code>{' '}
          — read-only; create variants for the same contract here.
        </p>
        <pre
          className="ggui-code"
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 200,
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
      </Section>

      <Section title="variance" num="GEN / 02">
        <div className="ggui-field">
          <label className="ggui-label" htmlFor="ggui-gen-persona">
            persona
          </label>
          <input
            id="ggui-gen-persona"
            name="persona"
            data-ggui-variant-generate-persona
            placeholder="e.g. minimalist, data-dense, mobile-first"
            value={persona}
            onChange={(event) => setPersona(event.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <div className="ggui-field">
          <label className="ggui-label" htmlFor="ggui-gen-seed">
            seed prompt
          </label>
          <textarea
            id="ggui-gen-seed"
            name="seedPrompt"
            data-ggui-variant-generate-seed
            placeholder="e.g. use a glassy card with rounded corners…"
            value={seedPrompt}
            onChange={(event) => setSeedPrompt(event.target.value)}
            rows={3}
          />
        </div>
        <div className="ggui-field">
          <label className="ggui-label" htmlFor="ggui-gen-context">
            context (JSON object, optional)
          </label>
          <textarea
            id="ggui-gen-context"
            name="context"
            data-ggui-variant-generate-context
            placeholder='{"locale": "en", "density": "compact"}'
            value={contextText}
            onChange={(event) => setContextText(event.target.value)}
            rows={3}
            spellCheck={false}
            style={{ fontFamily: 'var(--ggui-font-mono, monospace)' }}
          />
        </div>
      </Section>

      <Section title="dispatch" num="GEN / 03">
        <div className="ggui-field">
          <label className="ggui-label" htmlFor="ggui-gen-generator">
            generator
          </label>
          <select
            id="ggui-gen-generator"
            name="generator"
            data-ggui-variant-generate-generator
            value={generator}
            onChange={(event) => setGenerator(event.target.value)}
          >
            <option value="">(registry default)</option>
            {slugs.map((slug) => (
              <option key={slug} value={slug}>
                {slug}
              </option>
            ))}
          </select>
        </div>
        <label
          className="ggui-field"
          htmlFor="ggui-gen-set-default"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
          }}
        >
          <input
            id="ggui-gen-set-default"
            data-ggui-variant-generate-set-default
            type="checkbox"
            checked={setAsOperatorDefault}
            onChange={(event) => setSetAsOperatorDefault(event.target.checked)}
          />
          <span className="ggui-label" style={{ margin: 0 }}>
            pin as operator default for this contract
          </span>
        </label>
      </Section>

      {state.kind === 'error' ? (
        <p className="ggui-body">
          <StatusBadge tone="signal">error</StatusBadge>{' '}
          {state.message}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <button
          type="submit"
          className="ggui-btn"
          data-ggui-variant-generate-submit
          disabled={state.kind === 'pending'}
        >
          {state.kind === 'pending' ? 'generating…' : 'generate →'}
        </button>
        {onCancel ? (
          <button
            type="button"
            className="ggui-btn ggui-btn--ghost"
            onClick={onCancel}
            disabled={state.kind === 'pending'}
          >
            cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function Section({
  title,
  num,
  children,
}: {
  readonly title: string;
  readonly num: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="ggui-card" style={{ marginBottom: 16 }}>
      <div className="ggui-card__head">
        <span className="ggui-card__title">{title}</span>
        <span className="ggui-card__num">{num}</span>
      </div>
      <div className="ggui-card__body">{children}</div>
    </div>
  );
}
