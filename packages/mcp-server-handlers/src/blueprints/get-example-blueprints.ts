/**
 * `ggui_get_example_blueprints` — curated reference blueprints for
 * Claude to read-and-learn (NOT start-from).
 *
 * Pure compute, no DDB. Returns 3 hand-authored examples covering the
 * most common contract patterns:
 *
 *   - `display`  — props in, no actions, no stream (weather card)
 *   - `collect`  — props in, action with payload (task input)
 *   - `converse` — props in + stream out + action with payload (chat)
 *
 * Each entry pairs a complete `source.tsx` with the matching
 * `contract` envelope so Claude can see exactly how contract fields
 * thread through to imports, hooks, and JSX.
 *
 * Use this when:
 *   - First-time composing in a fresh conversation (alongside
 *     `ggui_protocol_describe_blueprint_format` + `ggui_protocol_describe_data_contract_format`).
 *   - The intent maps to a familiar pattern (form / list / chat /
 *     dashboard) and you want a starting point for the contract shape.
 *
 * For a contract-driven scaffold tailored to YOUR specific contract,
 * call `ggui_protocol_get_blueprint_boilerplate` instead — that's the
 * generative path; this is the curated reference path.
 */
import { z } from 'zod';
import type { SharedHandler } from '../types.js';

const inputSchema = {
  kind: z
    .enum(['display', 'collect', 'converse', 'all'])
    .default('all')
    .describe(
      'Filter by pattern kind. `all` returns every example; pick a specific value to narrow.',
    ),
};

const outputSchema = {
  examples: z.array(
    z.object({
      title: z.string(),
      kind: z.enum(['display', 'collect', 'converse']),
      summary: z.string(),
      blueprint: z.object({
        source: z.string(),
        contract: z.record(z.string(), z.unknown()),
        fixtureProps: z.record(z.string(), z.unknown()).optional(),
      }),
    }),
  ),
};

interface ExampleBlueprintEntry {
  readonly title: string;
  readonly kind: 'display' | 'collect' | 'converse';
  readonly summary: string;
  readonly blueprint: {
    readonly source: string;
    readonly contract: Record<string, unknown>;
    readonly fixtureProps?: Record<string, unknown>;
  };
}

interface GetExampleBlueprintsOutput {
  readonly examples: ReadonlyArray<ExampleBlueprintEntry>;
}

const WEATHER_CARD: ExampleBlueprintEntry = {
  title: 'Weather card',
  kind: 'display',
  summary:
    'Read-only card showing current weather for a city. Demonstrates props with enums, primitive layout (Card + Stack + Row + Text), and zero actions/stream.',
  blueprint: {
    source: `import { Card, Stack, Row, Text, Heading } from '@ggui-ai/design/primitives';

interface Props {
  city: string;
  tempC: number;
  condition: 'sunny' | 'cloudy' | 'rainy';
  humidityPct: number;
}

const ICON: Record<Props['condition'], string> = {
  sunny: '☀️',
  cloudy: '☁️',
  rainy: '🌧️',
};

export default function WeatherCard(props: Props) {
  return (
    <Card>
      <Stack gap={2}>
        <Heading level={3}>{props.city}</Heading>
        <Row align="center" gap={3}>
          <Text size="3xl">{ICON[props.condition]}</Text>
          <Stack gap={0}>
            <Text size="2xl" weight="bold">{Math.round(props.tempC)}°C</Text>
            <Text size="sm" tone="muted">{props.condition}</Text>
          </Stack>
        </Row>
        <Text size="sm" tone="muted">Humidity {props.humidityPct}%</Text>
      </Stack>
    </Card>
  );
}`,
    contract: {
      propsSpec: {
        properties: {
          city: { schema: { type: 'string' }, required: true, description: 'City name' },
          tempC: { schema: { type: 'number' }, required: true, description: 'Temperature in Celsius' },
          condition: {
            schema: { type: 'string', enum: ['sunny', 'cloudy', 'rainy'] },
            required: true,
            description: 'Sky condition',
          },
          humidityPct: {
            schema: { type: 'number', minimum: 0, maximum: 100 },
            required: true,
            description: 'Humidity 0-100',
          },
        },
      },
    },
    fixtureProps: {
      city: 'Seoul',
      tempC: 18,
      condition: 'cloudy',
      humidityPct: 62,
    },
  },
};

