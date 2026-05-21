/**
 * `ggui gadget create <scope/name>` — scaffold a new gadget repo.
 *
 * Generates the minimal file set an author needs to start writing a
 * gadget: manifest, package.json, tsconfig, src entry, README. The
 * generated manifest is validated against `gadgetManifestSchema` from
 * `@ggui-ai/artifact-manifest` before any file is written — defense in
 * depth that catches template regressions, not author error (authors
 * never see this code path).
 *
 * Distinct from `ggui gadget publish`, which reads the scaffolded
 * manifest, builds the bundle, and uploads to the resolved registry.
 * Create is local-only; no network calls.
 *
 * Kept pure / testable — no `process.exit`, no direct stdout writes
 * (errors return as structured results). `cli.ts` composes this with
 * the real argv + writes the banner.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GGUI_GADGET_JSON_FILENAME,
  parseGadgetManifest,
  type GadgetManifest,
} from '@ggui-ai/artifact-manifest';

/** Default version for a freshly scaffolded gadget. */
const DEFAULT_VERSION = '0.0.1';

/** Default visibility — public matches the marketplace's primary path. */
const DEFAULT_VISIBILITY: GadgetManifest['visibility'] = 'public';

/**
 * Parsed `<scope>/<name>` identifier. Scope INCLUDES the leading `@`
 * (mirrors the manifest schema's `ArtifactScopeSchema`).
 */
export interface ParsedScopeName {
  readonly scope: string;
  readonly name: string;
}

/**
 * Parse a `<scope>/<name>` positional argument. Accepts only the
 * canonical npm-style `@scope/name` shape. Returns `null` on any
 * structural mismatch — caller renders the help text + exits non-zero.
 *
 * Loose at this layer (no character-class checks); the strict regex
 * lives on the manifest schema and runs at the validation step before
 * write. Keeps this parser focused on the one thing it can know:
 * "is there a scope/name structure here at all?".
 */
export function parseScopeName(raw: string): ParsedScopeName | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.startsWith('@')) return null;
  const slash = raw.indexOf('/');
  if (slash === -1) return null;
  const scope = raw.slice(0, slash);
  const name = raw.slice(slash + 1);
  if (scope.length < 2 || name.length === 0) return null;
  return { scope, name };
}

/**
 * Convert a kebab-case gadget name into a `use<PascalCase>` hook name.
 * Matches the brief: `weather-card` → `useWeatherCard`. Numeric
 * segments collapse alongside hyphens — `mapbox-v2` → `useMapboxV2`.
 */
export function deriveHookName(gadgetName: string): string {
  const segments = gadgetName
    .split('-')
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1));
  return `use${segments.join('')}`;
}

/**
 * Flag bundle accepted by {@link runGadgetCreate}. Mirrors the CLI's
 * positional + flag surface; pulled out so `cli.ts` can build it from
 * `process.argv` and tests can build it from object literals.
 */
export interface GadgetCreateFlags {
  /** Positional `<scope>/<name>`. Validated in {@link runGadgetCreate}. */
  readonly scopeName: string;
  /**
   * Target directory. Defaults to the `name` portion of `scopeName`
   * (i.e. `@my-org/weather-card` → `./weather-card`). Resolved relative
   * to `cwd` at write time.
   */
  readonly dir?: string;
  /**
   * Hook export name. Defaults to {@link deriveHookName}(`name`).
   */
  readonly hook?: string;
  /** Optional one-line `description` for the manifest. */
  readonly description?: string;
  /** Manifest `visibility`. Defaults to {@link DEFAULT_VISIBILITY}. */
  readonly visibility?: GadgetManifest['visibility'];
}

/**
 * Flag-parse helper. Mirrors the shape used by other CLI subcommands —
 * returns a discriminated `{error}` vs. successful flags so the caller
 * doesn't throw on user input.
 */
export interface ParsedCreateFlags {
  readonly flags?: GadgetCreateFlags;
  /** `'__help__'` for `--help`; other strings = usage error. */
  readonly error?: string;
}

