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

  // `registerClientTool` + agent→UI RPC retired 2026-05-11 with the
  // `clientTools` → `clientCapabilities` reframe. Capability hooks are
  // imported from `@ggui-ai/gadgets` (or vendor) and own their
  // own lifecycle on the UI side; no probe surface remains.

  // `callWiredTool` retired 2026-05-11 with the EE+ wire-shape v2. The
  // probe's `wiredToolResponses` / `fired wiredTool.called` internals
  // are retained as inert no-ops for shape stability (see probe.ts) but
  // the component-side hook is gone, so there's nothing left to test.

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
//   tools/call(non-audit) → ToolDirectlyInvokedEvent (Pattern α direct fire)
//   tools/call(ggui_runtime_submit_action) → ignored (audit envelope; WireConfig already
//                                    records the paired action.fired event)
//
// Pattern β's third message (`ui/message` consent prompt) is NOT recorded —
// the paired `action.fired` from WireConfig.dispatch already represents the
// gesture. The `sendMessage` primitive has been dropped entirely; the
// chat-shortcut path that drove the dedicated `ui/message` spy decoder is
// retired.

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

  it("records non-audit tools/call as tool.directly_invoked (Pattern α)", () => {
    const probe = createProbe();
    const uninstall = probe.installPostMessageSpy();
    try {
      window.parent.postMessage(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "gmail_archive",
            arguments: { messageId: "abc123" },
          },
        },
        "*",
      );
      const log = probe.getFireLog();
      const toolEvent = log.find(e => e.kind === "tool.directly_invoked");
      expect(toolEvent).toBeDefined();
      expect(toolEvent).toMatchObject({
        kind: "tool.directly_invoked",
        toolName: "gmail_archive",
        arguments: { messageId: "abc123" },
      });
    } finally {
      uninstall();
    }
  });

  it("ignores tools/call(ggui_runtime_submit_action) — audit envelopes don't double-record", () => {
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
              renderId: "r1",
              appId: "a1",
            },
          },
        },
        "*",
      );
      const log = probe.getFireLog();
      // Audit envelope is filtered out — WireConfig.dispatch already
      // records the paired action.fired event when applicable.
      expect(log.find(e => e.kind === "tool.directly_invoked")).toBeUndefined();
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
