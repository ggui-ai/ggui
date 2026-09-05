# CLI sample inputs

What the three pure-function-catalog flags of `ggui-protocol-conformance`
expect — `--registry <file.json>`, `--projector <module>`,
`--transport-projector <module>` (ggui#803 leg 3). `project.mjs` and
`endpoint.mjs` are minimal but spec-correct: each passes the catalog it
demonstrates (`cli.test.ts` pins that), so they are safe to copy as a
starting point. `registry.json` is one well-formed row, and
`bad-export.mjs` is the negative sample (no function export). These
files live in the repository only — the npm tarball ships `dist` and the
README.
