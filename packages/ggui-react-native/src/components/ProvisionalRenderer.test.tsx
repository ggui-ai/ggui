/**
 * ProvisionalRenderer (RN) — behaviour tests covering the reducer +
 * catalog mapping end-to-end. Envelopes are injected through the
 * cross-platform `preview-bridge` emitter, exactly the path
 * `GguiRender.tsx` fans out in production.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { PREVIEW_CHANNEL } from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { ProvisionalRenderer, type ProvisionalRendererProps } from './ProvisionalRenderer';
import {
  __resetPreviewBridgeForTests,
  emitPreviewBridge,
} from '../internal/preview-bridge';

function sendPayload(payload: unknown, complete = false): void {
  const envelope: StreamEnvelope = {
    sessionId: 'render-1',
    channel: PREVIEW_CHANNEL,
    mode: 'append',
    payload: payload as StreamEnvelope['payload'],
    ...(complete ? { complete: true } : {}),
  };
  emitPreviewBridge(envelope);
}

function createSurface(surfaceId = 'stack-1'): void {
  sendPayload({
    version: 'v0.9',
    createSurface: { surfaceId, catalogId: 'ggui.preview.v1' },
  });
}

function updateComponents(
  components: Array<Record<string, unknown>>,
  surfaceId = 'stack-1',
): void {
  sendPayload({
    version: 'v0.9',
    updateComponents: { surfaceId, components },
  });
}

function deleteSurface(surfaceId = 'stack-1'): void {
  sendPayload({
    version: 'v0.9',
    deleteSurface: { surfaceId },
  });
}

function countByType(tree: ReactTestRenderer, type: string): number {
  try {
    return tree.root.findAllByType(type).length;
  } catch {
    return 0;
  }
}

function hasTestId(tree: ReactTestRenderer, id: string): boolean {
  try {
    return tree.root.findAllByProps({ testID: id }).length > 0;
  } catch {
    return false;
  }
}

function findTextNodes(tree: ReactTestRenderer): string[] {
  const texts: string[] = [];
  try {
    for (const node of tree.root.findAllByType('Text')) {
      const children = node.props.children;
      const walk = (child: unknown): void => {
        if (typeof child === 'string') texts.push(child);
        else if (Array.isArray(child)) child.forEach(walk);
        else if (
          child &&
          typeof child === 'object' &&
          'props' in (child as Record<string, unknown>)
        ) {
          walk(
            (child as { props: { children?: unknown } }).props.children,
          );
        }
      };
      walk(children);
    }
  } catch {
    // no Text nodes in the tree
  }
  return texts;
}

describe('ProvisionalRenderer (RN) — root buffering', () => {
  beforeEach(() => {
    __resetPreviewBridgeForTests();
  });

  it('renders the fallback before any envelopes arrive', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(
        React.createElement<ProvisionalRendererProps>(ProvisionalRenderer, {
          fallback: React.createElement(
            'View',
            { testID: 'custom-fallback' },
            null,
          ),
        }),
      );
    });
    expect(hasTestId(tree!, 'custom-fallback')).toBe(true);
  });

  it('renders a default testable fallback when none is provided', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    expect(hasTestId(tree!, 'ggui-preview-fallback')).toBe(true);
  });

  it('renders fallback while only createSurface has arrived (no root yet)', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
    });
    expect(hasTestId(tree!, 'ggui-preview-fallback')).toBe(true);
  });

  it('renders the surface once the root fragment arrives', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([{ id: 'root', component: 'Text', text: 'Hello RN' }]);
    });
    expect(hasTestId(tree!, 'ggui-preview-fallback')).toBe(false);
    expect(findTextNodes(tree!)).toContain('Hello RN');
  });
});

describe('ProvisionalRenderer (RN) — replace-by-id', () => {
  beforeEach(() => {
    __resetPreviewBridgeForTests();
  });

  it('replaces a component when its id is re-emitted', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([{ id: 'root', component: 'Text', text: 'first' }]);
    });
    expect(findTextNodes(tree!)).toContain('first');

    await act(async () => {
      updateComponents([{ id: 'root', component: 'Text', text: 'second' }]);
    });
    const texts = findTextNodes(tree!);
    expect(texts).toContain('second');
    expect(texts).not.toContain('first');
  });

  it('patches one child without clobbering siblings', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([
        {
          id: 'root',
          component: 'Column',
          children: ['title', 'body'],
        },
        { id: 'title', component: 'Text', text: 'Initial', variant: 'h2' },
        { id: 'body', component: 'Text', text: 'Body copy' },
      ]);
    });
    expect(findTextNodes(tree!)).toContain('Initial');
    expect(findTextNodes(tree!)).toContain('Body copy');

    await act(async () => {
      updateComponents([
        { id: 'title', component: 'Text', text: 'Updated', variant: 'h2' },
      ]);
    });
    const texts = findTextNodes(tree!);
    expect(texts).toContain('Updated');
    expect(texts).toContain('Body copy');
    expect(texts).not.toContain('Initial');
  });
});

describe('ProvisionalRenderer (RN) — surface lifecycle', () => {
  beforeEach(() => {
    __resetPreviewBridgeForTests();
  });

  it('deleteSurface reverts to fallback', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([{ id: 'root', component: 'Text', text: 'live' }]);
    });
    expect(findTextNodes(tree!)).toContain('live');

    await act(async () => {
      deleteSurface();
    });
    expect(hasTestId(tree!, 'ggui-preview-fallback')).toBe(true);
  });

  it('ignores updates targeting a surface that was never created', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      updateComponents(
        [{ id: 'root', component: 'Text', text: 'stray' }],
        'stray-surface',
      );
    });
    expect(findTextNodes(tree!)).not.toContain('stray');
  });

  it('ignores updates targeting a different active surface id', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface('active');
      updateComponents(
        [{ id: 'root', component: 'Text', text: 'cross-talk' }],
        'other',
      );
    });
    expect(findTextNodes(tree!)).not.toContain('cross-talk');
  });
});

describe('ProvisionalRenderer (RN) — malformed envelopes', () => {
  beforeEach(() => {
    __resetPreviewBridgeForTests();
  });

  it('drops malformed envelopes without interrupting the stream', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      sendPayload({ version: 'v0.8', createSurface: { surfaceId: 's1' } });
      sendPayload({ garbage: 'nope' });
      sendPayload(null);
      createSurface();
      updateComponents([{ id: 'root', component: 'Text', text: 'survived' }]);
    });
    expect(findTextNodes(tree!)).toContain('survived');
  });
});

describe('ProvisionalRenderer (RN) — catalog mapping', () => {
  beforeEach(() => {
    __resetPreviewBridgeForTests();
  });

  it('renders containers (Row / Column / Card / Divider / List)', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([
        {
          id: 'root',
          component: 'Column',
          children: ['card', 'row', 'list'],
        },
        { id: 'card', component: 'Card', child: 'inside' },
        { id: 'inside', component: 'Text', text: 'in-card' },
        { id: 'row', component: 'Row', children: ['a', 'divider', 'b'] },
        { id: 'a', component: 'Text', text: 'A' },
        { id: 'divider', component: 'Divider' },
        { id: 'b', component: 'Text', text: 'B' },
        { id: 'list', component: 'List', children: ['one', 'two'] },
        { id: 'one', component: 'Text', text: 'one' },
        { id: 'two', component: 'Text', text: 'two' },
      ]);
    });
    const texts = findTextNodes(tree!);
    expect(texts).toContain('in-card');
    expect(texts).toContain('A');
    expect(texts).toContain('B');
    expect(texts).toContain('one');
    expect(texts).toContain('two');
  });

  it('renders Text with h1..h6 using the header accessibility role', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([
        { id: 'root', component: 'Text', text: 'Title', variant: 'h2' },
      ]);
    });
    const headers = tree!.root.findAll(
      (n) => n.props?.accessibilityRole === 'header',
    );
    expect(headers.length).toBeGreaterThan(0);
  });

  it('renders disabled control shells (Button / TextField / CheckBox / ChoicePicker)', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([
        {
          id: 'root',
          component: 'Column',
          children: ['btn', 'tf', 'cb', 'cp'],
        },
        { id: 'btn', component: 'Button', label: 'Submit' },
        {
          id: 'tf',
          component: 'TextField',
          label: 'Name',
          placeholder: 'Jane',
        },
        { id: 'cb', component: 'CheckBox', label: 'Agree', checked: true },
        {
          id: 'cp',
          component: 'ChoicePicker',
          label: 'Color',
          options: [
            { label: 'Red', value: 'red' },
            { label: 'Blue', value: 'blue' },
          ],
          value: 'blue',
        },
      ]);
    });

    // Button shell — Pressable with disabled prop.
    const pressable = tree!.root.findByType('Pressable');
    expect(pressable.props.disabled).toBe(true);
    expect(pressable.props.accessibilityState).toEqual({ disabled: true });

    // TextField — TextInput editable=false.
    const input = tree!.root.findByType('TextInput');
    expect(input.props.editable).toBe(false);
    expect(input.props.placeholder).toBe('Jane');

    // CheckBox — role=checkbox + disabled state + ☑ glyph (checked=true).
    const checkbox = tree!.root.findByProps({
      accessibilityRole: 'checkbox',
    });
    expect(checkbox.props.accessibilityState).toEqual({
      disabled: true,
      checked: true,
    });
    expect(findTextNodes(tree!)).toContain('☑');

    // ChoicePicker — role=combobox + selected option label rendered.
    const combo = tree!.root.findByProps({
      accessibilityRole: 'combobox',
    });
    expect(combo.props.accessibilityState).toEqual({ disabled: true });
    expect(findTextNodes(tree!)).toContain('Blue');
  });

  it('renders Image with uri source', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([
        {
          id: 'root',
          component: 'Image',
          src: 'https://cdn/example.png',
          alt: 'example',
        },
      ]);
    });
    const image = tree!.root.findByType('Image');
    expect(image.props.source).toEqual({ uri: 'https://cdn/example.png' });
    expect(image.props.accessibilityLabel).toBe('example');
  });

  it('renders a placeholder for unresolvable child refs', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([
        {
          id: 'root',
          component: 'Column',
          children: ['present', 'missing'],
        },
        { id: 'present', component: 'Text', text: 'I am here' },
      ]);
    });
    expect(findTextNodes(tree!)).toContain('I am here');
    expect(hasTestId(tree!, 'ggui-preview-unresolved')).toBe(true);
  });
});

describe('ProvisionalRenderer (RN) — accessibility + suspension', () => {
  beforeEach(() => {
    __resetPreviewBridgeForTests();
  });

  it('wraps the tree in a progressbar-role surface with aria-busy', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([{ id: 'root', component: 'Text', text: 'busy' }]);
    });
    const surface = tree!.root.findByProps({
      accessibilityRole: 'progressbar',
    });
    expect(surface.props.accessibilityState).toEqual({ busy: true });
  });

  it('suspended prop hides the surface even when envelopes are live', async () => {
    let tree: ReactTestRenderer;
    await act(async () => {
      tree = create(React.createElement(ProvisionalRenderer));
    });
    await act(async () => {
      createSurface();
      updateComponents([{ id: 'root', component: 'Text', text: 'hidden' }]);
    });
    expect(findTextNodes(tree!)).toContain('hidden');

    await act(async () => {
      tree!.update(
        React.createElement<ProvisionalRendererProps>(ProvisionalRenderer, { suspended: true }),
      );
    });
    expect(findTextNodes(tree!)).not.toContain('hidden');
    // Suspended renderer returns null — the root of the tree is empty.
    expect(countByType(tree!, 'View')).toBe(0);
  });
});
