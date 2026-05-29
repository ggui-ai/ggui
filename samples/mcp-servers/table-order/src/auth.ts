/**
 * Resolve a per-request `AuthContext` from the request + the MCP route.
 *
 * IMPORTANT: this is the SAMPLE's auth seam, NOT part of the ggui protocol.
 * The route selects the persona (`/customer/mcp` → customer, `/owner/mcp`
 * → owner); within that, a bearer token (static demo map) or an
 * `x-ggui-table` header binds a customer to a table. Everything has a
 * permissive default so the sample runs with zero setup.
 *
 * Production: replace `resolveAuth` with real MCP OAuth (bearer →
 * principal → role/scopes). Nothing else in the server changes. And note —
 * list-filtering tools by route is UX only; `service.ts` re-asserts the
 * resolved context before every mutation. That is the security boundary.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { DEMO_TABLE_ID, RESTAURANT_ID } from './seed.js';
import type { AuthContext, Role } from './types.js';

export interface AuthRequestLike {
  readonly headers: IncomingHttpHeaders;
  readonly url?: string;
}

interface TokenEntry {
  readonly role: Role;
  readonly tableId?: string;
  readonly principalId: string;
}

/** Demo-only token → context map. Swap for real OAuth in production. */
const TOKEN_MAP: Readonly<Record<string, TokenEntry>> = {
  'demo-customer-table-7': { role: 'customer', tableId: 'tbl-7', principalId: 'diner:tbl-7' },
  'demo-customer-table-2': { role: 'customer', tableId: 'tbl-2', principalId: 'diner:tbl-2' },
  'demo-owner': { role: 'owner', principalId: 'owner:demo' },
};

function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers.authorization;
  if (typeof raw !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1] : undefined;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function resolveAuth(req: AuthRequestLike, route: Role): AuthContext {
  const token = bearerToken(req.headers);
  if (token) {
    const entry = TOKEN_MAP[token];
    // The token's role must match the route it was presented on.
    if (entry && entry.role === route) {
      return {
        role: entry.role,
        restaurantId: RESTAURANT_ID,
        tableId: entry.tableId,
        principalId: entry.principalId,
      };
    }
  }

  if (route === 'customer') {
    const fromHeader = headerValue(req.headers, 'x-ggui-table');
    const fromQuery = req.url
      ? (new URL(req.url, 'http://localhost').searchParams.get('table') ?? undefined)
      : undefined;
    const tableId = fromHeader ?? fromQuery ?? DEMO_TABLE_ID;
    return { role: 'customer', restaurantId: RESTAURANT_ID, tableId, principalId: `diner:${tableId}` };
  }

  return { role: 'owner', restaurantId: RESTAURANT_ID, principalId: 'owner:demo' };
}
