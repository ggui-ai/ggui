/**
 * The two fixed fixtures every prompt pin renders — one action-bearing
 * `chat`×`mobile` shell, one `fullscreen`×`desktop` board with a
 * `contextSpec` — shared by `design-mode.pin.test.ts` (the stable prefix)
 * and `shape-guidance.pin.test.ts` (the axis-conditioned Shape Guidance).
 */
import type { DataContract } from '@ggui-ai/protocol';

export interface PinFixture {
  readonly userRequest: string;
  readonly shellType: 'chat' | 'fullscreen' | 'spatial';
  readonly screen: 'mobile' | 'tablet' | 'desktop' | 'universal';
  readonly contract: DataContract;
}

export const PIN_FIXTURES: readonly PinFixture[] = [
  {
    userRequest: 'A todo list where each item can be toggled done',
    shellType: 'chat',
    screen: 'mobile',
    contract: {
      propsSpec: {
        properties: {
          todos: {
            required: true,
            description: 'The todos to show',
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  done: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      actionSpec: {
        toggleTodo: {
          label: 'Toggle',
          description: 'Flip the done state of one todo',
          schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      },
    },
  },
  {
    userRequest: 'A kanban board with live task updates and a selected card',
    shellType: 'fullscreen',
    screen: 'desktop',
    contract: {
      propsSpec: {
        properties: {
          columns: {
            required: true,
            schema: { type: 'array', items: { type: 'string' } },
          },
          tasks: {
            required: false,
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  column: { type: 'string' },
                  title: { type: 'string' },
                },
              },
            },
          },
        },
      },
      streamSpec: {
        taskUpdates: {
          description: 'Task CRUD feed',
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'move', 'edit', 'delete'] },
              id: { type: 'string' },
            },
          },
        },
      },
      contextSpec: {
        selectedId: { schema: { type: 'string', nullable: true } },
      },
    },
  },
];
