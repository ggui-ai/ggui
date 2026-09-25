// speed/002 (ggui#1324) — the TS-doc section slicer. Code-property tests
// against the live generated doc: they pin the RULE (what is kept and what
// is dropped), not byte counts, which move whenever a design docstring does.
import { describe, expect, it } from "vitest";
import { PRIMITIVES_DOCUMENTATION_TS } from "../tools/get-primitives-ts.js";
import { slicePrimitiveDocumentationTs } from "./primitive-slice.js";

const DOC = PRIMITIVES_DOCUMENTATION_TS;
const EVERY_KNOWN = [
  "Container", "Card", "Stack", "Box", "Divider", "Spacer", "Text", "Heading", "Button", "Input", "TextArea",
  "Select", "Checkbox", "Toggle", "RadioGroup", "Slider", "Badge", "Spinner", "Avatar", "Alert", "Progress", "Image",
  "Icon", "Link", "Tooltip", "Table", "Tabs", "Toast", "Accordion", "SearchField", "FormField", "MenuItem", "Tag",
  "Dropdown", "Autocomplete", "Breadcrumb", "Pagination", "Stat", "Stepper", "Markdown", "MarkdownInline", "Header",
  "Sidebar", "CardGrid", "CommentThread", "DataTable", "ChatWindow", "NavigationBar", "FileUploader",
  "NotificationCenter", "Modal", "CommandPalette", "Footer", "Hero",
];
// weather-card's logged allowlist (speed/001 Amendment 1, run 1) — the smallest of the eight bench cards.
const WEATHER = ["Badge", "Box", "Button", "Card", "Container", "Divider", "Heading", "Icon", "Row", "Spacer", "Stack", "Stat", "Text"];

describe("slicePrimitiveDocumentationTs (speed/002)", () => {
  it("allowing every known primitive returns the doc byte-identical", () => {
    expect(slicePrimitiveDocumentationTs(DOC, EVERY_KNOWN)).toBe(DOC);
  });

  it("drops a non-allowed primitive's WHOLE section — header, interface and its usage example — and keeps an allowed one's", () => {
    const sliced = slicePrimitiveDocumentationTs(DOC, WEATHER);
    expect(sliced).not.toContain("interface AccordionProps");
    expect(sliced).not.toContain("// Accordion — ");
    expect(sliced).not.toContain("<Accordion"); // the example travels with its section
    expect(sliced).toContain("interface ButtonProps");
    expect(sliced).toContain("<Button variant=");
  });

  it("keeps what the allowlist never names: the preamble, category banners, CRITICAL guidance, support types, unknown sections", () => {
    const sliced = slicePrimitiveDocumentationTs(DOC, WEATHER);
    expect(sliced.startsWith(DOC.slice(0, 200))).toBe(true);
    expect((sliced.match(/^\/\/ ═/gm) ?? []).length).toBe((DOC.match(/^\/\/ ═/gm) ?? []).length);
    expect((sliced.match(/^\/\/ CRITICAL — /gm) ?? []).length).toBe((DOC.match(/^\/\/ CRITICAL — /gm) ?? []).length);
    for (const support of ["interface SelectOption", "interface TableColumn", "interface AccordionItem"]) {
      expect(sliced).toContain(support);
    }
    for (const unknown of ["interface RowProps", "interface GridProps", "interface SkeletonProps", "interface EmptyStateProps"]) {
      expect(sliced).toContain(unknown);
    }
  });

  it("cuts the bench cards' docs by roughly half, and a superset allowlist never yields a smaller doc", () => {
    const full = Buffer.byteLength(DOC, "utf8");
    const small = Buffer.byteLength(slicePrimitiveDocumentationTs(DOC, WEATHER), "utf8");
    const larger = Buffer.byteLength(slicePrimitiveDocumentationTs(DOC, [...WEATHER, "Input", "TextArea", "Select", "Tabs"]), "utf8");
    expect(small / full).toBeGreaterThan(0.3);
    expect(small / full).toBeLessThan(0.6);
    expect(larger).toBeGreaterThan(small);
    expect(larger).toBeLessThanOrEqual(full);
  });

  it("falls back to the whole doc when there is no section header (defensive)", () => {
    const plain = "interface FooProps {\n  a?: string;\n}\n";
    expect(slicePrimitiveDocumentationTs(plain, [])).toBe(plain);
  });
});
