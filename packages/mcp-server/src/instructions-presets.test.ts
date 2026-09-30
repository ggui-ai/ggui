/**
 * Tests for the server-level `instructions` preset resolver.
 */
import { describe, it, expect } from 'vitest';
import {
  MCP_INSTRUCTIONS_PRESETS,
  resolveMcpInstructions,
} from './instructions-presets.js';

describe('resolveMcpInstructions', () => {
  it('sends nothing when unset: the no-flag default is off (ggui#1579)', () => {
    // Until ggui#1579 no server's instructions reached a host (they rode the
    // wrong SDK argument), so the behaviour every host knows is "none". The
    // fix keeps that for an operator who set nothing; a preset is opt-in.
    expect(resolveMcpInstructions(undefined)).toBeUndefined();
    expect(resolveMcpInstructions(undefined)).toBe(resolveMcpInstructions('off'));
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
    // LLM sees the handshake → render pattern at boot". The Example:
    // line is the load-bearing distinguishing feature.
    expect(MCP_INSTRUCTIONS_PRESETS.always).toContain('Example:');
    expect(MCP_INSTRUCTIONS_PRESETS.aggressive).not.toContain('Example:');
    expect(MCP_INSTRUCTIONS_PRESETS.always.length).toBeGreaterThan(
      MCP_INSTRUCTIONS_PRESETS.aggressive.length,
    );
  });

  it('rehydrated-gesture section teaches "sessionId in user message → ggui_consume, not handshake"', () => {
    // Phase 2.0b experiment (#281): Gemini was reliably failing Step 4
    // (post-rehydration undo click) by calling ggui_handshake instead
    // of ggui_consume when the user message named a sessionId. The fix
    // is a persistent-surface teaching: when the agent sees a
    // user-message-borne sessionId, the first tool call is
    // ggui_consume on THAT id. Survives whether the directive is
    // synthesized agent-side (per-SDK bridge) OR client-side (hook).
    //
    // Lock the load-bearing wording so the section can't drift back
    // to weaker framing or get accidentally dropped.
    for (const key of ['default', 'aggressive', 'always'] as const) {
      const text = MCP_INSTRUCTIONS_PRESETS[key];
      expect(text).toContain('REHYDRATED USER GESTURES');
      expect(text).toMatch(/sessionId.*identifies an EXISTING/);
      expect(text).toMatch(/REQUIRED first tool call: `ggui_consume/);
      expect(text).toMatch(/DO NOT call `ggui_handshake`/);
    }
  });

  it('teaches the three-outcome render response (#786) in every protocol preset', () => {
    // This text ships on InitializeResult.instructions EVERY session,
    // so it is the most-read description of the render response we
    // publish. Since #786 the wire carries `outcome` first and the six
    // identity fields are present IFF something was committed — a
    // preset that still promises a `sessionId` unconditionally teaches
    // the agent to read a field a refusal does not carry.
    for (const key of ['default', 'aggressive', 'always'] as const) {
      const text = MCP_INSTRUCTIONS_PRESETS[key];
      expect(text).toMatch(/`outcome`/);
      expect(text).toMatch(/rendered.*failed.*refused/);
      // The refused arm's three load-bearing facts.
      expect(text).toMatch(/only `refusal`/);
      expect(text).toMatch(/handshake is NOT consumed/);
      // `fixBy` never travels on a refusal, so no preset may tell the agent to read it.
      expect(text).toContain('retry only once you have performed `refusal.fix` yourself');
      expect(text).not.toContain('fixBy');
    }
  });

  it('no preset promises the minted sessionId unconditionally (#786)', () => {
    // The pre-#786 wording ("response carries the minted `sessionId`" /
    // "Response includes the minted `sessionId`") is true only of a
    // RENDERED result. Pin the negative so it cannot drift back.
    for (const key of ['default', 'aggressive', 'always'] as const) {
      const text = MCP_INSTRUCTIONS_PRESETS[key];
      expect(text).not.toMatch(/response carries the minted `sessionId`/i);
      expect(text).not.toMatch(/Response includes the minted `sessionId`/i);
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

describe('the presets say what ggui_get_session returns — never "the session" (#817 audit)', () => {
  it('no preset promises get_session returns the session; contextSnapshot is named as what travels when the row has it', () => {
    for (const [name, text] of Object.entries(MCP_INSTRUCTIONS_PRESETS)) {
      expect(text, name).not.toMatch(/returns the session including/);
      if (text.includes('contextSnapshot')) {
        expect(text, name).toMatch(/contextSnapshot/);
        expect(text, name).toMatch(/ggui_get_session/);
      }
    }
  });
});

// ggui#1149 — the instructions preset ships on the wire to every host. A
// `docs/…` path is a monorepo-only location: on the public mirror and for
// every self-hoster it is a dead link. The rule the preset cites is stated
// inline; the citation must point at a public home or at nothing.
describe('instructions presets cite no monorepo-only docs/ path (ggui#1149)', () => {
  it('no preset body carries a docs/ repo path', () => {
    for (const [name, body] of Object.entries(MCP_INSTRUCTIONS_PRESETS)) {
      expect(body, `preset ${name}`).not.toMatch(/\bdocs\/(principles|development|plans|protocol)\//);
    }
  });
});

// ggui#1579 — the presets had never reached a host (the wiring dropped them),
// so nothing had exercised them, and an accuracy review found claims the
// shipped surface contradicts. Each false phrasing is pinned out; the true
// statement that replaced it is pinned in.
describe('the protocol presets state only what the shipped surface does (ggui#1579 accuracy review)', () => {
  const PROTOCOL_PRESETS = ['default', 'aggressive', 'always'] as const;
  it.each(PROTOCOL_PRESETS)('the %s preset carries none of the corrected claims', (name) => {
    const text = MCP_INSTRUCTIONS_PRESETS[name];
    for (const stale of [
      'actionData.nextStep', // the event carries `intent` + `actionData` (the payload); no nextStep on it
      'loop back to step 1 to render the response', // a gesture repaints the same card via ggui_amend
      'renderer URL', // render output carries sessionId + resourceUri; there is no URL to show
      'host-synthesized', // the card itself posts the doorbell message
      'cross_reference_unresolved', // no shipped path answers this code
      'Push sends', // there is no Push tool; ggui_render sends props
      "contractHash: '<hex>'", // not on the handshake response
      'silently never reach the agent', // an unconsumed gesture stays queued and the doorbell rings
      'fixBy', // never travels on a refusal
    ]) {
      expect(text, stale).not.toContain(stale);
    }
  });
  it.each(PROTOCOL_PRESETS)('the %s preset states the corrected facts', (name) => {
    const text = MCP_INSTRUCTIONS_PRESETS[name];
    expect(text).toContain('`intent` names the action');
    expect(text).toContain('show the result on the SAME card with `ggui_amend`');
    expect(text).toContain('(handshake → render → consume → amend)');
    expect(text).toContain('the `ai.ggui/userAction` doorbell');
    expect(text).toContain('there is no URL to show the user, so never invent one');
    expect(text).toContain('ggui_list_sessions, on servers that offer it');
  });
});


describe('the measured window stays inside 2,048 characters (ggui#1619)', () => {
  // Claude Code and Agent-SDK hosts show the model only the first 2,048
  // characters of `instructions`. reliability/017 and /018 measured what
  // that window does on those hosts: the rendering stance routes every turn
  // through ggui, and the propsSpec bullet is the props-shape guidance whose
  // absence (in a draft that pushed it out) came with refused renders. An
  // edit that moves either past the cut changes what those hosts read, so it
  // needs its own read first.
  const HOST_WINDOW = 2048;
  it.each(['default', 'aggressive', 'always'] as const)(
    '%s: the rendering stance and the whole propsSpec bullet end inside the window',
    (name) => {
      const text = MCP_INSTRUCTIONS_PRESETS[name];
      const stance = 'There is no plain-text reply path.';
      expect(text.indexOf(stance)).toBeGreaterThanOrEqual(0);
      expect(text.indexOf(stance) + stance.length).toBeLessThanOrEqual(HOST_WINDOW);
      const props = text.indexOf('  • propsSpec');
      expect(props).toBeGreaterThan(0);
      const propsEnd = text.indexOf('\n', props);
      expect(propsEnd).toBeGreaterThan(props);
      expect(propsEnd).toBeLessThanOrEqual(HOST_WINDOW);
    },
  );
});
