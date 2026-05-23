/**
 * `ggui blueprint create <scope/name>` — scaffold a new blueprint repo.
 *
 * Sibling of `gadget-create.ts`. Blueprints differ from gadgets in two
 * ways that justify a separate scaffolder (rather than a
 * kind-discriminated single template):
 *
 *   - **Source body** — blueprints are TSX components, not bundled
 *     hook libraries. The scaffold writes a `src/blueprint.tsx` with
 *     a minimal React component + a `src/contract.ts` stub that
 *     declares a `DataContract` for the LLM-driven cache-match path.
 *   - **Manifest shape** — `ggui.blueprint.json` carries `source`,
 *     `contract`, `fixtureProps`, `variance`. The scaffold synthesizes
 *     a working manifest with the inline source body, so an author can
 *     `cd <dir> && ggui blueprint publish` immediately after generation.
 *
 * The scaffold validates the synthesized manifest with
 * `parseBlueprintManifest` before any write — template regressions
 * fail LOUD at the scaffolder rather than silently shipping a broken
 * `ggui.blueprint.json`.
 *
 * Kept pure / testable — no `process.exit`, no direct stdout writes.
 * `blueprint-command.ts` composes this with the real argv + writes
 * the banner.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  GGUI_BLUEPRINT_JSON_FILENAME,
  parseBlueprintManifest,
  type BlueprintManifest,
} from '@ggui-ai/artifact-manifest';
import { parseScopeName, type ParsedScopeName } from './gadget-create.js';

/** Default version for a freshly scaffolded blueprint. */
const DEFAULT_VERSION = '0.0.1';

/** Default visibility — public matches the marketplace's primary path. */
const DEFAULT_VISIBILITY: BlueprintManifest['visibility'] = 'public';

/**
 * Flag bundle accepted by {@link runBlueprintCreate}. Mirrors the CLI's
 * positional + flag surface; pulled out so `blueprint-command.ts` can
 * build it from `process.argv` and tests can build it from object literals.
 */
export interface BlueprintCreateFlags {
  /** Positional `<scope>/<name>`. Validated in {@link runBlueprintCreate}. */
  readonly scopeName: string;
  /**
   * Target directory. Defaults to the `name` portion of `scopeName`
   * (i.e. `@my-org/login-form` → `./login-form`). Resolved relative
   * to `cwd` at write time.
   */
  readonly dir?: string;
  /** Optional one-line `description` for the manifest. */
  readonly description?: string;
  /** Manifest `visibility`. Defaults to {@link DEFAULT_VISIBILITY}. */
  readonly visibility?: BlueprintManifest['visibility'];
}

export interface ParsedBlueprintCreateFlags {
  readonly flags?: BlueprintCreateFlags;
  /** `'__help__'` for `--help`; other strings = usage error. */
  readonly error?: string;
}

/**
 * Parse the `ggui blueprint create` flag tail. Returns a discriminated
 * `{error}` vs. successful flags so the caller doesn't throw on user
 * input.
 */
export function parseBlueprintCreateFlags(
  args: readonly string[],
): ParsedBlueprintCreateFlags {
  if (args.length === 0) {
    return { error: '__help__' };
  }
  let scopeName: string | undefined;
  let dir: string | undefined;
  let description: string | undefined;
  let visibility: BlueprintManifest['visibility'] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') return { error: '__help__' };
    if (arg === '--dir') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { error: '--dir requires a value' };
      }
      dir = value;
      i += 1;
      continue;
    }
    if (arg === '--description') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { error: '--description requires a value' };
      }
      description = value;
      i += 1;
      continue;
    }
    if (arg === '--visibility') {
      const value = args[i + 1];
      if (value !== 'public' && value !== 'private') {
        return { error: '--visibility must be "public" or "private"' };
      }
      visibility = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `unknown flag: ${arg}` };
    }
    if (scopeName === undefined) {
      scopeName = arg;
      continue;
    }
    return { error: `unexpected positional argument: ${arg}` };
  }
  if (scopeName === undefined) {
    return { error: 'missing required <scope/name> positional argument' };
  }
  const flags: BlueprintCreateFlags = {
    scopeName,
    ...(dir !== undefined ? { dir } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
  };
  return { flags };
}

/**
 * Build the minimal TSX source body the scaffold ships as
 * `src/blueprint.tsx`. Authors edit this in-place; once the source
 * stabilizes the publish flow re-reads + inlines it into the manifest's
 * `source` field at upload time.
 */
function buildBlueprintTsx(parsed: ParsedScopeName): string {
  const componentName = toPascalCase(parsed.name);
  return `/**
 * ${parsed.scope}/${parsed.name} — ggui blueprint.
 *
 * Default-exports a React component the runtime renders against the
 * declared DataContract. Replace this placeholder with your real UI.
 */
export interface ${componentName}Props {
  readonly title?: string;
}

export default function ${componentName}(props: ${componentName}Props): JSX.Element {
  return (
    <section data-blueprint="${parsed.scope}/${parsed.name}">
      <h1>{props.title ?? '${parsed.scope}/${parsed.name}'}</h1>
    </section>
  );
}
`;
}

