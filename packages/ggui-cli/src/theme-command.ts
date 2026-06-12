/**
 * `ggui theme <subcommand>` — operator-facing theme tooling.
 *
 * Today only `validate <path>` ships: reads a DTCG `theme.json` from
 * disk, runs `safeParseThemeDocument` from `@ggui-ai/project-config`,
 * and prints either a one-line success summary or a per-issue error
 * list. Schema lives in `@ggui-ai/project-config` and is the single
 * source of truth — this command never re-implements validation.
 *
 * Sibling of `gadget-command.ts` / `blueprint-command.ts`. Kept thin
 * so future subcommands (`theme preview`, `theme diff`, …) drop in
 * alongside `validate` without restructuring.
 *
 * Exit codes:
 *   0  valid
 *   1  invalid (schema violations rendered to stderr) or unreadable
 *      input file
 *   2  bad CLI usage (missing path, unknown subcommand, `--help` from
 *      an empty router invocation)
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  safeParseThemeDocument,
  type ThemeDocument,
} from '@ggui-ai/project-config';

export const THEME_HELP = `ggui theme — validate + inspect operator-authored DTCG themes

Usage:
  ggui theme <subcommand> [options]

Subcommands:
  validate <path>   Validate a JSON theme file against the ThemeDocumentV1 schema.

Run \`ggui theme <subcommand> --help\` for subcommand-specific options.
`;

export const THEME_VALIDATE_HELP = `ggui theme validate — validate a DTCG theme file

Usage:
  ggui theme validate <path>

Arguments:
  <path>    Path to a JSON theme document (e.g. \`./theme.json\`).

Exit codes:
  0   theme is valid
  1   theme file is unreadable, not JSON, or fails schema validation
  2   bad CLI usage (missing path argument)
`;

export async function runThemeCommand(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(THEME_HELP);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case 'validate':
      return runValidate(rest);
    default:
      process.stderr.write(`ggui theme: unknown subcommand "${sub}"\n\n`);
      process.stderr.write(THEME_HELP);
      return 2;
  }
}

/* -------------------------------------------------------------------------- */
/* validate                                                                   */
/* -------------------------------------------------------------------------- */

async function runValidate(args: readonly string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(THEME_VALIDATE_HELP);
    return 0;
  }
  if (args.length === 0) {
    process.stderr.write(`ggui theme validate: missing <path> argument\n\n`);
    process.stderr.write(THEME_VALIDATE_HELP);
    return 2;
  }
  // Drop bare `--` if the operator used it as the long-flag terminator.
  const positional = args.filter((a) => a !== '--');
  const filePath = positional[0];
  if (!filePath) {
    process.stderr.write(`ggui theme validate: missing <path> argument\n\n`);
    process.stderr.write(THEME_VALIDATE_HELP);
    return 2;
  }
  if (positional.length > 1) {
    process.stderr.write(
      `ggui theme validate: too many arguments (expected exactly one path)\n\n`,
    );
    process.stderr.write(THEME_VALIDATE_HELP);
    return 2;
  }

  const absPath = resolve(process.cwd(), filePath);

  let raw: string;
  try {
    raw = await readFile(absPath, 'utf-8');
  } catch (err) {
    process.stderr.write(
      `ggui theme validate: cannot read ${absPath} — ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `ggui theme validate: ${absPath} is not valid JSON — ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 1;
  }

  const result = safeParseThemeDocument(parsed);
  if (!result.success) {
    process.stderr.write(
      `ggui theme validate: ${absPath} failed schema validation (${result.error.issues.length} issue${
        result.error.issues.length === 1 ? '' : 's'
      })\n`,
    );
    for (const issue of result.error.issues) {
      const path = issue.path.length === 0
        ? '<root>'
        : issue.path
            .map((seg) =>
              typeof seg === 'number' ? `[${seg}]` : String(seg),
            )
            .join('.');
      process.stderr.write(`  · ${path}: ${issue.message}\n`);
    }
    return 1;
  }

  for (const line of describeValidTheme(absPath, result.data)) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

/**
 * Build the success-path stdout lines. Pure so tests can pin the copy.
 * Green styling is applied only when stdout is a TTY — pipes/captures
 * stay clean for grep + assertions.
 */
function describeValidTheme(absPath: string, theme: ThemeDocument): string[] {
  const lines: string[] = [];
  const mark = process.stdout.isTTY ? '[32m✓[0m' : '✓';
  const nameSuffix = theme.$name ? ` (${theme.$name})` : '';
  lines.push(`${mark} Theme valid${nameSuffix}`);
  lines.push(`  file: ${absPath}`);

  // Color palette count: each top-level entry in `color` is either a
  // single-token role (e.g. `surface`) or a nested palette (e.g.
  // `primary: { 50: …, 100: … }`). Both count as one palette/role —
  // operators care about "how many colour groups did I declare?", not
  // "how many leaf colour tokens".
  const paletteCount = Object.keys(theme.color).length;
  lines.push(
    `  color: ${paletteCount} palette${paletteCount === 1 ? '' : 's'}/role${
      paletteCount === 1 ? '' : 's'
    }`,
  );

  const optional: string[] = [];
  if (theme.motion !== undefined) optional.push('motion');
  if (theme.accessibility !== undefined) optional.push('accessibility');
  if (theme.zIndex !== undefined) optional.push('zIndex');
  lines.push(
    optional.length === 0
      ? `  optional blocks: none`
      : `  optional blocks: ${optional.join(', ')}`,
  );
  return lines;
}
