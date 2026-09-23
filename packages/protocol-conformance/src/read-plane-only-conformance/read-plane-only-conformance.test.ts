/**
 * Read-plane-only conformance catalog (ggui#1304) — grading semantics,
 * pinned against fake drivers. The first-party server proves itself
 * against this catalog from its own package
 * (`mcp-server/src/read-plane-only.conformance.test.ts`); these fakes pin
 * what the kit decides, one violation per fake.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawToolCallResult } from '../domain-error-conformance/index.js';
import type { ResourceReadOutcome } from '../resource-read-conformance/index.js';
import {
  readPlaneOnlyCases,
  runReadPlaneOnlyConformance,
  type PreparedReadPlaneOnlyScenario,
  type ReadPlaneOnlyScenarioDriver,
} from './index.js';

const LOCATOR = 'ui://ggui/render/s-1/0123456789abcdef';

/** What a conforming server returns under the posture: identity only. */
function withheldResult(overrides: Partial<RawToolCallResult> = {}): RawToolCallResult {
  return {
    structuredContent: { outcome: 'rendered', sessionId: 's-1', resourceUri: LOCATOR },
    content: [{ type: 'text', text: JSON.stringify({ outcome: 'rendered' }) }],
    _meta: { ui: { resourceUri: LOCATOR }, 'ui/resourceUri': LOCATOR },
    ...overrides,
  };
}

const MOUNT: ResourceReadOutcome = {
  kind: 'mount',
  renderMeta: { codeB64: 'ZXhwb3J0IGRlZmF1bHQgKCkgPT4gbnVsbDs=' },
};

function driverOf(
  render: () => Promise<RawToolCallResult>,
  read: (uri: string) => Promise<ResourceReadOutcome> = async () => MOUNT,
  seenReads: string[] = [],
): ReadPlaneOnlyScenarioDriver {
  return async (): Promise<PreparedReadPlaneOnlyScenario> => ({
    render,
    async read(uri) {
      seenReads.push(uri);
      return read(uri);
    },
  });
}

async function failedCriteria(driver: ReadPlaneOnlyScenarioDriver): Promise<string[]> {
  const result = await runReadPlaneOnlyConformance(driver);
  return result.failed.map((f) => f.criterion).sort();
}

