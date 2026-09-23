/**
 * ggui#1185 — the options that keep a Claude-Code-login generation honest:
 * no provider key can win over the login, no built-in tool, no ~/.claude
 * config leaking in, the non-bare path pinned (`--bare` skips keychain reads
 * and is slated to become the `-p` default upstream), model pinned by the
 * caller. Pure, so the measurement is a table and not a spawned process.
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_LOGIN_CREDENTIAL,
  PROVIDER_KEY_ENV_NAMES,
  claudeCodeLoginQueryOptions,
  loginChildEnv,
} from "./claude-code-login";

// ggui#1278 — a parent env the way a real one arrives: a whole `.env` loaded,
// plus the variables the binary legitimately needs.
const PARENT = {
  PATH: "/usr/bin",
  HOME: "/home/x",
  USER: "x",
  TMPDIR: "/tmp/x",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  CLAUDE_CONFIG_DIR: "/home/x/.claude-alt",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-login",
  HTTPS_PROXY: "http://proxy:3128",
  NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  XDG_CONFIG_HOME: "/home/x/.config",
  // provider keys and endpoint overrides the binary would prefer over its login
  ANTHROPIC_API_KEY: "sk-ant-stale",
  CLAUDE_API_KEY: "stale",
  ANTHROPIC_AUTH_TOKEN: "stale",
  ANTHROPIC_BASE_URL: "http://localhost:4000",
  // every other secret a loaded `.env` carries
  OPENAI_API_KEY: "sk-openai",
  GOOGLE_API_KEY: "g",
  OPENROUTER_API_KEY: "or",
  RESEND_API_KEY: "re",
  GITHUB_TOKEN: "ghp",
  AWS_SECRET_ACCESS_KEY: "aws",
  // switches that would silently change what the binary does
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_MODEL: "claude-opus-5",
  // and a name nobody on the login path asked for
  GGUI_UNRELATED: "x",
} as const;

const SECRET_NAME = /API_KEY|TOKEN|SECRET/;

describe("claude-code-login (ggui#1185)", () => {
  it("the sentinel is the literal the CLI and the router agree on", () => {
    expect(CLAUDE_CODE_LOGIN_CREDENTIAL).toBe("claude-code-login");
  });
  it("the child env is an allowlist: what the login path needs, and nothing the parent merely holds (ggui#1278)", () => {
    const out = loginChildEnv(PARENT);
    expect(Object.keys(out).sort()).toEqual(
      [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "HTTPS_PROXY",
        "LANG",
        "LC_ALL",
        "NODE_EXTRA_CA_CERTS",
        "PATH",
        "TMPDIR",
        "USER",
        "XDG_CONFIG_HOME",
      ].sort(),
    );
    for (const k of PROVIDER_KEY_ENV_NAMES) expect(k in out, `${k} must be absent`).toBe(false);
    expect(out.PATH).toBe("/usr/bin");
    expect(PARENT.ANTHROPIC_API_KEY, "input not mutated").toBe("sk-ant-stale");
  });

  it("no credential-shaped name reaches the child but the login's own token — with a control that the parent held them (ggui#1278)", () => {
    const parentSecrets = Object.keys(PARENT).filter((k) => SECRET_NAME.test(k));
    expect(parentSecrets.length, "control: the parent really carries secrets").toBeGreaterThanOrEqual(9);
    expect(Object.keys(loginChildEnv(PARENT)).filter((k) => SECRET_NAME.test(k))).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
  });

  it("a switch that changes what the binary does is not inherited (ggui#1278)", () => {
    const out = loginChildEnv(PARENT);
    expect("CLAUDE_CODE_USE_BEDROCK" in out).toBe(false);
    expect("ANTHROPIC_MODEL" in out).toBe(false);
  });

  it("undefined values are dropped, and every LC_* locale name passes (ggui#1278)", () => {
    const out = loginChildEnv({ PATH: "/usr/bin", HOME: undefined, LC_TIME: "C", LC_MESSAGES: "C" });
    expect(out).toEqual({ PATH: "/usr/bin", LC_TIME: "C", LC_MESSAGES: "C" });
  });
  it("pins tool-less, config-less, non-bare", () => {
    expect(claudeCodeLoginQueryOptions()).toEqual({ tools: [], settingSources: [] });
  });
});
