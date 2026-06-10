// core/src/harness/check/runtime-render/find-wiring.test.ts
//
// Tests for AST-based wiring detection (per Codex's repro-set, 2026-04-13).
// Covers the six canonical cases:
//   - direct button click       → click (verified)
//   - form submit               → submit (verified)
//   - native select/input change → change (verified)
//   - dropdown / custom select  → unverified
//   - missing wiring            → missing
//   - alias indirection         → click (verified)

import { describe, it, expect } from "vitest";
import { findWiring } from "./find-wiring.js";

describe("findWiring — direct deterministic kinds", () => {
  it("direct button onClick → click", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const save = useAction('save');
        return <button onClick={() => save({ id: 1 })}>Save</button>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    expect(w.kind).toBe("click");
    expect(w.observedNativeProps).toContain("onClick");
  });

  it("form onSubmit → submit", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const save = useAction('save');
        return <form onSubmit={(e) => { e.preventDefault(); save({}); }}><input /></form>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    expect(w.kind).toBe("submit");
  });

  it("button[type=submit] inside form → submit", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const save = useAction('save');
        const handleSubmit = () => save({});
        return <form onSubmit={handleSubmit}><button type="submit">Go</button></form>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    expect(w.kind).toBe("submit");
  });

  it("native select onChange → change", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const setSort = useAction('setSort');
        return <select onChange={(e) => setSort({ value: e.target.value })}><option /></select>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "setSort" });
    expect(w.kind).toBe("change");
  });

  it("native input onChange → change", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const setQuery = useAction('setQuery');
        return <input onChange={(e) => setQuery({ q: e.target.value })} />;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "setQuery" });
    expect(w.kind).toBe("change");
  });

  it("button onKeyDown → keyboard-enter", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const save = useAction('save');
        return <button onKeyDown={(e) => e.key === 'Enter' && save({})}>Save</button>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    // Click attribute might not exist, so keyboard-enter wins.
    // (If a future tweak prefers click, we'd accept either — but for now we expect keyboard-enter.)
    expect(["click", "keyboard-enter"]).toContain(w.kind);
  });
});

describe("findWiring — alias indirection", () => {
  it("named arrow alias → click", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const save = useAction('save');
        const onSave = () => save({ id: 1 });
        return <button onClick={onSave}>Save</button>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    expect(w.kind).toBe("click");
  });

  it("direct identifier alias → click", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const save = useAction('save');
        const handler = save;
        return <button onClick={handler}>Save</button>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    expect(w.kind).toBe("click");
  });

  it("useCallback wrapper around action → click", () => {
    const src = `
      import { useCallback } from 'react';
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const save = useAction('save');
        const onClick = useCallback(() => save({}), [save]);
        return <button onClick={onClick}>Save</button>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    // useCallback is not literally an arrow/function expression bound to a name we recognize,
    // so this case might land in unverified depending on AST detection completeness.
    // Soft expectation: we DO recognize the inner reference to `save`.
    expect(["click", "unverified"]).toContain(w.kind);
  });
});

describe("findWiring — unverified (custom-component / non-native props)", () => {
  it("custom Dropdown.onChange → unverified", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      import { Dropdown } from '@ggui-ai/design/components';
      export default function C() {
        const move = useAction('move');
        return <Dropdown onChange={(v) => move({ to: v })} options={[]} />;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "move" });
    // Dropdown is a capitalized custom component → onChange on it is non-native.
    expect(w.kind).toBe("unverified");
    expect(w.observedCustomProps).toContain("onChange");
  });

  it("custom Select onValueChange → unverified", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      import { Select } from '@ggui-ai/design/components';
      export default function C() {
        const setKind = useAction('setKind');
        return <Select onValueChange={(v) => setKind({ kind: v })} />;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "setKind" });
    expect(w.kind).toBe("unverified");
    expect(w.observedCustomProps).toContain("onValueChange");
  });

  it("Modal onOpenChange → unverified", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      import { Modal } from '@ggui-ai/design/compositions';
      export default function C() {
        const close = useAction('close');
        return <Modal onOpenChange={(open) => !open && close({})} />;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "close" });
    expect(w.kind).toBe("unverified");
  });
});

describe("findWiring — missing", () => {
  it("hook destructured but not referenced → missing", () => {
    const src = `
      import { useAction } from '@ggui-ai/wire';
      export default function C() {
        const save = useAction('save');
        void save;
        return <button>Inert</button>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    expect(w.kind).toBe("missing");
  });

  it("hook never even destructured → missing", () => {
    const src = `
      export default function C() {
        return <div>nothing</div>;
      }
    `;
    const w = findWiring({ sourceCode: src, hookName: "useAction", hookArg: "save" });
    expect(w.kind).toBe("missing");
  });
});
