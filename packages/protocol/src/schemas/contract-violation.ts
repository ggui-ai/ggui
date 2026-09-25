/**
 * Zod mirror of {@link ContractViolation} — one finding from
 * `validateActionData` / `validateContract`: the field that failed, a
 * human-readable message, and the optional expected / received / keyword
 * facts. The same shape the live channel already sends inside its
 * `CONTRACT_VIOLATION` error frame (`ContractViolationError.toErrorData()`);
 * it exists as a schema so the `ggui_runtime_submit_action` relay can
 * declare the same facts on its `{ ok: false, code: 'CONTRACT_VIOLATION' }`
 * answer (ggui#1358). `ContractViolation` extends `JsonObject`, so the
 * mirror is loose: a validator MAY carry further JSON members.
 */
import { z } from 'zod';
import type { ContractViolation } from '../validation/contract-validator';

export const contractViolationSchema: z.ZodType<ContractViolation> = z
  .object({
    field: z.string(),
    message: z.string(),
    expected: z.string().optional(),
    received: z.string().optional(),
    keyword: z.string().optional(),
  })
  .loose() as z.ZodType<ContractViolation>;
