// packages/ui-gen/src/adapters/claude/source-capture.ts
//
// ggui#1714 — which tool call carries a component's source, decided once.
// Both Agent SDK paths (ClaudeSdkAdapter's message parser and the evaluation
// loop's extractor) read source through this function, so the rule cannot be
// fixed on one path and left stale on the other.
//
//   `*__compile_component` → `input.code`    (the bridged compile tool)
//   `Write`                → `input.content` (a CLI built-in, offered only by opt-in)

const COMPILE_TOOL_SUFFIX = '__compile_component';

/** The source a tool_use block carries, or undefined when it carries none. */
export function sourceCodeFromToolUse(name: unknown, input: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const field = name === 'Write' ? 'content' : name.endsWith(COMPILE_TOOL_SUFFIX) ? 'code' : undefined;
  if (field === undefined || typeof input !== 'object' || input === null) return undefined;
  const value: unknown = Reflect.get(input, field);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
