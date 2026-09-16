# R1 fixtures (ggui#1158 / #1093)

Three light-mode DTCG theme documents, **delivered** by guuey-team-platform from
their deterministic composer (a theme, nothing private) — not derived here.

| file                          | what it is                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stored-dtcg-light.json`      | the negative control: a real stored document with **no** `typeScale`, **no** `rhythm`                                                                   |
| `r1-dtcg-light.json`          | the same generator with `typeScale` + `rhythm` **and** `font.ramp` (base 1.1rem) — the pre-R1 ramp path is live too                                     |
| `r1-isolated-dtcg-light.json` | `typeScale` + `rhythm` with `typography.scale` at default — **no `font.ramp`**, so every variable that moves against the control is the R1 signal alone |

Receipt that makes the isolated one the clean fixture: under `@ggui-ai/design@0.17.0`
(which predates the projection) it derives **0 variables differing** from the control
and the same `overlayHash`. Dark variants exist beside these in guuey's tree.
