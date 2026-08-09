/**
 * #446 trap pin — the WS bootstrap credential must never become a
 * row's subject.
 *
 * `subscribe.ts` synthesizes an `AuthResult` whose `userId` is the
 * SESSION ID, so a subscriber row has an identity for logging and
 * roster inspection. That value is a render-scoped credential: every
 * holder of the bootstrap token for a session presents it. If it ever
 * reached the row as its subject, the render-read gate's subject rung
 * would compare a caller's credential against itself and pass every
 * bearer — turning the gate into a no-op precisely where it matters.
 *
 * The behavioral half lives in `render-read-gate.test.ts` (a bound row
 * is NOT readable by a bootstrap credential). This is the structural
 * half: the dev path must not hand a subject to the store at all.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SUBSCRIBE = new URL(
  "./ggui-session-channel/subscribe.ts",
  import.meta.url,
);

describe("subscribe.ts — the dev path mints no subject", () => {
  it("synthesizes userId from the sessionId for the auth result", async () => {
    const source = await readFile(SUBSCRIBE, "utf-8");
    // Guards the premise: if this synthesis ever stops happening, the
    // trap below is moot and this pin should be revisited rather than
    // silently passing forever.
    expect(source).toContain("userId: bound.sessionId");
  });

  it("creates the row with id + appId only — never a userId", async () => {
    const source = await readFile(SUBSCRIBE, "utf-8");
    const call = source.slice(
      source.indexOf("stored = await deps.renderStore.create({"),
    );
    const body = call.slice(0, call.indexOf("});") + 3);
    expect(body).toContain("id: payload.sessionId");
    expect(body).toContain("appId: effectiveAppId");
    // The whole point: no subject reaches the row here. It arrives
    // later from the agent's commit, via if-not-exists.
    expect(body).not.toContain("userId");
    expect(body).not.toContain("effectiveIdentity");
  });
});