export function parseGadgetCreateFlags(
  args: readonly string[],
): ParsedCreateFlags {
  if (args.length === 0) {
    return { error: '__help__' };
  }

  let scopeName: string | undefined;
  let dir: string | undefined;
  let hook: string | undefined;
  let description: string | undefined;
  let visibility: GadgetManifest['visibility'] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      return { error: '__help__' };
    }
    if (arg === '--dir') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { error: '--dir requires a value' };
      }
      dir = value;
      i += 1;
      continue;
    }
    if (arg === '--hook') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { error: '--hook requires a value' };
      }
      hook = value;
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
        return {
          error: '--visibility must be "public" or "private"',
        };
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

  const flags: GadgetCreateFlags = {
    scopeName,
    ...(dir !== undefined ? { dir } : {}),
    ...(hook !== undefined ? { hook } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
  };
  return { flags };
}

/** Successful scaffold output — list of relative paths written. */
export interface GadgetCreateSuccess {
  readonly ok: true;
  /** Absolute path to the scaffolded gadget directory. */
  readonly targetDir: string;
  /** Files written, relative to `targetDir`. */
  readonly files: readonly string[];
  /** Resolved hook name (auto-derived or operator-supplied). */
  readonly hook: string;
  /** Resolved manifest — useful for callers that want to chain on it. */
  readonly manifest: GadgetManifest;
}

/** Structured failure. `code` is the stable error surface for tests. */
export interface GadgetCreateFailure {
  readonly ok: false;
  /** Machine-readable failure code. */
  readonly code:
    | 'invalid-scope-name'
    | 'target-not-empty'
    | 'manifest-invalid'
    | 'fs-error';
  /** Human-readable diagnostic — safe to write to stderr verbatim. */
  readonly message: string;
}

export type GadgetCreateResult = GadgetCreateSuccess | GadgetCreateFailure;

/**
 * Build a {@link GadgetManifest} from CLI flags. Separated from the
 * write step so tests can assert the manifest shape without touching
 * the filesystem. Runs through {@link parseGadgetManifest} so a
 * template regression (missing field, typo in `kind`) fails LOUD at
 * the scaffolder rather than silently shipping a broken `ggui.gadget.
 * json` that explodes on the first `ggui gadget publish`.
 */
export function buildScaffoldManifest(args: {
  scope: string;
  name: string;
  hook: string;
  visibility: GadgetManifest['visibility'];
  description?: string;
}): GadgetManifest {
  // A gadget manifest describes a PACKAGE: the package-level
  // `description` is required at registry side, and each `exports[*]`
  // entry carries its own required `description` / `usage` / `example`
  // teaching text. Scaffold sensible defaults so a freshly-created repo
  // passes `parseGadgetManifest` immediately. Authors should edit
  // `ggui.gadget.json` to refine the LLM teaching text before publish.
  const description =
    args.description ?? `${args.scope}/${args.name} — ggui gadget.`;
  const exportUsage =
    `Use \`${args.hook}\` whenever the agent needs to expose ${args.scope}/${args.name}'s capabilities to the UI. ` +
    `Edit this field in ggui.gadget.json before publish to refine the LLM's context-of-use prompt.`;
  const exportExample = {} as const;
  const raw = {
    kind: 'gadget' as const,
    scope: args.scope,
    name: args.name,
    version: DEFAULT_VERSION,
    bundle: 'src/index.ts',
    visibility: args.visibility,
    description,
    exports: [
      {
        hook: args.hook,
        description,
        usage: exportUsage,
        example: exportExample,
      },
    ],
    tags: [],
    peerDeps: { react: '^19.0.0' },
  };
  // Defense-in-depth — `parseGadgetManifest` enforces the schema. A
  // hand-edited template that drifts (e.g. drops `bundle`) blows up
  // here, before any write, so authors don't see a corrupt scaffold.
  return parseGadgetManifest(raw);
}

/**
 * `package.json` template. Strict-typed so a typo in the template
 * shape fails typecheck rather than at install time.
 */
interface ScaffoldPackageJson {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly type: 'module';
  readonly main: string;
  readonly types: string;
  readonly files: readonly string[];
  readonly scripts: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
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
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    files: ['dist', GGUI_GADGET_JSON_FILENAME, 'README.md'],
    scripts: {
      build: 'tsc -p tsconfig.json',
      typecheck: 'tsc --noEmit',
    },
    peerDependencies: {
      '@ggui-ai/gadgets': '*',
      react: '^19.0.0',
    },
    devDependencies: {
      typescript: '^5.0.0',
      '@types/react': '^19.0.0',
    },
  };
}

