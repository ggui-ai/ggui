/**
 * ggui#1185 (B) — the pure pieces of the Claude Code LOGIN client.
 *
 * `ClaudeCodeLoginAgent` (in `./llm-router.ts`, beside the raw Anthropic
 * client) turns every router call into ONE Agent SDK `query()` against
 * the machine's own Claude Code login. Everything here is the part that
 * needs no router state: how the options are assembled (the carve-out as
 * behaviour), how the router's JSON-Schema tools are offered to the
 * binary, how the stream is read back into the router's shape, and which
 * endings are success, which are "the model chose not to call", and
 * which are errors. It imports nothing from the router, so the router can
 * import it without an ESM cycle.
 *
 * Every behaviour pinned here was MEASURED on Agent SDK 0.3.229 before it
 * was written (design slice `docs/plans/2026-09-21-1185-b-login-client.md`):
 * - `system:init.apiKeySource` reads the literal `"none"` on the login
 *   path — a value the SDK's `ApiKeySource` union does not name.
 * - allow-listed MCP tools bypass `canUseTool` and EXECUTE; un-listed
 *   ones are asked, and a `deny` means the handler never runs.
 * - `result.usage` is the ONLY usage source; per-message usage is
 *   chunk-level.
 * - `maxTurns: 1` ends the one-shot as `result:error_max_turns` after the
 *   captured tool call, and the SDK then throws to re-surface the error
 *   result — the result decides, the throw is redundant.
 * - a `user` message with an `image` content block reaches the model
 *   intact when delivered through an `AsyncIterable<SDKUserMessage>`
 *   prompt.
 */
import type {
  ApiKeySource,
  CanUseTool,
  McpSdkServerConfigWithInstance,
  Options,
  SDKMessage,
  SDKResultError,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { isRecord, type JsonObject, type JsonValue } from "@ggui-ai/protocol";
import { z } from "zod";
import type { LLMToolDef } from "../llm.js";
import {
  claudeCodeLoginQueryOptions,
  stripProviderKeyEnv,
} from "../adapters/claude/claude-code-login.js";
import { MCP_SERVER_NAME } from "../adapters/claude/tool-bridge.js";
import { toolArgsToJsonObject } from "../adapters/tool-bridge.js";

/** The SDK surface the login client uses — resolved once via a dynamic import. */
export type LoginSdk = Pick<
  typeof import("@anthropic-ai/claude-agent-sdk"),
  "query" | "tool" | "createSdkMcpServer"
>;

/** The binary names an MCP tool `mcp__<server>__<tool>`; the router names it `<tool>`. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export function stripMcpToolPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

/**
 * `system:init` as the binary emits it on the login path. The SDK's
 * `ApiKeySource` union omits `"none"`, which is exactly the value that
 * says "no key — the login"; this is that type widened by that one value.
 */
export type MeasuredInitMessage = Omit<SDKSystemMessage, "apiKeySource"> & {
  readonly apiKeySource: ApiKeySource | "none";
};

/** The `apiKeySource` a run on the login reports. Anything else is a key. */
export const LOGIN_API_KEY_SOURCE = "none";

/**
 * The binary authenticated from a KEY, not from its login: a provider key
 * reached the spawned process despite the env strip (a helper in
 * `~/.claude` settings, say). Such a run is off the login path — it is
 * stopped at `system:init`, before it spends a turn.
 */
export class ClaudeCodeLoginAuthError extends Error {
  readonly apiKeySource: string;
  constructor(apiKeySource: string) {
    super(
      `claude-code-login: the Claude Code binary authenticated from apiKeySource=${apiKeySource}, ` +
        `not from its login — a provider key reached the spawned process; the run was stopped before it spent a turn`
    );
    this.name = "ClaudeCodeLoginAuthError";
    this.apiKeySource = apiKeySource;
  }
}

/**
 * `query()` ended with a result the one-shot cannot treat as a turn:
 * an error class other than `error_max_turns`, or a `success`-shaped
 * result flagged `is_error` (an API error the binary relayed — its HTTP
 * status, when present, rides on `status`, so the router's `apiCall()`
 * retries a 429 exactly as it does for the raw client).
 */
export class ClaudeCodeLoginResultError extends Error {
  readonly subtype: SDKResultMessage["subtype"];
  readonly errors: readonly string[];
  readonly status: number | undefined;
  constructor(
    subtype: SDKResultMessage["subtype"],
    errors: readonly string[],
    status: number | undefined
  ) {
    super(
      `claude-code-login: query() ended with ${subtype}` +
        (status !== undefined ? ` (api status ${status})` : "") +
        `: ${errors.length > 0 ? errors.join("; ") : "no detail from the binary"}`
    );
    this.name = "ClaudeCodeLoginResultError";
    this.subtype = subtype;
    this.errors = errors;
    this.status = status;
  }
}

/** A tool call the binary PROPOSED (the router's shape; the harness executes it). */
export interface LoginToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

/**
 * What `canUseTool` saw — recorded to cross-check against the stream's
 * blocks. The input is typed as the SDK hands it to the intercept.
 */
export interface InterceptedToolCall {
  readonly name: string;
  readonly input: Parameters<CanUseTool>[1];
}

/**
 * The intercept: record what the binary wants to run and DENY it, so the
 * handler never runs and the harness executes the call. Never allow-list
 * a ggui tool — an allow-listed MCP tool executes without asking.
 */
export function createDenyingIntercept(intercepted: InterceptedToolCall[]): CanUseTool {
  return async (toolName, input) => {
    intercepted.push({ name: toolName, input });
    return {
      behavior: "deny",
      message: "ggui executes tools in its harness; the binary only proposes them.",
    };
  };
}

/** The image the visual judge sends. Mirrors the router's `VisionImageInput`. */
export interface LoginImageInput {
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly base64: string;
}

/**
 * One `user` message carrying an image block and the text, delivered as
 * the streamed prompt shape `query()` accepts — the only way to send
 * anything but a string. Measured: a 176-byte solid-orange PNG sent this
 * way was answered "Orange".
 */
export async function* imageUserMessage(
  text: string,
  image: LoginImageInput
): AsyncGenerator<SDKUserMessage> {
  const message: MessageParam = {
    role: "user",
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: image.mediaType, data: image.base64 },
      },
      { type: "text", text },
    ],
  };
  yield { type: "user", message, parent_tool_use_id: null };
}

