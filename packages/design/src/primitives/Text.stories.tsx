import type { Meta, StoryObj } from '@storybook/react';
import { Text } from './Text';

const meta: Meta<typeof Text> = {
  title: 'Primitives/Typography/Text',
  component: Text,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['body', 'bodySmall', 'bodyLarge', 'caption', 'label', 'overline'],
    },
    size: {
      control: 'select',
      options: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'],
    },
    weight: {
      control: 'select',
      options: ['normal', 'medium', 'semibold', 'bold'],
    },
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
    children: 'This is body text, the default variant for paragraphs and general content.',
    variant: 'body',
  },
};

export const BodySmall: Story = {
  args: {
    children: 'This is smaller body text, useful for secondary information.',
    variant: 'bodySmall',
  },
};

export const BodyLarge: Story = {
  args: {
    children: 'This is larger body text, great for introductions or emphasis.',
    variant: 'bodyLarge',
  },
};

export const Caption: Story = {
  args: {
    children: 'This is caption text for image descriptions or footnotes.',
    variant: 'caption',
  },
};

export const Label: Story = {
  args: {
    children: 'Form Label',
    variant: 'label',
  },
};

export const Overline: Story = {
  args: {
    children: 'OVERLINE TEXT',
    variant: 'overline',
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
      <Text is="label" htmlFor="story-email" variant="label">
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

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Text variant="overline">OVERLINE</Text>
      <Text variant="caption">Caption text</Text>
      <Text variant="label">Label text</Text>
      <Text variant="bodySmall">Body small text</Text>
      <Text variant="body">Body text (default)</Text>
      <Text variant="bodyLarge">Body large text</Text>
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