/** `tsconfig.json` template — strict TS, ESNext, bundler resolution. */
function buildTsconfig(): unknown {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      declaration: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
      rootDir: 'src',
    },
    include: ['src'],
  };
}

/**
 * `src/index.ts` template — a typed-hook stub conforming to
 * {@link import('@ggui-ai/protocol').GadgetHook}. The
 * marketplace renders this hook into a contract's
 * `clientCapabilities.gadgets` entry; the UI generator emits a
 * matching call site. Authors fill in the body.
 */
function buildSrcIndex(args: { hook: string }): string {
  return `import { useCallback, useState } from 'react';
import type { GadgetHook, GadgetStatus } from '@ggui-ai/protocol';

/**
 * Output shape for ${args.hook}. Returned by the hook's \`value\`
 * field when \`status === 'completed'\` or \`'active'\`.
 *
 * TODO: replace with the real shape your gadget exposes.
 */
export interface ${capitalizeHookOutput(args.hook)} {
  readonly placeholder: string;
}

/**
 * Options accepted by ${args.hook}. Optional; gadgets that take no
 * options can leave this as \`void\` on the type parameter and drop
 * the interface entirely.
 *
 * TODO: replace with real options or remove if unused.
 */
export interface ${capitalizeHookOptions(args.hook)} {
  readonly placeholder?: string;
}

/**
 * ${args.hook} — gadget hook entry. Conforms to
 * \`GadgetHook<TOutput, TOptions>\` so the ggui registry can
 * register it as a client library.
 *
 * Lifecycle (see \`GadgetStatus\` for the full set):
 *   - \`idle\` — initial.
 *   - \`active\` / \`completed\` — value available.
 *   - \`denied\` / \`error\` — see \`error\` for diagnostics.
 */
export const ${args.hook}: GadgetHook<
  ${capitalizeHookOutput(args.hook)},
  ${capitalizeHookOptions(args.hook)}
> = (_options) => {
  const [value, _setValue] = useState<${capitalizeHookOutput(args.hook)} | undefined>(
    undefined,
  );
  const [status, _setStatus] = useState<GadgetStatus>('idle');

  const start = useCallback(async (): Promise<
    ${capitalizeHookOutput(args.hook)} | undefined
  > => {
    // TODO: implement the gadget. Update \`status\` + \`value\` as the
    // capability progresses through its lifecycle.
    return undefined;
  }, []);

  return { value, status, start };
};
`;
}

function capitalizeHookOutput(hook: string): string {
  // `useFoo` → `FooValue`. Suffixed with `Value` so it doesn't clash
  // with the hook name if the gadget ever wants both exported.
  const stripped = hook.startsWith('use') ? hook.slice(3) : hook;
  const cap = stripped.length > 0 ? stripped[0]!.toUpperCase() + stripped.slice(1) : 'Result';
  return `${cap}Value`;
}

function capitalizeHookOptions(hook: string): string {
  const stripped = hook.startsWith('use') ? hook.slice(3) : hook;
  const cap = stripped.length > 0 ? stripped[0]!.toUpperCase() + stripped.slice(1) : 'Options';
  return `${cap}Options`;
}

/** README — single short paragraph + usage snippet. No frontmatter. */
function buildReadme(args: {
  scope: string;
  name: string;
  hook: string;
  description?: string;
}): string {
  const summary =
    args.description ?? `${args.scope}/${args.name} — ggui gadget.`;
  return `# ${args.scope}/${args.name}

${summary}

## Develop

\`\`\`bash
pnpm install
pnpm typecheck
\`\`\`

## Publish

\`\`\`bash
ggui gadget publish
\`\`\`

See [ggui gadget docs](https://ggui.ai/docs/gadgets) for the full
marketplace flow.

## Use

Contract authors declare this gadget on a \`DataContract\`:

\`\`\`ts
clientCapabilities: {
  gadgets: {
    ${stripUsePrefix(args.hook)}: { hook: '${args.hook}' },
  },
}
\`\`\`

The UI generator emits the matching \`import { ${args.hook} } from '${args.scope}/${args.name}'\`
and call site automatically.
`;
}

