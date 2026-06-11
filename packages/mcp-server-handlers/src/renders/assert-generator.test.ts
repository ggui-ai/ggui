import { describe, expect, it } from 'vitest';
import {
  assertGeneratorRegistered,
  UnknownGeneratorError,
} from './assert-generator.js';

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

  it('rejects an unknown slug with UnknownGeneratorError + registered list', () => {
    try {
      assertGeneratorRegistered('custom-slug', 'ui-gen-default-haiku-4-5');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownGeneratorError);
      const e = err as UnknownGeneratorError;
      expect(e.code).toBe('unknown_generator');
      expect(e.requested).toBe('custom-slug');
      expect(e.defaultGenerator).toBe('ui-gen-default-haiku-4-5');
      expect(e.message).toContain(
        "'custom-slug' is not registered on this server",
      );
      expect(e.message).toContain("['ui-gen-default-haiku-4-5']");
    }
  });

  it('rejects any non-undefined slug when no generator is bound', () => {
    try {
      assertGeneratorRegistered('anything', undefined);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownGeneratorError);
      const e = err as UnknownGeneratorError;
      expect(e.code).toBe('unknown_generator');
      expect(e.requested).toBe('anything');
      expect(e.defaultGenerator).toBeUndefined();
      expect(e.message).toContain('[] (no generator registered)');
    }
  });

  it('still accepts undefined when no generator is bound (no-op)', () => {
    expect(() => assertGeneratorRegistered(undefined, undefined)).not.toThrow();
  });
});
