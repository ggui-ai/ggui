// Classifier snapshot test — locks the AxisVector + riskTier + provenance
// for every benchmark fixture against `classifyAxes()`. Restores the locked
// snapshot test that was lost in the 2026-04 core/-deletion refactor (per
// STATE.md prior to fix(triad-snapshot)).
//
// Each fixture's `.expected` field is the lock. When classifier behavior
// changes, this test will fail loudly across all 14 fixtures, forcing
// review of the change against the manifest in
// internal/benchmarks/docs/harness-modes/MODES.md.

import { describe, expect, test } from "vitest";
import { classifyAxes } from "@ggui-ai/ui-gen/classifier";

import { activityFeed } from "./activity-feed.fixture";
import { chatInterface } from "./chat-interface.fixture";
import { flightStatus } from "./flight-status.fixture";
import { inboxTriage } from "./inbox-triage.fixture";
import { kanbanBoard } from "./kanban-board.fixture";
import { onboardingWizard } from "./onboarding-wizard.fixture";
import { periodicTable } from "./periodic-table.fixture";
import { placeSearch } from "./place-search.fixture";
import { planMyWeek } from "./plan-my-week.fixture";
import { productPage } from "./product-page.fixture";
import { stockTicker } from "./stock-ticker.fixture";
import { surveyForm } from "./survey-form.fixture";
import { uberRide } from "./uber-ride.fixture";
import { weatherCard } from "./weather-card.fixture";

import type { ClassifierInput } from "@ggui-ai/ui-gen/classifier";
import type { BenchmarkFixture } from "./types";

const FIXTURES: BenchmarkFixture[] = [
  activityFeed,
  chatInterface,
  flightStatus,
  inboxTriage,
  kanbanBoard,
  onboardingWizard,
  periodicTable,
  placeSearch,
  planMyWeek,
  productPage,
  stockTicker,
  surveyForm,
  uberRide,
  weatherCard,
];

describe("classifier snapshot — locks AxisVector + riskTier across all 14 fixtures", () => {
  test.each(FIXTURES.map((fx) => [fx.id, fx]))(
    "%s",
    (_id, fx) => {
      const result = classifyAxes({
        contract: fx.contract as ClassifierInput,
        prompt: fx.prompt,
        blueprint: fx.blueprint,
      });

      expect(result.vector).toEqual(fx.expected.vector);
      expect(result.riskTier).toBe(fx.expected.riskTier);
      expect(result.provenance).toEqual(fx.expected.provenance);
    },
  );
});
