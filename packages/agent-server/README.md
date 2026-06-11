# @ggui-ai/agent-server

> Brand-agnostic Hono-based HTTP backend for ggui-aware agents.

[![npm version](https://img.shields.io/npm/v/@ggui-ai/agent-server.svg)](https://www.npmjs.com/package/@ggui-ai/agent-server)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

This package owns everything an MCP-Apps host needs to expose an agent over HTTP — the wire shape, MCP discovery, tool-result resource inlining, server-allocated chat ids, guest + bearer auth with chat ownership — so each per-SDK integration only has to implement a thin `AgentAdapter` (prompt + chatId in → normalized message stream out). The prompt path has no ggui-protocol knowledge: the prompt is forwarded to the adapter verbatim, and guest-gesture directives are authored in the iframe's `ui/message` text and pass straight through. The library itself implements a ggui runtime surface — it inlines ggui render resources into tool results and (with `crossFramework`) declares the agent's tool-identity catalog to ggui via `ggui_runtime_declare_tool_catalog`.

Pairs with [`@ggui-ai/react/chat-helpers`](https://www.npmjs.com/package/@ggui-ai/react) on the frontend.

## Install

```bash
npm install @ggui-ai/agent-server
```

## Usage

```ts
import { startAgentServer, type AgentAdapter } from "@ggui-ai/agent-server";

const adapter: AgentAdapter = {
  name: "my-sdk",
  async *run(input) {
    // input.prompt — string the LLM should see (directive already synthesized)
    // input.chatId — server-allocated stable id for this conversation
    // input.mcpServers — { name → { url, bearer } } map
    // input.abortSignal — fires on client disconnect
    // ... yield NormalizedMessage values (assistant text, tool_use, tool_result, result) ...
  },
};

// Zero-config: auto-mounts guest-token auth at /auth/*.
await startAgentServer({
  port: 6790,
  sandboxProxyPort: 7790,
  mcpServers: { ggui: { url: "http://localhost:6781/mcp" } },
  adapter,
});
```

## Auth

The library ships two `AuthAdapter` implementations. Default when `auth` is omitted is `createGuestTokenAuth()`.

### Guest tokens (default)

Stateless signed bearer tokens — works across browser + React Native + CLI with the same client code, no cookie-jar plumbing.

```ts
import { createGuestTokenAuth } from "@ggui-ai/agent-server";

await startAgentServer({
  // ...
  auth: createGuestTokenAuth({
    // GUEST_TOKEN_SECRET in env survives restarts; omit it and the
    // library generates an ephemeral secret + logs a warning.
    signingSecret: process.env.GUEST_TOKEN_SECRET,
    tokenLifetimeSeconds: 60 * 60 * 24 * 30, // 30 days
  }),
});
```

Client flow:

1. On mount: check localStorage for the stored guest token.
2. Missing? `POST /auth/guest` → server returns `{guestId, guestToken, expiresAt}`. Store both.
3. On every `/agent` request: include `Authorization: Bearer <guestToken>`.
4. On 401: clear stored token, `POST /auth/guest` again, retry the request once.

Endpoints mounted by the adapter:

| Route               | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `POST /auth/guest`  | Mint a fresh `{guestId, guestToken, expiresAt}` triple.   |
| `GET /auth/me`      | Return the principal resolved from the current bearer.    |
| `POST /auth/logout` | Advisory — tokens are stateless; client discards locally. |

### Static bearer tokens

For sample apps, CI fixtures, small-scale self-hosts. Production deployments should adopt JWT / OAuth (tracked in #289).

```ts
import { createBearerTokenAuth } from "@ggui-ai/agent-server";

await startAgentServer({
  // ...
  auth: createBearerTokenAuth({
    tokens: {
      "sk-alice": { userId: "alice", claims: { role: "admin" } },
    },
  }),
});
```

Mounts `GET /auth/me` only (no minting; tokens are operator-configured).

### Chat ownership

Every chat row is stamped with `ownerId` on creation (matching the principal's stable id). Read paths check ownership before returning the snapshot:

- `GET /agent?chatId=X` → 200 to owner, 403 to others, 404 unknown.
- `POST /agent` with an existing `chatId` → same gate before appending.

Override with `AuthAdapter.authorizeChat(principal, chatRow)` for team-chat / shared-org semantics:

```ts
const teamAuth: AuthAdapter = {
  ...createBearerTokenAuth({ tokens }),
  async authorizeChat(principal, row) {
    if (principal.kind !== "user") return false;
    const orgId = principal.claims?.orgId;
    return Boolean(orgId) && row.ownerId.startsWith(`org:${orgId}:`);
  },
};
```

## What's inside

| Area                    | Exports                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| Server bootstrap        | `startAgentServer`, `AgentServerOptions`                                    |
| Adapter contract        | `AgentAdapter`, `AgentInput`, `NormalizedMessage`                           |
| Auth                    | `AuthAdapter`, `Principal`, `createGuestTokenAuth`, `createBearerTokenAuth` |
| Chat ownership          | `ChatRow`, `ChatRecord`, `defaultAuthorizeChat`                             |
| Tool-result interceptor | `interceptToolResult` — inlines `_meta.ui.resourceUri`                      |
| MCP wire helpers        | `callMcpResourcesRead`, `callMcpToolsCall`, `parseMcpResponse`              |

Richer auth flows (JWT/JWKS, OAuth Authorization Code + PKCE, signed-header platform trust, multi-device chat claim) are deferred to #289 and will ship as `@ggui-ai/agent-server-auth-extras` — same `AuthAdapter` contract, no handler rewrites needed.

## License

Apache-2.0
