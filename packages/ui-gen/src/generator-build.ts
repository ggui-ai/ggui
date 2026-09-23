/**
 * The generator's BUILD identity (ggui#1280): values that change when the
 * triad's templates change and never with the request, so generations group
 * by the build that produced them.
 *
 * - `promptTemplateSha256` / `boilerplateTemplateSha256` are sha256 over the
 *   production system prompt and the boilerplate rendered on the design-mode
 *   pin's FIXED fixtures (`PIN_FIXTURES`), in the live env, so an env-gated
 *   block (the pitfalls) counts as it really is. The design-mode pin renders
 *   the same functions and asserts these values equal its recorded constants
 *   under the default env: the runtime key and the pin cannot drift.
 * - These are BUILD keys, not instance fingerprints. A hash of the prompt one
 *   generation actually sent embeds the request and differs every time, so it
 *   could never group two generations by build.
 * - `version` is the package's own version, read once from the nearest
 *   `package.json` named `@ggui-ai/ui-gen` above this module. It is absent
 *   when none is found (e.g. a consumer bundled this package into one file),
 *   never guessed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeneratorBuild } from '@ggui-ai/mcp-server-core';
import { generateBoilerplate } from './boilerplate/generate.js';
import type { DesignMode } from './design-mode.js';
import { buildSystemPrompt } from './harness/runtime.js';
import { PIN_FIXTURES } from './pin-fixtures.js';

/** The separator the rendered fixtures are joined with before hashing. */
export const TEMPLATE_FIXTURE_BOUNDARY = '\n<<<pin-fixture-boundary>>>\n';

/** sha256 hex of a rendered template. */
export function templateSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The production system prompt for every pin fixture, joined. The constrained
 * arm uses the positional default-path signature (no `designMode` argument),
 * which is what the pin has always recorded.
 */
export function renderPromptTemplates(designMode: DesignMode): string {
  return PIN_FIXTURES.map((f) => {
    switch (designMode) {
      case 'constrained':
        return buildSystemPrompt(f.userRequest, f.shellType, f.screen);
      case 'free':
        return buildSystemPrompt(f.userRequest, f.shellType, f.screen, undefined, undefined, undefined, 'free');
    }
  }).join(TEMPLATE_FIXTURE_BOUNDARY);
}

/** The boilerplate for every pin fixture, joined — same signature split as the prompt. */
export function renderBoilerplateTemplates(designMode: DesignMode): string {
  return PIN_FIXTURES.map((f) => {
    switch (designMode) {
      case 'constrained':
        return generateBoilerplate(f.userRequest, f.contract, f.shellType, f.screen);
      case 'free':
        return generateBoilerplate(f.userRequest, f.contract, f.shellType, f.screen, undefined, undefined, 'free');
    }
  }).join(TEMPLATE_FIXTURE_BOUNDARY);
}

/**
 * ui-gen's precise {@link GeneratorBuild}: the core port's generic shape with
 * ui-gen's own keys — `mode` is the design mode, and `digests` names the two
 * template digests (the keys a blueprint's build stamp copies).
 */
export interface UiGenBuild extends GeneratorBuild {
  /** This package's version; absent when its `package.json` cannot be found at runtime. */
  readonly version?: string;
  readonly mode: DesignMode;
  readonly digests: {
    readonly promptTemplateSha256: string;
    readonly boilerplateTemplateSha256: string;
  };
}

const PACKAGE_NAME = '@ggui-ai/ui-gen';
/** How far up from this module the package root can sit (`src/`, `dist/`, a nested entry). */
const MAX_PACKAGE_DEPTH = 6;

/**
 * A `package.json` the walk meets may not be ours, and in a consumer's bundle
 * it may not even parse. A candidate that does not parse is skipped (as if
 * absent), so reading this package's version can never fail a generation —
 * the version is then absent, never guessed. Only a JSON `SyntaxError` is
 * handled here; any other error is a real fault and propagates.
 */
function parsePackageJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/**
 * Walk up from `startDir` (this module's own directory by default) to the
 * nearest `package.json` named `@ggui-ai/ui-gen` and return its version;
 * `undefined` when none is found within reach.
 */
export function findPackageVersion(startDir: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = startDir;
  for (let i = 0; i < MAX_PACKAGE_DEPTH; i++) {
    const candidate = join(dir, 'package.json');
    const pkg = existsSync(candidate) ? parsePackageJson(readFileSync(candidate, 'utf8')) : undefined;
    if (pkg !== undefined) {
      if (
        typeof pkg === 'object' &&
        pkg !== null &&
        'name' in pkg &&
        pkg.name === PACKAGE_NAME &&
        'version' in pkg &&
        typeof pkg.version === 'string'
      ) {
        return pkg.version;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

let versionRead = false;
let packageVersion: string | undefined;
const identities = new Map<string, UiGenBuild>();

/**
 * The build identity for `designMode`, computed once per process per design
 * mode and pitfalls env gate (the only env the templates read), so a changed
 * gate is never answered from a stale memo.
 */
export function generatorBuild(designMode: DesignMode): UiGenBuild {
  const key = `${designMode}|${process.env.GGUI_PITFALLS ?? ''}|${process.env.GGUI_NEW_PITFALLS ?? ''}`;
  const known = identities.get(key);
  if (known !== undefined) return known;
  if (!versionRead) {
    packageVersion = findPackageVersion();
    versionRead = true;
  }
  const identity: UiGenBuild = {
    ...(packageVersion !== undefined ? { version: packageVersion } : {}),
    mode: designMode,
    digests: {
      promptTemplateSha256: templateSha256(renderPromptTemplates(designMode)),
      boilerplateTemplateSha256: templateSha256(renderBoilerplateTemplates(designMode)),
    },
  };
  identities.set(key, identity);
  return identity;
}
