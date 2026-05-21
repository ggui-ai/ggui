# Notes MCP fixture

The second stateful MCP fixture — the "Notes" domain — per the OSS
stateful-MCP strategy
(`docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md` §8).

Ships **only** as a test fixture. Not a product surface. Not published.

## Why Notes (after Tasks)

Strategy §9: proves the mounted-MCP pattern generalises, **and** exercises a
meaningfully different blueprint-signal surface from Tasks:

| Aspect            | Tasks (reference)                          | Notes (this fixture)                           |
| ----------------- | ------------------------------------------ | ---------------------------------------------- |
| Core content      | Short title                                | Title + markdown **body** (freeform)           |
| State             | Status machine (`todo/doing/done/blocked`) | No status; `pinned` boolean + tag set          |
| Taxonomy          | Single `priority` enum                     | `tags[]` (multi-label)                         |
| Cross-ref         | `assigneeId`, `linkedNoteId`               | `aboutContactId`, `linkedTaskIds[]`            |
| Domain-specific   | `tasks_complete` (status transition)       | `notes_append` (append markdown w/o replacing) |
| Search surface    | Title LIKE                                 | Title **or** body substring                    |
| Natural blueprint | Kanban / list / form                       | Markdown detail, timeline, tag filter          |

`notes_search` matching against **body** is the key differentiator — an
agent asking "find the note that mentions pricing comparables" is a
legitimate query whose title gives no signal.

## Entity shape

Locked per strategy §8.1:

```
Note = {
  id, title, body,
  tags: string[],          // canonicalised (dedup + sort) at the store boundary
  pinned: boolean,
  aboutContactId?: string | null,
  linkedTaskIds: string[], // id-reference-by-convention (no FK validation)
  createdAt, updatedAt
}
```

## Tool surface

Seven tools — the six canonical `<entity>_*` tools plus `notes_append`:

| Tool           | Input                               | Output                  |
| -------------- | ----------------------------------- | ----------------------- |
| `notes_list`   | `{filter?, sort?, cursor?, limit?}` | `{items, nextCursor?}`  |
| `notes_get`    | `{id}`                              | `{item: Note \| null}`  |
| `notes_create` | `{input}`                           | `{item: Note}`          |
| `notes_update` | `{id, patch}`                       | `{item: Note \| null}`  |
| `notes_delete` | `{id}`                              | `{deleted: boolean}`    |
| `notes_search` | `{query, filter?, limit?}`          | `{items, totalMatches}` |
| `notes_append` | `{id, markdown}`                    | `{item: Note \| null}`  |

All seven registered in `server.ts` (standalone) AND `handlers.ts` (the
`SharedHandler` bundle consumed by the OSS mount seam). `handlers.test.ts`
asserts referential parity between the two surfaces so drift fails loudly.

## Tags

Tags are lowercase alphanumeric + hyphens (regex `^[a-z0-9][a-z0-9-]{0,31}$`).
Enforced at the schema layer so a typo like `Pricing` vs `pricing` can't
produce two silently-separate buckets. Canonicalised (dedup + sort) at every
store boundary — set equality, not array equality.

## Testing

- `store.test.ts` — direct store CRUD + filter/sort + search + append paragraph semantics.
- `handlers.test.ts` — `SharedHandler` bundle parity with `server.ts` + dispatch into the store.
- `server.test.ts` — MCP wire-level contract via `InMemoryTransport`.
- `mount-integration.test.ts` — full `createGguiServer({ mcpMounts: [...] })` boot + MCP HTTP round-trip.

Run with:

```sh
pnpm --filter @ggui-private/e2e-oss test:mcp-fixtures
```