/**
 * Build the matching `src/contract.ts` stub — a minimal `DataContract`
 * the blueprint registers under. Authors flesh out `propsSchema` to
 * match the component's prop shape and add `clientCapabilities` /
 * `commitSpec` as needed.
 */
function buildContractStub(parsed: ParsedScopeName): string {
  return `/**
 * DataContract for ${parsed.scope}/${parsed.name}. The runtime feeds
 * the matching props into the default-exported component on render;
 * the contract's hash also drives cache-match for the cold-gen short-
 * circuit.
 */
export const contract = {
  schemaVersion: '1' as const,
  contextSpec: {
    propsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
      },
    },
  },
} as const;
`;
}

/** Convert a kebab-case blueprint name → PascalCase component name. */
function toPascalCase(name: string): string {
  return name
    .split('-')
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join('');
}

/**
 * Build + validate the {@link BlueprintManifest} BEFORE any write.
 * A template regression that drifts (e.g. drops `source`) blows up
 * here, before any file lands on disk, so authors don't see a corrupt
 * scaffold.
 */
export function buildScaffoldManifest(args: {
  scope: string;
  name: string;
  visibility: BlueprintManifest['visibility'];
  description?: string;
  source: string;
}): BlueprintManifest {
  const description =
    args.description ??
    `${args.scope}/${args.name} — ggui marketplace blueprint.`;
  const raw = {
    kind: 'blueprint' as const,
    scope: args.scope,
    name: args.name,
    version: DEFAULT_VERSION,
    visibility: args.visibility,
    source: args.source,
    description,
    tags: [],
  };
  return parseBlueprintManifest(raw);
}

/** Top-level scaffolder result — mirror of `GadgetCreateResult`. */
export interface BlueprintCreateSuccess {
  readonly ok: true;
  /** Absolute path to the scaffolded blueprint directory. */
  readonly targetDir: string;
  /** Files written, relative to `targetDir`. */
  readonly files: readonly string[];
  /** Resolved manifest — useful for callers that want to chain on it. */
  readonly manifest: BlueprintManifest;
}

export interface BlueprintCreateFailure {
  readonly ok: false;
  readonly code:
    | 'invalid-scope-name'
    | 'invalid-name'
    | 'target-not-empty'
    | 'manifest-invalid'
    | 'fs-error';
  readonly message: string;
}

export type BlueprintCreateResult = BlueprintCreateSuccess | BlueprintCreateFailure;

/**
 * `package.json` template. Strict-typed so a typo in the template
 * shape fails typecheck rather than at install time.
 */
interface ScaffoldPackageJson {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly type: 'module';
  readonly files: readonly string[];
  readonly devDependencies: Readonly<Record<string, string>>;
}

function buildPackageJson(args: {
  scope: string;
  name: string;
  description?: string;
}): ScaffoldPackageJson {
  return {
    name: `${args.scope}/${args.name}`,
    version: DEFAULT_VERSION,
    ...(args.description !== undefined ? { description: args.description } : {}),
    type: 'module',
    files: ['src', GGUI_BLUEPRINT_JSON_FILENAME, 'README.md'],
    devDependencies: {
      typescript: '^5.0.0',
      '@types/react': '^19.0.0',
    },
  };
}

function buildReadme(args: {
  scope: string;
  name: string;
  description?: string;
}): string {
  const summary =
    args.description ??
    `${args.scope}/${args.name} — ggui marketplace blueprint.`;
  return `# ${args.scope}/${args.name}

${summary}

## Develop

\`\`\`bash
pnpm install
\`\`\`

Edit \`src/blueprint.tsx\` (component body) and \`src/contract.ts\`
(matching \`DataContract\`).

## Publish

\`\`\`bash
ggui blueprint publish
\`\`\`

See [ggui blueprint docs](https://ggui.ai/docs/blueprints) for the full
marketplace flow.
`;
}

/** Refuse-to-overwrite check, matching gadget-create's posture. */
async function isDirectoryEmpty(path: string): Promise<{
  exists: boolean;
  empty: boolean;
}> {
  try {
    const entries = await readdir(path);
    return { exists: true, empty: entries.length === 0 };
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { exists: false, empty: true };
    }
    throw err;
  }
}

/**
 * Run the blueprint scaffold end-to-end. Resolves the target dir,
 * builds + validates the manifest, writes files. Returns a structured
 * result so the CLI driver can render copy + exit code without
 * re-deriving paths.
 */
