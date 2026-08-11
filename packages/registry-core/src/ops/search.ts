/**
 * `searchArtifacts` — pure op for `GET /search?…`. Delegates the
 * post-fetch filter + cursor to {@link RegistryStorage.scanArtifacts} so
 * every storage impl shares the single semantic — AND-composition over
 * q/kind/hook/tag/author/tool/server.
 *
 * Visibility: only `visibility: "public"` rows are exposed. Without that
 * filter the public `/search` route would leak private artifact IDs.
 * Impls MUST apply the visibility filter inside `scanArtifacts` — the
 * normative obligation on {@link RegistryStorage.scanArtifacts} (#474);
 * this op's post-fetch check is defense-in-depth ONLY, never the sole
 * gate (a private row that reaches the storage-layer page would
 * consume a `limit` slot before this filter ever discards it).
 */
import type {
  ArtifactKind,
  ArtifactScanFilter,
  ArtifactsMetadataRow,
  ScopeOwnerRow,
  SearchErrorBody,
  SearchResponse,
  SearchResultEntry,
  SearchSort,
} from '../types.js';
import { SEARCH_SORT_OPTIONS } from '../types.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';
import { artifactScope } from './private-read-authz.js';
import { MCP_TOOL_BINDING_NAME_RE } from '@ggui-ai/artifact-manifest';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface SearchArtifactsInput {
  readonly q?: string;
  readonly kind?: string;
  readonly hook?: string;
  readonly tag?: string;
  readonly author?: string;
  readonly limit?: string | number;
  readonly cursor?: string;
  /**
   * Optional sort. `'recent'` orders results by `publishedAt` DESC; any
   * other string is a 400. Default (omitted) is impl-defined ordering —
   * memory insertion order, filesystem directory order, or the backing
   * store's scan order. See {@link SearchSort} for the full enum.
   *
   * Ordering is served by the storage layer: the op forwards the sort
   * as `order` on the scan filter, and every
   * {@link RegistryStorage.scanArtifacts} impl MUST return a
   * globally-correct newest-first order across the full cursor chain.
   */
  readonly sort?: string;
  /**
   * Exact MCP tool-name filter — matches artifacts whose bindings
   * include this tool (declared under any server, or none). Must match
   * `^[A-Za-z0-9_.-]{1,128}$`; anything else is a 400.
   */
  readonly tool?: string;
  /**
   * Exact MCP server-name filter — matches artifacts whose bindings
   * declare this server; bindings without a server never match. Same
   * charset rule as `tool`.
   */
  readonly server?: string;
}

export interface SearchArtifactsDeps {
  readonly storage: RegistryStorage;
}

export type SearchArtifactsResult =
  | { readonly ok: true; readonly status: 200; readonly body: SearchResponse }
  | { readonly ok: false; readonly status: 400 | 500; readonly body: SearchErrorBody };

export async function searchArtifacts(
  input: SearchArtifactsInput,
  deps: SearchArtifactsDeps,
): Promise<SearchArtifactsResult> {
  let kind: ArtifactKind | undefined;
  if (input.kind !== undefined) {
    if (input.kind !== 'gadget' && input.kind !== 'blueprint') {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          message: '`kind` must be one of: gadget, blueprint',
        },
      };
    }
    kind = input.kind;
  }

  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    const raw = typeof input.limit === 'number' ? input.limit : Number.parseInt(input.limit, 10);
    if (!Number.isInteger(raw) || raw < 1 || raw > MAX_LIMIT) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          message: `\`limit\` must be an integer in [1, ${MAX_LIMIT}]`,
        },
      };
    }
    limit = raw;
  }

  let sort: SearchSort | undefined;
  if (input.sort !== undefined) {
    if (!isSearchSort(input.sort)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          message: `\`sort\` must be one of: ${SEARCH_SORT_OPTIONS.join(', ')}`,
        },
      };
    }
    sort = input.sort;
  }

  const tool = nonEmpty(input.tool);
  if (tool !== undefined && !MCP_TOOL_BINDING_NAME_RE.test(tool)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        message: '`tool` must match ^[A-Za-z0-9_.-]{1,128}$',
      },
    };
  }

  const server = nonEmpty(input.server);
  if (server !== undefined && !MCP_TOOL_BINDING_NAME_RE.test(server)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        message: '`server` must match ^[A-Za-z0-9_.-]{1,128}$',
      },
    };
  }

  const filter: ArtifactScanFilter = {
    q: nonEmpty(input.q),
    kind,
    hook: nonEmpty(input.hook),
    tag: nonEmpty(input.tag),
    author: nonEmpty(input.author),
    tool,
    server,
    limit,
    cursor: nonEmpty(input.cursor),
    order: sort,
  };

  let page: { rows: readonly ArtifactsMetadataRow[]; nextCursor?: string };
  try {
    page = await deps.storage.scanArtifacts(filter);
  } catch {
    return {
      ok: false,
      status: 500,
      body: { error: 'server_error', message: 'failed to search registry' },
    };
  }

  const visibleRows: ArtifactsMetadataRow[] = [];
  for (const row of page.rows) {
    if (row.visibility !== 'public') continue;
    visibleRows.push(row);
  }

  // Scope-verification surfacing — ONE owner read per unique scope on
  // the page, batched. A failed or empty read leaves the fields ABSENT
  // (state unknown is not 'unverified'): the wire only carries a label
  // the ownership row actually asserted.
  const ownersByScope = await readScopeOwners(deps.storage, visibleRows);

  // `sort=recent` ordering is served by the storage layer (the filter
  // carries `order: 'recent'`); rows arrive newest-first and are
  // emitted verbatim — no re-sort here, so page order and cursor order
  // cannot diverge.
  const results: SearchResultEntry[] = visibleRows.map((row) =>
    rowToEntry(row, ownersByScope.get(artifactScope(row.artifactId)) ?? null),
  );

  return {
    ok: true,
    status: 200,
    body: { results, nextCursor: page.nextCursor },
  };
}

function isSearchSort(value: string): value is SearchSort {
  return (SEARCH_SORT_OPTIONS as readonly string[]).includes(value);
}

async function readScopeOwners(
  storage: RegistryStorage,
  rows: readonly ArtifactsMetadataRow[],
): Promise<Map<string, ScopeOwnerRow | null>> {
  const scopes = [...new Set(rows.map((row) => artifactScope(row.artifactId)))];
  const entries = await Promise.all(
    scopes.map(async (scope): Promise<readonly [string, ScopeOwnerRow | null]> => {
      try {
        return [scope, await storage.getScopeOwner(scope)] as const;
      } catch (err) {
        // eslint-disable-next-line no-console -- server-side operator signal; the wire simply omits the fields
        console.error('registry search: scope-owner lookup failed; omitting verification fields', {
          scope,
          error: err instanceof Error ? err.message : String(err),
        });
        return [scope, null] as const;
      }
    }),
  );
  return new Map(entries);
}

function rowToEntry(
  row: ArtifactsMetadataRow,
  scopeOwner: ScopeOwnerRow | null,
): SearchResultEntry {
  return {
    artifactId: row.artifactId,
    latestVersion: row.latestVersion,
    kind: row.kind,
    description: row.description,
    tags: row.tags,
    publishedAt: row.publishedAt,
    mcpTools: row.mcpTools,
    mcpToolsSource: row.mcpToolsSource,
    scopeVerification: scopeOwner?.verification,
    verifiedDomain: scopeOwner?.verification === 'verified' ? scopeOwner.verifiedDomain : undefined,
  };
}

function nonEmpty(s: string | undefined): string | undefined {
  return typeof s === 'string' && s.length > 0 ? s : undefined;
}
