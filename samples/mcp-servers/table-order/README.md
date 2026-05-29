# `@ggui-samples/mcp-table-order`

A realistic reference sample: a restaurant table-ordering backend exposed as
**two persona-scoped MCP endpoints over one shared SQLite database**. It's the
"applied" companion to the minimal `mcp-todo` sample.

```
one node process (default port 6783)
  POST /customer/mcp   ← table-bound diner tools     (browse / add / submit / …)
  POST /owner/mcp      ← restaurant-wide owner tools  (queue / status / sales / floor / …)
  GET  /assets/<file>  ← menu photos
  GET  /admin/state    ← debug dump      POST /admin/reset (or /admin/seed) ← re-seed
      │
      └─ shared in-process core: service.ts (rules + authz) → store.ts → SQLite
```

**The route picks the persona.** Point an agent at `/customer/mcp` and it sees
the diner's tools; point it at `/owner/mcp` and it sees the owner's. Same
database underneath, so the order a diner submits shows up on the owner's
kitchen board. That's the "two faces, one restaurant" demo.

## This server does not render UI

Like every ggui domain server, this is a **pure data backend**. It exposes
write-capable tools and returns structured data; a ggui-connected **agent**
decides what to draw by calling `ggui_render`. Role-scoped `tools/list` is what
makes the two faces look like different apps — the agent simply _sees_ a
different tool catalog and renders a menu of cards vs. a kitchen board vs. a
sales chart. There are no `ggui_*` calls anywhere in this package.

## Run it

```bash
pnpm --filter @ggui-samples/mcp-table-order start          # boots on :6783
pnpm --filter @ggui-samples/mcp-table-order test           # selftest + mcp-test
```

Wire it into an agent the same way as the todo sample — two MCP servers, one
per endpoint:

```jsonc
{
  "customer": { "url": "http://localhost:6783/customer/mcp" },
  "owner": { "url": "http://localhost:6783/owner/mcp" },
}
```

Run the agent against one endpoint or the other to switch faces. (For the
claude sample agent, also add the new tool prefixes to its allowlist.)

## Tools

| `/customer/mcp` (table-bound)                            | `/owner/mcp` (restaurant-wide)                 |
| -------------------------------------------------------- | ---------------------------------------------- |
| `browse_menu`, `get_item_details`                        | `get_order_queue`, `update_order_status`       |
| `add_to_order`, `update_order_item`, `remove_order_item` | `set_menu_availability`, `get_sales_summary`   |
| `view_order`, `submit_order`, `request_assistance`       | `list_tables`, `respond_to_call`, `void_order` |
| `whoami`                                                 | `whoami`                                       |

The diner's table comes from identity (`AuthContext.tableId`), so customer
tools take **no** table argument — the agent can't order for the wrong table.

## Auth & security (read this)

`resolveAuth(req, route)` resolves a persona from the route plus an optional
bearer token / `x-ggui-table` header, with permissive demo defaults so the
sample runs with zero setup. **This is a sample-local convention, not part of
the ggui protocol.** In production, replace `resolveAuth` with real MCP OAuth
(bearer → principal → role/scopes); nothing else changes.

**Filtering the tool list by route is UX, not a security boundary.** The
boundary is `service.ts`: every mutating call re-asserts the resolved
`AuthContext` before it runs and raises a typed `PERMISSION_DENIED` on
violation (a customer cannot `void_order`; a customer cannot edit another
table's line — even if the call is somehow named). The `selftest` proves this.

## Demo data

`seed.ts` loads one fully-populated restaurant: a 15-item menu (with photos +
modifier groups, two items pre-"86'd"), a floor of tables (one calling for
help), and several in-flight + completed orders — so the kitchen board and
sales chart have data on first load. `POST /admin/reset` re-seeds.

Photos are served from `/assets/<file>` (relative paths in the seed are
absolutized per-request). Until real photos are dropped into `assets/`, the
route generates a labeled placeholder SVG — see `assets/CREDITS.md`.

## Contract placement (for the agent that renders this)

When the agent renders these surfaces with ggui, keep it principle-clean:
commits (`add_to_order`, `submit_order`, `update_order_status`, `void_order`)
are **actionSpec** events; live draft state (a quantity being stepped, a
modifier being toggled before commit) is **contextSpec**; the stepper mechanic
and any order-tracker animation are **component behavior** (generated code),
not contract fields.

## Layout

```
src/
  index.ts      HTTP server: /customer/mcp + /owner/mcp + /assets + /admin
  auth.ts       resolveAuth(req, route) → AuthContext  (sample-local; swap for OAuth)
  tools/
    customer.ts registerCustomerTools — the diner catalog
    owner.ts    registerOwnerTools — the owner catalog
  service.ts    business rules + the authz re-assertion (security boundary)
  pricing.ts    pure line pricing (shared by seed + service)
  store.ts      SQLite data access (rows validated via zod, no casts)
  db.ts         SQLite connection + schema
  seed.ts       the demo restaurant
  types.ts      domain types + AuthContext + typed DomainError
  selftest.ts   deterministic data-core smoke
  mcp-test.ts   MCP-level smoke (tools/list scoping, calls, errors, HTTP)
assets/         menu photos (generated placeholders until real ones are added)
```
