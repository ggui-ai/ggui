/**
 * ProvisionalRenderer — behaviour tests covering the reducer-over-envelopes
 * pipeline end-to-end: root buffering, replace-by-id, deleteSurface
 * teardown, catalog-miss fallbacks, and disabled-control rendering.
 *
 * Envelopes are injected by dispatching `BRIDGE_EVENTS.AGENT_DATA` on
 * `window` — exactly the shape `GguiSession` fans out — so the tests
 * exercise the same contract as production.
 */
import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import {
  BRIDGE_EVENTS,
  PREVIEW_CHANNEL,
} from '@ggui-ai/protocol';
import type { StreamEnvelope } from '@ggui-ai/protocol';
import { ProvisionalRenderer } from './ProvisionalRenderer.js';

type A2UIPayload = unknown;

function sendPayload(payload: A2UIPayload, complete = false): void {
  const envelope: StreamEnvelope = {
    sessionId: 's1',
    channel: PREVIEW_CHANNEL,
    mode: 'append',
    payload: payload as StreamEnvelope['payload'],
    ...(complete ? { complete: true } : {}),
  };
  act(() => {
    window.dispatchEvent(
      new CustomEvent(BRIDGE_EVENTS.AGENT_DATA, { detail: envelope }),
    );
  });
}

function createSurface(surfaceId = 'stack-1') {
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

describe('ProvisionalRenderer — root buffering', () => {
  it('renders the fallback before any envelopes arrive', () => {
    const { container } = render(
      <ProvisionalRenderer fallback={<div data-testid="fallback">loading</div>} />,
    );
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-ggui-preview]')).toBeNull();
  });

  it('renders the fallback when only createSurface has arrived (no root yet)', () => {
    const { container } = render(
      <ProvisionalRenderer fallback={<div data-testid="fallback">wait</div>} />,
    );
    createSurface();
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
    expect(container.querySelector('[data-ggui-preview]')).toBeNull();
  });

  it('renders the PreviewSurface once root arrives', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([
      { id: 'root', component: 'Text', text: 'Hello world' },
    ]);
    expect(container.querySelector('[data-ggui-preview]')).not.toBeNull();
    expect(container.textContent).toContain('Hello world');
  });

  it('uses a default Spinner fallback when none is provided', () => {
    const { container } = render(<ProvisionalRenderer />);
    // No envelopes — any rendered content at all IS the fallback.
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector('[data-ggui-preview]')).toBeNull();
  });
});

describe('ProvisionalRenderer — replace-by-id', () => {
  it('replaces a component when a later updateComponents re-emits its id', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([{ id: 'root', component: 'Text', text: 'first' }]);
    expect(container.textContent).toContain('first');

    updateComponents([{ id: 'root', component: 'Text', text: 'second' }]);
    expect(container.textContent).toContain('second');
    expect(container.textContent).not.toContain('first');
  });

  it('patches a single child without clobbering siblings', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([
      {
        id: 'root',
        component: 'Column',
        children: ['title', 'body'],
      },
      { id: 'title', component: 'Text', text: 'Initial Title', variant: 'h2' },
      { id: 'body', component: 'Text', text: 'Initial body copy' },
    ]);
    expect(container.textContent).toContain('Initial Title');
    expect(container.textContent).toContain('Initial body copy');

    // Patch only the title via replace-by-id.
    updateComponents([
      { id: 'title', component: 'Text', text: 'Updated Title', variant: 'h2' },
    ]);
    expect(container.textContent).toContain('Updated Title');
    expect(container.textContent).toContain('Initial body copy');
    expect(container.textContent).not.toContain('Initial Title');
  });
});

describe('ProvisionalRenderer — surface lifecycle', () => {
  it('deleteSurface clears the tree and reverts to fallback', () => {
    const { container } = render(
      <ProvisionalRenderer fallback={<div data-testid="fallback">wait</div>} />,
    );
    createSurface();
    updateComponents([{ id: 'root', component: 'Text', text: 'live' }]);
    expect(container.querySelector('[data-ggui-preview]')).not.toBeNull();

    deleteSurface();
    expect(container.querySelector('[data-ggui-preview]')).toBeNull();
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull();
  });

  it('ignores updateComponents for a surface that was never created', () => {
    const { container } = render(
      <ProvisionalRenderer fallback={<div data-testid="fallback">wait</div>} />,
    );
    updateComponents(
      [{ id: 'root', component: 'Text', text: 'stray' }],
      'stray-surface',
    );
    expect(container.querySelector('[data-ggui-preview]')).toBeNull();
    expect(container.textContent).not.toContain('stray');
  });

  it('ignores updateComponents targeting a different surface id', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface('active-surface');
    // Second surface never became active; its components must not
    // leak into the first one's fragment map.
    updateComponents(
      [{ id: 'root', component: 'Text', text: 'wrong-surface' }],
      'other-surface',
    );
    expect(container.textContent).not.toContain('wrong-surface');
  });

  it('createSurface starts a fresh fragment map', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface('s1');
    updateComponents(
      [{ id: 'root', component: 'Text', text: 'before' }],
      's1',
    );
    expect(container.textContent).toContain('before');

    // Start a second surface — the old root should no longer be
    // rendered (new surface begins with no fragments).
    createSurface('s2');
    expect(container.querySelector('[data-ggui-preview]')).toBeNull();
    expect(container.textContent).not.toContain('before');

    // Now root fills into s2.
    updateComponents(
      [{ id: 'root', component: 'Text', text: 'fresh' }],
      's2',
    );
    expect(container.textContent).toContain('fresh');
  });
});

