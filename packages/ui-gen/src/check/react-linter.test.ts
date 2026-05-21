// packages/ui-gen/src/check/react-linter.test.ts
//
// Regression tests for the `no-unused-vars` scope in react-linter.
// Relocated from `core/src/tools/react-linter.test.ts` as part of the
// OSS tier-0 CHECK migration. Only the import path and this header
// were rewritten — assertions are verbatim from the original so the
// promotion preserves behavior exactly.
//
// Why this file exists: core ESLint `no-unused-vars` was added to
// catch wire-hook bindings the LLM declared
// but never consumed. Rule was too broad — it also fired on the ~50
// primitive / hook imports the boilerplate injects at the top of every
// component ("DO NOT EDIT imports"). The LLM can only consume a
// handful per component, so the rule churned through 40-300+ lint
// violations per generation on imports that are contractually frozen.
//
// Fix: the boilerplate template wraps its import block in
// `/* eslint-disable no-unused-vars */` ... `/* eslint-enable
// no-unused-vars */`. The disable ENDS before the Props interface —
// so wire-hook bindings (`const submit = useAction('submit')`) in the
// component body stay subject to the rule, which catches
// contract-abandonment.
//
// These tests lock in both directions of that scope:
//   1. Unused primitive imports inside the disable block produce ZERO
//      `no-unused-vars` diagnostics (the intent of the fix).
//   2. Unused wire-hook bindings in the component body still fire
//      (so contract-abandonment is still caught).

import { describe, expect, it } from 'vitest';
import { lintReactHooks } from './react-linter.js';

describe('react-linter — no-unused-vars scope', () => {
  it('suppresses no-unused-vars on boilerplate imports inside the eslint-disable block', async () => {
    // Mirrors the real boilerplate shape: many imports, only one used.
    const code = `// DO NOT EDIT imports — all available components are pre-imported.
// prettier-ignore-start
/* eslint-disable no-unused-vars */
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Container, Card, Stack, Row, Box, Divider, Spacer, Text, Heading, Button, Input, TextArea, Select, Checkbox, Toggle, RadioGroup, Slider, Badge, Spinner, Avatar, Alert, Progress, Image, Icon, Link, Tooltip, Table, Tabs, Accordion } from '@ggui-ai/design/primitives';
import { SearchField, FormField, MenuItem, Tag, Dropdown, Autocomplete, Breadcrumb, Pagination } from '@ggui-ai/design/components';
import { Header, Sidebar, CardGrid, CommentThread, DataTable, ChatWindow, NavigationBar, Modal, Footer, Hero } from '@ggui-ai/design/compositions';
import { Clickable, Hoverable, Pressable } from '@ggui-ai/design/interact';
import { useAction, useStream } from '@ggui-ai/wire';
/* eslint-enable no-unused-vars */
// prettier-ignore-end

interface Props { title: string }

export default function Component(props: Props) {
  return <Text>{props.title}</Text>;
}
`;
    const diags = await lintReactHooks(code);
    const unused = diags.filter(d => d.rule === 'no-unused-vars');
    expect(unused).toHaveLength(0);
  });

  it('still fires no-unused-vars on wire-hook bindings inside the component body', async () => {
    // The eslint-disable block ends BEFORE the Props interface, so any
    // unused const inside the function body is still flagged — this is
    // the narrow scope Seal B was designed for (catching the
    // abandonment case: hook declared, never consumed).
    const code = `// prettier-ignore-start
/* eslint-disable no-unused-vars */
import React from 'react';
import { Text } from '@ggui-ai/design/primitives';
import { useAction } from '@ggui-ai/wire';
/* eslint-enable no-unused-vars */
// prettier-ignore-end

interface Props { title: string }

export default function Component(props: Props) {
  const submit = useAction('submit');
  return <Text>{props.title}</Text>;
}
`;
    const diags = await lintReactHooks(code);
    const unused = diags.filter(d => d.rule === 'no-unused-vars');
    expect(unused).toHaveLength(1);
    expect(unused[0].message).toContain('submit');
  });

  it('respects the _-prefix escape hatch in the component body', async () => {
    // LLMs occasionally need a local they don't consume. The rule
    // config allows `_`-prefixed names as an explicit opt-out.
    const code = `import React from 'react';
import { Text } from '@ggui-ai/design/primitives';

interface Props { title: string }

export default function Component(props: Props) {
  const _intentionallyUnused = 42;
  return <Text>{props.title}</Text>;
}
`;
    const diags = await lintReactHooks(code);
    const unused = diags.filter(d => d.rule === 'no-unused-vars');
    expect(unused).toHaveLength(0);
  });
});

describe('react-linter — no-unused-vars severity (wire vs local)', () => {
  // An unused CONTRACT-WIRE binding (`useAction`/`useStream`/
  // `useGguiContext`) stays a hard `error` — an abandoned wire ships a
  // dead subscription. An unused LOCAL helper / `useMemo` result / a
  // state-read gadget binding downgrades to `warning` — it is transient
  // mid-generation coding state, not a defect, and blocking tier-0 on
  // it is the largest turn-thrash driver.

  it('keeps an unused useAction binding at error severity', async () => {
    const code = `import React from 'react';
import { Text } from '@ggui-ai/design/primitives';
import { useAction } from '@ggui-ai/wire';

interface Props { title: string }

export default function Component(props: Props) {
  const submit = useAction('submit');
  return <Text>{props.title}</Text>;
}
`;
    const diags = await lintReactHooks(code);
    const unused = diags.filter(d => d.rule === 'no-unused-vars');
    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe('error');
  });

  it('keeps an unused useStream / useGguiContext binding at error severity', async () => {
    const code = `import React from 'react';
import { Text } from '@ggui-ai/design/primitives';
import { useStream, useGguiContext } from '@ggui-ai/wire';

interface Props { title: string }

export default function Component(props: Props) {
  const ticker = useStream('ticker');
  const [step] = useGguiContext('step');
  return <Text>{props.title}</Text>;
}
`;
    const diags = await lintReactHooks(code);
    const unused = diags.filter(d => d.rule === 'no-unused-vars');
    expect(unused.length).toBeGreaterThanOrEqual(1);
    for (const d of unused) expect(d.severity).toBe('error');
  });

  it('downgrades an unused local helper to warning severity', async () => {
    const code = `import React from 'react';
import { Text } from '@ggui-ai/design/primitives';

interface Props { title: string }

export default function Component(props: Props) {
  const columnLookup = { todo: 'To Do' };
  return <Text>{props.title}</Text>;
}
`;
    const diags = await lintReactHooks(code);
    const unused = diags.filter(d => d.rule === 'no-unused-vars');
    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe('warning');
  });

  it('downgrades an unused state-read gadget binding to warning severity', async () => {
    const code = `import React from 'react';
import { Text } from '@ggui-ai/design/primitives';
import { useBoardState } from '@example/gadget-board';

interface Props { title: string }

export default function Component(props: Props) {
  const boardState = useBoardState();
  return <Text>{props.title}</Text>;
}
`;
    const diags = await lintReactHooks(code);
    const unused = diags.filter(d => d.rule === 'no-unused-vars');
    expect(unused).toHaveLength(1);
    expect(unused[0].severity).toBe('warning');
  });
});
