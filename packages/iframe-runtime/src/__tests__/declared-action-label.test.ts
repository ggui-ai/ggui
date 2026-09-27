/**
 * ggui#1444 — a tap is named to a visitor by the action's declared `label`
 * (the control's own copy), never by its action name. These pin the lookup
 * the boot path uses, and that the boot path's dispatch threads it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ActionSpec, GguiSession } from '@ggui-ai/protocol';
import { declaredActionLabel } from '../runtime.js';

function render(actionSpec: ActionSpec | undefined): GguiSession {
  return {
    id: 'r_1444',
    appId: 'app_x',
    componentCode: '/* unused */',
    description: 'a card with a chip',
    eventSequence: 0,
    createdAt: 0,
    lastActivityAt: 0,
    expiresAt: 60_000,
    ...(actionSpec !== undefined ? { actionSpec } : {}),
  };
}

describe('declaredActionLabel (ggui#1444)', () => {
  it("returns the action's declared label, trimmed", () => {
    expect(declaredActionLabel(render({ chooseReply: { label: '  See pricing ' } }), 'chooseReply')).toBe('See pricing');
  });

  it('returns undefined for a blank label, an undeclared action, or a render with no actionSpec', () => {
    expect(declaredActionLabel(render({ chooseReply: { label: '   ' } }), 'chooseReply')).toBeUndefined();
    expect(declaredActionLabel(render({ other: { label: 'Other' } }), 'chooseReply')).toBeUndefined();
    expect(declaredActionLabel(render(undefined), 'chooseReply')).toBeUndefined();
  });

  it('returns undefined before any render is mounted', () => {
    expect(declaredActionLabel(null, 'chooseReply')).toBeUndefined();
  });

  it("the boot path's dispatch resolves the label from the current render and threads it", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '..', 'runtime.ts'), 'utf8');
    expect(src).toContain('const label = declaredActionLabel(currentRender, payload.action);');
    const call = src.slice(src.indexOf('const label = declaredActionLabel(currentRender, payload.action);'));
    expect(call.slice(0, 600)).toContain('...(label !== undefined ? { label } : {}),');
  });
});