/**
 * The `query()` options of one login turn — the carve-out as behaviour:
 * the system prompt REPLACES the CLI's default (measured by sentinel);
 * `maxTurns: 1` makes it a one-shot; thinking is asked off through the
 * SDK's typed `thinking` option (the probe spelled it `thinkingConfig`,
 * untyped, and saw a thinking block anyway — whether the typed spelling
 * is honoured is Exp 009's to measure; it reports thinking tokens as
 * their own column either way); every provider key name is stripped from the
 * env the binary inherits; Layer 1's pins keep it tool-less (the CLI's
 * own tools), config-less (`~/.claude` never loads) and non-bare (the
 * login store IS read). Tools, when offered, come as ggui's in-process
 * MCP server with NO allow-list and the denying intercept.
 */
export function buildLoginQueryOptions(params: {
  readonly model: string;
  readonly systemPrompt: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tools?: {
    readonly server: McpSdkServerConfigWithInstance;
    readonly canUseTool: CanUseTool;
  };
}): Options {
  return {
    model: params.model,
    systemPrompt: params.systemPrompt,
    maxTurns: 1,
    thinking: { type: "disabled" },
    env: stripProviderKeyEnv(params.env ?? process.env),
    ...claudeCodeLoginQueryOptions(),
    ...(params.tools !== undefined
      ? {
          mcpServers: { [MCP_SERVER_NAME]: params.tools.server },
          canUseTool: params.tools.canUseTool,
        }
      : {}),
  };
}

// ── JSON Schema → the SDK's tool() (which speaks Zod) ───────────────────

const JSON_SCHEMA_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
  "integer",
] as const;
type JsonSchemaType = (typeof JSON_SCHEMA_TYPES)[number];

