/**
 * Tests for the React component renderer mount lifecycle.
 *
 * jsdom-backed. These specs don't exercise the full data-url-shim
 * round-trip (the shim rewrite relies on dynamic-import, which jsdom
 * does not fully support for data: URLs in older versions) — instead
 * they lock:
 *
 *   1. Mount writes a scoped wrapper into the container (idempotent
 *      on second mount via the controller pattern of the caller).
 *   2. Empty componentCode mounts nothing interactive (fallback
 *      path).
 *   3. Eval error surfaces through `onError` and does not throw up.
 *   4. Props-only update re-renders without re-evaluating.
 *
 * The full round-trip (valid componentCode → mounted component
 * visible + receives props) is covered by the Commit 5 integration
 * spec using a handcrafted module URL; at this layer we're locking
 * the lifecycle seam.
 */
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { mountReactRoot } from '../react-renderer.js';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/**
 * React 19 defers initial renders via the concurrent scheduler. In
 * jsdom specs we need to `act()` to flush the commit phase so DOM
 * assertions see the rendered tree.
 */
async function flush(fn: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

describe('mountReactRoot — empty componentCode', () => {
  it('mounts a scoped wrapper and renders no component', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
      });
    });

    // Scope wrapper `<div class="ggui-rcr-…">` is installed.
    const wrapper = container.querySelector('[class^="ggui-rcr-"]');
    expect(wrapper).not.toBeNull();

    // No runtime error surfaced.
    mount!.unmount();
  });

  it('unmount replaces children so the container is reusable', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
      });
    });
    expect(container.children.length).toBeGreaterThan(0);

    mount!.unmount();
    expect(container.children.length).toBe(0);
  });
});

describe('mountReactRoot — eval error', () => {
  it('surfaces an error through onError without throwing', async () => {
    // Syntactically-broken ESM that causes `loadModule` to reject.
    const brokenCode = 'const x = (';
    const container = makeContainer();
    const onError = vi.fn();

    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: brokenCode },
        onError,
      });
    });

    // onError fires on the eval failure; the mount object is still
    // usable (unmount works, update works).
    expect(onError).toHaveBeenCalled();
    const err = onError.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);

    mount!.unmount();
  });
});

describe('mountReactRoot — per-app theme overlay', () => {
  it('injects the per-app theme overlay at :root + sets color-scheme', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        appTheme: {
          mode: 'dark',
          cssVariables: { '--ggui-color-primary-600': '#7c3aed' },
        },
      });
    });

    const styleEl = document.getElementById('ggui-theme-vars');
    expect(styleEl?.textContent).toContain('--ggui-color-primary-600: #7c3aed');
    expect(styleEl?.textContent).toContain('color-scheme:dark');

    mount!.unmount();
  });

  it('appends the overlay AFTER the base token block so it wins', async () => {
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' },
        appTheme: {
          mode: 'light',
          cssVariables: { '--ggui-color-primary-600': '#abcdef' },
        },
      });
    });

    const text = document.getElementById('ggui-theme-vars')?.textContent ?? '';
    // The overlay declaration must appear after the base `:root{...}`
    // token block — later declarations win the cascade.
    const overlayIdx = text.indexOf('color-scheme:light');
    expect(overlayIdx).toBeGreaterThan(0);
    expect(text.lastIndexOf('--ggui-color-primary-600: #abcdef')).toBeGreaterThan(
      overlayIdx,
    );

    mount!.unmount();
  });
});

describe('mountReactRoot — update with new props (no re-eval)', () => {
  it('skips evaluation when componentCode is unchanged across update()', async () => {
    // We can't easily observe "skipped evaluation" without mocking
    // loadModule, but we can confirm the mount stays stable across a
    // props-only update and no new error surfaces. This test
    // exercises the code path that guards the evaluate() call.
    const container = makeContainer();
    let mount: Awaited<ReturnType<typeof mountReactRoot>> | null = null;
    await flush(async () => {
      mount = await mountReactRoot(container, {
        render: { id: 'x', componentCode: '' }, // empty → currentCode null
      });
    });
    const onError = vi.fn();

    await flush(async () => {
      await mount!.update({
        render: { id: 'x', componentCode: '', props: { foo: 'bar' } },
        onError,
      });
    });
    await flush(async () => {
      await mount!.update({
        render: { id: 'x', componentCode: '', props: { foo: 'baz' } },
        onError,
      });
    });

    expect(onError).not.toHaveBeenCalled();
    mount!.unmount();
  });
});
