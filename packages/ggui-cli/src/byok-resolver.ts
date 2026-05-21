/**
 * BYOK ("bring your own key") provider-key resolver — the `ggui` CLI's
 * personal-mode credential plumbing for local UI generation.
 *
 * Resolves a {@link ProviderKeyRef} for a given LLM provider through a
 * deterministic two-step lookup. Used by `buildMcpServerBackend` to
 * decide whether to call a real provider or fail fast with the
 * canonical `'no-credentials'` error.
 *
 * **Resolution order, locked:**
 *
 *   1. **Environment variables** — checked first, always win. The
 *      env-var names match the conventions every Node ecosystem uses
 *      so operators who already export them for other tools (Claude
 *      Code, OpenAI CLI, etc.) get OSS generation working with zero
 *      extra config:
 *
 *        - `anthropic`   → `ANTHROPIC_API_KEY`
 *        - `google`      → `GOOGLE_API_KEY`, then `GEMINI_API_KEY`
 *                          (alias — Google publishes both)
 *        - `openai`      → `OPENAI_API_KEY`
 *        - `openrouter`  → `OPENROUTER_API_KEY`
 *        - `bedrock`     → not env-resolvable. Bedrock auth flows
 *                          through `AWS_*` env / IAM role chain at
 *                          the SDK level; the resolver returns null
 *                          and the (future) bedrock adapter pulls
 *                          from the standard AWS credential chain.
 *
 *   2. **`~/.ggui/credentials.json`** — operator-persistent personal
 *      store. Backed by `PlaintextFileProviderKeyStore` from
 *      `@ggui-ai/mcp-server-core/plaintext` at the **global** app
 *      scope. Single-user, single-tenant; multi-app or multi-user
 *      deployments swap in a different `ProviderKeyStore` binding at
 *      composition time and bypass this resolver entirely.
 *
 * **Explicitly NOT a source:** `ggui.json#secrets` or any other
 * project-file location. Plaintext secrets in a project file that
 * gets committed is a footgun, called out in the OSS-split plan
 * (§2.A). This resolver never reads project config.
 *
 * **Failure mode:** missing key returns `null`. Callers map `null` to
 * the canonical `ProviderError{kind:'no-credentials'}` from
 * `@ggui-ai/ui-gen/provider-adapter` so OSS surfaces one consistent
 * structured failure shape regardless of whether the operator never
 * configured a key vs. configured the wrong provider.
 */
import type {
  LlmProvider,
  ProviderKeyRef,
  ProviderKeyStore,
} from '@ggui-ai/mcp-server-core';
import { PlaintextFileProviderKeyStore } from '@ggui-ai/mcp-server-core/plaintext';
import { getCredentialsFile } from './paths.js';

/**
 * Per-process env interface. Narrow enough that tests can pass a
 * plain object instead of mutating `process.env` globally — vitest
 * workers share `process.env` so a clean injection seam matters.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/** App-scope key under which the resolver reads + writes the store. */
export const BYOK_GLOBAL_APP_SCOPE = 'global';

/**
 * Provider → ordered list of env-var names to check. First non-empty
 * wins. Single-name tuple for most providers; google has the
 * `GOOGLE_API_KEY` / `GEMINI_API_KEY` alias pair.
 *
 * `bedrock` is intentionally absent — its auth chain lives outside
 * this resolver (see module JSDoc).
 */
export const PROVIDER_ENV_NAMES: Readonly<
  Record<Exclude<LlmProvider, 'bedrock'>, readonly string[]>
> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

/**
 * Successful resolution. The `source` field is load-bearing — it
 * lets callers surface "BYOK from env" vs. "BYOK from credentials
 * file" in operator-facing logs (banner / `ggui auth status` later)
 * AND lets tests assert the precedence rule deterministically.
 */
export interface ByokKeyResolution {
  readonly key: string;
  readonly source: 'env' | 'credentials-file';
  readonly provider: LlmProvider;
  /**
   * Which env-var name produced the key (for `source: 'env'`). Lets
   * the operator-facing banner say "GEMINI_API_KEY" specifically when
   * that's what fired, instead of a generic "google env".
   */
  readonly envName?: string;
}

