// core/src/harness/compose.test.ts
//
// Compose must produce a deterministic prompt + boilerplate for each fixture.
// Asserts:
//   1. Every classified axis value has a registered fragment (no gaps).
//   2. Low-risk + "default" axis values produce empty promptText (no noise).
//   3. High-risk fixtures include guidance for their load-bearing axes.

import { describe, expect, it } from "vitest";
import { classifyAxes } from "@ggui-ai/ui-gen/classifier";
import { FRAGMENT_REGISTRY, type AxisKey } from "@ggui-ai/ui-gen/fragments";
import { compose } from "@ggui-ai/ui-gen/compose";
import type { BenchmarkFixture } from "../multi-sdk/fixtures/types";

import { weatherCard } from "../multi-sdk/fixtures/weather-card.fixture";
import { periodicTable } from "../multi-sdk/fixtures/periodic-table.fixture";
import { productPage } from "../multi-sdk/fixtures/product-page.fixture";
import { surveyForm } from "../multi-sdk/fixtures/survey-form.fixture";
import { onboardingWizard } from "../multi-sdk/fixtures/onboarding-wizard.fixture";
import { kanbanBoard } from "../multi-sdk/fixtures/kanban-board.fixture";
import { chatInterface } from "../multi-sdk/fixtures/chat-interface.fixture";
import { stockTicker } from "../multi-sdk/fixtures/stock-ticker.fixture";
import { uberRide } from "../multi-sdk/fixtures/uber-ride.fixture";
import { planMyWeek } from "../multi-sdk/fixtures/plan-my-week.fixture";
import { inboxTriage } from "../multi-sdk/fixtures/inbox-triage.fixture";
import { placeSearch } from "../multi-sdk/fixtures/place-search.fixture";
import { flightStatus } from "../multi-sdk/fixtures/flight-status.fixture";
import { activityFeed } from "../multi-sdk/fixtures/activity-feed.fixture";

const ALL: BenchmarkFixture[] = [
  weatherCard, periodicTable, productPage, surveyForm, onboardingWizard,
  kanbanBoard, chatInterface, stockTicker, uberRide, planMyWeek,
  inboxTriage, placeSearch, flightStatus, activityFeed,
];

describe("fragment registry coverage", () => {
  it("registers every enum value across 8 axes", () => {
    // Sanity: every axis is present and non-empty
    const axes: AxisKey[] = ["render", "state", "writes", "writeTrigger", "realtime", "fetch", "layout", "tooling"];
    for (const axis of axes) {
      expect(Object.keys(FRAGMENT_REGISTRY[axis]).length).toBeGreaterThan(0);
    }
  });

  it("each classified fixture finds a fragment for every axis value", () => {
    for (const fx of ALL) {
      const result = classifyAxes({
        contract: fx.contract as Parameters<typeof classifyAxes>[0]["contract"],
        prompt: fx.prompt,
        blueprint: fx.blueprint,
      });
      const composed = compose(result);
      const axes: AxisKey[] = ["render", "state", "writes", "writeTrigger", "realtime", "fetch", "layout", "tooling"];
      for (const axis of axes) {
        const value = result.vector[axis] as string;
        const frag = FRAGMENT_REGISTRY[axis][value];
        expect(frag, `${fx.id} missing fragment for ${axis}=${value}`).toBeDefined();
      }
      expect(composed.fragments.length).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("compose output — low risk vs high risk", () => {
  it("weather-card (low risk) produces terse prompt", () => {
    const c = classifyAxes({ contract: weatherCard.contract as never, prompt: weatherCard.prompt });
    const composed = compose(c);
    // All axis values for weather-card are defaults (static/none/none/click/none/none/single)
    // → every matched fragment has no promptText → empty output.
    expect(composed.promptText).toBe("");
    expect(composed.boilerplateSections).toBe("");
  });

  it("kanban-board (high risk) includes merge + per-item guidance", () => {
    const c = classifyAxes({ contract: kanbanBoard.contract as never, prompt: kanbanBoard.prompt });
    const composed = compose(c);
    expect(composed.promptText).toContain("State: merge");
    expect(composed.promptText).toContain("Writes: per-item");
    expect(composed.promptText).toContain("Realtime: merge");
    expect(composed.boilerplateSections).toContain("merge-by-id");
    expect(composed.boilerplateSections).toContain("Per-item actions");
  });

  it("chat-interface (mixed streams) includes mixed guidance", () => {
    const c = classifyAxes({ contract: chatInterface.contract as never, prompt: chatInterface.prompt });
    const composed = compose(c);
    expect(composed.promptText).toContain("Realtime: mixed");
  });

  it("plan-my-week (drag) includes drag trigger guidance", () => {
    const c = classifyAxes({
      contract: planMyWeek.contract as never,
      prompt: planMyWeek.prompt,
      blueprint: planMyWeek.blueprint,
    });
    const composed = compose(c);
    expect(composed.promptText).toContain("Trigger: drag");
    expect(composed.promptText).toContain("Writes: compose");
    expect(composed.promptText).toContain("GguiSession: master-detail");
  });

  it("inbox-triage (swipe + modal) includes swipe + modal guidance", () => {
    const c = classifyAxes({
      contract: inboxTriage.contract as never,
      prompt: inboxTriage.prompt,
      blueprint: inboxTriage.blueprint,
    });
    const composed = compose(c);
    expect(composed.promptText).toContain("Trigger: swipe");
    expect(composed.promptText).toContain("Layout: modal");
  });
});

describe("compose output — deterministic ordering", () => {
  it("stable axis ordering: render → layout → state → writes → writeTrigger → realtime → fetch → tooling", () => {
    const c = classifyAxes({ contract: kanbanBoard.contract as never, prompt: kanbanBoard.prompt });
    const composed = compose(c);
    const axisSeq = composed.fragments.map((f) => f.axis);
    expect(axisSeq).toEqual(["render", "layout", "state", "writes", "writeTrigger", "realtime", "fetch", "tooling"]);
  });
});
