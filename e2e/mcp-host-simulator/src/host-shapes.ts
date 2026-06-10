/**
 * Host-shape presets — pre-configured `HostSimulatorOptions`
 * partials for each MCP-Apps-aware host we know about. Tests use
 * these to keep `clientInfo` consistent + as a centralized
 * breadcrumb for known host-quirks documented in
 * `docs/development/mcp-apps-submit-action-bridge.md`.
 *
 * No server-side branching exists today on `clientInfo.name` —
 * every host walks the same MCP+OAuth+App-spec wire. The presets
 * are documentation-grade ergonomics, not behavioral. If a future
 * server release ever switches on `clientInfo.name`, the test
 * matrix can fan out by passing all three shapes through the
 * same scenario without touching call sites.
 *
 * The version pins are best-known-as-of-2026-05; bump when
 * empirical findings drift.
 */
import type { HostSimulatorOptions } from './host-simulator.js';

export type HostShapeName = 'claude-ai' | 'claude-desktop' | 'goose';

export interface HostShape extends Pick<HostSimulatorOptions, 'clientInfo'> {
  /** Stable identifier for switch-statements + telemetry. */
  readonly shape: HostShapeName;
}

/**
 * **claude.ai (web)** — the canonical MCP-Apps host the protocol
 * probe was validated against.
 *
 * Known empirical quirks (covered by simulator builders, no
 * preset-level branching needed):
 *   - `ui/message` / `ui/update-model-context` `content` MUST be
 *     `ContentBlock[]` (array). Single-object shape from the spec
 *     example is rejected by claude.ai's validator.
 *   - `tools/call` from a view scope `['app']` ONLY reaches the
 *     server, NEVER the LLM (host-side prompt-injection firewall
 *     per spec §401). The 3-message submit-action bridge exists
 *     because of this.
 *   - On `tools/list` claude.ai pre-fetches every declared
 *     `_meta.ui.resourceUri` — lazy fetch on first call is wrong.
 */
export function claudeAiShape(): HostShape {
  return {
    shape: 'claude-ai',
    clientInfo: { name: 'claude-ai', version: '2026.05' },
  };
}

/**
 * **Claude Desktop** — the macOS / Windows MCP host. Wire shape is
 * essentially identical to claude.ai; uses Streamable HTTP for
 * remote MCP (and stdio for local servers, which the simulator
 * doesn't model).
 */
export function claudeDesktopShape(): HostShape {
  return {
    shape: 'claude-desktop',
    clientInfo: { name: 'claude-desktop', version: '2026.05' },
  };
}

/**
 * **Goose** — Block's open-source MCP host. Less battle-tested than
 * claude.ai for App-spec; treat assertion failures here as
 * informational until the probe card is run against a real Goose
 * release.
 */
export function gooseShape(): HostShape {
  return {
    shape: 'goose',
    clientInfo: { name: 'goose', version: '1.0' },
  };
}

/** Iterate every shape — useful for parameterized vitest matrices. */
export const ALL_HOST_SHAPES: ReadonlyArray<() => HostShape> = [
  claudeAiShape,
  claudeDesktopShape,
  gooseShape,
];
