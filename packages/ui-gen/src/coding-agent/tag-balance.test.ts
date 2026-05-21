// core/src/coding-agent/tag-balance.test.ts
//
// Unit tests for the structural-diff preflight helper. Cover the specific
// failure shapes mined from the 2026-04-14 baseline bench logs so the
// regression guard pins the real behavior, not just synthetic cases.

import { describe, it, expect } from "vitest";
import {
  countTagBalance,
  computeTagDeltas,
  checkPatchTagBalance,
  formatImbalanceMessage,
} from "./tag-balance";

describe("countTagBalance", () => {
  it("counts open, close, and self-close per PascalCase tag", () => {
    const code = `<Stack>\n  <Card>hello</Card>\n  <Icon />\n  <Badge variant="primary" />\n</Stack>`;
    const c = countTagBalance(code);
    expect(c.get("Stack")).toEqual({ opens: 1, closes: 1, selfCloses: 0 });
    expect(c.get("Card")).toEqual({ opens: 1, closes: 1, selfCloses: 0 });
    expect(c.get("Icon")).toEqual({ opens: 0, closes: 0, selfCloses: 1 });
    expect(c.get("Badge")).toEqual({ opens: 0, closes: 0, selfCloses: 1 });
  });

  it("ignores lowercase (HTML) tags — only PascalCase components are counted", () => {
    const code = `<div><span>hi</span></div>`;
    const c = countTagBalance(code);
    expect(c.size).toBe(0);
  });

  it("handles multiline attributes", () => {
    const code = `<Card\n  shadow="md"\n  padding="lg"\n  border>\n  content\n</Card>`;
    const c = countTagBalance(code);
    expect(c.get("Card")).toEqual({ opens: 1, closes: 1, selfCloses: 0 });
  });

  it("does not double-count self-closing as opens", () => {
    const code = `<Container>\n  <Icon name="star" />\n  <Icon name="heart" />\n</Container>`;
    const c = countTagBalance(code);
    expect(c.get("Icon")).toEqual({ opens: 0, closes: 0, selfCloses: 2 });
    expect(c.get("Container")).toEqual({ opens: 1, closes: 1, selfCloses: 0 });
  });

  it("does NOT confuse TypeScript generics with JSX opens", () => {
    const code = [
      `const r: Promise<Foo> = fetchData();`,
      `const items = useState<Array<Item>>([]);`,
      `function f<T extends Bar>(x: T): Promise<Baz> { return x as unknown as Promise<Baz>; }`,
      `const stream = useStream<StockTickResponse>("ticks");`,
      `type Result = Map<string, List<User>>;`,
    ].join("\n");
    const c = countTagBalance(code);
    // None of these are JSX. No PascalCase tag should be counted as open/close.
    expect(c.size).toBe(0);
  });

  it("distinguishes TS generic from JSX when both appear in the same function", () => {
    const code = [
      `function Component(): JSX.Element {`,
      `  const data = useState<User>(null);`, // TS generic — don't count
      `  return (`,
      `    <Stack>`, // JSX — count
      `      <Card>content</Card>`, // JSX — count
      `    </Stack>`, // JSX — count
      `  );`,
      `}`,
    ].join("\n");
    const c = countTagBalance(code);
    expect(c.get("Stack")).toEqual({ opens: 1, closes: 1, selfCloses: 0 });
    expect(c.get("Card")).toEqual({ opens: 1, closes: 1, selfCloses: 0 });
    expect(c.has("User")).toBe(false); // the TS generic must NOT be counted
  });

  it("counts conditional-expression JSX correctly (preceded by ? or :)", () => {
    const code = `{loading ? <Spinner /> : <Content />}`;
    const c = countTagBalance(code);
    expect(c.get("Spinner")).toEqual({ opens: 0, closes: 0, selfCloses: 1 });
    expect(c.get("Content")).toEqual({ opens: 0, closes: 0, selfCloses: 1 });
  });

  it("counts JSX preceded by `(`, `{`, `,`, `>` as opens", () => {
    const codes = [
      `return (<Stack>x</Stack>);`, // preceded by `(`
      `items.map(item => <Card key={item.id}>{item.text}</Card>)`, // preceded by `>`
      `{shown && <Alert>hi</Alert>}`, // preceded by space after `&&`
    ];
    for (const code of codes) {
      const c = countTagBalance(code);
      // Each should have at least one balanced JSX element detected
      expect(c.size).toBeGreaterThan(0);
    }
  });
});

