/**
 * Extra headers for an MCP server (`McpServerConfig.headers`): the check the
 * library applies when a server starts, and the env reader the samples use.
 */
import { RESERVED_MCP_HEADER_NAMES } from './types.js';

/**
 * Refuse extra headers the library cannot send as given: a value that is not
 * a string, or a name the library sets itself (in any letter case). Throws an
 * error naming the server and the header.
 */
export function checkMcpHeaders(serverName: string, headers: Readonly<Record<string, unknown>>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') {
      throw new Error(`mcpServers.${serverName}.headers["${name}"] must be a string, got ${typeof value}`);
    }
    if (RESERVED_MCP_HEADER_NAMES.includes(name.toLowerCase())) {
      throw new Error(
        `mcpServers.${serverName}.headers["${name}"] is set by the library on every MCP request and cannot be overridden (reserved: ${RESERVED_MCP_HEADER_NAMES.join(', ')})`,
      );
    }
  }
}

/**
 * Read extra headers from an environment variable holding a JSON object of
 * header name → string value, e.g. `{"X-Request-Source":"docs"}`. Unset or empty →
 * undefined. Anything else that is not such an object (not JSON, an array, a
 * non-string value) throws, naming the variable, so a typo fails at startup
 * instead of being ignored.
 */
export function parseMcpHeadersEnv(varName: string, raw: string | undefined): Readonly<Record<string, string>> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${varName} must be a JSON object of header name → string value: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${varName} must be a JSON object of header name → string value, got ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`${varName}["${name}"] must be a string, got ${typeof value}`);
    headers[name] = value;
  }
  return headers;
}
