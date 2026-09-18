// ggui#1187 follow-up — `primeInputs` must resolve element constructors and
// Event from the ROOT'S OWN realm (`ownerDocument.defaultView`), never from
// ambient globals: the check worker installs happy-dom's `window`/`document`
// on `globalThis` without `HTMLInputElement` & co., and a `ReferenceError`
// there was what the swallowed catch hid. Node environment on purpose — the
// happy-dom window below is NOT on `globalThis`.

import { describe, it, expect } from "vitest";
import { Window } from "happy-dom";
import { primeInputs } from "@ggui-ai/ui-visual-tester/prime-inputs";

/**
 * happy-dom's element classes are not the lib.dom types `primeInputs` is
 * declared against (its `HTMLBodyElement` lacks ~130 lib.dom members in the
 * type system while carrying the DOM surface at runtime). Cross the seam the
 * way the check's own host boundary does (`toMinimalElement`): a runtime
 * check of the surface actually used, then one narrowing.
 */
function domRoot(v: unknown): HTMLElement {
  if (
    typeof v === "object" &&
    v !== null &&
    "ownerDocument" in v &&
    typeof (v as { querySelectorAll?: unknown }).querySelectorAll === "function"
  ) {
    return v as HTMLElement;
  }
  throw new Error("test root lacks the element surface (ownerDocument/querySelectorAll)");
}

describe("primeInputs — realm independence (ggui#1187)", () => {
  it("primes text inputs, textareas, selects and radios of a window that is not on globalThis", () => {
    expect(typeof (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement, "precondition: no DOM globals").toBe("undefined");
    const win = new Window({ url: "https://prime-inputs.local" });
    const doc = win.document;
    doc.body.innerHTML = `
      <input aria-label="message" placeholder="Type a message" />
      <textarea aria-label="notes"></textarea>
      <select aria-label="size"><option value="">Pick</option><option value="m">M</option></select>
      <label><input type="radio" name="plan" value="a" /> A</label>
      <label><input type="radio" name="plan" value="b" /> B</label>
      <input type="checkbox" aria-label="agree" />
    `;
    const primed = primeInputs(domRoot(doc.body));
    expect(primed).toBe(4);

    const message = doc.querySelector('input[aria-label="message"]');
    expect(message instanceof win.HTMLInputElement && message.value).toBe("probe");
    const notes = doc.querySelector("textarea");
    expect(notes instanceof win.HTMLTextAreaElement && notes.value).toBe("probe");
    const size = doc.querySelector("select");
    expect(size instanceof win.HTMLSelectElement && size.value).toBe("m");
    const planA = doc.querySelector('input[value="a"]');
    expect(planA instanceof win.HTMLInputElement && planA.checked).toBe(true);
    const planB = doc.querySelector('input[value="b"]');
    expect(planB instanceof win.HTMLInputElement && planB.checked).toBe(false);
    const agree = doc.querySelector('input[type="checkbox"]');
    expect(agree instanceof win.HTMLInputElement && agree.checked, "checkboxes are never touched").toBe(false);
    win.close();
  });
});
