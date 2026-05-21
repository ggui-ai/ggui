import { describe, it, expect } from 'vitest';
import {
  A2UI_V1_SUBSET_VERSION,
  GGUI_PREVIEW_CATALOG_V1,
  GGUI_PREVIEW_CATALOG_V1_COMPONENTS,
  GGUI_PREVIEW_CATALOG_V1_ID,
  isGguiPreviewComponentType,
} from './catalog.js';

describe('ggui provisional preview catalog v1', () => {
  it('pins the catalog id', () => {
    expect(GGUI_PREVIEW_CATALOG_V1_ID).toBe('ggui.preview.v1');
    expect(GGUI_PREVIEW_CATALOG_V1.id).toBe('ggui.preview.v1');
  });

  it('pins the A2UI subset version', () => {
    expect(A2UI_V1_SUBSET_VERSION).toBe('v0.9');
    expect(GGUI_PREVIEW_CATALOG_V1.version).toBe('v0.9');
  });

  it('lists exactly the 12 V1-supported components', () => {
    expect(GGUI_PREVIEW_CATALOG_V1_COMPONENTS).toEqual([
      'Row',
      'Column',
      'Card',
      'List',
      'Divider',
      'Text',
      'Image',
      'Icon',
      'Button',
      'TextField',
      'CheckBox',
      'ChoicePicker',
    ]);
    expect(GGUI_PREVIEW_CATALOG_V1_COMPONENTS).toHaveLength(12);
  });

  it('manifest components match the exported list', () => {
    expect(GGUI_PREVIEW_CATALOG_V1.components).toEqual(
      GGUI_PREVIEW_CATALOG_V1_COMPONENTS,
    );
  });
});

describe('isGguiPreviewComponentType', () => {
  it('returns true for every V1-supported component', () => {
    for (const name of GGUI_PREVIEW_CATALOG_V1_COMPONENTS) {
      expect(isGguiPreviewComponentType(name)).toBe(true);
    }
  });

  it('returns false for deferred A2UI Basic Catalog components', () => {
    // Deferred from V1 — see catalog.ts scope note. If these graduate
    // into the catalog later, this test should move, not disappear:
    // the rejection shape matters.
    for (const deferred of [
      'Tabs',
      'Modal',
      'Video',
      'AudioPlayer',
      'Slider',
      'DateTimeInput',
    ]) {
      expect(isGguiPreviewComponentType(deferred)).toBe(false);
    }
  });

  it('returns false for unrelated / invented component names', () => {
    expect(isGguiPreviewComponentType('Frobnicate')).toBe(false);
    expect(isGguiPreviewComponentType('')).toBe(false);
    expect(isGguiPreviewComponentType('row')).toBe(false); // case-sensitive
  });
});
