import { describe, expect, it } from 'vitest';
import { isGeneratorRegistered } from './assert-generator.js';

describe('isGeneratorRegistered', () => {
  it('treats undefined (use server default) as registered', () => {
    expect(isGeneratorRegistered(undefined, 'ui-gen-default')).toBe(
      true,
    );
  });

  it('accepts the registered default slug', () => {
    expect(
      isGeneratorRegistered(
        'ui-gen-default',
        'ui-gen-default',
      ),
    ).toBe(true);
  });

  it('rejects an unknown slug', () => {
    expect(isGeneratorRegistered('custom-slug', 'ui-gen-default')).toBe(
      false,
    );
  });

  it('rejects any non-undefined slug when no generator is bound', () => {
    expect(isGeneratorRegistered('anything', undefined)).toBe(false);
  });

  it('still treats undefined as registered when no generator is bound', () => {
    expect(isGeneratorRegistered(undefined, undefined)).toBe(true);
  });
});
