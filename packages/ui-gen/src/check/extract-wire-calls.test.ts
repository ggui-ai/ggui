// packages/ui-gen/src/check/extract-wire-calls.test.ts
//
// Unit tests for the AST-based wire call-site extractor + the new
// `checkWireImports` sibling.
//
// Promoted from `core/src/coding-agent/extract-wire-calls.test.ts`
// as part of the OSS tier-0 migration. Original coverage
// kept verbatim; new `checkWireImports` cases added at the bottom to
// lock the Gap-1 gate.

import { describe, expect, it } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import {
  checkWireImports,
  checkWirePreservation,
  collectExpectedWires,
  extractWireCallSites,
  extractWireImports,
} from "./extract-wire-calls.js";

describe("extractWireCallSites", () => {
  it("extracts the wire hook kinds with their string-literal names", () => {
    const code = `
      import { useAction, useStream } from '@ggui-ai/wire';
      export default function C() {
        const submit = useAction<SubmitPayload>('submit');
        const progress = useStream<number>('progress');
        const view = useGguiContext('view');
        return null;
      }
    `;

    const sites = extractWireCallSites(code);

    expect(sites).toEqual([
      { kind: "action", name: "submit" },
      { kind: "stream", name: "progress" },
      { kind: "context", name: "view" },
    ]);
  });

  it("keys on the string literal — variable renames don't change the wire", () => {
    const code = `
      const onSubmit = useAction('submit');
      const onCancel = useAction('cancel');
    `;

    const sites = extractWireCallSites(code);

    expect(sites).toEqual([
      { kind: "action", name: "submit" },
      { kind: "action", name: "cancel" },
    ]);
  });

  it("finds hook calls inside useCallback / useEffect wrappers", () => {
    const code = `
      export default function C() {
        const submit = useAction('submit');
        const handle = useCallback(() => submit({ email: '' }), [submit]);
        useEffect(() => { submit; }, [submit]);
        return <button onClick={handle}>go</button>;
      }
    `;

    const sites = extractWireCallSites(code);

    expect(sites).toEqual([{ kind: "action", name: "submit" }]);
  });

  it("ignores non-literal first arguments (LLM MUST use string literals)", () => {
    const code = `
      const name = 'submit';
      const dyn = useAction(name);
      const lit = useAction('cancel');
    `;

    const sites = extractWireCallSites(code);

    expect(sites).toEqual([{ kind: "action", name: "cancel" }]);
  });

  it("ignores member-access hook forms (hooks are imported as bare identifiers)", () => {
    const code = `
      const custom = Something.useAction('nope');
      const real = useAction('submit');
    `;

    const sites = extractWireCallSites(code);

    expect(sites).toEqual([{ kind: "action", name: "submit" }]);
  });

  it("returns empty array when code has no wire hooks", () => {
    const code = `
      export default function C() {
        return <div>hi</div>;
      }
    `;

    expect(extractWireCallSites(code)).toEqual([]);
  });

  it("handles malformed code gracefully (parser recovers, returns partial)", () => {
    const code = `
      const submit = useAction('submit');
      const oops = <Stack><Card></Stack>;
    `;

    expect(() => extractWireCallSites(code)).not.toThrow();
    const sites = extractWireCallSites(code);
    expect(sites).toContainEqual({ kind: "action", name: "submit" });
  });
});

describe("collectExpectedWires", () => {
  it("enumerates actions / streams / contextSpec slots from the contract (agentTools is a catalog, not a hook — out of scope; clientCapabilities import from @ggui-ai/gadgets — also out of scope)", () => {
    const contract: DataContract = {
      actionSpec: {
        submit: { label: "Submit" },
        cancel: { label: "Cancel" },
      },
      streamSpec: {
        progress: { description: "p", schema: { type: "number" } },
      },
      contextSpec: {
        view: { schema: { type: "string" }, default: "list" },
      },
      // agentCapabilities / clientCapabilities are intentionally present here
      // but NOT counted — the parser only enumerates @ggui-ai/wire hook surfaces.
      agentCapabilities: {
        tools: {
          search: { outputSchema: { type: "object" } },
        },
      },
    };

    expect(collectExpectedWires(contract)).toEqual([
      { kind: "action", name: "submit" },
      { kind: "action", name: "cancel" },
      { kind: "stream", name: "progress" },
      { kind: "context", name: "view" },
    ]);
  });

  it("returns empty array for a contract with no wires", () => {
    const contract: DataContract = {};
    expect(collectExpectedWires(contract)).toEqual([]);
  });

  it("handles partial contract (only some slots populated)", () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: "Submit" } },
    };

    expect(collectExpectedWires(contract)).toEqual([
      { kind: "action", name: "submit" },
    ]);
  });
});

