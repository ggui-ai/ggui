/**
 * Domain types for the table-order sample.
 *
 * These describe the restaurant's data + the per-request auth context.
 * They are *sample-local* shapes — NOT part of the ggui protocol. A
 * production system would resolve `AuthContext` from real auth (MCP
 * OAuth → principal → role/scopes); here it comes from a static token
 * map (see `auth.ts`). Money is always integer cents to avoid float drift.
 */

/** Persona resolved from the MCP endpoint route (`/customer/mcp` vs `/owner/mcp`). */
export type Role = 'customer' | 'owner';

/**
 * Per-request identity. Resolved once per MCP request and threaded into
 * every `service.ts` call, which re-asserts it before mutating (the route
 * picking the persona is UX/structure, NOT the security boundary).
 */
export interface AuthContext {
  readonly role: Role;
  /** Single restaurant for the demo; reserved for multi-tenant variants. */
  readonly restaurantId: string;
  /** Present iff `role === 'customer'` — the table the diner is bound to. */
  readonly tableId?: string;
  /** Stable id for audit / `whoami` (e.g. the token's subject). */
  readonly principalId: string;
}

export type MoneyCents = number;

export type MenuCategory = 'starters' | 'mains' | 'drinks' | 'desserts';
export type MenuTag = 'spicy' | 'vegetarian' | 'vegan' | 'gluten_free' | 'popular';

/** One choice within a modifier group, e.g. "Large (+$2)". */
export interface ModifierOption {
  readonly id: string;
  readonly label: string;
  readonly priceDeltaCents: MoneyCents;
}

/** A group of modifiers, e.g. "Size" (single-select) or "Extras" (multi). */
export interface ModifierGroup {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly multi: boolean;
  readonly options: readonly ModifierOption[];
}

export interface MenuItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: MoneyCents;
  readonly category: MenuCategory;
  readonly tags: readonly MenuTag[];
  readonly options: readonly ModifierGroup[];
  readonly available: boolean;
  /** Relative asset path, e.g. `/assets/margherita.svg`; absolutized at request time. */
  readonly photoPath: string;
}

/** A modifier the diner picked, by group + option id. */
export interface SelectedOption {
  readonly groupId: string;
  readonly optionId: string;
}

export interface OrderLine {
  readonly lineId: string;
  readonly itemId: string;
  /** Denormalized item name snapshot for display without a join. */
  readonly name: string;
  readonly qty: number;
  readonly selectedOptions: readonly SelectedOption[];
  readonly lineTotalCents: MoneyCents;
}

export type OrderStatus =
  | 'draft'
  | 'submitted'
  | 'cooking'
  | 'ready'
  | 'served'
  | 'voided';

/** Lifecycle order: draft → submitted → cooking → ready → served (voided is terminal). */
export const ORDER_FLOW: readonly OrderStatus[] = [
  'draft',
  'submitted',
  'cooking',
  'ready',
  'served',
];

export interface Order {
  readonly orderId: string;
  readonly tableId: string;
  readonly status: OrderStatus;
  readonly lines: readonly OrderLine[];
  readonly subtotalCents: MoneyCents;
  /** ISO timestamp set when the diner submits; `null` while `draft`. */
  readonly placedAt: string | null;
  readonly updatedAt: string;
}

export type TableStatus = 'empty' | 'seated' | 'needs_assistance';

export interface RestaurantTable {
  readonly tableId: string;
  readonly label: string;
  readonly status: TableStatus;
  readonly currentOrderId: string | null;
}

export interface SalesSummary {
  readonly period: SalesPeriod;
  readonly orderCount: number;
  readonly revenueCents: MoneyCents;
  readonly topItems: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly qty: number;
    readonly revenueCents: MoneyCents;
  }[];
}

export type SalesPeriod = 'today' | 'week' | 'all';

// ---------------------------------------------------------------------------
// Typed domain errors. Handlers map these to MCP tool errors; the `code`
// is the observable contract the agent surfaces to the user.
// ---------------------------------------------------------------------------

export type DomainErrorCode = 'PERMISSION_DENIED' | 'NOT_FOUND' | 'VALIDATION';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

/** Caller is not permitted to perform this action under its `AuthContext`. */
export class PermissionDeniedError extends DomainError {
  constructor(message: string) {
    super('PERMISSION_DENIED', message);
    this.name = 'PermissionDeniedError';
  }
}

/** A referenced entity (item, order, line, table) does not exist. */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super('NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

/** Input violated a domain rule (bad qty, unknown modifier, illegal transition). */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super('VALIDATION', message);
    this.name = 'ValidationError';
  }
}
