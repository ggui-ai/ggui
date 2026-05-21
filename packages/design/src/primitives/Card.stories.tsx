import type { Meta, StoryObj } from '@storybook/react';
import { Card } from './Card';
import type { CardProps } from './types';
import { Text } from './Text';
import { Button } from './Button';
import { Stack } from './Stack';
import { Clickable } from '../interact';

// Typed against `CardProps` (own props), not `typeof Card`: `Card`'s
// public type is `WithTrait<CardProps>` — a discriminated union on
// `as` — which Storybook's `StoryObj` arg inference collapses to
// `never`. The args-driven stories below only set own props; the
// trait path is exercised by the `render`-based ClickableCard story.
const meta: Meta<CardProps> = {
  title: 'Primitives/Layout/Card',
  component: Card,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    shadow: {
      control: 'select',
      options: ['none', 'sm', 'md', 'lg', 'xl'],
    },
    radius: {
      control: 'select',
      options: ['none', 'sm', 'md', 'lg', 'xl'],
    },
    border: { control: 'boolean' },
    padding: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'This is a basic card with default styling.',
  },
};

export const WithContent: Story = {
  render: () => (
    <Card style={{ width: '320px' }}>
      <Stack gap={12}>
        <Text variant="body" weight="semibold">Card Title</Text>
        <Text variant="bodySmall" tone="muted">
          This is a card with more complex content including text and actions.
        </Text>
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <Button size="sm">Action</Button>
          <Button size="sm" variant="outline">Cancel</Button>
        </div>
      </Stack>
    </Card>
  ),
};

export const NoShadow: Story = {
  args: {
    shadow: 'none',
    border: true,
    children: 'Card with no shadow but with border',
  },
};

export const LargeShadow: Story = {
  args: {
    shadow: 'xl',
    children: 'Card with extra large shadow',
  },
};

export const NoBorder: Story = {
  args: {
    border: false,
    shadow: 'md',
    children: 'Card without border',
  },
};

export const CustomPadding: Story = {
  args: {
    padding: 32,
    children: 'Card with 32px padding',
  },
};

export const Radiuses: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: '16px' }}>
      <Card radius="none" style={{ width: '120px' }}>
        <Text variant="caption">None</Text>
      </Card>
      <Card radius="sm" style={{ width: '120px' }}>
        <Text variant="caption">Small</Text>
      </Card>
      <Card radius="md" style={{ width: '120px' }}>
        <Text variant="caption">Medium</Text>
      </Card>
      <Card radius="lg" style={{ width: '120px' }}>
        <Text variant="caption">Large</Text>
      </Card>
      <Card radius="xl" style={{ width: '120px' }}>
        <Text variant="caption">XL</Text>
      </Card>
    </div>
  ),
};

// Trait composition proof — `as={Clickable}` widens Card's props to
// accept `onClick` / `hoverStyle` (ClickableProps). A bare `<Card>`
// (no `as`) rejects a raw `onClick` at compile time — the affordance
// is reachable only by opting into a trait, which carries the
// keyboard + ARIA wiring with it. This story compiling IS the proof.
export const ClickableCard: Story = {
  render: () => (
    <Card
      as={Clickable}
      onClick={() => {
        /* trait composition — typechecks via WithTrait<CardProps> */
      }}
      hoverStyle={{ boxShadow: 'var(--ggui-shape-shadow-lg)' }}
      shadow="md"
      style={{ width: '320px' }}
    >
      <Text variant="body">
        A clickable card — `as={'{Clickable}'}` layers click, keyboard
        activation, and ARIA onto the card with no change to the tree.
      </Text>
    </Card>
  ),
};
