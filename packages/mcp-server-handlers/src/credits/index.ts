/**
 * Credit handler family — MCP tools for the prepaid LLM-pool credit
 * system.
 *
 * Two read-only tools (no write surface today — paid top-up and the
 * free-credit grant are handled outside this package):
 *
 *   - `createGetCreditBalanceHandler({creditBalance})` — point-read
 *     of the live balance row.
 *   - `createListCreditTransactionsHandler({creditTransactions})` —
 *     paginated newest-first list of the ledger.
 *
 * Both factories take a seam dep (`CreditBalanceSource` /
 * `CreditTransactionSource`) so a cloud deployment can back them
 * with a real datastore while tests inject in-memory fakes.
 *
 * Neither tool tags `allowedFor` — the same toolset registers on
 * every deployment kind, both the end-user-facing posture and the
 * agent-builder posture. Callers without a credit account get the
 * zero-row fallback / empty ledger; auth + billing distinctions
 * live at the adapter layer, not at registration time.
 *
 * All seam-pure: no AWS imports, no config loading, no logging
 * side-channel — same posture as the blueprint family.
 */

export {
  createGetCreditBalanceHandler,
} from './get-credit-balance.js';
export type {
  CreditBalanceSource,
  CreditBalanceView,
  GetCreditBalanceDeps,
  GetCreditBalanceOutput,
} from './get-credit-balance.js';

export {
  createListCreditTransactionsHandler,
} from './list-credit-transactions.js';
export type {
  CreditTransactionSource,
  CreditTransactionView,
  ListCreditTransactionsDeps,
  ListCreditTransactionsOutput,
} from './list-credit-transactions.js';
