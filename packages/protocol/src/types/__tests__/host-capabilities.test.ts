/**
 * ggui#1309 — the host's own declaration of what it does with a view's
 * gestures, carried as the `Ggui-Host-Capabilities` request header on the
 * MCP connection. Host code writes it, never the model (a model-writable
 * flag would be the agent writing behaviour into the contract).
 */
import { describe, expect, it } from 'vitest';
import {
  GGUI_HOST_CAPABILITIES_HEADER,
  HOST_CAPABILITY_UI_MESSAGE_TURN,
  parseHostCapabilitiesHeader,
} from '../host-capabilities.js';

describe('Ggui-Host-Capabilities (ggui#1309)', () => {
  it('names the header in lowercase (HTTP header names are case-insensitive; Node lowercases them)', () => {
    expect(GGUI_HOST_CAPABILITIES_HEADER).toBe('ggui-host-capabilities');
    expect(HOST_CAPABILITY_UI_MESSAGE_TURN).toBe('ui-message-turn');
  });

  it('parses comma-separated tokens: trimmed, lowercased, de-duplicated, empties dropped', () => {
    expect(parseHostCapabilitiesHeader(' UI-Message-Turn , ,ui-message-turn,future-thing ')).toEqual([
      'ui-message-turn',
      'future-thing',
    ]);
  });

  it('keeps unknown tokens (tolerant read — a later capability never breaks an older server) and joins a repeated header', () => {
    expect(parseHostCapabilitiesHeader(['ui-message-turn', 'later-capability'])).toEqual([
      'ui-message-turn',
      'later-capability',
    ]);
  });

  it('absent or empty reads as no capabilities — today’s behaviour', () => {
    expect(parseHostCapabilitiesHeader(undefined)).toEqual([]);
    expect(parseHostCapabilitiesHeader('')).toEqual([]);
    expect(parseHostCapabilitiesHeader('  ,  ')).toEqual([]);
  });
});
