/**
 * The display-mode vocabulary this package DECLARES is EQUAL to the spec's
 * (ggui#847). `@modelcontextprotocol/ext-apps` is a devDependency here for
 * exactly this pin: a widening or narrowing of the spec's `McpUiDisplayMode`
 * at the next ext-apps bump is a compile error on this line, never a silent
 * drift between what the protocol accepts on the wire and what hosts speak.
 *
 * `Equal` is the conditional-type identity test (two generic function types
 * are assignable iff their checked types are identical), NOT mutual
 * assignability — readonly and optionality differences pass assignability
 * both ways and would pass a weaker pin. The negative control below keeps the
 * test itself honest: a strict subset of the union reads `false`.
 *
 * A `.test-d.ts` file is checked by the package's `tsc --noEmit` (and the
 * full-repo typecheck) and excluded from the published tarball (`files`).
 */
import type { McpUiDisplayMode as ExtAppsMcpUiDisplayMode } from '@modelcontextprotocol/ext-apps';
import type { McpUiDisplayMode } from './host-context.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The pin: protocol's `McpUiDisplayMode` is identical to ext-apps' `McpUiDisplayMode`. */
export const MCP_UI_DISPLAY_MODE_EQUALS_EXT_APPS: Equal<McpUiDisplayMode, ExtAppsMcpUiDisplayMode> = true;

/** Control: a strict subset of the vocabulary is NOT equal — the test can fail. */
export const MCP_UI_DISPLAY_MODE_SUBSET_IS_NOT_EQUAL: Equal<McpUiDisplayMode, 'inline' | 'fullscreen'> = false;
