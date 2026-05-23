# Security Policy

## Supported Versions

ggui is in active pre-1.0 development. Security fixes are applied to the latest published release candidate on npm under the `@ggui-ai/*` scope. There is no extended-LTS support for prior RC versions during the 0.x line.

| Version    | Supported        |
| ---------- | ---------------- |
| `0.1.x-rc` | ✅               |
| < `0.1.0`  | ❌ (pre-publish) |

Once `1.0.0` ships, this table will be updated with the support window for older majors.

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Report privately through one of:

1. **GitHub Private Vulnerability Reporting** — use the [Report a vulnerability](https://github.com/ggui-ai/ggui/security/advisories/new) button on this repo's Security tab. Preferred.
2. **Email** — `security@ggui.ai`. PGP key available on request.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a minimal proof-of-concept
- The affected package + version (e.g. `@ggui-ai/mcp-server@0.1.0-rc.1`)
- Any suggested mitigation

## Response Timeline

We aim to:

- **Acknowledge** receipt within 3 business days
- **Triage + initial assessment** within 7 business days
- **Coordinate disclosure** with you before any public advisory or patch release

For critical vulnerabilities (RCE, auth bypass, key exfiltration), we will treat the report as the highest priority and aim for a much faster response.

## Disclosure

After a fix is available, we will:

1. Publish a patched version on npm
2. File a GitHub Security Advisory crediting the reporter (unless anonymity is requested)
3. Note the CVE (if assigned) in the next release's CHANGELOG

We appreciate responsible disclosure and will publicly credit reporters in advisories with their consent.
