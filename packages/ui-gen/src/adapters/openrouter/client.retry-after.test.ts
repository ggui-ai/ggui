import { describe, expect, it, vi, afterEach } from "vitest";
import { OpenRouterClient } from "./client.js";

describe("OpenRouterClient — retry-after header capture (#489)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chatCompletion() attaches the response Retry-After header to the thrown OpenRouterError", async () => {
    const headers = new Headers({ "retry-after": "7" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers,
        })
      )
    );
    const client = new OpenRouterClient({ apiKey: "test-key" });
    await expect(client.chatCompletion({ model: "x", messages: [] })).rejects.toMatchObject({
      status: 429,
      message: "rate limited",
    });
    try {
      await client.chatCompletion({ model: "x", messages: [] });
      throw new Error("expected rejection");
    } catch (e) {
      const err = e as { headers?: { get(name: string): string | null } };
      expect(err.headers?.get("retry-after")).toBe("7");
    }
  });
});
