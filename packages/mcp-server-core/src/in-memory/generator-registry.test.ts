import { describe, expect, it } from 'vitest';
import { isGeneratorId } from '@ggui-ai/protocol';
import type { UiGenerator } from '../ui-generator.js';
import { createInMemoryGeneratorRegistry } from './generator-registry.js';

function makeGenerator(slug: string): UiGenerator {
  // Slugs in these tests use grammar `ui-gen-<tier>` so the returned
  // generator's identity is self-consistent; the model is a declared
  // field, never part of the slug (ggui#923). Identity is the only thing
  // the registry observes; `generate` is never invoked.
  if (!isGeneratorId(slug)) throw new Error(`bad test slug ${slug}`);
  return {
    slug,
    tier: slug.slice('ui-gen-'.length),
    model: 'anthropic/claude-haiku-4-5',
    async generate() {
      throw new Error('test generator generate() must not be called');
    },
  };
}

describe('createInMemoryGeneratorRegistry', () => {
  it('seeds a single default generator', () => {
    const haiku = makeGenerator('ui-gen-default');
    const registry = createInMemoryGeneratorRegistry({ default: haiku });
    expect(registry.get('ui-gen-default')).toBe(haiku);
    expect(registry.defaultGenerator()).toBe(haiku);
    expect(registry.list()).toEqual([haiku]);
  });

  it('accepts additional generators alongside the default', () => {
    const haiku = makeGenerator('ui-gen-default');
    const opus = makeGenerator('ui-gen-advanced');
    const registry = createInMemoryGeneratorRegistry({
      default: haiku,
      generators: [opus],
    });
    expect(registry.get('ui-gen-advanced')).toBe(opus);
    expect(registry.defaultGenerator()).toBe(haiku);
    expect(registry.list()).toEqual([haiku, opus]);
  });

  it('de-dupes when the default also appears in generators', () => {
    const haiku = makeGenerator('ui-gen-default');
    const registry = createInMemoryGeneratorRegistry({
      default: haiku,
      generators: [haiku],
    });
    expect(registry.list()).toEqual([haiku]);
    expect(registry.defaultGenerator()).toBe(haiku);
  });

  it('falls back to the first generator when no default is supplied', () => {
    const a = makeGenerator('ui-gen-default');
    const b = makeGenerator('ui-gen-advanced');
    const registry = createInMemoryGeneratorRegistry({ generators: [a, b] });
    expect(registry.defaultGenerator()).toBe(a);
  });

  it('throws when defaultGenerator() is called on an empty registry', () => {
    const registry = createInMemoryGeneratorRegistry();
    expect(() => registry.defaultGenerator()).toThrow(
      /no generators registered/,
    );
  });

  it('register() promotes first-registered to default when empty', () => {
    const haiku = makeGenerator('ui-gen-default');
    const registry = createInMemoryGeneratorRegistry();
    registry.register(haiku);
    expect(registry.defaultGenerator()).toBe(haiku);
  });

  it('register() preserves explicit default after later additions', () => {
    const haiku = makeGenerator('ui-gen-default');
    const opus = makeGenerator('ui-gen-advanced');
    const registry = createInMemoryGeneratorRegistry({ default: haiku });
    registry.register(opus);
    expect(registry.defaultGenerator()).toBe(haiku);
  });

  it('throws on duplicate slug registration', () => {
    const haiku1 = makeGenerator('ui-gen-default');
    const haiku2 = makeGenerator('ui-gen-default');
    const registry = createInMemoryGeneratorRegistry();
    registry.register(haiku1);
    expect(() => registry.register(haiku2)).toThrow(/already registered/);
  });

  it('throws on malformed slug at registration', () => {
    const bad = {
      slug: 'ui-gen-not valid',
      tier: 'default',
      model: 'anthropic/claude-haiku-4-5',
      generate: async () => {
        throw new Error('unreachable');
      },
    } as const satisfies UiGenerator;
    expect(() => createInMemoryGeneratorRegistry({ default: bad })).toThrow(
      /not a valid ui-gen-/,
    );
  });

  it('get() returns null on unknown slug', () => {
    const haiku = makeGenerator('ui-gen-default');
    const registry = createInMemoryGeneratorRegistry({ default: haiku });
    expect(registry.get('ui-gen-advanced')).toBeNull();
  });

  it('setDefaultGenerator() repoints the default', () => {
    const haiku = makeGenerator('ui-gen-default');
    const opus = makeGenerator('ui-gen-advanced');
    const registry = createInMemoryGeneratorRegistry({
      default: haiku,
      generators: [opus],
    });
    registry.setDefaultGenerator('ui-gen-advanced');
    expect(registry.defaultGenerator()).toBe(opus);
  });

  it('setDefaultGenerator() throws on unknown slug', () => {
    const haiku = makeGenerator('ui-gen-default');
    const registry = createInMemoryGeneratorRegistry({ default: haiku });
    expect(() =>
      registry.setDefaultGenerator('ui-gen-advanced'),
    ).toThrow(/not registered/);
  });

  it('list() preserves registration order', () => {
    const a = makeGenerator('ui-gen-default');
    const b = makeGenerator('ui-gen-advanced');
    const c = makeGenerator('ui-gen-extra');
    const registry = createInMemoryGeneratorRegistry();
    registry.register(a);
    registry.register(b);
    registry.register(c);
    expect(registry.list().map((g) => g.slug)).toEqual([
      'ui-gen-default',
      'ui-gen-advanced',
      'ui-gen-extra',
    ]);
  });
});
