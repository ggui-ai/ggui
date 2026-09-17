// oss/packages/ui-visual-tester/src/prime-inputs.ts
//
// Shared input-priming for the "generic minimum a user does before pressing
// Send / Submit / Complete" (#1021), incl. the #1040 relative-to-now date rule.
// Extracted from fixture-runtime.ts so BOTH the Playwright fixture runtime and
// the ui-gen runtime-render action-wiring probe (ggui#1187) prime inputs the
// SAME way — one typed-values table, no divergence. Pure DOM + Date only (no
// Playwright), so it is safe to import into the lightweight happy-dom check
// worker via the `@ggui-ai/ui-visual-tester/prime-inputs` subpath.

// #1040: date-like types too — a wizard's first step is routinely gated on one ("preferred follow-up
// date"), and a Next that never enables hides every step behind it from the probe.
const TEXT_LIKE_INPUT_TYPES = new Set([
  'text', 'email', 'search', 'url', 'tel', 'number', 'password', '',
  'date', 'time', 'month', 'week', 'datetime-local',
]);

/**
 * #1040: dates are primed RELATIVE TO NOW — a form routinely refuses a date in the past
 * ("preferred follow-up date"), and a constant sample date is a past date. Thirty days out,
 * clamped into the input's own [min, max] when those are set in the input's format (ISO
 * strings compare lexically). Time-of-day values have no past to fall into.
 */
const pad2 = (n: number): string => String(n).padStart(2, '0');
type DateParts = { readonly y: number; readonly m: number; readonly d: number };
const partsOf = (at: Date): DateParts => ({ y: at.getFullYear(), m: at.getMonth() + 1, d: at.getDate() });
/** Today and thirty days out, as the parts a date-like value is built from. */
function todayAndThirtyDaysOut(): { readonly today: DateParts; readonly later: DateParts } {
  const now = new Date();
  const at = new Date(now);
  at.setDate(at.getDate() + 30);
  return { today: partsOf(now), later: partsOf(at) };
}
/**
 * Clamp a value into the input's [min, max] when each is set in the input's own format
 * (ISO-shaped strings compare lexically). `min` later than the value wins; `max` earlier than
 * the value wins only while it is not before `floor` (today in the same format) — a max in
 * the past is a form that can never be satisfied, and the probe reports that as it is.
 */
function clampToRange(el: HTMLInputElement, value: string, floor: string, format: RegExp): string {
  let out = value;
  if (format.test(el.min) && el.min > out) out = el.min;
  if (format.test(el.max) && el.max < out && el.max >= floor) out = el.max;
  return out;
}
function isoWeekOf(y: number, m: number, d: number): string {
  // ISO-8601 week: Thursday of the same week decides the year.
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const jan1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - jan1.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad2(week)}`;
}
export function sampleValueFor(el: HTMLInputElement | HTMLTextAreaElement): string {
  if (!(el instanceof HTMLInputElement)) return 'probe'; // a textarea has no type to switch on
  switch (el.type) {
    case 'number':
      return '1';
    case 'email':
      return 'probe@example.com';
    case 'url':
      return 'https://example.com';
    case 'tel':
      return '5550100';
    case 'date': {
      const { today, later } = todayAndThirtyDaysOut();
      const iso = (p: DateParts): string => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
      return clampToRange(el, iso(later), iso(today), /^\d{4}-\d{2}-\d{2}$/);
    }
    case 'time':
      return '09:30';
    case 'month': {
      const { today, later } = todayAndThirtyDaysOut();
      const ym = (p: DateParts): string => `${p.y}-${pad2(p.m)}`;
      return clampToRange(el, ym(later), ym(today), /^\d{4}-\d{2}$/);
    }
    case 'week': {
      const { today, later } = todayAndThirtyDaysOut();
      return clampToRange(el, isoWeekOf(later.y, later.m, later.d), isoWeekOf(today.y, today.m, today.d), /^\d{4}-W\d{2}$/);
    }
    case 'datetime-local': {
      const { today, later } = todayAndThirtyDaysOut();
      const at = (p: DateParts, hm: string): string => `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${hm}`;
      return clampToRange(el, at(later, '09:30'), at(today, '00:00'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    }
    default:
      return 'probe';
  }
}

/** Set a value the way React notices it: through the prototype's native setter, then an input + change event. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * The generic minimum a user does before pressing Send / Submit / Complete
 * (#1021): give every empty text-like input and textarea a value, every
 * unset select its first real option, every unchecked radio group its first
 * radio. Checkboxes are never touched — they are often the action itself.
 * Returns how many controls were primed.
 */
export function primeInputs(root: HTMLElement): number {
  let primed = 0;
  const editable = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean =>
    !el.disabled && !(el instanceof HTMLSelectElement) ? !(el as HTMLInputElement | HTMLTextAreaElement).readOnly : !el.disabled;
  for (const el of Array.from(root.querySelectorAll('input, textarea'))) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !editable(el)) continue;
    if (el instanceof HTMLInputElement && !TEXT_LIKE_INPUT_TYPES.has(el.type)) continue;
    if (el.value.trim().length > 0) continue;
    setNativeValue(el, sampleValueFor(el));
    if (el.value.trim().length > 0) primed += 1;
  }
  for (const el of Array.from(root.querySelectorAll('select'))) {
    if (!(el instanceof HTMLSelectElement) || el.disabled) continue;
    const current = el.options[el.selectedIndex];
    if (current !== undefined && current.value.trim().length > 0) continue;
    const first = Array.from(el.options).find((o) => o.value.trim().length > 0 && !o.disabled);
    if (first === undefined) continue;
    setNativeValue(el, first.value);
    primed += 1;
  }
  const seenGroups = new Set<string>();
  for (const el of Array.from(root.querySelectorAll('input[type="radio"]'))) {
    if (!(el instanceof HTMLInputElement) || el.disabled) continue;
    const group = el.name || '';
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    const members = group
      ? Array.from(root.querySelectorAll(`input[type="radio"][name="${CSS.escape(group)}"]`)).filter((m): m is HTMLInputElement => m instanceof HTMLInputElement)
      : [el];
    if (members.some((m) => m.checked)) continue;
    const first = members.find((m) => !m.disabled);
    if (first === undefined) continue;
    first.click();
    primed += 1;
  }
  return primed;
}
