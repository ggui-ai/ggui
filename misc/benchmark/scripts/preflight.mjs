/**
 * Provider-key preflight for the cron publish path. A requested provider
 * with no API key would otherwise produce all-failed cells that publish as
 * not-evaluated scores — indistinguishable from a real provider regression.
 * The publisher must refuse to publish in that case.
 */

/** Map a benchmark provider id → the env var(s) that hold its key. */
const PROVIDER_KEY_ENV = {
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/**
 * @param {string[]} providers requested provider ids
 * @param {Record<string,string|undefined>} env
 * @returns {string[]} the subset of providers with no usable key
 */
export function missingProviderKeys(providers, env) {
  return providers.filter((p) => {
    const keys = PROVIDER_KEY_ENV[p];
    if (!keys) return false; // unknown provider id — not our concern here
    return !keys.some((k) => typeof env[k] === 'string' && env[k].length > 0);
  });
}
