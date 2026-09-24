# Security Policy

## Supported Versions

ggui is pre-1.0. Every `@ggui-ai/*` package is published together as one wave with one version, and security fixes ship in the **next wave of the current line** — there are no back-ported patch releases for earlier waves during 0.x.

| Line                | Security fixes        | Notes                                                                                                                                                    |
| ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.18.x` (current)  | ✅ next wave          | Install with `npm install @ggui-ai/cli@latest`.                                                                                                          |
| `0.17.x` (previous) | ❌ upgrade to current | Still speaks the wire the current line accepts (N−1 compatibility), so upgrading is a version bump, not a migration.                                     |
| `0.16.x` and older  | ❌ upgrade to current | Older lines keep working against the hosted service only inside the dated windows in `docs/protocol/SERVICE-COMPAT-POLICY.md` §4; they receive no fixes. |

The wire schema is a draft (`draft-2026-09-10`); a fix that has to change the wire follows `docs/protocol/VERSION-POLICY.md` like any other change. Once `1.0.0` ships this table gains a support window for older majors.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for a security vulnerability.**

Email **`hello@ggui.ai`** with `[security]` in the subject. That inbox is read by a person every business day; it is the same door every other request to the project goes through, and it is the one that is actually staffed.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce, or a minimal proof of concept
- The affected package and version (e.g. `@ggui-ai/mcp-server@0.18.0`)
- Any suggested mitigation

## Response Timeline

- **Acknowledgement** within **3 business days** of receipt
- **Triage and an initial assessment** within **7 business days**
- **Coordinated disclosure** with you before any public advisory or fix ships

A report of remote code execution, an authentication or authorization bypass, or credential exfiltration is treated as the project's highest priority from the moment it is read.

## Disclosure

Once a fix is available:

1. We publish the fixed wave on npm
2. We may publish a GitHub Security Advisory on `ggui-ai/ggui` crediting you, unless you ask to stay anonymous
3. If we publish an advisory, we name it (and the CVE, if one is assigned) in that wave's release notes

We appreciate responsible disclosure and credit reporters in advisories with their consent.