function isJsonSchemaType(value: JsonValue | undefined): value is JsonSchemaType {
  return typeof value === "string" && (JSON_SCHEMA_TYPES as readonly string[]).includes(value);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ZodJsonSchema = z.core.JSONSchema.JSONSchema;

function schemaAt(value: JsonValue, path: string): ZodJsonSchema | boolean {
  if (typeof value === "boolean") return value;
  if (!isJsonObject(value)) {
    throw new Error(
      `claude-code-login: ${path} must be a JSON-Schema object or boolean, got ${JSON.stringify(value)}`
    );
  }
  return toZodJsonSchema(value, path);
}

/**
 * The router's tools carry JSON Schema as data (`LLMToolDef.parameters`);
 * the SDK's `tool()` wants Zod. Zod 4 converts JSON Schema itself
 * (`z.fromJSONSchema`) but its input type is structured, so this is the
 * validating projection from `JsonObject` onto it: the keywords whose
 * shape matters are checked and recursed, every other keyword passes
 * through. A malformed schema is a programming error in the tool
 * definition and throws, naming the path.
 */
export function toZodJsonSchema(parameters: JsonObject, path = "parameters"): ZodJsonSchema {
  const out: ZodJsonSchema = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    switch (key) {
      case "type": {
        if (!isJsonSchemaType(value)) {
          throw new Error(
            `claude-code-login: ${path}.type must be one of ${JSON_SCHEMA_TYPES.join("|")}, got ${JSON.stringify(value)}`
          );
        }
        out.type = value;
        break;
      }
      case "properties":
      case "patternProperties":
      case "$defs": {
        if (!isJsonObject(value))
          throw new Error(`claude-code-login: ${path}.${key} must be an object`);
        const record: Record<string, ZodJsonSchema | boolean> = {};
        for (const [name, sub] of Object.entries(value)) {
          if (sub === undefined) continue;
          record[name] = schemaAt(sub, `${path}.${key}.${name}`);
        }
        if (key === "$defs") {
          const defs: Record<string, ZodJsonSchema> = {};
          for (const [name, sub] of Object.entries(record)) {
            if (typeof sub === "boolean")
              throw new Error(`claude-code-login: ${path}.$defs.${name} must be an object`);
            defs[name] = sub;
          }
          out.$defs = defs;
        } else {
          out[key] = record;
        }
        break;
      }
      case "items": {
        out.items = Array.isArray(value)
          ? value.map((sub, i) => schemaAt(sub, `${path}.items[${i}]`))
          : schemaAt(value, `${path}.items`);
        break;
      }
      case "additionalProperties":
      case "not": {
        out[key] = schemaAt(value, `${path}.${key}`);
        break;
      }
      case "anyOf":
      case "oneOf":
      case "allOf": {
        if (!Array.isArray(value))
          throw new Error(`claude-code-login: ${path}.${key} must be an array`);
        out[key] = value.map((sub, i) => {
          const s = schemaAt(sub, `${path}.${key}[${i}]`);
          if (typeof s === "boolean")
            throw new Error(`claude-code-login: ${path}.${key}[${i}] must be an object`);
          return s;
        });
        break;
      }
      case "required": {
        if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string")) {
          throw new Error(`claude-code-login: ${path}.required must be an array of strings`);
        }
        out.required = value;
        break;
      }
      case "enum": {
        if (
          !Array.isArray(value) ||
          !value.every(
            (v): v is string | number | boolean | null =>
              v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean"
          )
        ) {
          throw new Error(`claude-code-login: ${path}.enum must be an array of primitives`);
        }
        out.enum = value;
        break;
      }
      default:
        // description, default, examples, minimum, … — the index signature
        // takes them as written.
        out[key] = value;
    }
  }
  return out;
}

/**
 * ggui's tools as an in-process MCP server the binary can LIST. The
 * handlers never run — `createDenyingIntercept` denies every call and the
 * harness executes it — so a handler that does run is a violated
 * invariant and says so loudly.
 */
export function createLoginToolServer(
  sdk: LoginSdk,
  tools: readonly LLMToolDef[]
): McpSdkServerConfigWithInstance {
  const sdkTools = tools.map((def) => {
    const schema = z.fromJSONSchema(toZodJsonSchema(def.parameters, `${def.name}.parameters`));
    if (!(schema instanceof z.ZodObject)) {
      throw new Error(
        `claude-code-login: tool ${def.name}'s parameters must be a JSON-Schema object`
      );
    }
    return sdk.tool(def.name, def.description, schema.shape, async () => {
      throw new Error(
        `claude-code-login: the binary tried to execute ${def.name} — ggui's tools are proposed to the harness and never run in the binary (the intercept denies every call)`
      );
    });
  });
  return sdk.createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: sdkTools });
}

