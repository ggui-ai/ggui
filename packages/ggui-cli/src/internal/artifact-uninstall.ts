/**
 * `ggui {gadget,blueprint} uninstall <scope/name>@<version>` — the
 * kind-discriminated reverse of `runArtifactInstall`, one branch per
 * install effect:
 *
 * - **blueprint** — removes
 *   `.ggui/installed-blueprints/<scope-bare>__<name>__<version>/`
 *   from the project root and — when this was the LAST remaining
 *   installed-blueprint subdir — strips the `INSTALLED_BLUEPRINTS_GLOB`
 *   entry from `ggui.json#blueprints.include` so a future `ggui serve`
 *   doesn't walk an empty glob.
 * - **gadget** — removes the PACKAGE's row from
 *   `ggui.json#app.gadgets` (the row `runArtifactInstall` appended).
 *   Rows are keyed by package — one row per package is the catalog
 *   invariant, and install replaces the row on a version change — so
 *   the supplied version does not gate the match; when it differs
 *   from the installed one, the actual removed version is reported.
 *   When it was the last row, the empty `gadgets` array is dropped
 *   too, keeping the manifest tidy. Nothing on disk to delete —
 *   gadget installs never materialize files.
 *
 * What this does NOT touch:
 *
 *   - **The runtime cache row.** The install-to-cache bridge is
 *     per-scope idempotent within a single server lifetime; the row
 *     stays in the `vectorStore` until the operator restarts
 *     `ggui serve`. Sqlite-backed stores survive restart too. A
 *     restart is the documented step to reclaim the cache slot.
 *   - **The marketplace registry.** Uninstall is purely local; the
 *     published artifact is unaffected. Registry-side withdrawal is a
 *     separate operation.
 *   - **`ggui.json#blueprints.include` entries that aren't the
 *     installed-blueprints glob.** Hand-authored UI globs survive
 *     verbatim; only the install-managed glob is auto-removed when
 *     no installed-blueprints subdirs remain.
 *
 * Posture: idempotent. Uninstalling a blueprint that was never
 * installed succeeds with exit code 0 and a stderr note — operators
 * shouldn't be punished for re-running the command.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  FIND_MAX_DEPTH,
  findGguiJson,
  readGguiJson,
  writeGguiJson,
  type GguiJsonObject,
} from './ggui-json.js';
import {
  blueprintInstallSubdir,
  INSTALLED_BLUEPRINTS_GLOB,
  INSTALLED_BLUEPRINTS_SUBDIR,
} from './artifact-install.js';
import type { ArtifactKind } from './artifact-install.js';

/* -------------------------------------------------------------------------- */
/* Help text                                                                  */
/* -------------------------------------------------------------------------- */

export function buildUninstallHelp(kind: ArtifactKind): string {
  const verb = `ggui ${kind} uninstall`;
  const behavior =
    kind === 'blueprint'
      ? `  - Removes \`.ggui/installed-blueprints/<scope-bare>__<name>__<version>/\` from disk.
  - When this was the LAST installed-blueprint subdir, strips the
    \`${INSTALLED_BLUEPRINTS_GLOB}\` entry from \`ggui.json#blueprints.include\`.
    Other globs in the include list are preserved verbatim.
  - Idempotent: uninstalling a never-installed identifier exits 0
    with a stderr note. Re-runs are safe.

Caveats:
  - The runtime cache row stays warm until the next \`ggui serve\` restart
    (the install-to-cache bridge is per-scope idempotent within a server
    lifetime). Restart to reclaim the cache slot.
  - This is local-only. The published marketplace artifact is unchanged.
`
      : `  - Removes the package's entry from \`ggui.json#app.gadgets\`
    (the entry install appended). Entries are keyed by package — if the
    installed version differs from the one you supply, the entry is
    still removed and the actual version is reported. When it was
    the last entry, the empty \`gadgets\` array is dropped too. Other
    entries are preserved verbatim.
  - Idempotent: uninstalling a never-installed identifier exits 0
    with a stderr note. Re-runs are safe.

Caveats:
  - This is local-only. The published marketplace artifact is unchanged.
`;
  return `${verb} — remove a marketplace-installed ${kind} from this project.

Usage:
  ${verb} <scope/name>@<version> [options]

Arguments:
  <scope/name>@<version>    Full install identifier. Same shape as install.

Options:
  --help                    Show this help.

Behavior:
${behavior}`;
}

