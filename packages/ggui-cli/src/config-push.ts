/**
 * `config-push` — read `ggui.json#app.{gadgets,publicEnv}`, guard against
 * loopback bundle URLs, and PATCH the cloud app config via the REST API.
 *
 * Consumed by `ggui deploy` (M3.3) — wiring into that command is a separate
 * task. This module is the pure logic layer: readers + guard + network call.
 */
import process from 'node:process';
import {
  strictGadgetDescriptorSchema,
  appPublicEnvSchema,
  LOOPBACK_HOST_RE,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
import { z } from 'zod';
import { patchAppConfig } from './api-client.js';
import { findGguiJson, readGguiJson } from './internal/ggui-json.js';

// ─────────────────────────────────────────────────────────────────────────────
// Readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract and validate `app.gadgets` from a decoded ggui.json value.
 *
 * Returns `[]` when the field is absent.
 * Throws with a descriptive message when any descriptor is malformed
 * (schema parse fails).
 */
export function readGadgetsFromGguiJson(gguiJson: unknown): GadgetDescriptor[] {
  // Navigate to `app.gadgets` via a nested schema rather than casting +
  // index access. `z.object` is non-strict by default, so ggui.json's other
  // fields (schema / protocol / generation / app.publicEnv / …) ride through
  // as allowed-and-stripped extras — only `app.gadgets` is validated here.
  const schema = z.object({
    app: z
      .object({
        gadgets: z.array(strictGadgetDescriptorSchema).optional(),
      })
      .optional(),
  });
  const result = schema.safeParse(gguiJson);
  if (!result.success) {
    throw new Error(
      `ggui.json: app.gadgets is invalid — ${result.error.issues[0]?.message ?? 'malformed descriptor'}`,
    );
  }
  // result.data.app?.gadgets is GadgetDescriptor[] — strictGadgetDescriptorSchema
  // parses to the same shape as GadgetDescriptor. Spread to a fresh mutable array.
  return [...(result.data.app?.gadgets ?? [])];
}

/**
 * Extract and validate `app.publicEnv` from a decoded ggui.json value.
 *
 * Returns `{}` when the field is absent.
 * Throws with a descriptive message when any key/value is invalid.
 * Keys must match `PUBLIC_ENV_APP_KEY_RE` (`GGUI_PUBLIC_APP_<NAME>`).
 */
export function readPublicEnvFromGguiJson(gguiJson: unknown): Record<string, string> {
  // Navigate to `app.publicEnv` via a nested schema (same posture as
  // readGadgetsFromGguiJson) — other ggui.json fields ride through as
  // allowed-and-stripped extras; only `app.publicEnv` is validated here.
  const schema = z.object({
    app: z
      .object({
        publicEnv: appPublicEnvSchema.optional(),
      })
      .optional(),
  });
  const result = schema.safeParse(gguiJson);
  if (!result.success) {
    throw new Error(
      `ggui.json: app.publicEnv is invalid — keys must match GGUI_PUBLIC_APP_<NAME>: ${result.error.issues[0]?.message ?? 'invalid entry'}`,
    );
  }
  // appPublicEnvSchema returns a readonly record; spread to a fresh mutable one.
  return { ...(result.data.app?.publicEnv ?? {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Loopback guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert that none of the gadget bundle references point at a loopback host.
 *
 * `LOOPBACK_HOST_RE` matches bare hosts (no scheme, optional `:port`):
 *   - `localhost` / `localhost:3000`
 *   - `127.0.0.1` / `127.0.0.1:8080`
 *   - `0.0.0.0` / `0.0.0.0:4321`
 *
 * Resolution order for "bundle host":
 *   1. `bundleHost` (bare hostname, already scheme-free)
 *   2. `bundleUrl` parsed via `new URL()` → `.host` (includes port)
 *   3. Neither present → gadget has no cloud bundle reference; passes.
 *
 * Throws an `Error` with a remediation hint when a loopback is detected.
 */
export function assertGadgetBundlesReachable(gadgets: GadgetDescriptor[]): void {
  for (const g of gadgets) {
    let host: string | undefined;

    if (g.bundleHost !== undefined) {
      host = g.bundleHost;
    } else if (g.bundleUrl !== undefined) {
      host = new URL(g.bundleUrl).host;
    }

    if (host !== undefined && LOOPBACK_HOST_RE.test(host)) {
      throw new Error(
        `gadget ${g.package}'s bundle is local-only (${host}) — publish it to a ` +
          `cloud-reachable registry (run \`ggui gadget publish\`) before deploy.`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find + read `ggui.json`, validate gadgets + publicEnv, guard against
 * loopback bundles, then PATCH the app config via the REST API.
 *
 * @param appId  - The ggui app ID to patch.
 * @param startDir - Optional start directory for `findGguiJson` (defaults to
 *                   `process.cwd()`). Primarily used for testing.
 * @returns 0 on success, 1 on any error (malformed ggui.json, loopback bundle,
 *          network failure). Errors are written to stderr; success summary to
 *          stdout.
 */
export async function runConfigPushStep(
  appId: string,
  startDir: string = process.cwd(),
): Promise<number> {
  const gguiJsonPath = findGguiJson(startDir);
  if (!gguiJsonPath) {
    process.stderr.write(
      'ggui deploy: could not find ggui.json (looked up to 8 parent directories).\n',
    );
    return 1;
  }

  const readResult = readGguiJson(gguiJsonPath);
  if ('error' in readResult) {
    process.stderr.write(`ggui deploy: ${readResult.error}\n`);
    return 1;
  }

  let gadgets: GadgetDescriptor[];
  let publicEnv: Record<string, string>;

  try {
    gadgets = readGadgetsFromGguiJson(readResult.value);
  } catch (err) {
    process.stderr.write(
      `ggui deploy: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  try {
    publicEnv = readPublicEnvFromGguiJson(readResult.value);
  } catch (err) {
    process.stderr.write(
      `ggui deploy: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  try {
    assertGadgetBundlesReachable(gadgets);
  } catch (err) {
    process.stderr.write(
      `ggui deploy: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  try {
    await patchAppConfig(appId, {
      gadgets,
      ...(Object.keys(publicEnv).length > 0 ? { publicEnv } : {}),
    });
  } catch (err) {
    process.stderr.write(
      `ggui deploy: config push failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const gadgetLine =
    gadgets.length > 0
      ? `pushed ${gadgets.length} gadget extension(s)`
      : 'no gadget extensions — cleared (stdlib still available)';
  const envLine =
    Object.keys(publicEnv).length > 0
      ? ` + ${Object.keys(publicEnv).length} publicEnv key(s)`
      : '';
  process.stdout.write(`  ${gadgetLine}${envLine}\n`);

  return 0;
}
