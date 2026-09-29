/**
 * ggui#1536 — a tap the outbound contract check refused did nothing the
 * visitor could see. The runtime now draws the ordinary error toast, named by
 * the action's declared label (by contract the control's own copy), never by
 * the action's name or its data.
 *
 * The toast's wiring lives in `bootProduction`, which dynamic-imports the full
 * React graph and is too heavy to boot here (see boot-production-context's
 * note), so the call is pinned at the source.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { showRefusedDispatchToast } from '../runtime.js';

const toastEl = (): HTMLElement | null => document.getElementById('__ggui-action-toast__');

afterEach(() => {
  toastEl()?.remove();
});

describe('the refused-tap toast (ggui#1536)', () => {
  it('names a labelled tap by its label', () => {
    showRefusedDispatchToast('Book a call');
    expect(toastEl()?.textContent).toContain('⚠ Book a call — could not be sent');
  });

  it('says the same thing unnamed when the action declares no label', () => {
    showRefusedDispatchToast(undefined);
    expect(toastEl()?.textContent).toContain('⚠ Could not be sent');
  });

  it("bootProduction's wire config hands every refused dispatch to it, named by the declared label", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime.ts'), 'utf8');
    const call = source.indexOf('const rootConfig = buildRootWireConfig({');
    expect(call).toBeGreaterThan(-1);
    const end = source.indexOf('});', call);
    expect(source.slice(call, end).replace(/\s+/g, ' ')).toContain(
      'onDispatchRefused: (actionName) => showRefusedDispatchToast(declaredActionLabel(currentRender, actionName))',
    );
  });
});
