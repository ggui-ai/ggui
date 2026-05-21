/**
 * `ggui blueprint <create|publish|install|search>` — kind-discriminated
 * sibling of `gadget-command.ts`.
 *
 * - `create`  — scaffold a new blueprint repo (TSX + contract stub)
 * - `publish` — build, sign, and push to a registry; manifest-kind
 *               mismatch errors with a friendly redirect.
 * - `install` — fetch, verify, and materialize a blueprint into
 *               `.ggui/installed-blueprints/<id>/`.
 * - `search`  — query the registry, hard-locked to `kind=blueprint`.
 *
 * A thin router that passes `kind: 'blueprint'` to the shared
 * `internal/artifact-*` implementations. Per-kind state (scaffolders,
 * help text) lives in sibling files; the rest is shared.
 */
import {
  BLUEPRINT_CREATE_HELP,
  parseBlueprintCreateFlags,
  runBlueprintCreate,
  type BlueprintCreateResult,
} from './blueprint-create.js';
import {
  buildPublishHelp,
  parseArtifactPublishFlags,
  runArtifactPublish,
} from './internal/artifact-publish.js';
import {
  buildInstallHelp,
  parseArtifactInstallFlags,
  runArtifactInstall,
} from './internal/artifact-install.js';
import {
  buildUninstallHelp,
  parseArtifactUninstallFlags,
  runArtifactUninstall,
} from './internal/artifact-uninstall.js';
import {
  buildSearchHelp,
  parseArtifactSearchFlags,
  runArtifactSearch,
  type SearchOutput,
} from './internal/artifact-search.js';

const KIND = 'blueprint' as const;

export const BLUEPRINT_HELP = `ggui blueprint — author + manage marketplace blueprints

Usage:
  ggui blueprint <subcommand> [options]

Subcommands:
  create       Scaffold a new blueprint repo.
  publish      Build, sign, and push the blueprint in CWD to a marketplace registry.
  install      Fetch, verify, and materialize a blueprint locally.
  uninstall    Remove a locally-installed blueprint (reverse of install).
  search       Search the marketplace registry for blueprints.

Run \`ggui blueprint <subcommand> --help\` for subcommand-specific options.
`;

export async function runBlueprintCommand(
  args: readonly string[],
): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(BLUEPRINT_HELP);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case 'create':
      return runCreate(rest);
    case 'publish':
      return runPublish(rest);
    case 'install':
      return runInstall(rest);
    case 'uninstall':
      return runUninstall(rest);
    case 'search':
      return runSearch(rest);
    default:
      process.stderr.write(`ggui blueprint: unknown subcommand "${sub}"\n\n`);
      process.stderr.write(BLUEPRINT_HELP);
      return 2;
  }
}

/* -------------------------------------------------------------------------- */
/* create                                                                     */
/* -------------------------------------------------------------------------- */

async function runCreate(args: readonly string[]): Promise<number> {
  const parsed = parseBlueprintCreateFlags(args);
  if (parsed.error === '__help__') {
    process.stdout.write(BLUEPRINT_CREATE_HELP);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`ggui blueprint create: ${parsed.error}\n\n`);
    process.stderr.write(BLUEPRINT_CREATE_HELP);
    return 2;
  }
  if (!parsed.flags) {
    process.stderr.write(`ggui blueprint create: failed to parse flags\n`);
    return 2;
  }
  const result = await runBlueprintCreate(parsed.flags, { cwd: process.cwd() });
  return renderCreateResult(result);
}

function renderCreateResult(result: BlueprintCreateResult): number {
  if (!result.ok) {
    process.stderr.write(`ggui blueprint create: ${result.message}\n`);
    return 1;
  }
  process.stdout.write(`\n`);
  process.stdout.write(`Scaffolded blueprint at ${result.targetDir}\n\n`);
  process.stdout.write(`Files written:\n`);
  for (const f of result.files) {
    process.stdout.write(`  - ${f}\n`);
  }
  process.stdout.write(`\n`);
  process.stdout.write(
    `Identifier:  ${result.manifest.scope}/${result.manifest.name}@${result.manifest.version}\n`,
  );
  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`  cd ${result.targetDir}\n`);
  process.stdout.write(`  pnpm install\n`);
  process.stdout.write(`  # implement the component in src/blueprint.tsx, then:\n`);
  process.stdout.write(`  ggui blueprint publish\n\n`);
  return 0;
}

