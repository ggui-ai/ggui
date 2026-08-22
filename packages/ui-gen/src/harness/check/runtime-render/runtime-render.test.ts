// @vitest-environment happy-dom
// core/src/harness/check/runtime-render/runtime-render.test.ts
//
// Unit + integration tests for the runtime render check.
// Uses happy-dom environment so React + RTL have the DOM globals they expect.

import { describe, it, expect } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import { createProbe, createProbeWireConfig } from "./probe.js";
import { prepareMockupProps } from "./prepare-mockup.js";
import { installGadgetStubRegistry, runRenderCheck } from "./render-check.js";

// ─────────────────────────────────────────────────────────────────────────────
// Probe — pure unit tests (no DOM)
// ─────────────────────────────────────────────────────────────────────────────

describe("Probe", () => {
  it("captures dispatch as action.fired event", () => {
    const probe = createProbe();
    const config = createProbeWireConfig(probe);

    config.dispatch("save", { id: "1", title: "Test" });
    config.dispatch("delete", { id: "1" });

    expect(probe.fired("save")).toBe(true);
    expect(probe.fired("delete")).toBe(true);
    expect(probe.fired("update")).toBe(false);
    expect(probe.getFireLog()).toHaveLength(2);
  });

  it("captures subscribe + emitStream round-trip", () => {
    const probe = createProbe();
    const config = createProbeWireConfig(probe);

    const received: unknown[] = [];
    const unsubscribe = config.subscribe("newMessage", payload => received.push(payload));

    probe.emitStream("newMessage", { id: "m1", text: "hello" });
    probe.emitStream("newMessage", { id: "m2", text: "world" });

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ id: "m1", text: "hello" });
    expect(probe.getRegistered().streams).toContain("newMessage");

    unsubscribe();
    probe.emitStream("newMessage", { id: "m3", text: "after-unsub" });
    expect(received).toHaveLength(2); // didn't receive
  });

  it("reset() clears all state", () => {
    const probe = createProbe();
    const config = createProbeWireConfig(probe);

    config.dispatch("save", null);
    config.subscribe("evt", () => {});

    probe.reset();
    expect(probe.getFireLog()).toHaveLength(0);
    expect(probe.getRegistered().streams).toHaveLength(0);
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Probe — postMessage spy (envelope-layer observation)
// ─────────────────────────────────────────────────────────────────────────────
//
// The native interceptors (anchor click, requestFullscreen) bypass
// WireConfig and emit envelopes directly via window.parent.postMessage.
// The probe's spy observes those envelopes and records:
//   ui/open-link        → LinkOpenedEvent
//   ui/request-display-mode → DisplayModeRequestedEvent
//   tools/call          → ignored (the audit envelope's gesture is already
//                         recorded as the paired action.fired via
//                         WireConfig.dispatch; no other tools/call has a
//                         legitimate emitter — agents invoke tools on
//                         their own turn, never the iframe)

describe("Probe — postMessage spy", () => {
  it("records ui/open-link envelopes as link.opened events", () => {
    const probe = createProbe();
    const uninstall = probe.installPostMessageSpy();
    try {
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "ui/open-link",
          params: { url: "https://example.com" },
        },
        "*",
      );
      const log = probe.getFireLog();
      const linkEvent = log.find(e => e.kind === "link.opened");
      expect(linkEvent).toBeDefined();
      expect(linkEvent).toMatchObject({
        kind: "link.opened",
        url: "https://example.com",
      });
    } finally {
      uninstall();
    }
  });

  it("records ui/request-display-mode envelopes as displayMode.requested events", () => {
    const probe = createProbe();
    const uninstall = probe.installPostMessageSpy();
    try {
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "ui/request-display-mode",
          params: { mode: "fullscreen" },
        },
        "*",
      );
      const log = probe.getFireLog();
      const dmEvent = log.find(e => e.kind === "displayMode.requested");
      expect(dmEvent).toBeDefined();
      expect(dmEvent).toMatchObject({
        kind: "displayMode.requested",
        mode: "fullscreen",
      });
    } finally {
      uninstall();
    }
  });

  it("ignores tools/call envelopes — the gesture is recorded via WireConfig.dispatch", () => {
    const probe = createProbe();
    const uninstall = probe.installPostMessageSpy();
    try {
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "ggui_runtime_submit_action",
            arguments: {
              kind: "openLink",
              payload: { url: "https://example.com" },
              sessionId: "r1",
              appId: "a1",
            },
          },
        },
        "*",
      );
      // The audit envelope is filtered out — WireConfig.dispatch already
      // records the paired action.fired event when applicable. Nothing
      // else legitimately emits tools/call from the iframe.
      expect(probe.getFireLog()).toHaveLength(0);
    } finally {
      uninstall();
    }
  });

  it("uninstall restores the original postMessage and stops recording", () => {
    const probe = createProbe();
    const uninstall = probe.installPostMessageSpy();
    uninstall();
    window.parent.postMessage(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "ui/open-link",
        params: { url: "https://example.com/post-uninstall" },
      },
      "*",
    );
    expect(probe.getFireLog()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// prepareMockupProps — schema-first synthesis
// ─────────────────────────────────────────────────────────────────────────────

describe("prepareMockupProps", () => {
  it("uses fixture props when provided", () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          name: { schema: { type: "string" }, required: true },
        },
      },
    };
    const result = prepareMockupProps({
      contract,
      fixtureProps: { name: "Alice" },
    });
    expect(result.props.name).toBe("Alice");
    expect(result.source.name).toBe("fixture");
  });

  it("uses entry.example when fixture missing", () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          name: {
            schema: { type: "string" },
            example: "Bob",
            required: true,
          },
        },
      },
    };
    const result = prepareMockupProps({ contract });
    expect(result.props.name).toBe("Bob");
    expect(result.source.name).toBe("entry-example");
  });

  it("synthesizes from schema for missing fields", () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          temperature: { schema: { type: "number", minimum: -50, maximum: 50 }, required: true },
          city: { schema: { type: "string" }, required: true },
          isHot: { schema: { type: "boolean" }, required: true },
        },
      },
    };
    const result = prepareMockupProps({ contract });
    expect(typeof result.props.temperature).toBe("number");
    expect(typeof result.props.city).toBe("string");
    expect(result.props.isHot).toBe(true);
  });

  it("synthesizes arrays with 2 items including id", () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          tasks: {
            schema: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  done: { type: "boolean" },
                },
              },
            },
            required: true,
          },
        },
      },
    };
    const result = prepareMockupProps({ contract });
    const tasks = result.props.tasks as Array<{ id: string; title: string; done: boolean }>;
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toHaveProperty("id");
    expect(tasks[0]).toHaveProperty("title");
  });

  it("respects format hints on strings", () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          email: { schema: { type: "string", format: "email" }, required: true },
          createdAt: { schema: { type: "string", format: "date-time" }, required: true },
        },
      },
    };
    const result = prepareMockupProps({ contract });
    expect(result.props.email).toBe("user@example.com");
    expect(typeof result.props.createdAt).toBe("string");
    expect(result.props.createdAt).toContain("2026");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runRenderCheck — end-to-end with a simple compiled component
