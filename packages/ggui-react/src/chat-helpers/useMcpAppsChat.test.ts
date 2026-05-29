/**
 * Focused unit coverage for {@link useMcpAppsChat}'s spec-canonical
 * `_meta.ui.displayMode` + `_meta.ui.resourceUri` extraction.
 *
 * Why a unit test instead of an e2e test: the post-G-series
 * "fullscreen mode" is no longer a wire-level concept (`McpAppsMode`
 * was deleted in the kill-displaymode-divergence slice). What
 * remains is a presentation HINT on `_meta.ui.displayMode` that
 * chat shells consume to auto-switch their layout. The mechanism
 * lives entirely in this hook's event walker — exercising it via a
 * full LLM-driven agent-loop matrix would cost ~5 min per SDK to
 * verify a CSS class flip. A direct test on `handleEvent` covers the
 * exact same behavior in milliseconds and asserts the contract at
 * its actual source.
 */
import { describe, it, expect } from 'vitest';

import { handleEvent } from './useMcpAppsChat';
import type {
  ChatEntry,
  HostDisplayMode,
  RenderRef,
} from './mcp-apps-chat-types';

interface CapturedDeps {
  readonly entries: ChatEntry[];
  readonly renders: RenderRef[];
  readonly displayModes: Array<HostDisplayMode | undefined>;
  readonly patches: Array<{
    readonly toolUseId: string;
    readonly result?: unknown;
    readonly isError?: boolean;
  }>;
}

function makeDeps(): {
  readonly captured: CapturedDeps;
  readonly deps: Parameters<typeof handleEvent>[3];
} {
  const captured: CapturedDeps = {
    entries: [],
    renders: [],
    displayModes: [],
    patches: [],
  };
  return {
    captured,
    deps: {
      append: (e) => {
        captured.entries.push(e);
      },
      addRender: (r) => {
        captured.renders.push(r);
      },
      setHostDisplayMode: (m) => {
        captured.displayModes.push(m);
      },
      patchToolCall: (toolUseId, patch) => {
        captured.patches.push({ toolUseId, ...patch });
      },
    },
  };
}

/**
 * Minimal spec-canonical `tool_result` SDK message — the shape every
 * normalized sample agent produces (see each SDK's `agent.ts`
 * `NormalizedMessage` type under `oss/samples/agents/`).
 */
function makeToolResultMessage(opts: {
  readonly toolUseId: string;
  readonly resourceUri?: string;
  readonly displayMode?: string;
  readonly legacyFlatUri?: string;
  readonly structuredContent?: Record<string, unknown>;
}): unknown {
  const uiBlock: Record<string, unknown> = {};
  if (opts.resourceUri !== undefined) uiBlock.resourceUri = opts.resourceUri;
  if (opts.displayMode !== undefined) uiBlock.displayMode = opts.displayMode;

  const meta: Record<string, unknown> = {};
  if (Object.keys(uiBlock).length > 0) meta.ui = uiBlock;
  if (opts.legacyFlatUri !== undefined) {
    meta['ui/resourceUri'] = opts.legacyFlatUri;
  }

  return {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: opts.toolUseId,
          content: [{ type: 'text', text: 'ok' }],
        },
      ],
    },
    tool_use_result: {
      content: [{ type: 'text', text: 'ok' }],
      ...(opts.structuredContent !== undefined
        ? { structuredContent: opts.structuredContent }
        : {}),
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    },
  };
}

