/**
 * `getPublicEnv(key, opts?)`.
 *
 * Wrapper-author accessor for the public env channel. Reads values
 * the operator stamped on `App.publicEnv` and the server projected
 * (filtered to declared wrappers' `requires`) onto
 * `globalThis.__ggui__.publicEnv`.
 *
 * Usage pattern (inside a wrapper's `hookImpl`):
 *
 *   ```ts
 *   import { createGguiGadget, getPublicEnv } from '@ggui-ai/gadgets';
 *   import mapboxgl from 'mapbox-gl';
 *
 *   export const useMapbox = createGguiGadget({
 *     hook: 'useMapbox',
 *     requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
 *     hookImpl: (opts) => {
 *       mapboxgl.accessToken = getPublicEnv('GGUI_PUBLIC_APP_MAPBOX_TOKEN');
 *       return useMapboxInternal(opts);
 *     },
 *     // …
 *   });
 *   ```
 *
 * Semantics
 * ---------
 *
 *   - **Throws** when called before the iframe runtime initializes
 *     (`globalThis.__ggui__` absent). This indicates the wrapper is
 *     running outside the ggui iframe (test misconfig, host SDK
 *     misuse).
 *   - **Throws** by default when the requested key is not present in
 *     the registry. The thrown error names the missing key + lists
 *     available keys — gives gadget authors actionable diagnostics
 *     without leaking the values themselves.
 *   - Pass `{ optional: true }` to get `undefined` for a missing key
 *     instead of throwing. Use when the wrapper has a sensible
 *     fallback (e.g., a default origin); the render gate enforces that
 *     declared `requires` keys are present, so the typical wrapper
 *     path uses the throwing default.
 *   - Empty-string values are returned verbatim (the operator may
 *     have intentionally configured a key with no value).
 *
 * The render gate (`assertPublicEnvSatisfied`) verifies the
 * `App.publicEnv` satisfies every declared wrapper's `requires` BEFORE
 * the iframe boots. So in well-configured deployments, the only
 * `getPublicEnv` throws are gadget authoring bugs (typoed key, key
 * not declared in `requires`). In production, the render gate catches
 * the misconfiguration upstream.
 */

interface MinimalGguiRootForPublicEnv {
  readonly publicEnv?: Readonly<Record<string, string>>;
}

export interface GetPublicEnvOptions {
  /**
   * When true, returns `undefined` for a missing key instead of
   * throwing. Use sparingly — the render gate enforces declared
   * `requires`, so a missing key usually indicates a wrapper bug
   * (key not in `requires` array). The throwing default is the
   * right call for keys that ARE declared in `requires`.
   */
  readonly optional?: boolean;
}

/**
 * Return the public env value at `key`. Throws on missing-required;
 * returns `undefined` when `{ optional: true }`.
 *
 * `target` is the global root to read from; defaults to `globalThis`.
 * Exposed for tests; production callers omit it.
 */
export function getPublicEnv(
  key: string,
  opts?: GetPublicEnvOptions,
  target: typeof globalThis = globalThis,
): string | undefined {
  const root = (target as { __ggui__?: MinimalGguiRootForPublicEnv })
    .__ggui__;
  if (!root) {
    throw new Error(
      `getPublicEnv('${key}'): globalThis.__ggui__ is not initialized. ` +
        "This function must be invoked from inside a ggui-rendered " +
        "component or wrapper hook, after the iframe runtime has booted.",
    );
  }
  const env = root.publicEnv ?? {};
  if (Object.prototype.hasOwnProperty.call(env, key)) {
    return env[key];
  }
  if (opts?.optional) return undefined;
  const available = Object.keys(env);
  throw new Error(
    `getPublicEnv('${key}'): not provided in App.publicEnv. ` +
      `Available: [${available.join(', ') || '(none)'}]. ` +
      `Operators set this on the App record; gadget authors declare ` +
      `the key in 'requires' so the render gate verifies it before mount.`,
  );
}
