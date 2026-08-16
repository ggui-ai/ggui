/**
 * Strict-CSP hygiene (ggui#522 slice 3): declare zod v4 jitless BEFORE
 * any schema-defining module initializes.
 *
 * zod v4 feature-probes codegen with `new Function("")` and falls back
 * cleanly when a CSP forbids it — correct, but the ATTEMPT fires a
 * `securitypolicyviolation` (script-src eval) report in every strict
 * host, polluting the exact diagnostic channel embedders watch (and
 * scenario 27's regression net asserts on). The probe can run during
 * dependency module-init (schemas are constructed at module scope
 * across `@ggui-ai/protocol` / the ext-apps SDK), so a config call in
 * the entry's own body is too late — this module exists to be the
 * runtime entry's FIRST import, ahead of everything that constructs a
 * schema. The frame never wants zod codegen anyway; jitless validation
 * speed is a non-factor at frame scale.
 */
import { z } from 'zod';

z.config({ jitless: true });
