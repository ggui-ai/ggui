/**
 * The Anthropic model-family rules (`../anthropic-model-rules`) — moved
 * here with the predicates they pin, from `@ggui-ai/ui-gen`'s router
 * test (ggui#1255/#1264: one list every Anthropic caller imports).
 *
 * Strings per ggui#706's verified table (platform.claude.com,
 * 2026-09-02) — never from memory.
 */
import { describe, expect, it } from "vitest";
import {
  anthropicRejectsForcedToolChoice,
  anthropicRejectsSamplingParams,
  normalizeAnthropicModelId,
} from "../anthropic-model-rules.js";
import { BEDROCK_INFERENCE_REGION_PREFIXES } from "../llm-route.js";

describe("normalizeAnthropicModelId", () => {
  it("reduces every routing spelling to the bare API id", () => {
    expect(normalizeAnthropicModelId("anthropic/claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(normalizeAnthropicModelId("anthropic.claude-opus-5")).toBe("claude-opus-5");
    expect(normalizeAnthropicModelId("us.anthropic.claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeAnthropicModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "claude-haiku-4-5-20251001-v1:0"
    );
    expect(normalizeAnthropicModelId("claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  it("leaves ARNs alone (they name a profile, not a family)", () => {
    const arn = "arn:aws:bedrock:us-east-1:123:inference-profile/x";
    expect(normalizeAnthropicModelId(arn)).toBe(arn);
  });
});

describe("anthropicRejectsSamplingParams — Opus 4.7+ and the 5-family", () => {
  it.each([
    "claude-opus-4-7",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "anthropic/claude-fable-5-1",
    "us.anthropic.claude-opus-5",
    "anthropic.claude-sonnet-5",
  ])("%s rejects sampling params", (id) => {
    expect(anthropicRejectsSamplingParams(id)).toBe(true);
  });

  it.each([
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "anthropic/claude-haiku-4-5",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
  ])("%s still accepts sampling params", (id) => {
    expect(anthropicRejectsSamplingParams(id)).toBe(false);
  });

  it("does not false-match a longer family name by prefix", () => {
    // "opus-5" must not match "opus-50" and "fable-5" must not match "fable-55".
    expect(anthropicRejectsSamplingParams("claude-opus-50")).toBe(false);
    expect(anthropicRejectsSamplingParams("claude-fable-55")).toBe(false);
  });
});

describe("anthropicRejectsForcedToolChoice — Fable 5.1 only", () => {
  it("flags Fable 5.1 in every spelling", () => {
    expect(anthropicRejectsForcedToolChoice("claude-fable-5-1")).toBe(true);
    expect(anthropicRejectsForcedToolChoice("anthropic/claude-fable-5-1")).toBe(true);
    expect(anthropicRejectsForcedToolChoice("us.anthropic.claude-fable-5-1")).toBe(true);
  });

  it("does not flag Fable 5, Opus 5, Sonnet 5 or Haiku 4.5", () => {
    for (const id of ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(anthropicRejectsForcedToolChoice(id)).toBe(false);
    }
  });
});

// ─── ggui#1254 — Opus 5.5, Mythos, every Bedrock profile, OpenRouter's dotted ids ───

describe("BEDROCK_INFERENCE_REGION_PREFIXES — the one region list (ggui#1254)", () => {
  it("is exactly the six AWS cross-region profile prefixes", () => {
    expect([...BEDROCK_INFERENCE_REGION_PREFIXES]).toEqual(["us", "eu", "au", "jp", "apac", "global"]);
  });
});

describe("normalizeAnthropicModelId — every region profile and the bedrock/ form (ggui#1254)", () => {
  it("strips every prefix in the list, and a bedrock/ prefix", () => {
    for (const region of BEDROCK_INFERENCE_REGION_PREFIXES) {
      expect(normalizeAnthropicModelId(`${region}.anthropic.claude-opus-5-5`)).toBe("claude-opus-5-5");
    }
    expect(normalizeAnthropicModelId("bedrock/global.anthropic.claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(normalizeAnthropicModelId("bedrock/anthropic.claude-fable-5-1")).toBe("claude-fable-5-1");
    expect(normalizeAnthropicModelId("apac.anthropic.claude-fable-5-1")).toBe("claude-fable-5-1");
  });

  it("does not strip a prefix that is not an AWS profile", () => {
    expect(normalizeAnthropicModelId("xx.anthropic.claude-opus-5-5")).toBe("xx.anthropic.claude-opus-5-5");
  });
});

describe("anthropicRejectsForcedToolChoice — Fable 5.1, Mythos 5.1, Opus 5.5, Mythos Preview (ggui#1254)", () => {
  it("flags Opus 5.5 in every spelling — bare, anthropic/, anthropic., us., global., apac., bedrock/", () => {
    for (const id of [
      "claude-opus-5-5",
      "anthropic/claude-opus-5-5",
      "anthropic.claude-opus-5-5",
      "us.anthropic.claude-opus-5-5",
      "global.anthropic.claude-opus-5-5",
      "apac.anthropic.claude-opus-5-5",
      "bedrock/global.anthropic.claude-opus-5-5",
    ]) {
      expect(anthropicRejectsForcedToolChoice(id), id).toBe(true);
    }
  });

  it("flags Claude Mythos 5.1 and Mythos Preview, the rest of the forced-tool set in the API reference", () => {
    expect(anthropicRejectsForcedToolChoice("claude-mythos-5-1")).toBe(true);
    expect(anthropicRejectsForcedToolChoice("global.anthropic.claude-mythos-5-1")).toBe(true);
    expect(anthropicRejectsForcedToolChoice("claude-mythos-preview")).toBe(true);
  });

  it("flags OpenRouter's dotted spellings of both families", () => {
    expect(anthropicRejectsForcedToolChoice("anthropic/claude-opus-5.5")).toBe(true);
    expect(anthropicRejectsForcedToolChoice("anthropic/claude-fable-5.1")).toBe(true);
    expect(anthropicRejectsForcedToolChoice("global.anthropic.claude-fable-5-1")).toBe(true);
  });

  it("does not flag Opus 5, Fable 5, Mythos 5, a longer version number, or a non-Anthropic id", () => {
    for (const id of [
      "claude-opus-5",
      "claude-opus-5-50",
      "anthropic/claude-opus-5",
      "claude-mythos-5",
      "claude-fable-5",
      "openai/gpt-6-sol",
      "gpt-6-luna",
    ]) {
      expect(anthropicRejectsForcedToolChoice(id), id).toBe(false);
    }
  });
});

describe("anthropicRejectsSamplingParams — Opus 5.5 pinned explicitly (ggui#1254)", () => {
  it("flags claude-opus-5-5 in its API and Bedrock spellings", () => {
    expect(anthropicRejectsSamplingParams("claude-opus-5-5")).toBe(true);
    expect(anthropicRejectsSamplingParams("global.anthropic.claude-opus-5-5")).toBe(true);
  });
});
