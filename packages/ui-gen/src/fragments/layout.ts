// packages/ui-gen/src/fragments/layout.ts
//
// Layout-axis fragments. Structural composition — how the screen is split.

import type { HarnessFragment } from "./types.js";

export const layoutFragments: Record<string, HarnessFragment> = {
  single: {
    axis: "layout",
    value: "single",
    cacheTier: "axisDelta",
  },
  "multi-step": {
    axis: "layout",
    value: "multi-step",
    cacheTier: "axisDelta",
    // 2026-04-27: anti-pattern warnings added after 6× n=3 benches showed
    // survey-form + onboarding-wizard accounted for 9 of 11 probe FAILs
    // ("Too many re-renders" 6×, "function is not iterable" 2×, TDZ 1×).
    // All 3 classes trace to the same multi-step-specific anti-patterns
    // below; non-multi-step fixtures had 0 fails across the same benches.
    promptText:
      "## Layout: multi-step\n" +
      "Wizard. Track `step` in useState (0-indexed). Render a progress " +
      "indicator (e.g., '2 of 4') and Next/Back buttons. Keep all step " +
      "state in a single payload object; do NOT reset previous-step data " +
      "on navigation.\n\n" +
      "### Anti-patterns that crash at runtime — DO NOT do these:\n\n" +
      "1. **No setState in render body** — causes 'Too many re-renders'.\n" +
      "```tsx\n" +
      "// ❌ WRONG — fires every render, infinite loop\n" +
      "const Form = () => {\n" +
      "  const [errors, setErrors] = useState({});\n" +
      "  setErrors(validate(values));  // setState in render → loop\n" +
      "};\n" +
      "// ✅ RIGHT — derive with useMemo (no state)\n" +
      "const Form = () => {\n" +
      "  const errors = useMemo(() => validate(values), [values]);\n" +
      "};\n" +
      "```\n\n" +
      "2. **No setState in useEffect with state-derived deps** — also " +
      "causes 'Too many re-renders'.\n" +
      "```tsx\n" +
      "// ❌ WRONG — payload identity changes → setIsValid → re-render → ...\n" +
      "useEffect(() => { setIsValid(check(payload)); }, [payload]);\n" +
      "// ✅ RIGHT — useMemo, no setState\n" +
      "const isValid = useMemo(() => check(payload), [payload]);\n" +
      "```\n\n" +
      "3. **Declare `steps` array as a top-level `const`, NEVER state.** " +
      "Default arrays (`fields`, `options`) the same way. Iterating over " +
      "an undefined or unstable array throws 'function is not iterable'.\n" +
      "```tsx\n" +
      "// ❌ WRONG — useState('steps array...') is a string, .map crashes\n" +
      "const [steps] = useState('Welcome,Profile,Done');\n" +
      "// ✅ RIGHT — top-level const\n" +
      "const STEPS = ['Welcome', 'Profile', 'Done'] as const;\n" +
      "```\n\n" +
      "4. **Hooks/`const` declarations come BEFORE any useEffect/" +
      "useMemo/useCallback that reads them.** Otherwise: TDZ 'Cannot " +
      "access X before initialization'.\n" +
      "```tsx\n" +
      "// ❌ WRONG — useEffect reads `total` before its `const` line\n" +
      "useEffect(() => log(total), [total]);\n" +
      "const total = items.reduce(sum, 0);\n" +
      "// ✅ RIGHT — declare first, read after\n" +
      "const total = items.reduce(sum, 0);\n" +
      "useEffect(() => log(total), [total]);\n" +
      "```",
  },
  "master-detail": {
    axis: "layout",
    value: "master-detail",
    cacheTier: "axisDelta",
    promptText:
      "## Layout: master-detail\nSplit container: master list on the left/top, detail panel on the right/bottom. Track `selectedId` and show a 'select an item' placeholder in the detail panel when null.",
  },
  overlay: {
    axis: "layout",
    value: "overlay",
    cacheTier: "axisDelta",
    promptText:
      "## Layout: overlay\nFloating controls layered on top of content. Use position: absolute with explicit insets. Ensure the overlay does not block critical content (leave a safe area).",
  },
  modal: {
    axis: "layout",
    value: "modal",
    cacheTier: "axisDelta",
    promptText:
      "## Layout: modal\nUse the <Modal> primitive. Track `isOpen` in useState. Provide a clear close affordance (X button + clicking backdrop). Trap focus inside the modal.",
  },
};
