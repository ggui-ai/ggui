// core/src/evaluation/axis-checks/dispatch.test.ts
//
// Axis-keyed dispatcher tests.
//
//   1. Registry matching — every classified fixture fires at least the
//      checks its vector demands (universal + axis-gated).
//   2. Axis-only extras (drag/swipe/compose/multi-step/mixed) fire when
//      their gate matches and pass when handlers are present.
//   3. Skip when compile failed.

import { describe, expect, it } from "vitest";
import { runAxisChecks, REGISTRY } from "@ggui-ai/ui-gen/evaluation/axis-checks";
import { classifyAxes } from "@ggui-ai/ui-gen/classifier";
import type { DataContract } from "@ggui-ai/protocol";
import type { EvalIssue } from "@ggui-ai/ui-gen/evaluation";

import { weatherCard } from "../multi-sdk/fixtures/weather-card.fixture";
import { surveyForm } from "../multi-sdk/fixtures/survey-form.fixture";
import { kanbanBoard } from "../multi-sdk/fixtures/kanban-board.fixture";
import { planMyWeek } from "../multi-sdk/fixtures/plan-my-week.fixture";
import { inboxTriage } from "../multi-sdk/fixtures/inbox-triage.fixture";
import { chatInterface } from "../multi-sdk/fixtures/chat-interface.fixture";
import { onboardingWizard } from "../multi-sdk/fixtures/onboarding-wizard.fixture";

const TRIVIAL_SRC = `
export default function C(props: { title: string }) {
  return <div>{props.title}</div>;
}
`;

describe("registry sanity", () => {
  it("registry is non-empty", () => {
    expect(REGISTRY.length).toBeGreaterThan(0);
  });
  it("no duplicate check ids", () => {
    const ids = REGISTRY.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("expected axis-check ids per fixture", () => {
  function idsFor(fx: (typeof weatherCard) & { blueprint?: unknown }) {
    const c = classifyAxes({
      contract: fx.contract as never,
      prompt: fx.prompt,
      blueprint: fx.blueprint as never,
    });
    const issues = runAxisChecks(c, {
      sourceCode: TRIVIAL_SRC,
      compiledCode: "compiled",
      contract: fx.contract as DataContract,
      originalPrompt: fx.prompt,
    });
    return issues.map((i: EvalIssue) => i.subcategory ?? "").filter(Boolean);
  }

  it("weather-card (low risk) fires only universal checks, no extras", () => {
    const ids = idsFor(weatherCard);
    for (const id of ids) {
      expect(id.startsWith("universal.")).toBe(true);
    }
  });

  it("survey-form fires submit + payload checks", () => {
    const ids = idsFor(surveyForm);
    expect(ids).toContain("writes.submit.hook_present");
    expect(ids).toContain("state.payload.covers_submit");
  });

  it("kanban-board fires merge-state + per-item writes checks", () => {
    const ids = idsFor(kanbanBoard);
    expect(ids).toContain("state.merge.seeded_from_props");
    expect(ids).toContain("writes.action_hook_wired");
  });

  it("chat-interface (mixed streams) fires mixed extras + stream checks", () => {
    const ids = idsFor(chatInterface);
    expect(ids).toContain("realtime.mixed.handlers_per_event");
    expect(ids).toContain("realtime.stream_handler_per_event");
  });

  it("plan-my-week fires drag + compose extras", () => {
    const ids = idsFor(planMyWeek);
    expect(ids).toContain("writeTrigger.drag.handlers_wired");
    expect(ids).toContain("writes.compose.cross_entity_ids");
  });

  it("inbox-triage fires swipe extras", () => {
    const ids = idsFor(inboxTriage);
    expect(ids).toContain("writeTrigger.swipe.handlers_wired");
  });

  it("onboarding-wizard fires multi-step extra", () => {
    const ids = idsFor(onboardingWizard);
    expect(ids).toContain("layout.multi_step.state_present");
  });
});

describe("extras pass when handlers are satisfied", () => {
  it("drag satisfied → no drag issue", () => {
    const c = classifyAxes({
      contract: planMyWeek.contract as never,
      prompt: planMyWeek.prompt,
      blueprint: planMyWeek.blueprint,
    });
    const src = `${TRIVIAL_SRC}
      function X() {
        return <div onDragStart={() => {}} onDrop={() => {}} onDragOver={(e) => e.preventDefault()} />;
      }
    `;
    const issues = runAxisChecks(c, {
      sourceCode: src,
      compiledCode: "compiled",
      contract: planMyWeek.contract as DataContract,
      originalPrompt: planMyWeek.prompt,
    });
    expect(issues.map((i) => i.subcategory)).not.toContain(
      "writeTrigger.drag.handlers_wired",
    );
  });

  it("multi-step state present → no multi-step issue", () => {
    const c = classifyAxes({
      contract: onboardingWizard.contract as never,
      prompt: onboardingWizard.prompt,
    });
    const src = `${TRIVIAL_SRC}
      function X() {
        const [step, setStep] = useState(0);
        return null;
      }
    `;
    const issues = runAxisChecks(c, {
      sourceCode: src,
      compiledCode: "compiled",
      contract: onboardingWizard.contract as DataContract,
      originalPrompt: onboardingWizard.prompt,
    });
    expect(issues.map((i) => i.subcategory)).not.toContain(
      "layout.multi_step.state_present",
    );
  });
});

describe("compile failed → no checks run", () => {
  it("returns empty when compiledCode is null", () => {
    const c = classifyAxes({
      contract: planMyWeek.contract as never,
      prompt: planMyWeek.prompt,
      blueprint: planMyWeek.blueprint,
    });
    const issues = runAxisChecks(c, {
      sourceCode: TRIVIAL_SRC,
      compiledCode: null,
      contract: planMyWeek.contract as DataContract,
      originalPrompt: planMyWeek.prompt,
    });
    expect(issues).toEqual([]);
  });
});
