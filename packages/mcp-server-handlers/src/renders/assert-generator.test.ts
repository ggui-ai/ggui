import { describe, expect, it } from 'vitest';
import { assertGeneratorRegistered } from './assert-generator.js';

describe('assertGeneratorRegistered', () => {
  it('is a no-op when no generator is requested', () => {
    expect(() =>
      assertGeneratorRegistered(undefined, 'ui-gen-default-haiku-4-5'),
    ).not.toThrow();
  });

  it('accepts the registered default slug', () => {
    expect(() =>
      assertGeneratorRegistered(
        'ui-gen-default-haiku-4-5',
        'ui-gen-default-haiku-4-5',
      ),
    ).not.toThrow();
  });

  it('rejects an unknown slug with unknown_generator + registered list', () => {
    expect(() =>
      assertGeneratorRegistered(
        'custom-slug',
        'ui-gen-default-haiku-4-5',
      ),
    ).toThrow(
      /unknown_generator: 'custom-slug' is not registered.*\['ui-gen-default-haiku-4-5'\]/,
    );
  });

  it('rejects any non-undefined slug when no generator is bound', () => {
    expect(() => assertGeneratorRegistered('anything', undefined)).toThrow(
      /unknown_generator: 'anything'.*\[\] \(no generator registered\)/,
    );
  });

  it('still accepts undefined when no generator is bound (no-op)', () => {
    expect(() => assertGeneratorRegistered(undefined, undefined)).not.toThrow();
  });
});
