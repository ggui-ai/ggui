/**
 * Probe tests — exercise the runtime gate via real React +
 * react-dom/server. Each case constructs a minimal blueprint manifest
 * and asserts the runner's response code.
 */
import { describe, expect, it } from 'vitest';
import { blueprintProbeRunner } from './index.js';

function blueprintManifest(source: string, fixtureProps?: unknown) {
  return {
    kind: 'blueprint' as const,
    scope: '@my-org',
    name: 'probe-fixture',
    version: '1.0.0',
    visibility: 'public' as const,
    source,
    ...(fixtureProps !== undefined ? { fixtureProps } : {}),
  };
}

describe('blueprintProbeRunner', () => {
  it('renders a clean blueprint with no props', async () => {
    const result = await blueprintProbeRunner.probe(
      blueprintManifest(`export default function Hello() { return <div>hello</div>; }`),
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('renders a blueprint that consumes fixtureProps', async () => {
    const result = await blueprintProbeRunner.probe(
      blueprintManifest(
        `export default function City({ city }) { return <div>{city}</div>; }`,
        { city: 'Tokyo' },
      ),
    );
    expect(result.ok).toBe(true);
  });

  it('renders a blueprint that calls a stubbed gadget hook', async () => {
    const result = await blueprintProbeRunner.probe(
      blueprintManifest(`
        import { useTodos } from '@ggui-ai/gadgets';
        export default function Todos() {
          const todos = useTodos();
          return <div>{String(todos)}</div>;
        }
      `),
    );
    expect(result.ok).toBe(true);
  });

  it('renders a blueprint that calls useState', async () => {
    const result = await blueprintProbeRunner.probe(
      blueprintManifest(`
        import { useState } from 'react';
        export default function Counter() {
          const [n] = useState(0);
          return <div>{n}</div>;
        }
      `),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when the default export is not a function', async () => {
    const result = await blueprintProbeRunner.probe(
      blueprintManifest(`export default 42;`),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('blueprint_runtime_probe_failed');
    expect(result.errors[0]?.message).toContain('not a function');
  });

  it('fails when the component throws during render', async () => {
    const result = await blueprintProbeRunner.probe(
      blueprintManifest(`
        export default function Broken() {
          throw new Error('intentional render failure for the probe');
        }
      `),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('blueprint_runtime_probe_failed');
    expect(result.errors[0]?.message).toContain('intentional render failure');
  });

  it('fails when the component destructures a required prop the fixture omits', async () => {
    const result = await blueprintProbeRunner.probe(
      blueprintManifest(
        `export default function City({ city: { name } }) { return <div>{name}</div>; }`,
        {},
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('blueprint_runtime_probe_failed');
  });
});