const TASK_INPUT: ExampleBlueprintEntry = {
  title: 'Task input form',
  kind: 'collect',
  summary:
    'Single-field form that submits a task title. Demonstrates `useAction<T>` with a typed payload, controlled Input, button-disabled state, and a cancel action.',
  blueprint: {
    source: `import { useState } from 'react';
import { Card, Stack, Row, Input, Button } from '@ggui-ai/design/primitives';
import { useAction } from '@ggui-ai/wire';

interface Props {
  placeholder?: string;
}

export default function TaskInput(props: Props) {
  const submit = useAction<{ title: string }>('submit');
  const cancel = useAction<void>('cancel');
  const [title, setTitle] = useState('');
  const canSubmit = title.trim().length > 0;
  return (
    <Card>
      <Stack gap={2}>
        <Input
          value={title}
          onChange={setTitle}
          placeholder={props.placeholder ?? 'New task'}
          autoFocus
        />
        <Row gap={2} justify="end">
          <Button variant="secondary" onClick={() => cancel()}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() => submit({ title: title.trim() })}
          >
            Add task
          </Button>
        </Row>
      </Stack>
    </Card>
  );
}`,
    contract: {
      propsSpec: {
        properties: {
          placeholder: {
            schema: { type: 'string' },
            required: false,
            default: 'New task',
            description: 'Placeholder text for the empty input.',
          },
        },
      },
      actionSpec: {
        submit: {
          label: 'Add task',
          description: 'User submitted a new task title.',
          schema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
        },
        cancel: {
          label: 'Cancel',
          description: 'User dismissed without submitting.',
        },
      },
    },
    fixtureProps: {
      placeholder: 'What needs doing?',
    },
  },
};

const CHAT_PANEL: ExampleBlueprintEntry = {
  title: 'Chat panel',
  kind: 'converse',
  summary:
    'Live chat with streamed agent replies. Demonstrates `useStream<T>` for token-delta updates, message-list rendering, and a send action paired with the stream.',
  blueprint: {
    source: `import { useState, useEffect } from 'react';
import { Card, Stack, Row, Text, Input, Button } from '@ggui-ai/design/primitives';
import { useAction, useStream } from '@ggui-ai/wire';

interface Message {
  role: 'user' | 'agent';
  text: string;
}

interface Props {
  messages: Message[];
}

export default function ChatPanel(props: Props) {
  const send = useAction<{ text: string }>('send');
  const reply = useStream<{ delta: string }>('agentReply');
  const [draft, setDraft] = useState('');
  const [agentText, setAgentText] = useState('');

  useEffect(() => {
    if (reply.latest) {
      setAgentText(prev => prev + reply.latest!.delta);
    }
  }, [reply.latest]);

  return (
    <Card>
      <Stack gap={2}>
        <Stack gap={1}>
          {props.messages.map((m, i) => (
            <Row key={i} gap={2}>
              <Text weight="bold">{m.role === 'user' ? 'You' : 'Agent'}:</Text>
              <Text>{m.text}</Text>
            </Row>
          ))}
          {agentText && (
            <Row gap={2}>
              <Text weight="bold">Agent:</Text>
              <Text>{agentText}</Text>
            </Row>
          )}
        </Stack>
        <Row gap={2}>
          <Input value={draft} onChange={setDraft} placeholder="Say something..." />
          <Button
            onClick={() => {
              send({ text: draft });
              setDraft('');
              setAgentText('');
            }}
          >
            Send
          </Button>
        </Row>
      </Stack>
    </Card>
  );
}`,
    contract: {
      propsSpec: {
        properties: {
          messages: {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['user', 'agent'] },
                  text: { type: 'string' },
                },
                required: ['role', 'text'],
              },
            },
            required: true,
            description: 'Initial conversation history.',
          },
        },
      },
      streamSpec: {
        agentReply: {
          description: 'Token-by-token agent response chunks.',
          schema: {
            type: 'object',
            properties: { delta: { type: 'string' } },
            required: ['delta'],
          },
        },
      },
      actionSpec: {
        send: {
          label: 'Send',
          description: 'User sent a message to the agent.',
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
    },
    fixtureProps: {
      messages: [
        { role: 'user', text: 'What can you do?' },
        { role: 'agent', text: 'Lots of things — try asking me anything.' },
      ],
    },
  },
};

const ALL_EXAMPLES: ReadonlyArray<ExampleBlueprintEntry> = [
  WEATHER_CARD,
  TASK_INPUT,
  CHAT_PANEL,
];

export function createGetExampleBlueprintsHandler(): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  GetExampleBlueprintsOutput
> {
  return {
    name: 'ggui_protocol_get_example_blueprints',
    title: 'Get example blueprints',
    audience: ['protocol'],
    description:
      "Returns 3 curated reference blueprints (one per common contract pattern: `display`, `collect`, `converse`) — each is a complete `source` + `contract` pair you can read to learn how the pieces thread together. Pass `kind` to filter, or omit / pass `all` to get everything. **Read-to-learn, not start-from** — for a scaffold tailored to YOUR specific contract, call `ggui_protocol_get_blueprint_boilerplate` instead. These examples cover the canonical patterns: weather card (props, no actions), task input (props + action with payload), chat panel (props + stream + action).",
    inputSchema,
    outputSchema,
    async handler(rawInput: Record<string, unknown>) {
      const parsed = z.object(inputSchema).parse(rawInput);
      const filtered =
        parsed.kind === 'all'
          ? ALL_EXAMPLES
          : ALL_EXAMPLES.filter((ex) => ex.kind === parsed.kind);
      return { examples: [...filtered] };
    },
  };
}
