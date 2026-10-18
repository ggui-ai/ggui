// ggui#1932 — the boilerplate's DO NOT EDIT React import is kept by code: the auto-commit restores a
// dropped boilerplate hook before the build and tier-0, so the model never spends a turn on
// `Cannot find name 'useMemo'`. The restored line is a superset of the model's; any other 'react'
// import form is left alone.
import { describe, expect, it, vi } from 'vitest';
import { AgentWorkspace } from '../workspace';
import { executeTool } from '../tools';
import { BOILERPLATE_REACT_IMPORT, restoreReactImport } from '../../boilerplate/react-hooks';

const body = `import { Box, Text } from '@ggui-ai/design';

interface Props {
  title: string;
}

export default function Component(props: Props) {
  const v = useMemo(() => props.title.length, [props.title]);
  return (
    <Box padding="md">
      <Text>{String(v)}</Text>
    </Box>
  );
}
`;

describe('restoreReactImport (ggui#1932)', () => {
  it('intact boilerplate line: byte-identical, nothing added', () => {
    const src = `${BOILERPLATE_REACT_IMPORT}\n${body}`;
    expect(restoreReactImport(src)).toEqual({ source: src, added: [] });
  });

  it('reduced to the default import: the boilerplate line comes back, byte-for-byte', () => {
    const r = restoreReactImport(`import React from 'react';\n${body}`);
    expect(r.source).toBe(`${BOILERPLATE_REACT_IMPORT}\n${body}`);
    expect(r.added).toEqual(['useState', 'useCallback', 'useMemo', 'useEffect', 'useLayoutEffect', 'useRef']);
  });

  it('a hook dropped, an extra name kept: a superset, boilerplate order then the model\'s extras', () => {
    const r = restoreReactImport(`import React, { useState, useReducer, Fragment } from 'react';\n${body}`);
    expect(r.source.split('\n')[0]).toBe(
      "import React, { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef, useReducer, Fragment } from 'react';",
    );
    expect(r.added).toEqual(['useCallback', 'useMemo', 'useEffect', 'useLayoutEffect', 'useRef']);
  });

  it('an aliased boilerplate hook counts as imported', () => {
    const line = "import React, { useState, useCallback, useMemo as memo, useEffect, useLayoutEffect, useRef } from 'react';";
    expect(restoreReactImport(`${line}\n${body}`).added).toEqual([]);
  });

  it('no import from react at all and a boilerplate hook called: the boilerplate line is inserted at the top', () => {
    const r = restoreReactImport(body);
    expect(r.source).toBe(`${BOILERPLATE_REACT_IMPORT}\n${body}`);
  });

  it('no import from react and no boilerplate hook called: left alone (an insert would shift every line)', () => {
    const src = 'export default function C() { return <div />; }\n';
    expect(restoreReactImport(src)).toEqual({ source: src, added: [] });
  });

  it.each([
    ['named-only', "import { useState } from 'react';"],
    ['namespace', "import * as React from 'react';"],
    ['two react imports', `${BOILERPLATE_REACT_IMPORT}\nimport { useId } from 'react';`],
    ['spanning lines', "import React, {\n  useState,\n  useMemo,\n} from 'react';"],
    ['a type specifier', "import React, { useState, type ReactNode } from 'react';"],
    ['a comment', "import React, { useState /* keep */ } from 'react';"],
  ])('fail-closed: %s is left alone', (_kind, line) => {
    const src = `${line}\n${body}`;
    expect(restoreReactImport(src)).toEqual({ source: src, added: [] });
  });
});

describe('the auto-commit restores before tier-0 (ggui#1932)', () => {
  it('a dropped hook commits PASS, the workspace holds the restored line, and the restore is logged', async () => {
    const ws = new AgentWorkspace();
    await ws.init();
    const log = vi.spyOn(console, 'log');
    const result = await executeTool(ws, 'write', { code: `import React from 'react';\n${body}`, commit_message: 'feat: x' }, new Map());
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(result.done, result.result).toBe(true);
    expect(ws.read()?.split('\n')[0]).toBe(BOILERPLATE_REACT_IMPORT);
    // The COMMITTED source carries the line the checks ran on, not just the working copy.
    const [head] = await ws.log(1);
    expect(head).toBeDefined();
    const committed = await ws.readFileAtCommit(head?.oid ?? '');
    expect(committed).toBe(`${BOILERPLATE_REACT_IMPORT}\n${body}`);
    expect(lines.some((l) => l === '[coding-agent] react-import restored: +useState,+useCallback,+useMemo,+useEffect,+useLayoutEffect,+useRef')).toBe(true);
  }, 30000);

  it('all six boilerplate hooks unused: the restored line raises no tier-0 fail (behaviour, not lint config)', async () => {
    const ws = new AgentWorkspace();
    await ws.init();
    const card = `import React from 'react';\ninterface Props {\n  title: string;\n}\n\nimport { Text } from '@ggui-ai/design';\n\nexport default function Component(props: Props) {\n  return <Text>{props.title}</Text>;\n}\n`;
    const result = await executeTool(ws, 'write', { code: card, commit_message: 'feat: x' }, new Map());
    expect(result.done, result.result).toBe(true);
    expect(ws.read()?.startsWith(BOILERPLATE_REACT_IMPORT)).toBe(true);
  }, 30000);

  it('control: an intact line logs no restore', async () => {
    const ws = new AgentWorkspace();
    await ws.init();
    const log = vi.spyOn(console, 'log');
    const result = await executeTool(ws, 'write', { code: `${BOILERPLATE_REACT_IMPORT}\n${body}`, commit_message: 'feat: x' }, new Map());
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(result.done, result.result).toBe(true);
    expect(lines.some((l) => l.includes('react-import restored'))).toBe(false);
  }, 30000);
});
