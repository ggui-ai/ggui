/**
 * Module Loader
 *
 * Browser-only utility that loads compiled ESM code as a dynamic module
 * via a temporary blob URL. Used by ReactComponentRenderer to instantiate
 * generated components inline (no iframe).
 */
import {
  INLINE_EXEC_HANDOFF_GLOBAL,
  resolveInlineSpecifier,
  transformForInlineExec,
  type InlineExecOptions,
} from './inline-exec';

/**
 * Hoist static `import` declarations to the top of the module.
 *
 * esbuild's ESM output sometimes places helper declarations (`var`, `const`)
 * before `import` statements. This is valid inside esbuild's own bundle but
 * invalid standalone ESM (spec requires imports before any statements).
 *
 * Call this on raw code BEFORE import rewriting (before specifiers become
 * data-URLs that contain semicolons and confuse simple parsers).
 */
export function hoistImports(code: string): string {
  // Split into top-level statements by semicolon.
  // This is safe for pre-rewrite code where specifiers are simple strings
  // like "react/jsx-runtime" or "@ggui-ai/design/primitives".
  const parts = code.split(';');
  const imports: string[] = [];
  const rest: string[] = [];

  for (const part of parts) {
    const trimmed = part.trimStart();
    if (trimmed.startsWith('import')) {
      imports.push(part);
    } else {
      rest.push(part);
    }
  }

  if (imports.length === 0) return code;

  return imports.join(';') + ';' + rest.join(';');
}

/**
 * Load compiled ESM code as a module and return its exports.
 *
 * Creates a temporary blob URL, dynamically imports it, then immediately
 * revokes the URL to avoid memory leaks.
 *
 * **Browser-only** — requires `Blob`, `URL.createObjectURL`, and dynamic `import()`.
 *
 * @param code - Compiled ESM code string (imports should already be hoisted and rewritten)
 * @returns Module exports as a key-value record
 */
export async function loadModule(code: string): Promise<Record<string, unknown>> {
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    // Both bundler pragmas: consumers of this shared loader are built
    // by webpack (`webpackIgnore`), Vite (`@vite-ignore`), and esbuild
    // (which ignores both). Pragmas are comments — inert wherever the
    // matching bundler isn't in play.
    return await import(/* webpackIgnore: true */ /* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Cached verdict of {@link probeUrlModuleLoad} — one probe per
 * document lifetime; a page's CSP cannot change under it.
 */
let urlModuleLoadProbe: Promise<boolean> | undefined;

/**
 * Can THIS document import a `blob:` URL module at all?
 *
 * Imports a known-good one-liner module and reports whether it
 * evaluates. Distinguishes "the host CSP blocks URL-scheme module
 * loading" (probe fails) from "this particular module failed" (probe
 * succeeds — e.g. an import-shim allowlist miss rejects the real
 * module while blob loading itself is healthy). Callers deciding
 * whether to permanently prefer inline execution MUST use this
 * verdict, not the failure of an arbitrary module.
 */
export function probeUrlModuleLoad(): Promise<boolean> {
  if (urlModuleLoadProbe === undefined) {
    urlModuleLoadProbe = loadModule('export default true;').then(
      () => true,
      () => false,
    );
  }
  return urlModuleLoadProbe;
}

/**
 * Execute compiled ESM code as an INLINE classic script and return its
 * exports — the CSP-resilient fallback to {@link loadModule} for host
 * pages whose `script-src` grants only `'unsafe-inline'` (no `blob:`,
 * no `data:`, no external origins), where every URL-based module load
 * is blocked while inline `<script>` elements still execute.
 *
 * The code is rewritten by `transformForInlineExec` (imports → bindings
 * resolved from the `globalThis.__ggui__` registry via
 * `resolveInlineSpecifier`, exports → handoff assignments) and
 * evaluated SYNCHRONOUSLY: dynamically-inserted classic scripts run on
 * append, so the exports are available on return without a task hop.
 *
 * Pass the RAW compiled code (markers stripped, imports NOT rewritten
 * to data-URLs) — the transform consumes the original bare specifiers.
 *
 * **Browser-only** — requires `document`.
 *
 * @param code - Compiled ESM code with bare import specifiers
 * @param opts - Gadget-package allowlist forwarded to the resolver
 * @returns Module exports as a key-value record
 */
export function loadModuleInline(
  code: string,
  opts?: InlineExecOptions,
): Record<string, unknown> {
  interface Handoff {
    resolve: (spec: string) => Record<string, unknown>;
    exports: Record<string, unknown>;
    error?: unknown;
    ran?: boolean;
  }
  const handoff: Handoff = {
    resolve: (spec) => resolveInlineSpecifier(spec, opts),
    exports: {},
  };
  // The handoff travels on the script ELEMENT (read via
  // `document.currentScript`) with the caller's global as fallback.
  // Element identity survives realm splits — a jsdom-backed test
  // runtime evaluates injected scripts against a different global
  // than the caller's, but the element object is shared; in a real
  // browser both routes name the same objects.
  const scope = globalThis as Record<string, unknown>;
  const transformed = transformForInlineExec(code);
  scope[INLINE_EXEC_HANDOFF_GLOBAL] = handoff;
  // A PARSE-time failure in the script (transformed source with a
  // syntax error) never reaches the in-script try/catch — it surfaces
  // only as a window `error` event. Capture it for the duration of the
  // synchronous evaluation so it lands in this call's stack instead of
  // escaping as an unhandled page error.
  let parseError: unknown;
  const onWindowError = (ev: ErrorEvent): void => {
    parseError = ev.error ?? new Error(ev.message);
    ev.preventDefault();
  };
  window.addEventListener('error', onWindowError);
  try {
    const script = document.createElement('script');
    (script as unknown as Record<string, unknown>).__gguiInlineExec = handoff;
    script.textContent = transformed;
    document.head.appendChild(script);
    script.remove();
    if (handoff.error !== undefined) throw handoff.error;
    if (handoff.ran !== true) {
      if (parseError !== undefined) {
        throw parseError instanceof Error
          ? parseError
          : new Error(String(parseError));
      }
      throw new Error(
        'loadModuleInline: the inline script did not execute — the host CSP blocks inline scripts as well as URL-based module loads.',
      );
    }
    return handoff.exports;
  } finally {
    window.removeEventListener('error', onWindowError);
    delete scope[INLINE_EXEC_HANDOFF_GLOBAL];
  }
}