export async function runBlueprintCreate(
  flags: BlueprintCreateFlags,
  options: { cwd: string },
): Promise<BlueprintCreateResult> {
  const parsed = parseScopeName(flags.scopeName);
  if (!parsed) {
    return {
      ok: false,
      code: 'invalid-scope-name',
      message: `"${flags.scopeName}" is not a valid <scope>/<name>. Expected \`@org/blueprint-name\` (e.g. \`@my-org/login-form\`).`,
    };
  }
  // Blueprint name regex (`^[a-z0-9][a-z0-9_-]{0,63}$`) is enforced by
  // the manifest schema; a structurally-valid scope/name with an
  // invalid blueprint slug surfaces at parse time below as
  // `manifest-invalid`. Bail early on the more obvious mismatches so
  // the operator sees a crisp message.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(parsed.name)) {
    return {
      ok: false,
      code: 'invalid-name',
      message: `"${parsed.name}" is not a valid blueprint name. Expected lowercase alphanum + hyphens / underscores, 1..64 chars, first char alphanumeric (e.g. \`login-form\`).`,
    };
  }

  const { scope, name } = parsed;
  const visibility = flags.visibility ?? DEFAULT_VISIBILITY;
  const source = buildBlueprintTsx(parsed);

  let manifest: BlueprintManifest;
  try {
    manifest = buildScaffoldManifest({
      scope,
      name,
      visibility,
      source,
      ...(flags.description !== undefined
        ? { description: flags.description }
        : {}),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'manifest-invalid',
      message: err instanceof Error ? err.message : 'failed to validate manifest',
    };
  }

  // `resolve` (not `join`): when `flags.dir` is an absolute path, it must
  // win over `options.cwd`. `join('/repo', '/tmp/foo')` concatenates to
  // `/repo/tmp/foo`; `resolve('/repo', '/tmp/foo')` correctly returns
  // `/tmp/foo`. Relative paths still resolve against cwd.
  const targetDir = resolve(options.cwd, flags.dir ?? name);

  let dirState: { exists: boolean; empty: boolean };
  try {
    dirState = await isDirectoryEmpty(targetDir);
  } catch (err) {
    return {
      ok: false,
      code: 'fs-error',
      message: err instanceof Error ? err.message : 'failed to read target dir',
    };
  }
  if (dirState.exists && !dirState.empty) {
    return {
      ok: false,
      code: 'target-not-empty',
      message: `target directory ${targetDir} is not empty. Refusing to overwrite — choose a different --dir or remove existing files.`,
    };
  }

  try {
    await mkdir(targetDir, { recursive: true });
    await mkdir(join(targetDir, 'src'), { recursive: true });

    const manifestPath = join(targetDir, GGUI_BLUEPRINT_JSON_FILENAME);
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf-8',
    );

    const pkg = buildPackageJson({
      scope,
      name,
      ...(flags.description !== undefined
        ? { description: flags.description }
        : {}),
    });
    await writeFile(
      join(targetDir, 'package.json'),
      `${JSON.stringify(pkg, null, 2)}\n`,
      'utf-8',
    );

    await writeFile(
      join(targetDir, 'src', 'blueprint.tsx'),
      source,
      'utf-8',
    );

    await writeFile(
      join(targetDir, 'src', 'contract.ts'),
      buildContractStub(parsed),
      'utf-8',
    );

    await writeFile(
      join(targetDir, 'README.md'),
      buildReadme({
        scope,
        name,
        ...(flags.description !== undefined
          ? { description: flags.description }
          : {}),
      }),
      'utf-8',
    );
  } catch (err) {
    return {
      ok: false,
      code: 'fs-error',
      message: err instanceof Error ? err.message : 'failed to write files',
    };
  }

  return {
    ok: true,
    targetDir,
    files: [
      GGUI_BLUEPRINT_JSON_FILENAME,
      'package.json',
      'src/blueprint.tsx',
      'src/contract.ts',
      'README.md',
    ],
    manifest,
  };
}

export const BLUEPRINT_CREATE_HELP = `ggui blueprint create — scaffold a new blueprint repo

Usage:
  ggui blueprint create <scope/name> [options]

Arguments:
  <scope/name>     Required. \`@my-org/login-form\` style identifier.
                   The scope (with leading \`@\`) becomes the manifest's
                   \`scope\`; the segment after \`/\` becomes the \`name\`
                   (must match \`^[a-z0-9][a-z0-9_-]{0,63}$\`).

Options:
  --dir <path>             Target directory. Defaults to \`./<name>\`.
  --description <text>     One-line description threaded into the
                           manifest + README.
  --visibility <p>         \`public\` (default, sigstore-signed) or
                           \`private\` (Ed25519-signed, org-only).
  --help, -h               Show this help.

Output:
  <dir>/ggui.blueprint.json   Strict-schema manifest (validated before write).
  <dir>/package.json          Workspace shell.
  <dir>/src/blueprint.tsx     Default-exported React component stub.
  <dir>/src/contract.ts       Matching \`DataContract\` stub.
  <dir>/README.md             One-paragraph orientation.

After scaffold:
  cd <dir> && pnpm install
  # implement the component in src/blueprint.tsx, then:
  ggui blueprint publish     # publishes to the resolved registry.
`;
