// packages/ui-gen/src/fragments/choice.ts
//
// Choice-axis fragments (ggui#2010). `offered-items` carries a header only; the props it teaches are appended from
// REVEALED_PROPS (fragments/index.ts), so their text has one home: the design source's docblock.

import type { HarnessFragment } from "./types.js";

export const choiceFragments: Record<string, HarnessFragment> = {
  none: {
    axis: "choice",
    value: "none",
    cacheTier: "axisDelta",
  },
  "offered-items": {
    axis: "choice",
    value: "offered-items",
    cacheTier: "axisDelta",
    promptText: "## Choice: offered items\nThe visitor chooses one of the items this contract offers.",
  },
};
