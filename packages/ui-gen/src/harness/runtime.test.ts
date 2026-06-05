/**
 * Plugin slice 1.2.1 follow-up — pin the dispatch-boundary thread for
 * the `appGadgets` catalog through the `harness/runtime.ts`
 * `buildSystemPrompt` wrapper. Pre-this-commit the wrapper accepted
 * 4 positional args and never forwarded a catalog; downstream the
 * `boilerplate/system-prompt.ts` skeleton had `appGadgets` exposed
 * as a HOOK but no caller reached it. This pins that the wrapper now
 * threads the optional 5th positional arg into the skeleton.
 *
 * Coverage:
 *   - omit → defaults to STDLIB_GADGETS rendering (byte-
 *     identical to pre-1.2.1 dispatch behaviour for OSS callers that
 *     never resolved a catalog)
 *   - pass a registered Leaflet wrapper → table renders the row
 */
import { describe, expect, it } from "vitest";
import type { GadgetDescriptor } from "@ggui-ai/protocol";
import { buildSystemPrompt } from "./runtime.js";

const leaflet: GadgetDescriptor = {
  package: "@ggui-samples/gadget-leaflet",
  version: "0.0.1",
  exports: [
    {
      hook: "useLeafletMap",
      description: "GguiSession an interactive Leaflet map.",
      usage: "Mount when intent names a rendered map.",
    },
  ],
};

describe("buildSystemPrompt wrapper — appGadgets thread", () => {
  it("defaults to STDLIB rendering when appGadgets is omitted", () => {
    const prompt = buildSystemPrompt("show the user a counter");
    // STDLIB seed always carries useGeolocation; if the wrapper
    // forgot to forward, the prompt would have no library table at all.
    expect(prompt).toMatch(/\|\s*`useGeolocation`\s*\|/);
    expect(prompt).not.toMatch(/\|\s*`useLeafletMap`\s*\|/);
  });

  it("forwards a registered catalog to the skeleton", () => {
    const prompt = buildSystemPrompt(
      "show a map of the user's last 5 deliveries",
      undefined,
      undefined,
      undefined,
      [leaflet],
    );
    expect(prompt).toMatch(/\|\s*`useLeafletMap`\s*\|/);
    // When a catalog is provided, the STDLIB seed is REPLACED, not
    // merged — symmetric with `formatGadgetsSection`'s pin.
    expect(prompt).not.toMatch(/\|\s*`useGeolocation`\s*\|/);
  });
});
