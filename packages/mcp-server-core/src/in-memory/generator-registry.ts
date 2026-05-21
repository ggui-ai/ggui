/**
 * `createInMemoryGeneratorRegistry` — the in-memory {@link GeneratorRegistry}.
 *
 * Seam between {@link UiGenerator} implementations and the
 * `createGguiServer` composition. Operators register one or more named
 * generators (`ui-gen-default-haiku-4-5`, `ui-gen-advanced-opus-4-7`,
 * etc.); the push handler today still reads `generation.uiGenerator`
 * directly, but the blueprint matcher and the
 * `ggui_ops_generate_blueprint` tool dispatch via this registry.
 *
 * The factory:
 *
 *   - Accepts an optional `default` generator + an optional initial
 *     `generators` array.
 *   - Sets the registry's default slug to the `default` generator's
 *     slug, or — if `default` is omitted — to the first generator in
 *     `generators` (so a one-arg `{generators: [g]}` form Just Works).
 *   - Throws on duplicate slug, malformed slug, or default-slug not in
 *     the registered set.
 *
 * Sealed against later mutation? No — `register` and `setDefaultGenerator`
 * remain callable for operators that compose dynamically (e.g. CLI
 * `--generator-factory` flag plumbed in after construction). The factory
 * is a convenience for the common static-config case.
 */
import { isValidGeneratorSlug } from '../generator-registry.js';
import type { GeneratorRegistry } from '../generator-registry.js';
import type { UiGenerator } from '../ui-generator.js';

export interface CreateInMemoryGeneratorRegistryOptions {
  /**
   * The default generator. Sets the registry's default slug to this
   * generator's `slug`. When absent, the first entry in
   * {@link generators} is used as default. When BOTH are absent the
   * registry is empty and {@link GeneratorRegistry.defaultGenerator}
   * throws on call until a generator is registered.
   */
  readonly default?: UiGenerator;
  /**
   * Additional generators to register at construction. Order is
   * preserved by {@link GeneratorRegistry.list}.
   */
  readonly generators?: readonly UiGenerator[];
}

export function createInMemoryGeneratorRegistry(
  options: CreateInMemoryGeneratorRegistryOptions = {},
): GeneratorRegistry {
  const bySlug = new Map<string, UiGenerator>();
  const order: string[] = [];
  let defaultSlug: string | null = null;

  function registerInternal(generator: UiGenerator): void {
    if (!isValidGeneratorSlug(generator.slug)) {
      throw new Error(
        `createInMemoryGeneratorRegistry: generator slug ${JSON.stringify(generator.slug)} is not a valid ui-gen-<tier>-<model> slug.`,
      );
    }
    if (bySlug.has(generator.slug)) {
      throw new Error(
        `createInMemoryGeneratorRegistry: generator slug ${JSON.stringify(generator.slug)} is already registered. Operators must explicitly remove a generator before replacing it.`,
      );
    }
    bySlug.set(generator.slug, generator);
    order.push(generator.slug);
  }

  if (options.default) registerInternal(options.default);
  for (const g of options.generators ?? []) {
    // Skip the default generator if it appears in `generators` as well —
    // letting the same instance be passed twice is a common authoring
    // mistake, and silently de-duping is friendlier than throwing on
    // collision when the same generator was supplied via both opts.
    if (options.default && g === options.default) continue;
    registerInternal(g);
  }

  if (options.default) {
    defaultSlug = options.default.slug;
  } else if (order.length > 0) {
    defaultSlug = order[0] ?? null;
  }

  return {
    register(generator) {
      registerInternal(generator);
      if (defaultSlug === null) defaultSlug = generator.slug;
    },
    get(slug) {
      return bySlug.get(slug) ?? null;
    },
    list() {
      return order.map((slug) => {
        const g = bySlug.get(slug);
        if (!g) {
          // Unreachable: order is only mutated alongside bySlug.
          throw new Error(
            `createInMemoryGeneratorRegistry: internal invariant violated — slug ${slug} in order but not in bySlug.`,
          );
        }
        return g;
      });
    },
    defaultGenerator() {
      if (defaultSlug === null) {
        throw new Error(
          'createInMemoryGeneratorRegistry: no generators registered — defaultGenerator() called on empty registry. Register at least one UiGenerator before invoking.',
        );
      }
      const g = bySlug.get(defaultSlug);
      if (!g) {
        throw new Error(
          `createInMemoryGeneratorRegistry: default slug ${JSON.stringify(defaultSlug)} not in registry — internal invariant violated.`,
        );
      }
      return g;
    },
    setDefaultGenerator(slug) {
      if (!bySlug.has(slug)) {
        throw new Error(
          `createInMemoryGeneratorRegistry: cannot set default to ${JSON.stringify(slug)} — slug not registered. Registered slugs: [${order.map((s) => JSON.stringify(s)).join(', ')}].`,
        );
      }
      defaultSlug = slug;
    },
  };
}
