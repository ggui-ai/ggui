/**
 * ggui#2010 — the no-truncate pin, as an in-page expression the visual evaluator runs on every capture and this
 * package's Chromium tests read back. A dependency-free module, so `@ggui-ai/ui-gen` imports it without the
 * Playwright half of this package (the same shape as `./prime-inputs`).
 *
 * Every shown control (a `button`, or `role="button"`) under `#root` whose label a visitor cannot read whole:
 * - the control, or any element inside it, ends its text in an ellipsis over content wider than its box;
 * - the control's own overflow clips content wider or taller than its box;
 * - an ancestor that clips (`overflow: hidden` or `clip`, up to `#root`) cuts the control's box: a chip crossing its
 *   group's bottom edge, the cropped-chip failure (guuey#1487). A scrolling ancestor does not count: a visitor
 *   scrolls to what it holds.
 * 1 px is rounding. A quick-reply chip's label is the bound suggestion verbatim, so a cut label breaks the bind.
 * Evaluates to up to eight labels (60 characters each), `[]` when every control reads whole.
 */
export const TRUNCATED_CONTROLS_EXPRESSION =
  "(() => { const out = []; const over = (el) => el.scrollWidth > el.clientWidth + 1; " +
  "for (const c of document.querySelectorAll('#root button, #root [role=\"button\"]')) { " +
  "const cs = getComputedStyle(c); if (cs.display === 'none' || cs.visibility === 'hidden' || c.getClientRects().length === 0) continue; " +
  "const clipped = (cs.overflowX !== 'visible' && over(c)) || (cs.overflowY !== 'visible' && c.scrollHeight > c.clientHeight + 1); " +
  "const ellipsis = [c, ...c.querySelectorAll('*')].some((el) => getComputedStyle(el).textOverflow === 'ellipsis' && over(el)); " +
  "const root = document.getElementById('root'); const b = c.getBoundingClientRect(); let cut = false; " +
  "for (let a = c.parentElement; a !== null && !cut; a = a === root ? null : a.parentElement) { " +
  "const s = getComputedStyle(a); const clipsX = s.overflowX === 'hidden' || s.overflowX === 'clip'; " +
  "const clipsY = s.overflowY === 'hidden' || s.overflowY === 'clip'; if (!clipsX && !clipsY) continue; " +
  "const r = a.getBoundingClientRect(); " +
  "cut = (clipsX && (b.left < r.left - 1 || b.right > r.right + 1)) || (clipsY && (b.top < r.top - 1 || b.bottom > r.bottom + 1)); } " +
  "if (clipped || ellipsis || cut) out.push((c.textContent || '').trim().slice(0, 60)); } return out.slice(0, 8); })()";