describe("checkWirePreservation", () => {
  it("reports empty diff when code consumes exactly the contract's wires", () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: "Submit" } },
      streamSpec: { progress: { description: "p", schema: { type: "number" } } },
    };
    const code = `
      const submit = useAction('submit');
      const progress = useStream('progress');
    `;

    expect(checkWirePreservation(code, contract)).toEqual({
      missing: [],
      extra: [],
    });
  });

  it("flags contract wires the code doesn't consume (missing)", () => {
    const contract: DataContract = {
      actionSpec: {
        submit: { label: "Submit" },
        cancel: { label: "Cancel" },
      },
    };
    const code = `
      const submit = useAction('submit');
    `;

    const report = checkWirePreservation(code, contract);

    expect(report.missing).toEqual([{ kind: "action", name: "cancel" }]);
    expect(report.extra).toEqual([]);
  });

  it("flags code wires not declared on the contract (extra)", () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: "Submit" } },
    };
    const code = `
      const submit = useAction('submit');
      const archive = useAction('archive');
    `;

    const report = checkWirePreservation(code, contract);

    expect(report.missing).toEqual([]);
    expect(report.extra).toEqual([{ kind: "action", name: "archive" }]);
  });

  it("variable rename: string-literal match ignores the identifier name", () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: "Submit" } },
    };
    const code = `
      const onSubmit = useAction('submit');
    `;

    expect(checkWirePreservation(code, contract)).toEqual({
      missing: [],
      extra: [],
    });
  });

  it("reports the wire kinds in missing/extra simultaneously (agentTools + clientCapabilities are out of scope)", () => {
    const contract: DataContract = {
      actionSpec: { a: { label: "A" } },
      streamSpec: { s: { description: "s", schema: { type: "string" } } },
      contextSpec: { v: { schema: { type: "string" }, default: "" } },
    };
    const code = `
      const otherAction = useAction('other');
      const otherStream = useStream('otherStream');
      const otherCtx = useGguiContext('otherCtx');
    `;

    const report = checkWirePreservation(code, contract);

    expect(report.missing).toEqual([
      { kind: "action", name: "a" },
      { kind: "stream", name: "s" },
      { kind: "context", name: "v" },
    ]);
    expect(report.extra).toEqual([
      { kind: "action", name: "other" },
      { kind: "stream", name: "otherStream" },
      { kind: "context", name: "otherCtx" },
    ]);
  });

  it("empty contract + empty code → empty report", () => {
    const contract: DataContract = {};
    const code = `export default function C() { return <div />; }`;

    expect(checkWirePreservation(code, contract)).toEqual({
      missing: [],
      extra: [],
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// checkWireImports — new cases. Gates eyeball Gap 1:
// componentCode calls a wire hook but doesn't import it.
// ───────────────────────────────────────────────────────────────────────────

describe("extractWireImports", () => {
  it("collects named specifiers from @ggui-ai/wire", () => {
    const code = `
      import { useAction, useStream } from '@ggui-ai/wire';
      export default function C() { return null; }
    `;
    expect(Array.from(extractWireImports(code)).sort()).toEqual([
      "useAction",
      "useStream",
    ]);
  });

  it("ignores imports from other modules", () => {
    const code = `
      import { useAction } from 'some-other-lib';
      import { useStream } from '@ggui-ai/wire';
    `;
    expect(Array.from(extractWireImports(code))).toEqual(["useStream"]);
  });

  it("returns empty set when no @ggui-ai/wire import is present", () => {
    const code = `
      import { useState } from 'react';
      export default function C() { return null; }
    `;
    expect(extractWireImports(code).size).toBe(0);
  });

  it("reads the local binding name when import is aliased", () => {
    // Aliases are unusual for wire hooks (LLM never emits them), but the
    // checker's invariant is "compare to identifiers USED in the body",
    // so the local name is the correct key even when aliased.
    const code = `
      import { useAction as a } from '@ggui-ai/wire';
    `;
    expect(Array.from(extractWireImports(code))).toEqual(["a"]);
  });
});

describe("checkWireImports", () => {
  it("passes when every used hook is imported from @ggui-ai/wire", () => {
    const code = `
      import { useAction, useStream } from '@ggui-ai/wire';
      export default function C() {
        const submit = useAction('submit');
        const progress = useStream('progress');
        return null;
      }
    `;
    expect(checkWireImports(code)).toEqual({ missing: [] });
  });

  it("reports missing imports for hooks the code calls but doesn't import (THE GAP-1 BUG)", () => {
    // Mirrors the 2026-04-24 eyeball repro: componentCode calls
    // useAction('createTask') without emitting the paired import line.
    // rewriteImports can't attach the data-URL shim without an import
    // specifier to replace, so the hook is undeclared at eval time.
    const code = `
      export default function TodoList({ tasks }) {
        const createTask = useAction('createTask');
        const toggleTask = useAction('toggleTask');
        return null;
      }
    `;
    const report = checkWireImports(code);
    expect(report.missing).toEqual([{ hook: "useAction", kind: "action" }]);
  });

  it("reports every missing hook kind independently", () => {
    const code = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const submit = useAction('submit');
        const progress = useStream('progress');
        const view = useGguiContext('view');
        return null;
      }
    `;
    const report = checkWireImports(code);
    expect(report.missing).toEqual([
      { hook: "useStream", kind: "stream" },
      { hook: "useGguiContext", kind: "context" },
    ]);
  });

  it("is silent when a hook is imported but never called (unused imports are a lint concern)", () => {
    const code = `
      import { useAction, useStream } from '@ggui-ai/wire';
      export default function C() {
        const submit = useAction('submit');
        return null;
      }
    `;
    expect(checkWireImports(code)).toEqual({ missing: [] });
  });

  it("is silent on empty components", () => {
    const code = `
      export default function C() { return <div />; }
    `;
    expect(checkWireImports(code)).toEqual({ missing: [] });
  });
});