// ─────────────────────────────────────────────────────────────────────────────

const SIMPLE_COMPONENT = `
import { useAction } from '@ggui-ai/wire';

interface Props {
  title: string;
}

export default function Component(props: Props) {
  const save = useAction('save');
  return (
    <div>
      <h1>{props.title}</h1>
      <button onClick={() => save({ id: '1' })}>Save</button>
    </div>
  );
}
`;

const COMPONENT_WITH_BROKEN_WIRING = `
import { useAction } from '@ggui-ai/wire';

interface Props {
  title: string;
}

export default function Component(props: Props) {
  const save = useAction('save');
  // Note: handler exists but is never wired to a click target
  void save;
  return (
    <div>
      <h1>{props.title}</h1>
      <button>Inert button</button>
    </div>
  );
}
`;

// D1 regression guard: generated code imports the single
// `@ggui-ai/design` barrel. The package is ESM-only with no `require`
// export, so the render-check sandbox MUST have it pre-resolved in
// `moduleResolutions` — otherwise this crash:fails.
const DESIGN_BARREL_COMPONENT = `
import { Card, Stack, Text } from '@ggui-ai/design';

interface Props {
  title: string;
}

export default function Component(props: Props) {
  return (
    <Card>
      <Stack gap="md">
        <Text>{props.title}</Text>
      </Stack>
    </Card>
  );
}
`;

const STREAM_COMPONENT = `
import { useStream } from '@ggui-ai/wire';

interface Props {
  title: string;
}

interface Msg { id: string; text: string }

export default function Component(props: Props) {
  const messages = useStream<Msg>('newMessage');
  return (
    <div>
      <h1>{props.title}</h1>
      <ul>
        {messages.all.map(m => <li key={m.id}>{m.text}</li>)}
      </ul>
    </div>
  );
}
`;

