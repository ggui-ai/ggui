/**
 * Canonical "Save button + note slot" contract — shared by the three
 * iframe-mount scenarios (01 submit-action, 02 PIPE_NOT_FOUND, 03
 * contextSnapshot). The wire surface each scenario asserts on is
 * orthogonal — one cares about the action drained from the pipe, one
 * cares about the fallthrough postMessage, one cares about the
 * contextSnapshot — but they all need the SAME rendered UI to drive
 * those assertions: a Save button that emits `save` on click.
 *
 * Sharing the contract means the OSS server's in-memory blueprint
 * registry exact-key-matches across the three. First scenario to render
 * cold-gens (real Anthropic, 10–60s). Scenarios 2 + 3 hit the
 * registry cache and complete in sub-second. Saves 2 cold-gens per
 * run; contains LLM flakiness to one cold path.
 *
 * If you change either field, EVERY consuming scenario reverts to
 * cold-gen until the new contract is re-cached — so consider whether
 * the change is worth the tax.
 *
 * Tested wire surface (across the three consumers):
 *
 *   - `actionSpec.save`     — click → submit_action → pipe append (01)
 *   - `actionSpec.save`     — click after pop → fallthrough (02)
 *   - `contextSpec.note`    — sync_context → consume bundles snap (03)
 *
 * Scenario 09 (A2UI streaming) uses a DIFFERENT, timestamped intent
 * so it always exercises the cold-gen path explicitly.
 */
export const SHARED_INTENT =
  'a single button labeled Save. no modal, no extra buttons, no input fields. clicking the button fires the save action immediately.';

export const SHARED_CONTRACT = {
  actionSpec: {
    save: {
      label: 'Save',
    },
  },
  contextSpec: {
    note: {
      schema: { type: 'string' },
      default: '',
    },
  },
} as const;
