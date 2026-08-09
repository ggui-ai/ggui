import type { ArtifactKind } from './types.js';

export interface InstallCommandOptions {
  /**
   * Registry origin to pin via an explicit `--registry=<url>` flag —
   * pass the URL the artifact was discovered on (the same origin the
   * search/read endpoints were queried against). When provided, the
   * emitted command installs from exactly that registry instead of
   * whatever the CLI's ambient default resolves to; when omitted, the
   * flag is left off and the CLI default applies.
   */
  readonly registryHost?: string;
}

/**
 * Compose the canonical CLI install command for a published artifact:
 *
 *     ggui <kind> install <scope>/<name>@<version> [--registry=<url>]
 *
 * Same shape the publish flow reports back after a successful publish,
 * so every surface that displays an install command agrees on one
 * wording. Pure string composition — callers are responsible for
 * validating `artifactId` (`@scope/name`) and `version` (semver)
 * before display; this function does not re-validate.
 */
export function installCommand(
  kind: ArtifactKind,
  artifactId: string,
  version: string,
  opts: InstallCommandOptions = {},
): string {
  const registry =
    opts.registryHost !== undefined ? ` --registry=${opts.registryHost}` : '';
  return `ggui ${kind} install ${artifactId}@${version}${registry}`;
}