describe('read-plane-only conformance — grading semantics (ggui#1304)', () => {
  it('a server that withholds the material and mounts through the read passes every case', async () => {
    const seen: string[] = [];
    const result = await runReadPlaneOnlyConformance(
      driverOf(async () => withheldResult(), undefined, seen),
    );
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.passed).toEqual(readPlaneOnlyCases.map((c) => c.name));
    // The read is of the locator the RESULT published — not one the kit built.
    expect(seen).toEqual([LOCATOR]);
  });

  it('the slice on the result FAILS slice-withheld', async () => {
    const failed = await failedCriteria(
      driverOf(async () =>
        withheldResult({
          _meta: {
            ui: { resourceUri: LOCATOR },
            'ai.ggui/render': { sessionId: 's-1', runtimeUrl: 'https://r.example/b.js' },
          },
        }),
      ),
    );
    expect(failed).toContain('slice-withheld');
  });

  it('a live-channel token anywhere on the result FAILS credential-withheld, even outside the slice', async () => {
    const failed = await failedCriteria(
      driverOf(async () =>
        withheldResult({
          _meta: { ui: { resourceUri: LOCATOR }, 'x.vendor/extra': { nested: { wsToken: 't' } } },
        }),
      ),
    );
    expect(failed).toEqual(['credential-withheld']);
  });

  it('a token on structuredContent FAILS credential-withheld too', async () => {
    const failed = await failedCriteria(
      driverOf(async () =>
        withheldResult({
          structuredContent: { outcome: 'rendered', resourceUri: LOCATOR, wsToken: 't' },
        }),
      ),
    );
    expect(failed).toEqual(['credential-withheld']);
  });

  it('no pointer on _meta FAILS locator-on-meta — a spec host has nothing to mount', async () => {
    const failed = await failedCriteria(driverOf(async () => withheldResult({ _meta: undefined })));
    expect(failed).toEqual(['locator-on-meta']);
  });

  it('no locator on structuredContent FAILS locator-on-structured-content', async () => {
    const failed = await failedCriteria(
      driverOf(async () => withheldResult({ structuredContent: { outcome: 'rendered' } })),
    );
    expect(failed).toContain('locator-on-structured-content');
  });

  it('a locator that is not a render locator FAILS locator-on-structured-content', async () => {
    const failed = await failedCriteria(
      driverOf(async () =>
        withheldResult({
          structuredContent: { outcome: 'rendered', resourceUri: 'https://example.com/x' },
          _meta: { ui: { resourceUri: 'https://example.com/x' } },
        }),
      ),
    );
    expect(failed).toContain('locator-on-structured-content');
  });

  it('two different locators FAIL one-locator — including the legacy flat key', async () => {
    const differ = await failedCriteria(
      driverOf(async () =>
        withheldResult({ _meta: { ui: { resourceUri: 'ui://ggui/render/s-2' } } }),
      ),
    );
    expect(differ).toContain('one-locator');
    const legacy = await failedCriteria(
      driverOf(async () =>
        withheldResult({
          _meta: { ui: { resourceUri: LOCATOR }, 'ui/resourceUri': 'ui://ggui/render/s-2' },
        }),
      ),
    );
    expect(legacy).toEqual(['one-locator']);
  });

  it('a read of the locator that errors FAILS read-mounts', async () => {
    const failed = await failedCriteria(
      driverOf(
        async () => withheldResult(),
        async () => ({
          kind: 'error',
          error: { code: -32002, message: 'Resource not found', data: { code: 'NOT_FOUND' } },
        }),
      ),
    );
    expect(failed).toEqual(['read-mounts']);
  });

  it('a read that returns contents with no delivery channel FAILS read-mounts', async () => {
    const failed = await failedCriteria(
      driverOf(
        async () => withheldResult(),
        async () => ({ kind: 'mount', renderMeta: { wsUrl: 'wss://x' } }),
      ),
    );
    expect(failed).toEqual(['read-mounts']);
  });

  it('a read that throws FAILS read-mounts — the read is under test, never an abort of the run', async () => {
    const result = await runReadPlaneOnlyConformance(
      driverOf(
        async () => withheldResult(),
        async () => {
          throw new Error('transport closed');
        },
      ),
    );
    expect(result.failed.map((f) => f.criterion)).toEqual(['read-mounts']);
    expect(result.failed[0]?.detail).toContain('transport closed');
  });

  it('a render that did not commit FAILS render-committed and grades nothing after it', async () => {
    const seen: string[] = [];
    const result = await runReadPlaneOnlyConformance(
      driverOf(
        async () => ({ isError: true, content: [{ type: 'text', text: 'handshake_not_found: x' }] }),
        undefined,
        seen,
      ),
    );
    expect(result.failed.map((f) => f.criterion)).toEqual(['render-committed']);
    expect(seen).toEqual([]);
  });

  it('a render that throws FAILS render-committed — the render is the thing under test', async () => {
    const result = await runReadPlaneOnlyConformance(
      driverOf(async () => {
        throw new Error('boom');
      }),
    );
    expect(result.failed.map((f) => f.criterion)).toEqual(['render-committed']);
    expect(result.failed[0]?.detail).toContain('boom');
  });

  it('a driver that cannot express the posture SKIPS with its reason — never a pass', async () => {
    const result = await runReadPlaneOnlyConformance(async () => {
      throw new Error('this deployment cannot run the read-plane-only posture');
    });
    expect(result.passed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(
      readPlaneOnlyCases.map(() => 'this deployment cannot run the read-plane-only posture'),
    );
  });

  it('disposes the prepared scenario after every case, pass or fail', async () => {
    let disposed = 0;
    await runReadPlaneOnlyConformance(async () => ({
      render: async () => withheldResult({ _meta: undefined }),
      read: async () => MOUNT,
      dispose: async () => {
        disposed += 1;
      },
    }));
    expect(disposed).toBe(readPlaneOnlyCases.length);
  });
});

describe('read-plane-only catalog — shipped as raw JSON', () => {
  it('every case name matches its JSON filename, and every file is registered', () => {
    const dir = fileURLToPath(new URL('./cases/', import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(readPlaneOnlyCases.map((c) => c.name).sort()).toEqual(files);
  });
});
