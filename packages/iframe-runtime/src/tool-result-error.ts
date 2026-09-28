/**
 * Reading a tool result the server answered with an error (ggui#1496).
 *
 * A server tool that throws reaches the view, through the host's
 * `tools/call` relay, as a result with `isError: true` whose first text
 * block is the error's text. A domain error's text is `<code>: <detail>`,
 * read by the protocol's own parser.
 */
import { parseDomainErrorText } from '@ggui-ai/protocol/wire';

/** Whether a tool result is an error result. */
export function isErrorToolResult(result: unknown): boolean {
  return typeof result === 'object' && result !== null && Reflect.get(result, 'isError') === true;
}

/** The text of a tool result's first text block, if it has one. */
export function toolResultText(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const content = Reflect.get(result, 'content');
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first: unknown = content[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const text = Reflect.get(first, 'text');
  return typeof text === 'string' ? text : undefined;
}

/** The domain-error code an error result carries; `undefined` for any other result. */
export function domainErrorCodeOf(result: unknown): string | undefined {
  if (!isErrorToolResult(result)) return undefined;
  return parseDomainErrorText(toolResultText(result) ?? '')?.code;
}
