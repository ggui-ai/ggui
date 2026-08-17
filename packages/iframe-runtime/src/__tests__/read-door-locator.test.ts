/**
 * The read-plane door's LOCATOR extraction (ggui#537): a tool result
 * from a server running the read-plane-only posture carries the view's
 * identity — `structuredContent.resourceUri` and/or `_meta.ui.resourceUri`
 * — and no bootstrap material. `extractLocatorFromToolResult` is what
 * every door site (autostart buffer, pre-handshake wait, Tier 2 listener)
 * keys on; `readPendingToolResultLocator` is the buffer drain's sibling.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { extractLocatorFromToolResult } from '../meta-parse.js';
import { readPendingToolResultLocator, readPendingToolResults } from '../runtime.js';

const LOCATOR = 'ui://ggui/render/render_001/abcdef0123456789';

describe('extractLocatorFromToolResult', () => {
  it('reads the locator off structuredContent.resourceUri (ggui-aware hosts)', () => {
    expect(extractLocatorFromToolResult({ structuredContent: { resourceUri: LOCATOR } })).toBe(LOCATOR);
  });

  it('reads the locator off _meta.ui.resourceUri (spec-canonical MCP Apps pointer)', () => {
    expect(extractLocatorFromToolResult({ _meta: { ui: { resourceUri: LOCATOR } } })).toBe(LOCATOR);
  });

  it('prefers structuredContent when both are present (they are the same value by construction)', () => {
    expect(
      extractLocatorFromToolResult({
        structuredContent: { resourceUri: LOCATOR },
        _meta: { ui: { resourceUri: 'ui://ggui/render/other/0000000000000000' } },
      }),
    ).toBe(LOCATOR);
  });

  it('is null for a non-render locator, a non-object, or a result with neither slot', () => {
    expect(extractLocatorFromToolResult({ structuredContent: { resourceUri: 'ui://other/thing' } })).toBeNull();
    expect(extractLocatorFromToolResult({ _meta: { ui: { resourceUri: 'https://x' } } })).toBeNull();
    expect(extractLocatorFromToolResult({ content: [] })).toBeNull();
    expect(extractLocatorFromToolResult('nope')).toBeNull();
    expect(extractLocatorFromToolResult(null)).toBeNull();
  });
});

describe('readPendingToolResultLocator', () => {
  afterEach(() => {
    delete (window as unknown as { __GGUI_PENDING_TOOL_RESULTS__?: unknown }).__GGUI_PENDING_TOOL_RESULTS__;
  });

  it('returns the NEWEST identity-only entry when the buffer holds no inline slice', () => {
    (window as unknown as { __GGUI_PENDING_TOOL_RESULTS__?: unknown }).__GGUI_PENDING_TOOL_RESULTS__ = [
      { structuredContent: { resourceUri: 'ui://ggui/render/render_000/0000000000000000' } },
      { structuredContent: { resourceUri: LOCATOR } },
    ];
    expect(readPendingToolResults()).toBeNull();
    expect(readPendingToolResultLocator()).toBe(LOCATOR);
  });

  it('is null on an empty or absent buffer', () => {
    expect(readPendingToolResultLocator()).toBeNull();
    (window as unknown as { __GGUI_PENDING_TOOL_RESULTS__?: unknown }).__GGUI_PENDING_TOOL_RESULTS__ = [];
    expect(readPendingToolResultLocator()).toBeNull();
  });
});
