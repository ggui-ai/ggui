import { describe, expect, it } from 'vitest';
import {
  GGUI_UI_JSON_FILENAME,
  UiManifestV1,
  parseUiManifest,
  safeParseUiManifest,
} from './ui-manifest.js';

const MINIMAL_UI: unknown = {
  id: 'weather-card',
  name: 'Weather Card',
  contract: { intent: 'show-weather' },
};

describe('ggui.ui.json schema — filename constant', () => {
  it('is exactly "ggui.ui.json"', () => {
    expect(GGUI_UI_JSON_FILENAME).toBe('ggui.ui.json');
  });
});

describe('ggui.ui.json schema — required minimum', () => {
  it('accepts the minimal three-field doc', () => {
    const parsed = parseUiManifest(MINIMAL_UI);
    expect(parsed.id).toBe('weather-card');
    expect(parsed.name).toBe('Weather Card');
  });

  it('round-trips through JSON.stringify + re-parse', () => {
    const once = parseUiManifest(MINIMAL_UI);
    const twice = parseUiManifest(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });

  it('is the zod value export — GguiJsonV1-style sanity', () => {
    expect(UiManifestV1.parse(MINIMAL_UI).id).toBe('weather-card');
  });
});

describe('ggui.ui.json schema — id is required and machine-oriented', () => {
  it('rejects missing id', () => {
    const { id: _id, ...rest } = MINIMAL_UI as { id: string; [k: string]: unknown };
    void _id;
    const result = safeParseUiManifest(rest);
    expect(result.success).toBe(false);
  });

  it.each([
    ['weather-card', 'hyphenated slug'],
    ['weather_card', 'underscore separator'],
    ['WeatherCard', 'CamelCase'],
    ['ui.weather.card', 'dotted namespace'],
    ['company:weather-card', 'scoped with colon'],
    ['0123456789abcdef', 'hex-like'],
    ['a', 'single char (matches regex start + empty tail)'],
  ])('accepts id %p (%s)', (id) => {
    const result = safeParseUiManifest({ ...(MINIMAL_UI as object), id });
    expect(result.success).toBe(true);
  });

  it.each([
    ['', 'empty string'],
    ['-weather', 'starts with hyphen'],
    ['.weather', 'starts with dot'],
    ['_weather', 'starts with underscore'],
    ['weather card', 'contains whitespace'],
    ['weather/card', 'contains slash'],
    ['weather\\card', 'contains backslash'],
    ['weather\ncard', 'contains newline'],
    ['weather#card', 'contains hash'],
  ])('rejects id %p (%s)', (id) => {
    const result = safeParseUiManifest({ ...(MINIMAL_UI as object), id });
    expect(result.success).toBe(false);
  });

  it('rejects id over 128 chars', () => {
    const id = 'a'.repeat(129);
    const result = safeParseUiManifest({ ...(MINIMAL_UI as object), id });
    expect(result.success).toBe(false);
  });
});

describe('ggui.ui.json schema — contentHash is separate from id', () => {
  it('is optional (authored manifests have no compiled hash yet)', () => {
    const parsed = parseUiManifest(MINIMAL_UI);
    expect(parsed.contentHash).toBeUndefined();
  });

  it('accepts a provided contentHash alongside id', () => {
    const parsed = parseUiManifest({
      ...(MINIMAL_UI as object),
      contentHash: 'abc123def456',
    });
    expect(parsed.id).toBe('weather-card');
    expect(parsed.contentHash).toBe('abc123def456');
  });
});

describe('ggui.ui.json schema — strict root', () => {
  it('rejects unknown top-level keys', () => {
    const result = safeParseUiManifest({
      ...(MINIMAL_UI as object),
      // `mode` was an old agent-centric field — must not sneak in.
      mode: 'personal',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a typo like `ids` (plural)', () => {
    const { id: _id, ...rest } = MINIMAL_UI as { id: string; [k: string]: unknown };
    void _id;
    const result = safeParseUiManifest({ ...rest, ids: 'weather-card' });
    expect(result.success).toBe(false);
  });
});

describe('ggui.ui.json schema — optional capability fields', () => {
  it('accepts category + matchPatterns + mcp pairing fields', () => {
    const parsed = parseUiManifest({
      ...(MINIMAL_UI as object),
      category: 'dashboard',
      matchPatterns: ['weather', 'forecast'],
      mcpTools: ['get_weather'],
      mcpServer: 'weather-api',
    });
    expect(parsed.category).toBe('dashboard');
    expect(parsed.matchPatterns).toEqual(['weather', 'forecast']);
  });

  it.each([['sandboxed'], ['fullstack']])('accepts uiClass %p', (uiClass) => {
    const result = safeParseUiManifest({ ...(MINIMAL_UI as object), uiClass });
    expect(result.success).toBe(true);
  });

  it('rejects unknown uiClass', () => {
    const result = safeParseUiManifest({
      ...(MINIMAL_UI as object),
      uiClass: 'hybrid',
    });
    expect(result.success).toBe(false);
  });
});
