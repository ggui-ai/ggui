/**
 * Child worker for `tryRender`. Runs the render smoke test in a
 * subprocess so the LLM-generated TSX executes outside the parent
 * Node process.
 *
 * Wire protocol (newline-delimited JSON):
 *
 *   stdin:  { sourceCode: string, sampleProps?: JsonObject }
 *   stdout: { ok: true } | { ok: false, error: string }
 *   exit:   0 on either outcome (errors are data, not status).
 *
 * Why a separate worker instead of `vm.Script.runInThisContext` in
 * the parent:
 *
 *   - `runInThisContext` runs in the parent's V8 context. A
 *     pathological component that attaches to a global, recurses
 *     into the event loop, or allocates a large buffer poisons the
 *     parent.
 *   - A subprocess gives us real kill semantics on runaway code +
 *     output caps + env isolation — delegated to
 *     `@ggui-ai/sandbox`.
 *
 * The worker still uses `vm.Script` to run compiled CJS because the
 * component needs a tailored `require` (react / jsx-runtime /
 * @ggui-ai/design only). Host-level process isolation is the
 * sandbox; module-scoped `require` is the resolution policy. The
 * mechanical compile+vm pipeline is the shared
 * `evaluateComponentSource` helper (also used by the in-loop probe's
 * `loadComponent`); only the resolution policy lives here.
 */
import { createRequire } from 'node:module';
import type { JsonObject } from '@ggui-ai/protocol';
import { evaluateComponentSource } from '../internal/evaluate-component-source.js';
import { hostGlobals } from '../internal/open-record.js';

interface WorkerInput {
  readonly sourceCode: string;
  readonly sampleProps?: JsonObject;
}

type WorkerOutput =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

async function main(): Promise<void> {
  const raw = await readAllStdin();
  let input: WorkerInput;
  try {
    input = JSON.parse(raw) as WorkerInput;
  } catch (err) {
    emit({
      ok: false,
      error: `worker: malformed input JSON — ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }

  if (typeof input.sourceCode !== 'string' || input.sourceCode.length === 0) {
    emit({ ok: false, error: 'worker: sourceCode is required' });
    return;
  }

  const result = await renderOnce(input);
  emit(result);
}

async function renderOnce(input: WorkerInput): Promise<WorkerOutput> {
  // Minimal window/document shims — mirror the in-process impl so
  // components that touch either global don't crash on import. The
  // shims only need to exist for the render; they're torn down by
  // process exit.
  const g = hostGlobals();
  if (!('window' in globalThis)) {
    g.window = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
  if (!('document' in globalThis)) {
    g.document = {
      getElementById: () => null,
      createElement: () => ({}),
      addEventListener: () => {},
    };
  }

  try {
    const React = await import('react');
    const ReactDOMServer = await import('react-dom/server');

    const require_ = createRequire(import.meta.url);

    const sandboxRequire = (id: string): unknown => {
      if (id === 'react/jsx-runtime' || id === 'react/jsx-dev-runtime') {
        return require_('react/jsx-runtime');
      }
      if (id === 'react') return require_('react');
      if (id.startsWith('@ggui-ai/design')) {
        try {
          return require_(id);
        } catch {
          // Fallback proxy — used in environments where the real
          // design package isn't resolvable. Each primitive becomes
          // a pass-through `div` so the render still exercises the
          // component's own logic.
          return new Proxy(
            {},
            {
              get: (_target, prop) => {
                if (prop === '__esModule') return true;
                return ({
                  children,
                  ...props
                }: {
                  children?: React.ReactNode;
                  [key: string]: unknown;
                }) =>
                  React.createElement(
                    'div',
                    { 'data-component': String(prop), ...props },
                    children,
                  );
              },
            },
          );
        }
      }
      throw new Error(`Import not allowed: ${id}`);
    };

    const exportsRecord = await evaluateComponentSource(
      input.sourceCode,
      sandboxRequire,
    );

    const Component = exportsRecord.default;
    if (typeof Component !== 'function') {
      return {
        ok: false,
        error: 'No default export function found in compiled code',
      };
    }

    const html = ReactDOMServer.renderToString(
      React.createElement(
        Component as React.ComponentType<JsonObject>,
        input.sampleProps ?? {},
      ),
    );

    if (!html || html.length < 5) {
      return { ok: false, error: 'Component rendered empty output' };
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Cannot read properties of undefined')) {
      return {
        ok: false,
        error: `Render error: ${message}. A prop is likely undefined — add a default value or null check.`,
      };
    }
    if (message.includes('Cannot read properties of null')) {
      return {
        ok: false,
        error: `Render error: ${message}. A value is null — add a null check or fallback.`,
      };
    }
    if (message.includes('is not a function')) {
      return {
        ok: false,
        error: `Render error: ${message}. Check that all imported functions exist and are called correctly.`,
      };
    }
    return { ok: false, error: `Render error: ${message}` };
  }
}

function emit(output: WorkerOutput): void {
  process.stdout.write(JSON.stringify(output));
}

async function readAllStdin(): Promise<string> {
  let buffer = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    buffer += chunk as string;
  }
  return buffer;
}

void main().catch((err: unknown) => {
  emit({
    ok: false,
    error: `worker crashed: ${err instanceof Error ? err.message : String(err)}`,
  });
});
