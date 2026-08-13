/**
 * Direct rendering tests for ReactComponentRenderer.
 *
 * NOTE: Full dynamic import tests require a browser environment (jsdom
 * doesn't support URL.createObjectURL + import()). These tests verify
 * the component mounting behavior and wire context integration.
 *
 * Full E2E rendering validation:
 * - Benchmarks: See core package benchmarks
 * - Visual: make vnc && Chrome DevTools MCP
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "@testing-library/react";
import { ReactComponentRenderer } from "../components/ReactComponentRenderer.js";

describe("ReactComponentRenderer", () => {
  it("shows fallback while loading", () => {
    const { container } = render(
      <ReactComponentRenderer
        code={"export default function C() { return null; }"}
        fallback={<div data-testid="loading">Loading...</div>}
      />
    );

    expect(container.querySelector('[data-testid="loading"]')).not.toBeNull();
  });

  it("shows fallback for empty code", () => {
    const { container } = render(
      <ReactComponentRenderer code="" fallback={<div data-testid="empty">No code</div>} />
    );

    expect(container.querySelector('[data-testid="empty"]')).not.toBeNull();
  });

  it("calls onError for invalid module code", async () => {
    const onError = vi.fn();

    render(
      <ReactComponentRenderer
        code="this is not valid javascript module"
        onError={onError}
        fallback={<div>Loading...</div>}
      />
    );

    // Wait for async load attempt
    await new Promise((r) => setTimeout(r, 200));

    // onError should have been called (URL.createObjectURL fails in jsdom)
    expect(onError).toHaveBeenCalled();
  });

  it("sets globalThis.__ggui__ registry during load", async () => {
    render(
      <ReactComponentRenderer
        code={"export default function C() { return null; }"}
        fallback={<div>Loading...</div>}
      />
    );

    // Wait for async load attempt
    await new Promise((r) => setTimeout(r, 200));

    // The registry should be set even if dynamic import fails in jsdom
    const registry = (globalThis as Record<string, unknown>).__ggui__ as
      | Record<string, unknown>
      | undefined;
    expect(registry).toBeDefined();
    expect(registry?.react).toBeDefined();
    expect(registry?.wire).toBeDefined();
    expect(registry?.primitives).toBeDefined();
  });
});