/* -------------------------------------------------------------------------- */
/* Flag parsing                                                               */
/* -------------------------------------------------------------------------- */

export interface ParsedArtifactUninstallFlags {
  readonly kind: ArtifactKind;
  readonly artifactId: string;
  readonly version: string;
}

export type ParsedArtifactUninstall =
  | ParsedArtifactUninstallFlags
  | { readonly error: string };

export function parseArtifactUninstallFlags(
  kind: ArtifactKind,
  args: readonly string[],
): ParsedArtifactUninstall {
  let positional: string | undefined;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      return { error: '__help__' };
    }
    if (arg.startsWith('--')) {
      return { error: `unknown flag: ${arg}` };
    }
    if (positional === undefined) {
      positional = arg;
      continue;
    }
    return { error: `unexpected positional argument: ${arg}` };
  }
  if (positional === undefined) {
    return {
      error:
        'missing positional argument: <scope/name>@<version> (e.g. @my-org/notepad@1.0.0)',
    };
  }
  const lastAt = positional.lastIndexOf('@');
  if (lastAt <= 0) {
    return {
      error: `invalid uninstall identifier: ${positional} — expected <scope/name>@<version>`,
    };
  }
  const artifactId = positional.slice(0, lastAt);
  const version = positional.slice(lastAt + 1);
  if (!artifactId.startsWith('@') || artifactId.indexOf('/') === -1) {
    return {
      error: `invalid artifactId: ${artifactId} — expected \`@scope/name\``,
    };
  }
  if (version.length === 0) {
    return {
      error: `invalid version: empty (expected SemVer after \`@\`)`,
    };
  }
  return { kind, artifactId, version };
}

/* -------------------------------------------------------------------------- */
/* Runtime                                                                    */
/* -------------------------------------------------------------------------- */

export interface ArtifactUninstallDeps {
  readonly cwd: string;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
}

export interface ArtifactUninstallResult {
  readonly exitCode: number;
  /** `true` when something was actually removed (a blueprint's install
   * directory, or a gadget's `app.gadgets` row). `false` on idempotent
   * no-ops. */
  readonly removed: boolean;
  /**
   * Blueprint-only signal: `true` when `INSTALLED_BLUEPRINTS_GLOB` was
   * stripped from `ggui.json#blueprints.include` (i.e. no
   * installed-blueprints subdirs remained). `false` when the glob was
   * kept (other installs still on disk), wasn't present to begin with,
   * or the uninstall was a gadget (gadgets never touch the glob).
   */
  readonly globRemoved: boolean;
}