export interface ByokResolverOptions {
  /**
   * Env source. Defaults to `process.env`. Tests pass a plain object
   * so they don't have to mutate `process.env` (which leaks across
   * vitest's shared worker pool).
   */
  readonly env?: EnvLike;
  /**
   * Override the credentials-file backed store. Defaults to a
   * `PlaintextFileProviderKeyStore` reading {@link getCredentialsFile}
   * — i.e. `~/.ggui/credentials.json` (or `$GGUI_CONFIG_DIR/credentials.json`
   * when set). Production callers leave this unset; tests inject a
   * fixture store or `null` to disable the file leg.
   *
   * Pass `null` (NOT `undefined`) to explicitly disable the file
   * lookup. `undefined` triggers the default-store construction.
   */
  readonly fileStore?: ProviderKeyStore | null;
}

/**
 * Per-call resolver options. Threaded through the request → handler →
 * generator chain so the BYOK lookup at gen-time honors the request's
 * authenticated identity.
 */
export interface ByokResolveOptions {
  /**
   * The end-user scope to consult AFTER the operator's platform key
   * (env + credentials-file at scope='global') has been checked and
   * missed. Operator-first fallback: if the operator set a key, every
   * user uses it (operator pays). If the operator opted out, each
   * user's own key (stored at this scope) is consulted.
   *
   * Absent or equal to `'global'`: no per-user fallback — only env +
   * global file are checked. This is the personal-mode default.
   *
   * Production callers thread the request's authenticated identity
   * here (e.g. `userId` for `kind:'user'`, `appId` for `kind:'app'`).
   */
  readonly userScope?: string;
}

/**
 * Wire-level resolver type. Returned by {@link createByokResolver};
 * shaped so call sites can DI a fake without importing the class.
 */
export interface ByokResolver {
  resolve(
    provider: LlmProvider,
    opts?: ByokResolveOptions,
  ): Promise<ByokKeyResolution | null>;
}

/**
 * Construct a {@link ByokResolver} bound to a specific env + file
 * store. Returned object is stateless; one resolver instance can
 * serve many lookups across a process.
 *
 * The resolver never throws. Missing key → `null`. Malformed
 * credentials file → propagates the underlying file store's error
 * (today: `PlaintextFileProviderKeyStore` throws a "not a valid v1
 * document" error so the operator gets a clear signal instead of a
 * silent miss).
 */
export function createByokResolver(
  opts: ByokResolverOptions = {},
): ByokResolver {
  const env: EnvLike = opts.env ?? process.env;
  const fileStore: ProviderKeyStore | null =
    opts.fileStore !== undefined
      ? opts.fileStore
      : new PlaintextFileProviderKeyStore({ filename: getCredentialsFile() });

  // File-store helper. Used twice in the fallback chain (once at the
  // operator's 'global' scope, optionally once at the end-user's
  // identity scope).
  const fileLookupAtScope = async (
    scope: string,
    provider: LlmProvider,
  ): Promise<ByokKeyResolution | null> => {
    if (fileStore === null) return null;
    const ref: ProviderKeyRef | null = await fileStore.get(scope, provider);
    if (!ref) return null;
    return {
      key: ref.key,
      source: 'credentials-file',
      provider,
    };
  };

  return {
    async resolve(
      provider: LlmProvider,
      resolveOpts?: ByokResolveOptions,
    ): Promise<ByokKeyResolution | null> {
      // Step 1: env. The PROVIDER_ENV_NAMES table is the locked
      // mapping; bedrock isn't in it on purpose, so destructuring to
      // `undefined` gives us the "skip env" path automatically.
      const envNames =
        provider === 'bedrock'
          ? undefined
          : PROVIDER_ENV_NAMES[provider as Exclude<LlmProvider, 'bedrock'>];
      if (envNames) {
        for (const name of envNames) {
          const value = env[name];
          if (value !== undefined && value.length > 0) {
            return {
              key: value,
              source: 'env',
              provider,
              envName: name,
            };
          }
        }
      }

      // Step 2: credentials file at operator's 'global' scope. If the
      // operator set a key here, every user uses it (operator pays).
      const globalHit = await fileLookupAtScope(
        BYOK_GLOBAL_APP_SCOPE,
        provider,
      );
      if (globalHit) return globalHit;

      // Step 3: credentials file at the end-user's identity scope.
      // Only consulted when the operator opted out of paying (no
      // global key). The /settings UI under --multi-tenant writes
      // here.
      if (
        resolveOpts?.userScope &&
        resolveOpts.userScope !== BYOK_GLOBAL_APP_SCOPE
      ) {
        const userHit = await fileLookupAtScope(
          resolveOpts.userScope,
          provider,
        );
        if (userHit) return userHit;
      }

      return null;
    },
  };
}
