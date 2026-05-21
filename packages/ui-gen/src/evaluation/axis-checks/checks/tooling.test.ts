import { describe, expect, it } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import type { Classification } from "../../../classifier/axes.js";
import type { AxisCheckInput } from "../types.js";
import { TOOLING_CHECKS } from "./tooling.js";

function classification(
  tooling: "none" | "wired" | "client" | "both",
): Classification {
  return {
    vector: {
      render: "static",
      state: "none",
      writes: "none",
      writeTrigger: "click",
      realtime: "none",
      fetch: "none",
      layout: "single",
      tooling,
    },
    provenance: {
      render: "default",
      state: "default",
      writes: "default",
      writeTrigger: "default",
      realtime: "default",
      fetch: "default",
      layout: "default",
      tooling: "default",
    },
    riskTier: "low",
  };
}

function makeInput(args: {
  sourceCode: string;
  toolingValue?: "none" | "wired" | "client" | "both";
  contract?: DataContract;
}): AxisCheckInput {
  return {
    sourceCode: args.sourceCode,
    compiledCode: args.sourceCode,
    originalPrompt: "",
    classification: classification(args.toolingValue ?? "none"),
    ...(args.contract !== undefined ? { contract: args.contract } : {}),
  };
}

const ANTI_PATTERN_CHECK = TOOLING_CHECKS.find(
  (c) => c.id === "universal.no_retired_identifiers",
);
const HOOK_CALLED_CHECK = TOOLING_CHECKS.find(
  (c) => c.id === "tooling.clientCapability.hook_called",
);
const START_CALLED_CHECK = TOOLING_CHECKS.find(
  (c) => c.id === "tooling.clientCapability.start_called",
);
const STREAM_SOURCE_CHECK = TOOLING_CHECKS.find(
  (c) => c.id === "realtime.stream_source.no_direct_call",
);

// The wire `clientCapabilities.gadgets` is package-keyed and
// carries only the export NAME (the inner map key). There is no
// separate binding name — the boilerplate derives it from the hook
// name (`useCamera` → `camera`).
function capContract(hook: string): DataContract {
  return {
    clientCapabilities: {
      gadgets: {
        '@ggui-ai/gadgets': { [hook]: {} },
      },
    },
  };
}

function streamSourceContract(
  channel: string,
  tool: string,
): DataContract {
  return {
    streamSpec: {
      [channel]: {
        schema: { type: "object" },
        source: { tool },
      },
    },
  };
}