describe("computeTagDeltas", () => {
  it("returns empty when balanced", () => {
    const a = `<Stack><Card>x</Card></Stack>`;
    const b = `<Stack><Card>y</Card></Stack>`;
    expect(computeTagDeltas(a, b)).toEqual([]);
  });

  it("detects extra open (replacement adds unclosed Stack)", () => {
    const a = `<Card>original</Card>`;
    const b = `<Stack><Card>original</Card>`;
    const deltas = computeTagDeltas(a, b);
    const stackDelta = deltas.find((d) => d.tag === "Stack")!;
    expect(stackDelta.netDelta).toBe(1);
    expect(stackDelta.opensDelta).toBe(1);
    expect(stackDelta.closesDelta).toBe(0);
  });

  it("detects extra close (replacement adds stray </Card>)", () => {
    const a = `<Stack>x</Stack>`;
    const b = `<Stack>x</Stack></Card>`;
    const deltas = computeTagDeltas(a, b);
    const cardDelta = deltas.find((d) => d.tag === "Card")!;
    expect(cardDelta.netDelta).toBe(-1);
  });

  it("treats self-close changes as balanced (adding <Icon /> doesn't imbalance)", () => {
    const a = `<Card>x</Card>`;
    const b = `<Card><Icon /></Card>`;
    expect(computeTagDeltas(a, b)).toEqual([]);
  });
});

describe("checkPatchTagBalance", () => {
  const sourceBefore = [
    `import React from 'react';`, // 1
    `export default function Component() {`, // 2
    `  return (`, // 3
    `    <Container>`, // 4
    `      <Stack>`, // 5
    `        <Card>`, // 6
    `          <Text>hello</Text>`, // 7
    `        </Card>`, // 8
    `      </Stack>`, // 9
    `    </Container>`, // 10
    `  );`, // 11
    `}`, // 12
  ].join("\n");

  it("passes balanced patches", () => {
    const report = checkPatchTagBalance(sourceBefore, [
      {
        startLine: 7,
        endLine: 7,
        code: [`          <Text>world</Text>`],
      },
    ]);
    expect(report.imbalanced).toBe(false);
    expect(report.totals).toEqual([]);
  });

  it("flags patch that removes a </Stack> closing tag", () => {
    // Replace lines 5-9 (Stack...Stack close) with content that opens but never closes
    const report = checkPatchTagBalance(sourceBefore, [
      {
        startLine: 5,
        endLine: 9,
        code: [
          `      <Stack>`,
          `        <Card>`,
          `          <Text>removed the close</Text>`,
          `        </Card>`,
        ],
      },
    ]);
    expect(report.imbalanced).toBe(true);
    const stackDelta = report.totals.find((d) => d.tag === "Stack")!;
    expect(stackDelta.netDelta).toBe(1);
  });

  it("flags patch that swaps </Card> for </Stack> (the classic mismatch)", () => {
    // Replace line 8 `</Card>` with `</Stack>` — simulates the top tag-mismatch
    // error shape. The Card was opened but not closed in the replacement; the
    // Stack has extra close.
    const report = checkPatchTagBalance(sourceBefore, [
      {
        startLine: 8,
        endLine: 8,
        code: [`        </Stack>`],
      },
    ]);
    expect(report.imbalanced).toBe(true);
    const cardDelta = report.totals.find((d) => d.tag === "Card");
    const stackDelta = report.totals.find((d) => d.tag === "Stack");
    expect(cardDelta?.netDelta).toBe(1); // Card unclosed
    expect(stackDelta?.netDelta).toBe(-1); // Stack extra close
  });

  it("summary message names the tag + nonzero net", () => {
    const report = checkPatchTagBalance(sourceBefore, [
      {
        startLine: 5,
        endLine: 9,
        code: [`      <Stack>`, `        <Card>`, `          <Text>x</Text>`, `        </Card>`],
      },
    ]);
    const msg = formatImbalanceMessage(report);
    expect(msg).toContain("<Stack>");
    expect(msg).toContain("tag open/close counts don't match");
    expect(msg).toContain("matching nesting level");
  });

  it("passes a balanced multi-change patch", () => {
    const report = checkPatchTagBalance(sourceBefore, [
      {
        startLine: 4,
        endLine: 4,
        code: [`    <Container className="x">`],
      },
      {
        startLine: 10,
        endLine: 10,
        code: [`    </Container>`],
      },
    ]);
    expect(report.imbalanced).toBe(false);
  });
});
