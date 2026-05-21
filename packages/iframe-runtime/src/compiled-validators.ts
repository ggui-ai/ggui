/**
 * Loader for precompiled, eval-free contract validators.
 *
 * The renderer iframe runs under a strict CSP with no `'unsafe-eval'`,
 * so it cannot call `ajv.compile()` (which builds validators via
 * `new Function`). The server precompiles each contract sub-schema into
 * a standalone, self-contained ESM validator-module source string and
 * ships them on the bootstrap as `compiledValidators`. This module
 * loads each source via a `blob:` dynamic import — governed by
 * `script-src` (which permits `blob:`), not by `unsafe-eval` — and
 * exposes the resulting `ValidateFunction`s as a
 * {@link CompiledValidatorSet}.
 */
import type { CompiledContractValidators } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { ValidateFunction } from '@ggui-ai/protocol';
import { loadModule } from '@ggui-ai/design/module-loader';

/**
 * Precompiled validators for the active stack item's contract, keyed to
 * match the four runtime-validated surfaces. `props` is a single
 * validator (the synthesized props wrapper); the other three are keyed
 * by action name / channel name / slot name.
 */
export interface CompiledValidatorSet {
  readonly props?: ValidateFunction;
  readonly actions: ReadonlyMap<string, ValidateFunction>;
  readonly streams: ReadonlyMap<string, ValidateFunction>;
  readonly context: ReadonlyMap<string, ValidateFunction>;
}

/**
 * An empty set — no precompiled validators. Callers fall back to
 * in-iframe `ajv.compile()`, which the CSP may then block; the empty
 * set is the honest "nothing precompiled" state, not a fix on its own.
 */
export const EMPTY_COMPILED_VALIDATOR_SET: CompiledValidatorSet = {
  actions: new Map(),
  streams: new Map(),
  context: new Map(),
};

/** A precompiled validator module's `default` export is an Ajv
 * standalone validate function. The runtime check is a `typeof`
 * function test; the assertion that it is specifically a
 * `ValidateFunction` is sound because the server emitted it as one. */
function isValidateFunction(value: unknown): value is ValidateFunction {
  return typeof value === 'function';
}

/**
 * Load one ESM validator-module source into a `ValidateFunction` via a
 * `blob:` dynamic import. Returns `undefined` on any failure — a
 * missing validator degrades to the in-iframe fallback rather than
 * crashing the boot.
 */
async function loadOne(
  source: string,
  label: string,
  warn?: (message: string, detail: unknown) => void,
): Promise<ValidateFunction | undefined> {
  try {
    const mod = await loadModule(source);
    const fn = mod['default'];
    if (!isValidateFunction(fn)) {
      warn?.(
        `[ggui:validators] ${label}: module has no default-export function`,
        mod,
      );
      return undefined;
    }
    return fn;
  } catch (err) {
    warn?.(
      `[ggui:validators] ${label}: failed to load precompiled validator`,
      err,
    );
    return undefined;
  }
}

/**
 * Load every precompiled validator on the bootstrap into a
 * {@link CompiledValidatorSet}. Each module loads independently; one
 * failure never blocks the others. Returns the empty set when the
 * bootstrap carries no `compiledValidators`.
 */
export async function loadCompiledValidators(
  meta: CompiledContractValidators | undefined,
  warn?: (message: string, detail: unknown) => void,
): Promise<CompiledValidatorSet> {
  if (meta === undefined) return EMPTY_COMPILED_VALIDATOR_SET;

  const loadGroup = async (
    group: Readonly<Record<string, string>> | undefined,
    kind: string,
  ): Promise<ReadonlyMap<string, ValidateFunction>> => {
    const map = new Map<string, ValidateFunction>();
    if (group === undefined) return map;
    await Promise.all(
      Object.entries(group).map(async ([name, source]) => {
        const fn = await loadOne(source, `${kind}.${name}`, warn);
        if (fn !== undefined) map.set(name, fn);
      }),
    );
    return map;
  };

  const [props, actions, streams, context] = await Promise.all([
    meta.props !== undefined
      ? loadOne(meta.props, 'props', warn)
      : Promise.resolve(undefined),
    loadGroup(meta.actions, 'action'),
    loadGroup(meta.streams, 'stream'),
    loadGroup(meta.context, 'context'),
  ]);

  return {
    ...(props !== undefined ? { props } : {}),
    actions,
    streams,
    context,
  };
}
