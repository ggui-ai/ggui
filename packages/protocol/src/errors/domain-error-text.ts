/**
 * The reader side of the Plane-2 grammar (ggui#880): `<code>: <detail>` for a
 * REGISTERED code. The emitter side, the `DomainError` base that composes the
 * text, is `./domain-error`. This module imports only the code names
 * (`../types/domain-error-code-names`), so a browser that parses a domain
 * error through `@ggui-ai/protocol/wire` carries the names and not the
 * registry's prose.
 */
import { isDomainErrorCode, type DomainErrorCode } from '../types/domain-error-code-names';

/** A parsed Plane-2 wire text. */
export interface ParsedDomainErrorText {
  readonly code: DomainErrorCode;
  readonly detail: string;
}

/**
 * The reader side of the grammar: `<code>: <detail>` for a REGISTERED code,
 * else `null` — a Plane-1 text (`MCP error -32602: …`), a tool-name prefix
 * (`ggui_render: …`) or an unregistered slug is not a domain error.
 */
export function parseDomainErrorText(text: string): ParsedDomainErrorText | null {
  const separator = text.indexOf(': ');
  if (separator <= 0) return null;
  const code = text.slice(0, separator);
  const detail = text.slice(separator + 2);
  if (!isDomainErrorCode(code) || detail.trim().length === 0) return null;
  return { code, detail };
}