describe('ProvisionalRenderer — malformed envelopes', () => {
  it('ignores envelopes that fail the A2UI parser', () => {
    const { container } = render(<ProvisionalRenderer />);
    sendPayload({ version: 'v0.8', createSurface: { surfaceId: 's1' } });
    sendPayload({ random: 'garbage' });
    sendPayload(null);
    createSurface();
    updateComponents([{ id: 'root', component: 'Text', text: 'survived' }]);
    expect(container.textContent).toContain('survived');
  });
});

describe('ProvisionalRenderer — catalog mapping', () => {
  it('renders Row / Column / Card / Divider / List containers', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([
      {
        id: 'root',
        component: 'Column',
        children: ['card', 'row', 'list'],
      },
      { id: 'card', component: 'Card', child: 'cardInner' },
      { id: 'cardInner', component: 'Text', text: 'inside card' },
      {
        id: 'row',
        component: 'Row',
        children: ['a', 'divider', 'b'],
      },
      { id: 'a', component: 'Text', text: 'A' },
      { id: 'divider', component: 'Divider' },
      { id: 'b', component: 'Text', text: 'B' },
      {
        id: 'list',
        component: 'List',
        children: ['item1', 'item2'],
      },
      { id: 'item1', component: 'Text', text: 'one' },
      { id: 'item2', component: 'Text', text: 'two' },
    ]);

    expect(container.textContent).toContain('inside card');
    expect(container.textContent).toContain('A');
    expect(container.textContent).toContain('B');
    expect(container.textContent).toContain('one');
    expect(container.textContent).toContain('two');
  });

  it('renders a Text fragment with h1..h6 variant as a Heading', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([
      { id: 'root', component: 'Text', text: 'Big Title', variant: 'h2' },
    ]);
    const heading = container.querySelector('h2');
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toContain('Big Title');
  });

  it('renders disabled control shells (non-interactive in V1)', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([
      {
        id: 'root',
        component: 'Column',
        children: ['btn', 'input', 'cb', 'sel'],
      },
      { id: 'btn', component: 'Button', label: 'Submit' },
      {
        id: 'input',
        component: 'TextField',
        label: 'Name',
        placeholder: 'Jane',
      },
      {
        id: 'cb',
        component: 'CheckBox',
        label: 'Agree',
        checked: false,
      },
      {
        id: 'sel',
        component: 'ChoicePicker',
        label: 'Color',
        options: [
          { label: 'Red', value: 'red' },
          { label: 'Blue', value: 'blue' },
        ],
      },
    ]);

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);

    const input = container.querySelector('input[type="text"]');
    expect(input).not.toBeNull();
    expect((input as HTMLInputElement | null)?.disabled).toBe(true);

    // Checkbox renders as an input[type=checkbox]; Select renders as
    // a <select>. Both should be disabled.
    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect((checkbox as HTMLInputElement | null)?.disabled).toBe(true);

    const select = container.querySelector('select');
    expect(select).not.toBeNull();
    expect(select?.disabled).toBe(true);
  });

  it('renders an Image with alt + an Icon by name', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([
      {
        id: 'root',
        component: 'Column',
        children: ['img', 'icon'],
      },
      {
        id: 'img',
        component: 'Image',
        src: 'https://cdn/example.png',
        alt: 'example',
      },
      { id: 'icon', component: 'Icon', name: 'check' },
    ]);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://cdn/example.png');
    expect(img?.getAttribute('alt')).toBe('example');
  });

  it('renders a neutral placeholder when a referenced child id is missing', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    // `missing-child` is referenced but never sent — the tree must
    // still paint, with a neutral placeholder where the child would
    // have been.
    updateComponents([
      {
        id: 'root',
        component: 'Column',
        children: ['present', 'missing-child'],
      },
      { id: 'present', component: 'Text', text: 'I am here' },
    ]);
    expect(container.textContent).toContain('I am here');
    expect(container.querySelector('[data-ggui-preview]')).not.toBeNull();
  });
});

describe('ProvisionalRenderer — suspended prop', () => {
  it('renders nothing when suspended, even after envelopes arrive', () => {
    const { container, rerender } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([{ id: 'root', component: 'Text', text: 'live' }]);
    expect(container.textContent).toContain('live');

    rerender(<ProvisionalRenderer suspended />);
    expect(container.firstChild).toBeNull();
  });

  it('resumes rendering when suspended flips back to false', () => {
    const { container, rerender } = render(<ProvisionalRenderer suspended />);
    createSurface();
    updateComponents([{ id: 'root', component: 'Text', text: 'hidden' }]);
    expect(container.firstChild).toBeNull();

    rerender(<ProvisionalRenderer />);
    expect(container.textContent).toContain('hidden');
  });
});

describe('ProvisionalRenderer — accessibility', () => {
  it('marks the surface as aria-busy so assistive tech reads it as in-progress', () => {
    const { container } = render(<ProvisionalRenderer />);
    createSurface();
    updateComponents([{ id: 'root', component: 'Text', text: 'busy' }]);
    const surface = container.querySelector('[data-ggui-preview]');
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute('aria-busy')).toBe('true');
  });
});
