/**
 * GguiSessionRenderer (RN) — provisional-branch tests.
 *
 * Mirrors the web test. Empty `componentCode` AND no `descriptor` →
 * routes through `ProvisionalRenderer` with the caller's fallback
 * preserved; populated code flows through the existing WebView /
 * descriptor path and ignores preview envelopes entirely.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { GguiSessionRenderer } from './DynamicComponent';
import {
  __resetPreviewBridgeForTests,
  emitPreviewBridge,
} from '../internal/preview-bridge';

function sendPreview(payload: unknown): void {
  const envelope: StreamEnvelope = {
    renderId: 'render-1',
    channel: PREVIEW_CHANNEL,
    mode: 'append',
    payload: payload as StreamEnvelope['payload'],
  };
  emitPreviewBridge(envelope);
}

function findTextNodes(tree: ReactTestRenderer): string[] {
  const texts: string[] = [];
  try {
    for (const node of tree.root.findAllByType('Text')) {
      const walk = (child: unknown): void => {
        if (typeof child === 'string') texts.push(child);
        else if (Array.isArray(child)) child.forEach(walk);
        else if (
          child &&
          typeof child === 'object' &&
          'props' in (child as Record<string, unknown>)
        ) {
          walk((child as { props: { children?: unknown } }).props.children);
        }
      };
      walk(node.props.children);
    }
  } catch {
    /* no Text nodes */
  }
  return texts;
}

function hasTestId(tree: ReactTestRenderer, id: string): boolean {
  try {
    return tree.root.findAllByProps({ testID: id }).length > 0;
  } catch {
    return false;
  }
}

describe('GguiSessionRenderer (RN) — provisional branching', () => {
  beforeEach(() => {
    __resetPreviewBridgeForTests();
  });

  it('routes empty componentCode (no descriptor) through ProvisionalRenderer and shows the caller fallback', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        React.createElement(GguiSessionRenderer, {
          render: { componentCode: '' },
          fallback: React.createElement(
            'View',
            { testID: 'caller-loading' },
            null,
          ),
        }),
      );
    });
    expect(hasTestId(tree!, 'caller-loading')).toBe(true);
  });

  it('paints the provisional surface once preview envelopes arrive', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        React.createElement(GguiSessionRenderer, {
          render: { componentCode: '' },
        }),
      );
    });
    await act(async () => {
      sendPreview({
        version: 'v0.9',
        createSurface: { surfaceId: 'pending', catalogId: 'ggui.preview.v1' },
      });
      sendPreview({
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'pending',
          components: [
            { id: 'root', component: 'Text', text: 'Assembling your UI…' },
          ],
        },
      });
    });
    expect(findTextNodes(tree!)).toContain('Assembling your UI…');
  });

  it('does NOT route through preview when a descriptor is supplied', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        React.createElement(GguiSessionRenderer, {
          render: {
            componentCode: '',
            descriptor: { type: 'TestUnknown' },
          },
          fallback: React.createElement(
            'View',
            { testID: 'caller-loading' },
            null,
          ),
        }),
      );
    });
    // Descriptor path runs; the caller fallback is not shown for empty
    // code once a descriptor is present, and preview envelopes
    // targeting anything are irrelevant here.
    await act(async () => {
      sendPreview({
        version: 'v0.9',
        createSurface: { surfaceId: 'any', catalogId: 'ggui.preview.v1' },
      });
      sendPreview({
        version: 'v0.9',
        updateComponents: {
          surfaceId: 'any',
          components: [
            { id: 'root', component: 'Text', text: 'should not appear' },
          ],
        },
      });
    });
    expect(findTextNodes(tree!)).not.toContain('should not appear');
  });
});