describe("buildClickUser", () => {
  it("passes the live document into user-event setup (ggui#403 pin)", async () => {
    // user-event v14 freezes `globalThis.document` into its setup
    // defaults at MODULE LOAD — a bare `setup()` after a DOM-less
    // pre-warm crashes every probe. The boundary must therefore pass
    // the probe's own document explicitly.
    const seen: unknown[] = [];
    const fakeModule = {
      setup: (opts: { document?: unknown }) => {
        seen.push(opts?.document);
        return { click: async () => {} };
      },
    };
    const docSentinel = { sentinel: "live-document" };
    const { buildClickUser } = await import("./host-boundary.js");
    buildClickUser(fakeModule, docSentinel);
    expect(seen).toEqual([docSentinel]);
  });
});

describe("runRenderCheck", () => {
  it("passes a well-wired component (action fires)", async () => {
    const contract: DataContract = {
      propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
      actionSpec: { save: { label: "Save" } },
    };
    const result = await runRenderCheck({
      sourceCode: SIMPLE_COMPONENT,
      mockupProps: { title: "Hello" },
      contract,
    });
    expect(result.ok).toBe(true);
    expect(result.stats.actionsChecked).toBe(1);
    const failures = result.issues.filter(i => i.outcome === "failed");
    expect(failures).toHaveLength(0);
  }, 30000);

  it("fails when an action is declared but never wired to a clickable", async () => {
    const contract: DataContract = {
      propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
      actionSpec: { save: { label: "SaveAction" } },
    };
    const result = await runRenderCheck({
      sourceCode: COMPONENT_WITH_BROKEN_WIRING,
      mockupProps: { title: "Hello" },
      contract,
    });
    expect(result.ok).toBe(false);
    const actionFailure = result.issues.find(
      i => i.check === "action-wiring" && i.outcome === "failed" && i.subject === "save",
    );
    expect(actionFailure).toBeDefined();
  }, 30000);

  it("loads a component importing the bare @ggui-ai/design barrel (D1)", async () => {
    const contract: DataContract = {
      propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
    };
    const result = await runRenderCheck({
      sourceCode: DESIGN_BARREL_COMPONENT,
      mockupProps: { title: "Hello" },
      contract,
    });
    // A failed `@ggui-ai/design` resolution surfaces as a render crash.
    expect(result.ok).toBe(true);
    const failures = result.issues.filter(i => i.outcome === "failed");
    expect(failures).toHaveLength(0);
  }, 30000);

  it("warns when stream is declared but DOM does not change on emit", async () => {
    const contract: DataContract = {
      propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
      streamSpec: { newMessage: { schema: { type: "object" } } },
    };
    const result = await runRenderCheck({
      sourceCode: STREAM_COMPONENT,
      mockupProps: { title: "Chat" },
      contract,
    });
    // STREAM_COMPONENT does subscribe — should pass or at least not have fails
    const failures = result.issues.filter(i => i.outcome === "failed");
    expect(failures).toHaveLength(0);
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// installGadgetStubRegistry — gadget probe-registry shim
// ─────────────────────────────────────────────────────────────────────────────

describe("installGadgetStubRegistry", () => {
  it("is a no-op when the contract declares no gadgets", () => {
    const before = (globalThis as { __ggui__?: unknown }).__ggui__;
    const uninstall = installGadgetStubRegistry(undefined);
    expect((globalThis as { __ggui__?: unknown }).__ggui__).toBe(before);
    uninstall();
  });

  it("installs a per-package stub registry for each declared hook, then uninstalls cleanly", () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          "@x/leaflet": { useLeafletMap: {} },
        },
      },
    };
    const uninstall = installGadgetStubRegistry(contract);
    try {
      // Registry is per-package (`GadgetPackageRegistry`):
      // `gadgets[<package>][<export>]`, NOT a flat hook-name keying.
      const root = (
        globalThis as {
          __ggui__?: {
            gadgets: Record<string, Record<string, () => unknown>>;
          };
        }
      ).__ggui__;
      expect(root).toBeDefined();
      const pkgSlot = root?.gadgets["@x/leaflet"];
      expect(pkgSlot).toBeDefined();
      const hook = pkgSlot?.useLeafletMap;
      expect(typeof hook).toBe("function");
      // Uniform gadget contract — `status` is a real string (safe as a
      // React child), `value` + `start` are present.
      const r = hook?.() as {
        status: unknown;
        value: unknown;
        start: unknown;
      };
      expect(typeof r.status).toBe("string");
      expect(typeof r.start).toBe("function");
      expect(r.value).toBeDefined();
    } finally {
      uninstall();
    }
    expect((globalThis as { __ggui__?: unknown }).__ggui__).toBeUndefined();
  });

  it("groups hooks from the same package under one package slot", () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          "@x/leaflet": {
            useLeafletMap: {},
            useLeafletMarkers: {},
          },
          "@ggui-ai/gadgets": { useGeolocation: {} },
        },
      },
    };
    const uninstall = installGadgetStubRegistry(contract);
    try {
      const root = (
        globalThis as {
          __ggui__?: {
            gadgets: Record<string, Record<string, () => unknown>>;
          };
        }
      ).__ggui__;
      const leaflet = root?.gadgets["@x/leaflet"];
      expect(typeof leaflet?.useLeafletMap).toBe("function");
      expect(typeof leaflet?.useLeafletMarkers).toBe("function");
      // STDLIB hooks land under their own `@ggui-ai/gadgets` slot.
      expect(typeof root?.gadgets["@ggui-ai/gadgets"]?.useGeolocation).toBe(
        "function",
      );
    } finally {
      uninstall();
    }
  });

  it("stubs a component export (PascalCase) with a render-nothing function component", () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          "@x/charts": { RevenueChart: {} },
        },
      },
    };
    const uninstall = installGadgetStubRegistry(contract);
    try {
      const root = (
        globalThis as {
          __ggui__?: {
            gadgets: Record<
              string,
              Record<string, (...a: unknown[]) => unknown>
            >;
          };
        }
      ).__ggui__;
      const Chart = root?.gadgets["@x/charts"]?.RevenueChart;
      expect(typeof Chart).toBe("function");
      // React invokes a component export as `Chart(props)` — the stub
      // renders nothing so the host component's tree is verified while
      // the gadget stays a black box.
      expect(Chart?.({ data: [1, 2, 3] })).toBeNull();
    } finally {
      uninstall();
    }
  });

  it("stubs hook + component exports from one package side by side", () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          "@x/chart": { Chart: {}, useChartTheme: {} },
        },
      },
    };
    const uninstall = installGadgetStubRegistry(contract);
    try {
      const root = (
        globalThis as {
          __ggui__?: {
            gadgets: Record<
              string,
              Record<string, (...a: unknown[]) => unknown>
            >;
          };
        }
      ).__ggui__;
      const pkg = root?.gadgets["@x/chart"];
      // Component export → renders nothing.
      expect(pkg?.Chart?.()).toBeNull();
      // Hook export → uniform `{ status, value, start }` result.
      const r = pkg?.useChartTheme?.() as { status: unknown; start: unknown };
      expect(typeof r.status).toBe("string");
      expect(typeof r.start).toBe("function");
    } finally {
      uninstall();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Check 7 — optional-props omission (ggui#528)
// ─────────────────────────────────────────────────────────────────────────────

const OPTIONAL_ASSUMED_PRESENT = `
interface Props {
  title: string;
  items?: string[];
}

export default function Component(props: Props) {
  // BUG CLASS: optional prop dereferenced unguarded. Passes the main
  // pass (mockup fills items) — crashes when the agent omits it.
  return (
    <div>
      <h1>{props.title}</h1>
      <ul>{props.items!.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  );
}
`;

const OPTIONAL_GUARDED = `
interface Props {
  title: string;
  items?: string[];
}

export default function Component(props: Props) {
  const items = props.items ?? [];
  return (
    <div>
      <h1>{props.title}</h1>
      <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  );
}
`;

describe("runRenderCheck — optional-props omission (ggui#528)", () => {
  // `items` has NO \`required\` — the wire gate treats it as optional,
  // so a legitimate render may omit it.
  const contract: DataContract = {
    propsSpec: {
      properties: {
        title: { schema: { type: "string" }, required: true },
        items: { schema: { type: "array", items: { type: "string" } } },
      },
    },
  };

  it("BLOCKS a component that crashes when an optional prop is omitted (main pass alone would pass it)", async () => {
    const result = await runRenderCheck({
      sourceCode: OPTIONAL_ASSUMED_PRESENT,
      mockupProps: { title: "Hello", items: ["a", "b"] },
      contract,
    });
    // The main pass renders fine — every prop filled.
    expect(result.issues.find((i) => i.check === "render-no-throw")).toBeUndefined();
    // The omission pass catches the latent class.
    const omit = result.issues.find((i) => i.check === "optional-props-omitted");
    expect(omit).toBeDefined();
    expect(omit!.outcome).toBe("failed");
    expect(omit!.subject).toBe("items");
    expect(result.ok).toBe(false);
  }, 30000);

  it("passes a component that guards its optional props", async () => {
    const result = await runRenderCheck({
      sourceCode: OPTIONAL_GUARDED,
      mockupProps: { title: "Hello", items: ["a", "b"] },
      contract,
    });
    expect(result.issues.find((i) => i.check === "optional-props-omitted")).toBeUndefined();
    expect(result.ok).toBe(true);
  }, 30000);

  it("skips the omission pass entirely when every declared prop is required", async () => {
    const allRequired: DataContract = {
      propsSpec: { properties: { title: { schema: { type: "string" }, required: true } } },
    };
    const result = await runRenderCheck({
      sourceCode: SIMPLE_COMPONENT.replace("const save = useAction('save');", "const save = useAction('save'); void save;"),
      mockupProps: { title: "Hello" },
      contract: allRequired,
    });
    expect(result.issues.find((i) => i.check === "optional-props-omitted")).toBeUndefined();
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// selection-identity (#601) — duplicate-label cells must carry their own id
// ─────────────────────────────────────────────────────────────────────────────

const SLOT_CONTRACT: DataContract = {
  propsSpec: {
    properties: {
      slots: { required: true, schema: { type: "array" } },
    },
  },
  actionSpec: {
    bookSlot: {
      label: "Book this slot",
      schema: {
        type: "object",
        properties: { slotId: { type: "string" } },
        required: ["slotId"],
      },
    },
  },
};

const SLOT_PROPS = {
  slots: [
    { id: "a1", time: "09:00" },
    { id: "b2", time: "09:00" },
    { id: "c3", time: "10:00" },
  ],
};

// The ggui#601 live bug, distilled: payload keyed on the DISPLAY VALUE —
// clicking either "09:00" cell fires the same slotId.
const VALUE_KEYED_SLOTS = `
import { useAction } from '@ggui-ai/wire';

interface Slot { id: string; time: string }
interface Props { slots: Slot[] }

export default function SlotGrid(props: Props) {
  const bookSlot = useAction('bookSlot');
  return (
    <div>
      {props.slots.map(slot => (
        <button key={slot.id} onClick={() => bookSlot({ slotId: slot.time })}>
          {slot.time}
        </button>
      ))}
    </div>
  );
}
`;

// The correct shape: payload keyed on the cell's identity.
const IDENTITY_KEYED_SLOTS = `
import { useAction } from '@ggui-ai/wire';

interface Slot { id: string; time: string }
interface Props { slots: Slot[] }

export default function SlotGrid(props: Props) {
  const bookSlot = useAction('bookSlot');
  return (
    <div>
      {props.slots.map(slot => (
        <button key={slot.id} onClick={() => bookSlot({ slotId: slot.id })}>
          {slot.time}
        </button>
      ))}
    </div>
  );
}
`;

describe("selection-identity (#601)", () => {
  it("FAILS a grid whose duplicate-label cells fire the same id (value-keyed)", async () => {
    const result = await runRenderCheck({
      sourceCode: VALUE_KEYED_SLOTS,
      mockupProps: SLOT_PROPS,
      contract: SLOT_CONTRACT,
    });
    const issue = result.issues.find(i => i.check === "selection-identity");
    expect(issue).toBeDefined();
    expect(issue?.outcome).toBe("failed");
    expect(issue?.subject).toBe("bookSlot");
    expect(issue?.reason).toContain("slotId");
    expect(issue?.reason).toContain("09:00");
    expect(result.ok).toBe(false);
  }, 30000);

  it("passes a grid whose duplicate-label cells fire their own ids (identity-keyed)", async () => {
    const result = await runRenderCheck({
      sourceCode: IDENTITY_KEYED_SLOTS,
      mockupProps: SLOT_PROPS,
      contract: SLOT_CONTRACT,
    });
    expect(result.issues.find(i => i.check === "selection-identity")).toBeUndefined();
  }, 30000);

  it("emits nothing when no labels are duplicated (check does not speculate)", async () => {
    const result = await runRenderCheck({
      sourceCode: IDENTITY_KEYED_SLOTS,
      mockupProps: {
        slots: [
          { id: "a1", time: "09:00" },
          { id: "c3", time: "10:00" },
        ],
      },
      contract: SLOT_CONTRACT,
    });
    expect(result.issues.find(i => i.check === "selection-identity")).toBeUndefined();
  }, 30000);

  it("emits nothing for actions without an id-like required string field", async () => {
    const contract: DataContract = {
      propsSpec: SLOT_CONTRACT.propsSpec,
      actionSpec: { bookSlot: { label: "Book this slot" } },
    };
    const result = await runRenderCheck({
      sourceCode: VALUE_KEYED_SLOTS,
      mockupProps: SLOT_PROPS,
      contract,
    });
    expect(result.issues.find(i => i.check === "selection-identity")).toBeUndefined();
  }, 30000);
});

// ─────────────────────────────────────────────────────────────────────────────
// prop-sensitivity (#563) — displayed required scalars must track their value
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_CONTRACT: DataContract = {
  propsSpec: {
    properties: {
      month: { required: true, schema: { type: "string" } },
      bookingId: { required: true, schema: { type: "string" } },
    },
  },
};

const MONTH_PROPS = { month: "January", bookingId: "bk-7731" };

// The economy/001 run-6 class, distilled: the contract delivers `month`
// but the component displays the request's literal.
const BAKED_MONTH = `
interface Props { month: string; bookingId: string }

export default function Calendar(props: Props) {
  return (
    <div>
      <h1>January Booking Calendar</h1>
      <p>ref: {props.bookingId}</p>
    </div>
  );
}
`;

const PROP_DRIVEN_MONTH = `
interface Props { month: string; bookingId: string }

export default function Calendar(props: Props) {
  return (
    <div>
      <h1>{props.month} Booking Calendar</h1>
      <p>ref: {props.bookingId}</p>
    </div>
  );
}
`;

// gen-2 shape from the probe: display fallback — still tracks the prop.
const FALLBACK_MONTH = `
interface Props { month: string; bookingId: string }

export default function Calendar(props: Props) {
  return <h1>{props.month || 'January'} Booking Calendar</h1>;
}
`;

describe("prop-sensitivity (#563)", () => {
  it("FAILS a component that displays the request literal instead of the prop", async () => {
    const result = await runRenderCheck({
      sourceCode: BAKED_MONTH,
      mockupProps: MONTH_PROPS,
      contract: MONTH_CONTRACT,
    });
    const issue = result.issues.find(i => i.check === "prop-sensitivity");
    expect(issue).toBeDefined();
    expect(issue?.outcome).toBe("failed");
    expect(issue?.subject).toBe("month");
    expect(issue?.reason).toContain("baked");
    expect(result.ok).toBe(false);
  }, 30000);

  it("passes a component that derives the display from the prop", async () => {
    const result = await runRenderCheck({
      sourceCode: PROP_DRIVEN_MONTH,
      mockupProps: MONTH_PROPS,
      contract: MONTH_CONTRACT,
    });
    expect(result.issues.find(i => i.check === "prop-sensitivity")).toBeUndefined();
  }, 30000);

  it("passes a display fallback that still tracks the prop (gen-2 shape)", async () => {
    const result = await runRenderCheck({
      sourceCode: FALLBACK_MONTH,
      mockupProps: MONTH_PROPS,
      contract: MONTH_CONTRACT,
    });
    expect(result.issues.find(i => i.check === "prop-sensitivity")).toBeUndefined();
  }, 30000);

  it("does not speculate about non-displayed props (ids are legitimately non-visual)", async () => {
    const NO_ID_SHOWN = `
interface Props { month: string; bookingId: string }
export default function Calendar(props: Props) {
  return <h1>{props.month} Booking Calendar</h1>;
}
`;
    const result = await runRenderCheck({
      sourceCode: NO_ID_SHOWN,
      mockupProps: MONTH_PROPS,
      contract: MONTH_CONTRACT,
    });
    // bookingId never appears in the DOM — the check must stay silent
    // about it (prop-coverage owns "should it be displayed").
    const flagged = result.issues.filter(i => i.check === "prop-sensitivity");
    expect(flagged.map(i => i.subject)).toEqual([]);
  }, 30000);
});