export async function runArtifactUninstall(
  flags: ParsedArtifactUninstallFlags,
  deps: ArtifactUninstallDeps,
): Promise<ArtifactUninstallResult> {
  const verb = `ggui ${flags.kind} uninstall`;
  const stdout = deps.stdout ?? ((s: string) => void process.stdout.write(s));
  const stderr = deps.stderr ?? ((s: string) => void process.stderr.write(s));

  const gguiPath = findGguiJson(deps.cwd);
  if (gguiPath === null) {
    stderr(
      `${verb}: no ggui.json found in ${deps.cwd} or any ancestor (up to ${FIND_MAX_DEPTH} levels).\n`,
    );
    return { exitCode: 2, removed: false, globRemoved: false };
  }
  const loaded = readGguiJson(gguiPath);
  if ('error' in loaded) {
    stderr(`${verb}: ${loaded.error}\n`);
    return { exitCode: 2, removed: false, globRemoved: false };
  }
  const gguiJson = loaded.value;

  // ---- gadget branch: remove the ggui.json#app.gadgets row ----
  // Gadget installs never materialize files; the whole install effect
  // is the package-keyed row `appendGadget` wrote. Reverse it: rows
  // are keyed by PACKAGE (one row per package is the catalog
  // invariant, and install replaces the row on a version change), so
  // uninstall matches by package alone — otherwise uninstalling the
  // originally-installed version after an upgrade would report
  // "nothing to remove" while the row is still live.
  if (flags.kind === 'gadget') {
    const rowRes = removeGadgetRow(gguiJson, flags.artifactId);
    if ('error' in rowRes) {
      stderr(`${verb}: ${rowRes.error}\n`);
      return { exitCode: 1, removed: false, globRemoved: false };
    }
    if (!rowRes.removed) {
      stderr(
        `${verb}: ${flags.artifactId} is not installed (no matching entry in ${gguiPath}#app.gadgets) — nothing to remove.\n`,
      );
      return { exitCode: 0, removed: false, globRemoved: false };
    }
    writeGguiJson(gguiPath, gguiJson);
    for (const v of rowRes.removedVersions) {
      stdout(
        `removed: ${flags.artifactId}@${v} from ggui.json#app.gadgets\n`,
      );
    }
    const mismatched = rowRes.removedVersions.filter(
      (v) => v !== flags.version,
    );
    if (mismatched.length > 0) {
      stdout(
        `note: you supplied @${flags.version}, but the installed version was ${mismatched.join(
          ', ',
        )} — gadget rows are keyed by package (one row per package), so the package's row was removed.\n`,
      );
    }
    stdout(`\nUninstall complete.\n`);
    return { exitCode: 0, removed: true, globRemoved: false };
  }

  // ---- blueprint branch: remove the materialized install directory ----
  // `dirname` (not a hand-rolled '/'-slice) so Windows paths resolve.
  const projectRoot = dirname(gguiPath);
  const scope = flags.artifactId.slice(1, flags.artifactId.indexOf('/'));
  const name = flags.artifactId.slice(flags.artifactId.indexOf('/') + 1);
  const subdir = blueprintInstallSubdir({
    scope: `@${scope}`,
    name,
    version: flags.version,
  });
  const installDir = join(projectRoot, INSTALLED_BLUEPRINTS_SUBDIR, subdir);

  let removed = false;
  if (existsSync(installDir)) {
    try {
      rmSync(installDir, { recursive: true, force: true });
      removed = true;
      stdout(`removed: ${installDir}\n`);
    } catch (err) {
      stderr(
        `${verb}: failed to remove ${installDir}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      return { exitCode: 1, removed: false, globRemoved: false };
    }
  } else {
    stderr(
      `${verb}: ${flags.artifactId}@${flags.version} is not installed at ${installDir} — nothing to remove.\n`,
    );
  }

  // Auto-cleanup of the include glob: only when zero installed-
  // blueprint subdirs remain. The base directory's continued existence
  // doesn't matter — we walk it for a non-empty subdir list (the
  // INSTALLED_BLUEPRINTS_GLOB matches `<subdir>/ggui.ui.json`, so the
  // absence of any subdir means the glob matches nothing).
  const installRoot = join(projectRoot, INSTALLED_BLUEPRINTS_SUBDIR);
  let remainingSubdirs = 0;
  if (existsSync(installRoot)) {
    try {
      remainingSubdirs = readdirSync(installRoot, { withFileTypes: true }).filter(
        (e) => e.isDirectory(),
      ).length;
    } catch {
      // If we can't enumerate the dir, leave the glob alone — better
      // than risk-stripping an include the operator still relies on.
      remainingSubdirs = Number.POSITIVE_INFINITY;
    }
  }

  let globRemoved = false;
  if (remainingSubdirs === 0) {
    if (removeBlueprintGlob(gguiJson)) {
      writeGguiJson(gguiPath, gguiJson);
      globRemoved = true;
      stdout(
        `removed glob from ggui.json#blueprints.include (no installed blueprints remain)\n`,
      );
    }
  }

  if (removed || globRemoved) {
    stdout(`\nUninstall complete.\n`);
  }
  return { exitCode: 0, removed, globRemoved };
}