/* -------------------------------------------------------------------------- */
/* publish                                                                    */
/* -------------------------------------------------------------------------- */

async function runPublish(args: readonly string[]): Promise<number> {
  const flags = parseArtifactPublishFlags(args);
  if (flags.help) {
    process.stdout.write(buildPublishHelp(KIND));
    return 0;
  }
  if (flags.error) {
    process.stderr.write(`ggui blueprint publish: ${flags.error}\n`);
    return 2;
  }
  const result = await runArtifactPublish({
    kind: KIND,
    ...(flags.registry !== undefined ? { registry: flags.registry } : {}),
    dryRun: flags.dryRun,
    ...(flags.key !== undefined ? { key: flags.key } : {}),
    ...(flags.auth !== undefined ? { auth: flags.auth } : {}),
  });
  return result.exitCode;
}

/* -------------------------------------------------------------------------- */
/* install                                                                    */
/* -------------------------------------------------------------------------- */

async function runInstall(args: readonly string[]): Promise<number> {
  const parsed = parseArtifactInstallFlags(KIND, args);
  if ('error' in parsed) {
    if (parsed.error === '__help__') {
      process.stdout.write(buildInstallHelp(KIND));
      return 0;
    }
    process.stderr.write(`ggui blueprint install: ${parsed.error}\n\n`);
    process.stderr.write(buildInstallHelp(KIND));
    return 2;
  }
  return runArtifactInstall(parsed, {
    cwd: process.cwd(),
    env: process.env,
    fetch: globalThis.fetch.bind(globalThis),
  });
}

/* -------------------------------------------------------------------------- */
/* uninstall                                                                  */
/* -------------------------------------------------------------------------- */

async function runUninstall(args: readonly string[]): Promise<number> {
  const parsed = parseArtifactUninstallFlags(KIND, args);
  if ('error' in parsed) {
    if (parsed.error === '__help__') {
      process.stdout.write(buildUninstallHelp(KIND));
      return 0;
    }
    process.stderr.write(`ggui blueprint uninstall: ${parsed.error}\n\n`);
    process.stderr.write(buildUninstallHelp(KIND));
    return 2;
  }
  const result = await runArtifactUninstall(parsed, {
    cwd: process.cwd(),
  });
  return result.exitCode;
}

/* -------------------------------------------------------------------------- */
/* search                                                                     */
/* -------------------------------------------------------------------------- */

async function runSearch(args: readonly string[]): Promise<number> {
  const parsed = parseArtifactSearchFlags(KIND, args);
  if (parsed.error === '__help__') {
    process.stdout.write(buildSearchHelp(KIND));
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`ggui blueprint search: ${parsed.error}\n\n`);
    process.stderr.write(buildSearchHelp(KIND));
    return 2;
  }
  if (!parsed.flags) {
    process.stderr.write(`ggui blueprint search: failed to parse flags\n`);
    return 2;
  }
  const result = await runArtifactSearch(parsed.flags, {
    cwd: process.cwd(),
    env: { GGUI_REGISTRY: process.env['GGUI_REGISTRY'] },
    fetch: globalThis.fetch.bind(globalThis),
  });
  return renderSearchResult(result, parsed.flags.json === true);
}

function renderSearchResult(result: SearchOutput, json: boolean): number {
  if (!result.ok) {
    process.stderr.write(`ggui blueprint search: ${result.message}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(`${result.json}\n`);
    return 0;
  }
  if (result.response.results.length === 0) {
    process.stderr.write('No blueprints found matching the supplied criteria.\n');
    return 0;
  }
  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}
