/**
 * Tests never reach a real AWS account through the developer's ambient credentials.
 *
 * Every vitest config in this repository loads this file FIRST in `setupFiles`. It runs in each test worker before
 * any test module is imported, and it rewrites `process.env` so that the AWS SDK's and the AWS CLI's default
 * credential chains find nothing: an unmocked client (one the code under test builds for itself, or an `aws` CLI a
 * test spawns) fails with a credentials error instead of signing with whatever the shell holds. Child processes
 * inherit the rewritten environment.
 *
 * The two file redirects are the load-bearing half. With AWS_PROFILE unset, or set to the empty string, the SDK
 * reads the `[default]` profile of the config file, so pointing that file at /dev/null is what leaves it nothing.
 * The deletes are belt. AWS_REGION is deliberately left alone: a missing region fails before the credential chain
 * runs, which would let a leak pass a canary for the wrong reason.
 *
 * Suites that use a local emulator set their own static fake credentials in a setup file listed AFTER this one.
 *
 * A suite that is meant to reach a real account opts in by name, never by leaving this file out: its config sets
 * AWS_TEST_PINNED_CONFIG to a config file that names exactly one profile, and AWS_TEST_PINNED_PROFILE to that
 * profile. The shell's own config file, credentials file and profile are still dropped; only the pinned pair is
 * used. On a CI runner (CI=true) the static key trio a job step exported is kept in pinned mode, because there it
 * is the job's explicit credential; on a workstation it is dropped like everything else.
 */

const NULL_FILE = '/dev/null';

/** Every variable the default chains read to pick a profile or a credential source. */
const AMBIENT = [
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_CREDENTIAL_EXPIRATION',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
];

const KEY_TRIO = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];

const pinnedConfig = process.env.AWS_TEST_PINNED_CONFIG;
const pinnedProfile = process.env.AWS_TEST_PINNED_PROFILE;

if (Boolean(pinnedConfig) !== Boolean(pinnedProfile)) {
  throw new Error(
    'no-ambient-aws: AWS_TEST_PINNED_CONFIG and AWS_TEST_PINNED_PROFILE are set together or not at all',
  );
}

const keepKeys = Boolean(pinnedConfig) && process.env.CI === 'true';
for (const name of AMBIENT) {
  if (keepKeys && KEY_TRIO.includes(name)) continue;
  delete process.env[name];
}

process.env.AWS_SHARED_CREDENTIALS_FILE = NULL_FILE;
process.env.AWS_EC2_METADATA_DISABLED = 'true';
if (pinnedConfig && pinnedProfile) {
  process.env.AWS_CONFIG_FILE = pinnedConfig;
  process.env.AWS_PROFILE = pinnedProfile;
} else {
  process.env.AWS_CONFIG_FILE = NULL_FILE;
}