/**
 * Remove every row of `artifactId`'s PACKAGE from
 * `ggui.json#app.gadgets`. Exact reverse of the append: rows are keyed
 * by package (one row per package is the catalog invariant, and
 * install replaces the row on any version change), so the supplied
 * version is NOT part of the match — uninstalling with a stale version
 * still removes the package's row; the caller reports the versions
 * that actually went away. Install keeps the catalog at one row per
 * package, but hand-edited manifests can carry duplicates — uninstall
 * removes ALL matches so "Uninstall complete" is never a half-truth.
 * When the removal empties the array, the `gadgets` key is dropped so
 * the manifest stays tidy (mirrors the blueprint branch's last-install
 * glob cleanup).
 *
 * Structural errors (`app` / `app.gadgets` present but wrong-shaped)
 * surface as `{ error }`; a missing block is simply "not installed".
 */
function removeGadgetRow(
  gguiJson: GguiJsonObject,
  artifactId: string,
):
  | { removed: boolean; removedVersions: string[] }
  | { error: string } {
  const app = gguiJson['app'];
  if (app === undefined) return { removed: false, removedVersions: [] };
  if (typeof app !== 'object' || app === null || Array.isArray(app)) {
    return { error: 'ggui.json#app must be an object' };
  }
  const appObj = app as GguiJsonObject;
  const gadgets = appObj['gadgets'];
  if (gadgets === undefined) return { removed: false, removedVersions: [] };
  if (!Array.isArray(gadgets)) {
    return { error: 'ggui.json#app.gadgets must be an array' };
  }
  const removedVersions: string[] = [];
  const remaining = gadgets.filter((e: unknown) => {
    if (e === null || typeof e !== 'object') return true;
    const cand = e as { package?: unknown; version?: unknown };
    if (cand.package !== artifactId) return true;
    removedVersions.push(
      typeof cand.version === 'string' ? cand.version : '(unknown)',
    );
    return false;
  });
  if (remaining.length === gadgets.length) {
    return { removed: false, removedVersions: [] };
  }
  if (remaining.length === 0) {
    delete appObj['gadgets'];
  } else {
    appObj['gadgets'] = remaining;
  }
  return { removed: true, removedVersions };
}

/**
 * Strip `INSTALLED_BLUEPRINTS_GLOB` from `gguiJson.blueprints.include`
 * when present. Returns `true` when a write is needed. Leaves the
 * `blueprints` block intact when it still contains other include
 * entries — operator-authored UI globs are preserved.
 */
function removeBlueprintGlob(gguiJson: GguiJsonObject): boolean {
  const blueprints = gguiJson['blueprints'];
  if (
    blueprints === undefined ||
    typeof blueprints !== 'object' ||
    blueprints === null ||
    Array.isArray(blueprints)
  ) {
    return false;
  }
  const blueprintsObj = blueprints as GguiJsonObject;
  const include = blueprintsObj['include'];
  if (!Array.isArray(include)) return false;
  const idx = include.indexOf(INSTALLED_BLUEPRINTS_GLOB);
  if (idx === -1) return false;
  include.splice(idx, 1);
  // When the include list is now empty AND no other blueprints-block
  // fields are present, remove the whole block so the manifest stays
  // tidy. Operator-edited blueprints blocks with additional fields
  // survive — we only touch the install-managed glob.
  if (include.length === 0 && Object.keys(blueprintsObj).length === 1) {
    delete gguiJson['blueprints'];
  }
  return true;
}
