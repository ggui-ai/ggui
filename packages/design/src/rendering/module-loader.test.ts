/**
 * Inline-script execution path of the module loader — the PRODUCTION
 * seam the CSP fallback rides (`loadModuleInline`), exercised through
 * real `<script>` element injection in jsdom, not through
 * `new Function` (which never touches the handoff install/cleanup,
 * the window-error parse capture, or the `ran` check).
 *
 * `loadModule` (blob-import) and `hoistImports` are covered by the
 * react-renderer suite; `probeUrlModuleLoad`'s verdict caching is
 * pinned here because the fallback latch decision rides on it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { INLINE_EXEC_HANDOFF_GLOBAL } from './inline-exec';
import { loadModuleInline, probeUrlModuleLoad } from './module-loader';

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__ggui__;
});

describe('loadModuleInline — real inline-script execution', () => {
  it('executes via an injected script element and returns exports', () => {
    (globalThis as Record<string, unknown>).__ggui__ = {
      primitives: { Button: 'BUTTON' },
      components: {},
      compositions: {},
      interact: {},
    };
    const exports = loadModuleInline(
      `import { Button } from '@ggui-ai/design/primitives';\nexport default Button;`,
    );
    expect(exports.default).toBe('BUTTON');
  });

  it('cleans up the handoff global on success AND on failure', () => {
    loadModuleInline(`export default 1;`);
    expect(
      (globalThis as Record<string, unknown>)[INLINE_EXEC_HANDOFF_GLOBAL],
    ).toBeUndefined();
    expect(() => loadModuleInline(`throw new Error('boom');`)).toThrow('boom');
    expect(
      (globalThis as Record<string, unknown>)[INLINE_EXEC_HANDOFF_GLOBAL],
    ).toBeUndefined();
  });

  it('surfaces a top-level throw from the component in the caller stack', () => {
    expect(() => loadModuleInline(`throw new Error('component blew up');`)).toThrow(
      'component blew up',
    );
  });

  it('surfaces a PARSE-time failure of the transformed script instead of losing it to the page', () => {
    // A syntax error never reaches the in-script try/catch; the
    // window-error capture must route it into this call's stack.
    expect(() => loadModuleInline(`const = broken (`)).toThrow();
  });

  it('leaves no script element behind', () => {
    const before = document.querySelectorAll('script').length;
    loadModuleInline(`export default 'tidy';`);
    expect(document.querySelectorAll('script').length).toBe(before);
  });
});

describe('probeUrlModuleLoad', () => {
  it('resolves a boolean and caches the verdict (one probe per document)', async () => {
    const first = await probeUrlModuleLoad();
    expect(typeof first).toBe('boolean');
    // Same promise identity — the CSP verdict cannot change under a
    // living document, so the probe never re-runs.
    expect(probeUrlModuleLoad()).toBe(probeUrlModuleLoad());
    expect(await probeUrlModuleLoad()).toBe(first);
  });
});
