import { describe, it, expect } from 'vitest';
import { missingProviderKeys } from './preflight.mjs';

describe('missingProviderKeys', () => {
  it('returns [] when every requested provider has a key', () => {
    const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' };
    expect(missingProviderKeys(['claude', 'openai', 'google'], env)).toEqual([]);
  });
  it('flags the provider whose key is missing', () => {
    const env = { ANTHROPIC_API_KEY: 'a' };
    expect(missingProviderKeys(['claude', 'openai'], env)).toEqual(['openai']);
  });
  it('accepts GOOGLE_API_KEY as an alias for google', () => {
    const env = { GOOGLE_API_KEY: 'g' };
    expect(missingProviderKeys(['google'], env)).toEqual([]);
  });
  it('treats empty-string keys as missing', () => {
    const env = { ANTHROPIC_API_KEY: '' };
    expect(missingProviderKeys(['claude'], env)).toEqual(['claude']);
  });
});
