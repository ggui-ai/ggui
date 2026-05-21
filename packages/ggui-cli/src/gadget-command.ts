/**
 * `ggui gadget <create|publish|install|search>` — top-level router for
 * the marketplace author + consumer surface.
 *
 * A thin sibling of `blueprint-command.ts`. Both commands dispatch into
 * the shared `internal/artifact-*` modules with their own `kind`
 * discriminator; per-kind state (scaffolders, help text) lives in
 * sibling files.
 *
 * - `create`  — scaffold a new gadget repo (hook + bundle stub).
 * - `publish` — build, sign, and push to a registry.
 *               Manifest-kind mismatch surfaces a redirect.
 * - `install` — fetch, verify, append to ggui.json.
 * - `search`  — query the registry, hard-locked to `kind=gadget`.
 */
import {
  GADGET_CREATE_HELP,
  parseGadgetCreateFlags,
  runGadgetCreate,
  type GadgetCreateResult,
} from './gadget-create.js';
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
  buildSearchHelp,
  parseArtifactSearchFlags,
  runArtifactSearch,
  type SearchOutput,
} from './internal/artifact-search.js';

const KIND = 'gadget' as const;

export const GADGET_HELP = `ggui gadget — author + manage marketplace gadgets

Usage:
  ggui gadget <subcommand> [options]

Subcommands:
  create       Scaffold a new gadget repo.
  publish      Build, sign, and push the gadget in CWD to a marketplace registry.
  install      Fetch, verify, and register a gadget in ggui.json.
  search       Search the marketplace registry for gadgets.

Run \`ggui gadget <subcommand> --help\` for subcommand-specific options.
`;

export async function runGadgetCommand(
  args: readonly string[],
): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(GADGET_HELP);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case 'create':
      return runCreate(rest);
    case 'publish':
      return runPublish(rest);
    case 'install':
      return runInstall(rest);
    case 'search':
      return runSearch(rest);
    default:
      process.stderr.write(`ggui gadget: unknown subcommand "${sub}"\n\n`);
      process.stderr.write(GADGET_HELP);
      return 2;
  }
}

/* -------------------------------------------------------------------------- */
/* create                                                                     */
/* -------------------------------------------------------------------------- */

async function runCreate(args: readonly string[]): Promise<number> {
  const parsed = parseGadgetCreateFlags(args);
  if (parsed.error === '__help__') {
    process.stdout.write(GADGET_CREATE_HELP);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`ggui gadget create: ${parsed.error}\n\n`);
    process.stderr.write(GADGET_CREATE_HELP);
    return 2;
  }
  if (!parsed.flags) {
    process.stderr.write(`ggui gadget create: failed to parse flags\n`);
    return 2;
  }
  const result = await runGadgetCreate(parsed.flags, { cwd: process.cwd() });
  return renderCreateResult(result);
}

function renderCreateResult(result: GadgetCreateResult): number {
  if (!result.ok) {
    process.stderr.write(`ggui gadget create: ${result.message}\n`);
    return 1;
  }
  process.stdout.write(`\n`);
  process.stdout.write(`Scaffolded gadget at ${result.targetDir}\n\n`);
  process.stdout.write(`Files written:\n`);
  for (const f of result.files) {
    process.stdout.write(`  - ${f}\n`);
  }
  process.stdout.write(`\n`);
  process.stdout.write(`Hook export: ${result.hook}\n`);
  process.stdout.write(
    `Identifier:  ${result.manifest.scope}/${result.manifest.name}@${result.manifest.version}\n`,
  );
  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`  cd ${result.targetDir}\n`);
  process.stdout.write(`  pnpm install\n`);
  process.stdout.write(`  # implement the hook in src/index.ts, then:\n`);
  process.stdout.write(`  ggui gadget publish\n\n`);
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
    process.stderr.write(`ggui gadget publish: ${flags.error}\n`);
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
    process.stderr.write(`ggui gadget install: ${parsed.error}\n\n`);
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
/* search                                                                     */
/* -------------------------------------------------------------------------- */

async function runSearch(args: readonly string[]): Promise<number> {
  const parsed = parseArtifactSearchFlags(KIND, args);
  if (parsed.error === '__help__') {
    process.stdout.write(buildSearchHelp(KIND));
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`ggui gadget search: ${parsed.error}\n\n`);
    process.stderr.write(buildSearchHelp(KIND));
    return 2;
  }
  if (!parsed.flags) {
    process.stderr.write(`ggui gadget search: failed to parse flags\n`);
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
    process.stderr.write(`ggui gadget search: ${result.message}\n`);
    return 1;
  }
  if (json) {
    process.stdout.write(`${result.json}\n`);
    return 0;
  }
  if (result.response.results.length === 0) {
    process.stderr.write('No gadgets found matching the supplied criteria.\n');
    return 0;
  }
  for (const line of result.lines) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}
