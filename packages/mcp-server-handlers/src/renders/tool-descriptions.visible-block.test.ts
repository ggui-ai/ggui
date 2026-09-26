/**
 * The model-visible block of a tool description (ggui#1417).
 *
 * The Claude Code CLI bundled in the Agent SDK caps every MCP tool
 * description at `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH ?? 2048`
 * characters (JS string length) and appends `… [truncated]` before the
 * first model request — silently, with no log. OpenAI Agents SDK and
 * Google ADK hosts pass the full text. So on every Claude Code host of a
 * ggui server the model reads only the first 2048 characters of each
 * description, and an obligation placed past that boundary is an
 * obligation the model never sees.
 *
 * This test pins, for the three tools whose descriptions exceed the cap,
 * that every OBLIGATION — the sentence a host must see for the loop to
 * work — starts inside the visible block. Guidance may follow it; a rule
 * may not. A future edit that pushes a rule past the boundary fails here,
 * naming the rule and its offset.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryGguiSessionStore,
  InMemoryKeyValueStore,
  InMemoryPendingEventConsumer,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiConsumeHandler } from './consume.js';
import { createGguiHandshakeHandler } from './handshake.js';
import { createGguiRenderHandler } from './render.js';

/**
 * The cap the Claude Code CLI applies (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`'s
 * default, measured on `@anthropic-ai/claude-agent-sdk` 0.3.282, ggui#1417).
 * A host may raise it; a server cannot rely on that.
 */
export const MODEL_VISIBLE_DESCRIPTION_CHARS = 2048;

const store = new InMemoryGguiSessionStore();
const consumer = new InMemoryPendingEventConsumer();

/**
 * Obligation anchors per tool — the operative SENTENCES (or their tails).
 * Each must fit WHOLE inside the visible block: a rule that starts inside
 * and is cut mid-clause reads as a stub, which is the failure this test
 * exists to catch (a review found 'OVERRIDE (P… [truncated]').
 */
const OBLIGATIONS: Record<string, { readonly build: () => string; readonly anchors: readonly string[] }> = {
  ggui_render: {
    build: () => createGguiRenderHandler({ renderStore: store }).description,
    anchors: [
      "PREREQUISITE: call ggui_handshake({intent, blueprintDraft}) FIRST.",
      "CLOSED at every level (top-level props AND the items/objects inside them)",
      "fails the render.",
      "so recovery starts at a fresh ggui_handshake.",
      "{code, message, fix, retry, handshake: 'intact'}",
      "a `later` refusal retries after the delay it names",
      "NEVER re-render to mutate",
      "only handshake_not_found forces a re-handshake.",
    ],
  },
  ggui_handshake: {
    build: () => createGguiHandshakeHandler({ kvStore: new InMemoryKeyValueStore() }).description,
    anchors: [
      "never the end user.",
      "call ggui_handshake again with forceCreate: true instead of rendering it.",
      "do NOT re-call ggui_handshake in a loop hoping for a different origin.",
      "handshake once more.",
      "OMIT `serverInfo` \u2014 never invent a name.",
      "MUST name a tool declared in `agentCapabilities.tools`",
      "`toolInfo` with its `inputSchema` is REQUIRED",
      "OMIT `override` to ACCEPT the proposed contract",
      "Then ggui_consume \u2192 react \u2192 repeat.",
    ],
  },
  ggui_consume: {
    build: () => createGguiConsumeHandler({ pendingEventConsumer: consumer, renderStore: store }).description,
    anchors: [
      "DO NOT skip the consume",
      "THE LOOP",
      "your reaction MUST include `ggui_amend` before re-consuming",
      "the default move in this loop",
      "two DISTINCT ids are two real gestures.",
    ],
  },
};

describe('tool descriptions — every obligation starts inside the model-visible block (ggui#1417)', () => {
  for (const [tool, { build, anchors }] of Object.entries(OBLIGATIONS)) {
    it(`${tool}: each obligation sentence is present and ends inside the first ${MODEL_VISIBLE_DESCRIPTION_CHARS} characters`, () => {
      const description = build();
      const late = anchors
        .map((anchor) => ({ anchor, at: description.indexOf(anchor) }))
        .filter(({ anchor, at }) => at < 0 || at + anchor.length > MODEL_VISIBLE_DESCRIPTION_CHARS);
      expect(late, `${tool} (${description.length} chars): ${late.map(({ anchor, at }) => `${JSON.stringify(anchor)} at ${at}`).join('; ')}`).toEqual([]);
    });
  }
});