// ── reading the stream back into the router's shape ─────────────────────

export interface CollectedLoginTurn {
  readonly init: MeasuredInitMessage | undefined;
  readonly toolCalls: readonly LoginToolCall[];
  /** Text blocks joined; thinking blocks excluded. */
  readonly text: string;
  readonly result: SDKResultMessage;
}

export interface CollectLoginTurnOptions {
  /** What the intercept saw, to cross-check against the stream's blocks. */
  readonly intercepted: readonly InterceptedToolCall[];
  readonly log: (line: string) => void;
  readonly warn: (line: string) => void;
}

function describeCalls(
  calls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>
): string {
  return JSON.stringify(calls.map((c) => ({ name: stripMcpToolPrefix(c.name), input: c.input })));
}

/**
 * Consume one `query()` and decide what the turn was.
 *
 * - `system:init` is the auth receipt: `apiKeySource` is printed, and a
 *   value other than `"none"` stops the run at once.
 * - `assistant` blocks: `tool_use` → a proposed call (prefix stripped,
 *   id carried, input intact); `text` → the reply; `thinking` ignored.
 * - `result` decides. `success` and `error_max_turns` are the one-shot's
 *   ends (with or without a call — the raw arm's zero-call return is the
 *   same shape). A `success` flagged `is_error` or any other error class
 *   throws `ClaudeCodeLoginResultError`.
 * - A throw AFTER the result is the SDK re-surfacing an error result as an
 *   exception; the result already decided, so it is logged, not obeyed.
 *   A throw BEFORE any result is a real failure and is rethrown as-is.
 */
export async function collectLoginTurn(
  stream: AsyncIterable<SDKMessage>,
  opts: CollectLoginTurnOptions
): Promise<CollectedLoginTurn> {
  let init: MeasuredInitMessage | undefined;
  const toolCalls: LoginToolCall[] = [];
  let text = "";
  let result: SDKResultMessage | undefined;
  try {
    for await (const msg of stream) {
      if (msg.type === "system" && msg.subtype === "init") {
        const measured: MeasuredInitMessage = msg;
        init = measured;
        opts.log(
          `[claude-code-login] apiKeySource=${measured.apiKeySource} claude_code_version=${measured.claude_code_version} model=${measured.model}`
        );
        if (measured.apiKeySource !== LOGIN_API_KEY_SOURCE) {
          throw new ClaudeCodeLoginAuthError(measured.apiKeySource);
        }
      } else if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              name: stripMcpToolPrefix(block.name),
              input: isRecord(block.input) ? toolArgsToJsonObject(block.input) : {},
            });
          } else if (block.type === "text") {
            text += block.text;
          }
        }
      } else if (msg.type === "result") {
        result = msg;
      }
    }
  } catch (e) {
    if (result === undefined) throw e;
    opts.log(
      `[claude-code-login] query() threw after its result message — the result decides (${e instanceof Error ? e.message : String(e)})`
    );
  }
  if (result === undefined) {
    throw new Error("claude-code-login: query() ended without a result message");
  }

  const streamSaw = describeCalls(toolCalls);
  const interceptSaw = describeCalls(opts.intercepted);
  if (streamSaw !== interceptSaw) {
    opts.warn(
      `[claude-code-login] intercept/stream disagreement — the stream's blocks win. intercepted=${interceptSaw} stream=${streamSaw}`
    );
  }

  if (result.subtype === "success") {
    if (result.is_error) {
      throw new ClaudeCodeLoginResultError(
        "success",
        [result.result],
        result.api_error_status ?? undefined
      );
    }
  } else if (result.subtype !== "error_max_turns") {
    const failed: SDKResultError = result;
    throw new ClaudeCodeLoginResultError(failed.subtype, failed.errors, undefined);
  }
  return { init, toolCalls, text, result };
}
