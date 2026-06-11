/**
 * `subscribe-tenancy` fixture sub-module.
 *
 * Exercises the subscribe-time tenancy contract (SPEC §12.2 subscribe
 * payload table + §12.2.3 channel-3 error codes):
 *
 *   - `app-mismatch` — the GguiSession exists but is bound to a
 *     different `appId` than the subscribe claims. §12.2 is explicit
 *     MUST language (a present `appId` "MUST match the GguiSession's
 *     bound `appId` or subscribe fails `APP_MISMATCH`"), and §12.2.3
 *     keeps the code distinct from `SESSION_NOT_FOUND` so clients can
 *     route the two recoveries (fix-appId vs re-handshake)
 *     differently.
 *
 *   - `absent-appid-defaults` — `appId` is OPTIONAL on the subscribe
 *     payload: absence resolves the caller's identity-default app
 *     (§12.2's resolution rule — token binding, else identity
 *     mapping, else the deployment default) and the subscribe acks.
 *     Graded as a session-state read-back of the bound `appId` on the
 *     provisioned render (hosts expose it via `readSessionField`), so
 *     a server that acks but binds an undefined tenant — the
 *     corrupt-row failure mode — fails rather than passing on the ack
 *     alone.
 *
 * ## Declared gaps — the other subscribe-rejection codes
 *
 * `SESSION_NOT_FOUND` (§12.2.3) is canonical VOCABULARY here, not a
 * graded subscribe obligation: the §12.2 subscribe-payload table
 * attaches a MUST to a PRESENT `appId` only. Whether a subscribe targeting an
 * unknown `sessionId` rejects or provisions is implementation-defined
 * — the first-party `@ggui-ai/mcp-server` channel deliberately
 * PROVISIONS the GguiSession on first subscribe (its dev-mode
 * render-provisioning seam; deployments tighten it via the
 * `AuthAdapter`), and the reference server provisions the same way. A
 * fixture demanding the error frame would fail conformant servers.
 * The first-party emission site for the code is the ACTION path (the
 * GguiSession vanished between subscribe and action) — not drivable
 * by the kit: there is no delete-session directive, by design
 * (renders decay via TTL). Note §12.2.3's provenance column ("emitted
 * by subscribe handlers") contradicts the shipping subscribe
 * behavior; resolving that is an upstream SPEC decision, declared
 * here rather than graded prematurely.
 *
 * `AUTH_REJECTED` is not a §12.2.3 channel-3 code at all. Failing
 * upgrade-auth rejects the HTTP upgrade itself (the WebSocket never
 * opens, so no error frame exists to match); the in-band `wsToken`
 * path rejects with the dedicated `BOOTSTRAP_INVALID` /
 * `BOOTSTRAP_EXPIRED` codes; and the `AUTH_REJECTED`
 * `ContractErrorCode` rides the `_ggui:contract-error` reserved
 * channel, whose server-side emission is an explicitly-declared gap
 * (SPEC §4.4 "No first-party emitter"). There is no wire surface on
 * which a failing-auth subscribe produces an `AUTH_REJECTED` frame
 * today, so no fixture ships and no fixture-level auth-override knob
 * was added — it would be dead vocabulary until such a surface
 * exists.
 */
import absentAppidDefaults from './absent-appid-defaults.json' with { type: 'json' };
import appMismatch from './app-mismatch.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting subscribe-time tenancy (SPEC §12.2 field
 *  table — identity-default resolution on absent `appId` — and
 *  §12.2.3 `APP_MISMATCH`). */
export const subscribeTenancyFixtures: readonly TestCase[] = [
  absentAppidDefaults as TestCase,
  appMismatch as TestCase,
];