describe('useMcpAppsChat handleEvent — _meta.ui.displayMode extraction', () => {
  it('captures "inline" presentation hint', () => {
    const { captured, deps } = makeDeps();
    handleEvent(
      'message',
      makeToolResultMessage({
        toolUseId: 'call_1',
        resourceUri: 'ui://ggui/render/r_abc',
        displayMode: 'inline',
      }),
      'base.1',
      deps,
    );
    expect(captured.displayModes).toEqual(['inline']);
  });

  it('captures "fullscreen" presentation hint', () => {
    const { captured, deps } = makeDeps();
    handleEvent(
      'message',
      makeToolResultMessage({
        toolUseId: 'call_2',
        resourceUri: 'ui://ggui/render/r_def',
        displayMode: 'fullscreen',
      }),
      'base.2',
      deps,
    );
    expect(captured.displayModes).toEqual(['fullscreen']);
  });

  it('captures "pip" presentation hint', () => {
    const { captured, deps } = makeDeps();
    handleEvent(
      'message',
      makeToolResultMessage({
        toolUseId: 'call_3',
        resourceUri: 'ui://ggui/render/r_ghi',
        displayMode: 'pip',
      }),
      'base.3',
      deps,
    );
    expect(captured.displayModes).toEqual(['pip']);
  });

  it('ignores an unknown displayMode string (forward-compat: never crashes, never sets)', () => {
    const { captured, deps } = makeDeps();
    handleEvent(
      'message',
      makeToolResultMessage({
        toolUseId: 'call_4',
        resourceUri: 'ui://ggui/render/r_jkl',
        // Some future spec extension the hook doesn't know about yet.
        displayMode: 'theater',
      }),
      'base.4',
      deps,
    );
    expect(captured.displayModes).toEqual([]);
    // The render itself should still mount — unknown displayMode
    // doesn't poison resourceUri pickup.
    expect(captured.renders).toHaveLength(1);
    expect(captured.renders[0]?.resourceUri).toBe('ui://ggui/render/r_jkl');
  });

  it('does NOT touch hostDisplayMode when _meta.ui block is absent', () => {
    const { captured, deps } = makeDeps();
    handleEvent(
      'message',
      makeToolResultMessage({
        toolUseId: 'call_5',
        legacyFlatUri: 'ui://ggui/render/r_mno',
      }),
      'base.5',
      deps,
    );
    expect(captured.displayModes).toEqual([]);
    // Legacy flat-key resourceUri still mounts a render entry.
    expect(captured.renders).toHaveLength(1);
    expect(captured.renders[0]?.resourceUri).toBe('ui://ggui/render/r_mno');
  });

  it('does NOT touch hostDisplayMode on a pure-text assistant frame', () => {
    const { captured, deps } = makeDeps();
    handleEvent(
      'message',
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'plain text reply' }],
        },
      },
      'base.6',
      deps,
    );
    expect(captured.displayModes).toEqual([]);
    expect(captured.entries).toHaveLength(1);
    expect(captured.entries[0]?.kind).toBe('assistant');
  });

  it('captures resourceUri AND displayMode from the same _meta.ui block', () => {
    const { captured, deps } = makeDeps();
    handleEvent(
      'message',
      makeToolResultMessage({
        toolUseId: 'call_7',
        resourceUri: 'ui://ggui/render/r_pqr',
        displayMode: 'fullscreen',
      }),
      'base.7',
      deps,
    );
    expect(captured.displayModes).toEqual(['fullscreen']);
    expect(captured.renders).toHaveLength(1);
    expect(captured.renders[0]?.resourceUri).toBe('ui://ggui/render/r_pqr');
    expect(captured.renders[0]?.toolUseId).toBe('call_7');
  });

  it('updates hostDisplayMode on each new tool_result (latest wins)', () => {
    const { captured, deps } = makeDeps();
    handleEvent(
      'message',
      makeToolResultMessage({
        toolUseId: 'call_8a',
        resourceUri: 'ui://ggui/render/r_stu',
        displayMode: 'inline',
      }),
      'base.8a',
      deps,
    );
    handleEvent(
      'message',
      makeToolResultMessage({
        toolUseId: 'call_8b',
        resourceUri: 'ui://ggui/render/r_vwx',
        displayMode: 'fullscreen',
      }),
      'base.8b',
      deps,
    );
    expect(captured.displayModes).toEqual(['inline', 'fullscreen']);
  });
});