function stripUsePrefix(hook: string): string {
  const stripped = hook.startsWith('use') ? hook.slice(3) : hook;
  return stripped.length > 0
    ? stripped[0]!.toLowerCase() + stripped.slice(1)
    : 'capability';
}

/**
 * Refuse-to-overwrite check. A non-empty target directory is the only
 * destructive case we guard against — empty + missing both green-light
 * the scaffold. Matches the discipline `ggui dev` and `ggui serve`
 * apply elsewhere (no silent file rewrites).
 */
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
 * Run the scaffold end-to-end. Resolves the target dir, validates the
 * manifest, writes files. Returns a structured result so the CLI
 * driver can render copy + exit code without re-deriving paths.
 */
export async function runGadgetCreate(
  flags: GadgetCreateFlags,
  options: { cwd: string },
): Promise<GadgetCreateResult> {
  const parsed = parseScopeName(flags.scopeName);
  if (!parsed) {
    return {
      ok: false,
      code: 'invalid-scope-name',
      message: `"${flags.scopeName}" is not a valid <scope>/<name>. Expected \`@org/gadget-name\` (e.g. \`@my-org/weather-card\`).`,
    };
  }

  const { scope, name } = parsed;
  const hook = flags.hook ?? deriveHookName(name);
  const visibility = flags.visibility ?? DEFAULT_VISIBILITY;

  // Build + validate the manifest BEFORE any filesystem write. If the
  // schema rejects (e.g. scope/name regex fails) we abort with a
  // structured error and the target dir stays untouched.
  let manifest: GadgetManifest;
  try {
    manifest = buildScaffoldManifest({
      scope,
      name,
      hook,
      visibility,
      ...(flags.description !== undefined
        ? { description: flags.description }
        : {}),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'manifest-invalid',
      message:
        err instanceof Error ? err.message : 'failed to validate manifest',
    };
  }

  const targetDir = join(options.cwd, flags.dir ?? name);

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

    const manifestPath = join(targetDir, GGUI_GADGET_JSON_FILENAME);
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
      join(targetDir, 'tsconfig.json'),
      `${JSON.stringify(buildTsconfig(), null, 2)}\n`,
      'utf-8',
    );

    await writeFile(
      join(targetDir, 'src', 'index.ts'),
      buildSrcIndex({ hook }),
      'utf-8',
    );

    await writeFile(
      join(targetDir, 'README.md'),
      buildReadme({
        scope,
        name,
        hook,
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
      GGUI_GADGET_JSON_FILENAME,
      'package.json',
      'tsconfig.json',
      'src/index.ts',
      'README.md',
    ],
    hook,
    manifest,
  };
}

export const GADGET_CREATE_HELP = `ggui gadget create — scaffold a new gadget repo

Usage:
  ggui gadget create <scope/name> [options]

Arguments:
  <scope/name>     Required. \`@my-org/weather-card\` style identifier.
                   The scope (with leading \`@\`) becomes the manifest's
                   \`scope\`; the segment after \`/\` becomes the \`name\`.

Options:
  --dir <path>             Target directory. Defaults to \`./<name>\`.
  --hook <hookName>        Exported hook name. Defaults to
                           \`use<NameInPascalCase>\` derived from <name>
                           (e.g. \`weather-card\` → \`useWeatherCard\`).
  --description <text>     One-line description threaded into the
                           manifest + README.
  --visibility <p>         \`public\` (default, sigstore-signed) or
                           \`private\` (Ed25519-signed, org-only).
  --help, -h               Show this help.

Output:
  <dir>/ggui.gadget.json   Strict-schema manifest (validated before write).
  <dir>/package.json       Workspace shell (\`type: module\`, peerDeps).
  <dir>/tsconfig.json      Strict TS, ESNext, bundler resolution.
  <dir>/src/index.ts       \`GadgetHook\`-shaped hook stub.
  <dir>/README.md          One-paragraph orientation + usage.

After scaffold:
  cd <dir> && pnpm install
  # implement the hook in src/index.ts, then:
  ggui gadget publish      # Slice 3.4 — publishes to the resolved registry.
`;