describe("universal.no_retired_identifiers (anti-pattern grep)", () => {
  it("is exported on TOOLING_CHECKS", () => {
    expect(ANTI_PATTERN_CHECK).toBeDefined();
  });

  it("flags useWiredTool usage", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const x = useWiredTool('search');",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.useWiredTool"),
      ),
    ).toBe(true);
  });

  it("flags useClientTool usage", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "useClientTool('refresh', () => {});",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.useClientTool"),
      ),
    ).toBe(true);
  });

  it("flags dispatch.kind discriminated union", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const x = { dispatch: { kind: 'tool', tool: 'X' } };",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.dispatch.kind"),
      ),
    ).toBe(true);
  });

  it("flags intendedTool", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const x = { intendedTool: 'X' };",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.intendedTool"),
      ),
    ).toBe(true);
  });

  it("flags `mode: 'host-routed'`", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const x = { mode: 'host-routed' };",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.mode.host-routed"),
      ),
    ).toBe(true);
  });

  it("flags `broadcast: { … }`", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const c = { broadcast: { tool: 'X' } };",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.broadcast"),
      ),
    ).toBe(true);
  });

  it("flags `useAgentTool` hook", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const x = useAgentTool('search');",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.useAgentTool"),
      ),
    ).toBe(true);
  });

  it("flags `callWiredTool` call", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "callWiredTool('search', {q: 'foo'});",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.callWiredTool"),
      ),
    ).toBe(true);
  });

  it("flags top-level `agentTools` contract field", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const c = { agentTools: { search: {} } };",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.contract.agentTools"),
      ),
    ).toBe(true);
  });

  it("flags `clientCapabilities.capabilities` inner key access", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const caps = contract.clientCapabilities.capabilities;",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes(
          "no_retired_identifiers.clientCapabilities.capabilities",
        ),
      ),
    ).toBe(true);
  });

  it("flags `@ggui-ai/client-tools` package import", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode:
          "import { useGeolocation } from '@ggui-ai/client-tools';",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes(
          "no_retired_identifiers.package.@ggui-ai/client-tools",
        ),
      ),
    ).toBe(true);
  });

  it("flags `PushStory` type reference", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const x: PushStory = { intent: 'x' };",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.PushStory"),
      ),
    ).toBe(true);
  });

  it("flags `pushStorySchema` reference", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "pushStorySchema.parse(input);",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.pushStorySchema"),
      ),
    ).toBe(true);
  });

  it("flags `story.adapters` access", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "if (story.adapters?.length) { /* ... */ }",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.story.adapters"),
      ),
    ).toBe(true);
  });

  it("flags `declaredAdapters` field", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const list = app.declaredAdapters;",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.declaredAdapters"),
      ),
    ).toBe(true);
  });

  it("flags `assertAdaptersDeclared` runtime call", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "assertAdaptersDeclared(app, contract);",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes(
          "no_retired_identifiers.assertAdaptersDeclared",
        ),
      ),
    ).toBe(true);
  });

  it("flags `HandshakeStoredStory` storage type", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const r: HandshakeStoredStory = { story: {} };",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.HandshakeStoredStory"),
      ),
    ).toBe(true);
  });

  it("flags `record.story` access", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: "const intent = record.story.intent;",
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("no_retired_identifiers.record.story"),
      ),
    ).toBe(true);
  });

  it("is quiet on clean current-shape source", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode: `
          import { useAction, useStream } from '@ggui-ai/wire';
          import { useGeolocation } from '@ggui-ai/gadgets';
          export default function C() {
            const loc = useGeolocation();
            const submit = useAction('submit');
            return null;
          }
        `,
      }),
    );
    expect(issues).toEqual([]);
  });

  it("emits one issue per distinct retired identifier when multiple are present", () => {
    const issues = ANTI_PATTERN_CHECK!.run(
      makeInput({
        sourceCode:
          "useWiredTool('a'); useClientTool('b', () => {}); broadcast: { tool: 'X' };",
      }),
    );
    const subs = issues.map((i) => i.subcategory).filter(Boolean) as string[];
    expect(subs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("tooling.clientCapability.start_called", () => {
  it("is exported on TOOLING_CHECKS", () => {
    expect(START_CALLED_CHECK).toBeDefined();
  });

  it("flags a capability bound but never .start()-ed", () => {
    const issues = START_CALLED_CHECK!.run(
      makeInput({
        sourceCode: "const camera = useCamera();\nreturn <Box />;",
        toolingValue: "client",
        contract: capContract("useCamera"),
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("clientCapability.start_called"),
      ),
    ).toBe(true);
  });

  it("is quiet when .start() is invoked", () => {
    const issues = START_CALLED_CHECK!.run(
      makeInput({
        sourceCode:
          "const camera = useCamera();\n<Button onClick={() => camera.start()}>Take photo</Button>",
        toolingValue: "client",
        contract: capContract("useCamera"),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("does not double-issue when the binding is missing (hook_called covers that)", () => {
    const issues = START_CALLED_CHECK!.run(
      makeInput({
        sourceCode: "return <Box />;",
        toolingValue: "client",
        contract: capContract("useCamera"),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("is quiet for a registered third-party gadget hook (no .start() lifecycle)", () => {
    const issues = START_CALLED_CHECK!.run(
      makeInput({
        // `useBoardState` is bound but never `.start()`-ed — for a
        // stdlib capability that fires, but a registered third-party
        // gadget hook has no idle→prompting lifecycle, so: no issue.
        sourceCode: "const boardState = useBoardState();\nreturn <Box />;",
        toolingValue: "client",
        contract: {
          clientCapabilities: {
            gadgets: {
              "@example/gadget-board": { useBoardState: {} },
            },
          },
        },
      }),
    );
    expect(issues).toEqual([]);
  });
});

describe("realtime.stream_source.no_direct_call", () => {
  it("is exported on TOOLING_CHECKS", () => {
    expect(STREAM_SOURCE_CHECK).toBeDefined();
  });

  it("flags direct invocation of a stream source tool", () => {
    const issues = STREAM_SOURCE_CHECK!.run(
      makeInput({
        sourceCode:
          "// component should subscribe to the channel\nconst data = list_messages();",
        contract: streamSourceContract("messages", "list_messages"),
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("stream_source.no_direct_call"),
      ),
    ).toBe(true);
  });

  it("is quiet when the component subscribes via useStream", () => {
    const issues = STREAM_SOURCE_CHECK!.run(
      makeInput({
        sourceCode:
          "const messages = useStream('messages');\nreturn <List items={messages.all} />;",
        contract: streamSourceContract("messages", "list_messages"),
      }),
    );
    expect(issues).toEqual([]);
  });

  it("is quiet when streamSpec has no source declaration", () => {
    const contract: DataContract = {
      streamSpec: { ticker: { schema: { type: "string" } } },
    };
    const issues = STREAM_SOURCE_CHECK!.run(
      makeInput({
        sourceCode: "ticker();",
        contract,
      }),
    );
    expect(issues).toEqual([]);
  });
});

describe("tooling.clientCapability.hook_called (regression)", () => {
  it("is exported on TOOLING_CHECKS", () => {
    expect(HOOK_CALLED_CHECK).toBeDefined();
  });

  it("flags a capability with no const binding", () => {
    const issues = HOOK_CALLED_CHECK!.run(
      makeInput({
        sourceCode: "return <Box />;",
        toolingValue: "client",
        contract: capContract("useCamera"),
      }),
    );
    expect(
      issues.some((i) =>
        i.subcategory?.includes("clientCapability.hook_called"),
      ),
    ).toBe(true);
  });
});
