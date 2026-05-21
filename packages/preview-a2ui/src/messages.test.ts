import { describe, it, expect } from 'vitest';
import {
  A2UI_MESSAGE_VERSION,
  isCreateSurfaceMessage,
  isDeleteSurfaceMessage,
  isUpdateComponentsMessage,
  parseServerMessage,
} from './messages.js';

const V = A2UI_MESSAGE_VERSION;

describe('parseServerMessage — createSurface', () => {
  it('accepts a valid createSurface', () => {
    const result = parseServerMessage({
      version: V,
      createSurface: {
        surfaceId: 'stack-item-1',
        catalogId: 'ggui.preview.v1',
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isCreateSurfaceMessage(result.value)).toBe(true);
      expect(isUpdateComponentsMessage(result.value)).toBe(false);
      expect(isDeleteSurfaceMessage(result.value)).toBe(false);
    }
  });

  it('rejects createSurface with empty surfaceId', () => {
    const result = parseServerMessage({
      version: V,
      createSurface: { surfaceId: '', catalogId: 'ggui.preview.v1' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects createSurface with empty catalogId', () => {
    const result = parseServerMessage({
      version: V,
      createSurface: { surfaceId: 's', catalogId: '' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects createSurface missing catalogId entirely', () => {
    const result = parseServerMessage({
      version: V,
      createSurface: { surfaceId: 's' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseServerMessage — updateComponents', () => {
  it('accepts updateComponents with a populated components array', () => {
    const result = parseServerMessage({
      version: V,
      updateComponents: {
        surfaceId: 's',
        components: [
          { id: 'root', component: 'Card', child: 'col' },
          {
            id: 'col',
            component: 'Column',
            children: ['title'],
          },
          {
            id: 'title',
            component: 'Text',
            text: 'Loading…',
            variant: 'h2',
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isUpdateComponentsMessage(result.value)).toBe(true);
    }
  });

  it('accepts updateComponents with an empty components array', () => {
    // Emitted when the preamble wants to stake out the surface
    // before committing components.
    const result = parseServerMessage({
      version: V,
      updateComponents: {
        surfaceId: 's',
        components: [],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects updateComponents when any component fails catalog gate', () => {
    const result = parseServerMessage({
      version: V,
      updateComponents: {
        surfaceId: 's',
        components: [
          { id: 'root', component: 'Card', child: 'inner' },
          { id: 'inner', component: 'Tabs' }, // Tabs deferred from V1
        ],
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseServerMessage — deleteSurface', () => {
  it('accepts a valid deleteSurface', () => {
    const result = parseServerMessage({
      version: V,
      deleteSurface: { surfaceId: 's' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isDeleteSurfaceMessage(result.value)).toBe(true);
    }
  });

  it('rejects deleteSurface with empty surfaceId', () => {
    const result = parseServerMessage({
      version: V,
      deleteSurface: { surfaceId: '' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseServerMessage — version pinning', () => {
  it('rejects a non-matching version literal', () => {
    const result = parseServerMessage({
      version: 'v0.8', // older A2UI version — don't silently accept
      createSurface: { surfaceId: 's', catalogId: 'ggui.preview.v1' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing version', () => {
    const result = parseServerMessage({
      createSurface: { surfaceId: 's', catalogId: 'ggui.preview.v1' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseServerMessage — deferred / out-of-subset messages', () => {
  it('rejects `updateDataModel` (explicitly out of V1 scope)', () => {
    const result = parseServerMessage({
      version: V,
      updateDataModel: { surfaceId: 's', value: { x: 1 } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects client→server `action` shape (out of V1 scope)', () => {
    const result = parseServerMessage({
      version: V,
      action: { name: 'submit', surfaceId: 's' },
    });
    expect(result.ok).toBe(false);
  });
});

describe('parseServerMessage — junk input', () => {
  it('rejects primitives', () => {
    expect(parseServerMessage(null).ok).toBe(false);
    expect(parseServerMessage('not-a-message').ok).toBe(false);
    expect(parseServerMessage(42).ok).toBe(false);
  });

  it('rejects empty object', () => {
    expect(parseServerMessage({}).ok).toBe(false);
  });

  it('rejects object with version alone (no payload key)', () => {
    const result = parseServerMessage({ version: V });
    expect(result.ok).toBe(false);
  });

  it('rejection result carries structured issues (not Zod internals)', () => {
    const result = parseServerMessage({
      version: V,
      createSurface: { surfaceId: '', catalogId: 'c' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.issues)).toBe(true);
      const [issue] = result.issues;
      expect(Array.isArray(issue.path)).toBe(true);
      expect(typeof issue.message).toBe('string');
    }
  });
});
