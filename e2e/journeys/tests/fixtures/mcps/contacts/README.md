# Contacts MCP fixture

The third stateful MCP fixture — the "Contacts" domain — per the OSS
stateful-MCP strategy
(`docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md` §8).
Completes the blocking trio (Tasks + Notes + Contacts).

Ships **only** as a test fixture. Not a product surface. Not published.

## Why Contacts (after Tasks + Notes)

Strategy §9: closes the trio, proves the mounted-MCP pattern holds for a
third distinct domain, and pre-positions the cross-ref seam for Slice 6.4
(the first 2-MCP composition E2E).

Three distinct data-shape profiles across the trio:

| Aspect            | Tasks                     | Notes                      | **Contacts** (this fixture)                  |
| ----------------- | ------------------------- | -------------------------- | -------------------------------------------- |
| Core content      | Short action title        | Title + markdown body      | Identity + communication metadata            |
| State             | Status machine            | `pinned` boolean + tags    | `favorite` boolean + tags                    |
| Taxonomy          | Single `priority` enum    | `tags[]` (multi-label)     | `tags[]` (multi-label, same regex as Notes)  |
| Cross-ref (out)   | `assigneeId → Contact`    | `aboutContactId → Contact` | —                                            |
| Cross-ref (in)    | —                         | `linkedTaskIds[]`          | `linkedTaskIds[]` + `linkedNoteIds[]`        |
| Domain-specific   | `tasks_complete` (status) | `notes_append` (body)      | `contacts_link` (cross-ref add/remove)       |
| Search surface    | Title LIKE                | Title OR body              | displayName OR email OR company              |
| Natural blueprint | Kanban / list / form      | Markdown detail / timeline | Detail / alphabetical list / cross-ref panel |

**Search differentiator ladder**: Tasks title-only → Notes title-OR-body
→ Contacts tri-field (displayName, email, company). Each MCP asserts a
visibly distinct query surface so the blueprint negotiator has clean
signals to pick between a list, a search-results view, and an
identity-centric detail.

**Cross-ref semantics**: Tasks points at Contacts via `assigneeId`, Notes
via `aboutContactId`. Contacts maintains the reverse sides
(`linkedTaskIds[]` + `linkedNoteIds[]`) so a composition slice can render
"Alice's open tasks + recent notes" from one fetch without asking the
Tasks/Notes stores to know that Contacts exists. The `contacts_link`
tool is the cross-ref management seam; nothing in this slice consumes
it cross-MCP.

## Entity shape

Locked per strategy §8.1 + §9 cross-ref enrichment:

```
Contact = {
  id,
  displayName,                 // required, the list-label
  givenName: string | null,    // structured breakdown when known
  familyName: string | null,
  email: string | null,        // RFC-reasonable, `.email()` zod
  phone: string | null,        // freeform (intl format, regional quirks)
  company: string | null,
  tags: string[],              // canonicalised (dedup + sort) like Notes
  favorite: boolean,           // entity-level flag (vs Note.pinned)
  linkedTaskIds: string[],     // id-reference-by-convention → tasks
  linkedNoteIds: string[],     // id-reference-by-convention → notes
  createdAt, updatedAt
}
```

## Tool surface

Seven tools — the six canonical `<entity>_*` tools plus `contacts_link`:

| Tool              | Input                               | Output                    |
| ----------------- | ----------------------------------- | ------------------------- |
| `contacts_list`   | `{filter?, sort?, cursor?, limit?}` | `{items, nextCursor?}`    |
| `contacts_get`    | `{id}`                              | `{item: Contact \| null}` |
| `contacts_create` | `{input}`                           | `{item: Contact}`         |
| `contacts_update` | `{id, patch}`                       | `{item: Contact \| null}` |
| `contacts_delete` | `{id}`                              | `{deleted: boolean}`      |
| `contacts_search` | `{query, filter?, limit?}`          | `{items, totalMatches}`   |
| `contacts_link`   | `{id, link:{kind,targetId,op}}`     | `{item: Contact \| null}` |

All seven registered in `server.ts` (standalone) AND `handlers.ts` (the
`SharedHandler` bundle consumed by the OSS mount seam). `handlers.test.ts`
asserts referential parity between the two surfaces so drift fails loudly.

## Tags

Same contract as Notes — lowercase alphanumeric + hyphens
(`^[a-z0-9][a-z0-9-]{0,31}$`). Canonicalised (dedup + sort) at every
store boundary — set equality, not array equality. Sharing the regex
across Notes + Contacts is intentional: a cross-MCP tag join never trips
a silent casing bucket mismatch.

## Testing

- `store.test.ts` — direct store CRUD + filter/sort + search + link semantics.
- `handlers.test.ts` — `SharedHandler` bundle parity with `server.ts` + dispatch into the store.
- `server.test.ts` — MCP wire-level contract via `InMemoryTransport`.
- `mount-integration.test.ts` — full `createGguiServer({ mcpMounts: [...] })` boot + MCP HTTP round-trip.

Run with:

```sh
pnpm --filter @ggui-private/e2e-oss test:mcp-fixtures
```
