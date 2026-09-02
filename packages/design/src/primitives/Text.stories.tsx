import type { Meta, StoryObj } from '@storybook/react-vite';
import { Text } from './Text';

const meta: Meta<typeof Text> = {
  title: 'Primitives/Typography/Text',
  component: Text,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'],
    },
    weight: {
      control: 'select',
      options: ['normal', 'medium', 'semibold', 'bold'],
    },
    caps: { control: 'boolean' },
    align: {
      control: 'select',
      options: ['left', 'center', 'right'],
    },
    truncate: { control: 'boolean' },
    tone: {
      control: 'select',
      options: [
        undefined,
        'default',
        'muted',
        'subtle',
        'emphasized',
        'loud',
        'success',
        'warning',
        'error',
        'info',
        'inverse',
        'inherit',
      ],
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Body: Story = {
  args: {
    children: 'This is body text, the default for paragraphs and general content.',
  },
};

export const BodySmall: Story = {
  args: {
    children: 'This is smaller body text, useful for secondary information.',
    size: 'sm',
  },
};

export const BodyLarge: Story = {
  args: {
    children: 'This is larger body text, great for introductions or emphasis.',
    size: 'lg',
  },
};

export const Caption: Story = {
  args: {
    children: 'This is caption text for image descriptions or footnotes.',
    size: 'xs',
    tone: 'muted',
  },
};

export const Label: Story = {
  args: {
    children: 'Form Label',
    size: 'sm',
    weight: 'medium',
  },
};

// The eyebrow/overline treatment — `caps` uppercases the content and
// adds 0.05em letter-spacing; children stay written in normal case.
export const Overline: Story = {
  args: {
    children: 'Overline text',
    size: 'xs',
    weight: 'semibold',
    caps: true,
  },
};

export const CustomColor: Story = {
  args: {
    children: 'Text with custom tone',
    tone: 'emphasized',
  },
};

export const Bold: Story = {
  args: {
    children: 'Bold text for emphasis',
    weight: 'bold',
  },
};

export const Truncated: Story = {
  args: {
    children: 'This is a very long text that will be truncated with an ellipsis when it exceeds the available width of its container.',
    truncate: true,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '200px' }}>
        <Story />
      </div>
    ),
  ],
};

// `is="label"` renders a semantic `<label>`; `htmlFor` ties it to a
// control by id. Text is a content primitive — `is` is its only
// polymorphism (no `as={Trait}`).
export const AsLabel: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <Text is="label" htmlFor="story-email" size="sm" weight="medium">
        Email address
      </Text>
      <input
        id="story-email"
        type="email"
        placeholder="you@example.com"
        style={{ padding: '8px', borderRadius: '4px', border: '1px solid #d4d4d8' }}
      />
    </div>
  ),
};

// The common typographic roles, each composed from size/weight/caps —
// there is no preset table; these three axes ARE the API.
export const TypeRoles: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Text size="xs" weight="semibold" caps tone="muted">Overline</Text>
      <Text size="xs" tone="muted">Caption text</Text>
      <Text size="sm" weight="medium">Label text</Text>
      <Text size="sm">Body small text</Text>
      <Text>Body text (default)</Text>
      <Text size="lg">Body large text</Text>
    </div>
  ),
};

export const AllSizes: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Text size="xs">Extra small (xs)</Text>
      <Text size="sm">Small (sm)</Text>
      <Text size="base">Base (default)</Text>
      <Text size="lg">Large (lg)</Text>
      <Text size="xl">Extra large (xl)</Text>
      <Text size="2xl">2XL</Text>
      <Text size="3xl">3XL</Text>
      <Text size="4xl">4XL</Text>
    </div>
  ),
};
