/**
 * Tests for the server-level `instructions` preset resolver.
 */
import { describe, it, expect } from 'vitest';
import {
  MCP_INSTRUCTIONS_PRESETS,
  resolveMcpInstructions,
} from './instructions-presets.js';

describe('resolveMcpInstructions', () => {
  it('returns the DEFAULT preset when called with undefined (no-preset fallback)', () => {
    // Presets explain protocol mechanics now (vs nudging tool-use),
    // so the previous "aggressive as no-preset default" rationale no
    // longer applies — `'default'` is the appropriate baseline.
    expect(resolveMcpInstructions(undefined)).toBe(
      MCP_INSTRUCTIONS_PRESETS.default,
    );
  });

  it('returns the named preset string for each enum value', () => {
    expect(resolveMcpInstructions('default')).toBe(
      MCP_INSTRUCTIONS_PRESETS.default,
    );
    expect(resolveMcpInstructions('aggressive')).toBe(
      MCP_INSTRUCTIONS_PRESETS.aggressive,
    );
    expect(resolveMcpInstructions('always')).toBe(
      MCP_INSTRUCTIONS_PRESETS.always,
    );
    expect(resolveMcpInstructions('minimal')).toBe(
      MCP_INSTRUCTIONS_PRESETS.minimal,
    );
  });

  it("returns undefined for the 'off' preset", () => {
    expect(resolveMcpInstructions('off')).toBeUndefined();
  });

  it('passes through arbitrary custom strings verbatim', () => {
    const custom = 'Always render via ggui_render. No exceptions.';
    expect(resolveMcpInstructions(custom)).toBe(custom);
  });

  it('returns undefined for the empty string', () => {
    expect(resolveMcpInstructions('')).toBeUndefined();
  });

  it('default, aggressive, and always presets all name the core lifecycle tools', () => {
    // Without these names, the LLM has no anchor to the workflow
    // step the preset is describing. Catches accidental over-trim.
    for (const key of ['default', 'aggressive', 'always'] as const) {
      const text = MCP_INSTRUCTIONS_PRESETS[key];
      expect(text).toContain('ggui_handshake');
      expect(text).toContain('ggui_render');
      expect(text).toContain('ggui_update');
    }
  });

  it('all behavior-text presets explain the action contract', () => {
    // Protocol-focused framing: presets describe what the protocol
    // does, not what the LLM should do. The "actions route back
    // automatically" framing is the load-bearing line — if a future
    // edit drops it, an LLM reading just the preset has no signal
    // that rendered UIs are interactive (vs static markup).
    for (const key of ['default', 'aggressive', 'always'] as const) {
      const text = MCP_INSTRUCTIONS_PRESETS[key];
      expect(text).toMatch(/route back/);
    }
  });

  it('aggressive preset adds action-routing detail beyond default', () => {
    // The graduation default → aggressive → always is depth of
    // protocol explanation, not strength of behavioral nudge.
    //
    // Both default and aggressive name the four-spec contract surface
    // (propsSpec / streamSpec / actionSpec / contextSpec) so agents
    // reading either preset see the canonical authoring vocabulary.
    // The default → aggressive graduation lives in "Action routing:"
    // — the paragraph explaining how actionSpec dispatches map to
    // MCP tool calls (with Pattern α/β routing) — which aggressive
    // carries and default doesn't.
    expect(MCP_INSTRUCTIONS_PRESETS.aggressive).toContain('Action routing:');
    expect(MCP_INSTRUCTIONS_PRESETS.default).not.toContain('Action routing:');
    expect(MCP_INSTRUCTIONS_PRESETS.aggressive.length).toBeGreaterThan(
      MCP_INSTRUCTIONS_PRESETS.default.length,
    );
  });

  it('always preset adds a worked invocation example beyond aggressive', () => {
    // The graduation aggressive → always is "concrete example so the
    // LLM sees the handshake → push pattern at boot". The Example:
    // line is the load-bearing distinguishing feature.
    expect(MCP_INSTRUCTIONS_PRESETS.always).toContain('Example:');
    expect(MCP_INSTRUCTIONS_PRESETS.aggressive).not.toContain('Example:');
    expect(MCP_INSTRUCTIONS_PRESETS.always.length).toBeGreaterThan(
      MCP_INSTRUCTIONS_PRESETS.aggressive.length,
    );
  });

  it('rehydrated-gesture section teaches "renderId in user message → ggui_consume, not handshake"', () => {
    // Phase 2.0b experiment (#281): Gemini was reliably failing Step 4
    // (post-rehydration undo click) by calling ggui_handshake instead
    // of ggui_consume when the user message named a renderId. The fix
    // is a persistent-surface teaching: when the agent sees a
    // user-message-borne renderId, the first tool call is
    // ggui_consume on THAT id. Survives whether the directive is
    // synthesized agent-side (per-SDK bridge) OR client-side (hook).
    //
    // Lock the load-bearing wording so the section can't drift back
    // to weaker framing or get accidentally dropped.
    for (const key of ['default', 'aggressive', 'always'] as const) {
      const text = MCP_INSTRUCTIONS_PRESETS[key];
      expect(text).toContain('REHYDRATED USER GESTURES');
      expect(text).toMatch(/renderId.*identifies an EXISTING/);
      expect(text).toMatch(/REQUIRED first tool call: `ggui_consume/);
      expect(text).toMatch(/DO NOT call `ggui_handshake`/);
    }
  });

  it('no preset carries imperative behavior-nudge language', () => {
    // Audit caught us overclaiming earlier: server `instructions` is
    // a "hint" per MCP spec, not enforcement. Imperatives like
    // "render every response" / "do not describe" overpromise the
    // field's pull and don't observably help (user-side custom
    // instructions are the actual lever). If a future edit
    // reintroduces them, flag the regression.
    for (const key of ['default', 'aggressive', 'always'] as const) {
      const text = MCP_INSTRUCTIONS_PRESETS[key];
      expect(text).not.toMatch(/do not describe/i);
      expect(text).not.toMatch(/render every response/i);
      expect(text).not.toMatch(/default to rendering/i);
    }
  });
});
