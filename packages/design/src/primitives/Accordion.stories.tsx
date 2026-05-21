import type { Meta, StoryObj } from '@storybook/react';
import { Accordion } from './Accordion';

const meta: Meta<typeof Accordion> = {
  title: 'Primitives/Disclosure/Accordion',
  component: Accordion,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'bordered', 'separated'],
    },
    multiple: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const faqItems = [
  {
    key: 'what',
    title: 'What is ggui?',
    content: 'ggui is an agent interface platform that enables AI agents to create rich, interactive UIs on demand through MCP.',
  },
  {
    key: 'how',
    title: 'How does it work?',
    content: 'Agents describe what they need in natural language, and ggui\'s UI Builder Agent generates ephemeral interfaces using React components.',
  },
  {
    key: 'pricing',
    title: 'Is there a free tier?',
    content: 'Yes! ggui offers a generous free tier with up to 100 UI generations per month.',
  },
  {
    key: 'support',
    title: 'How do I get support?',
    content: 'You can reach us via email at support@example.com or through our Discord community.',
  },
];

export const Default: Story = {
  args: {
    items: faqItems,
  },
};

export const Bordered: Story = {
  args: {
    items: faqItems,
    variant: 'bordered',
  },
};

export const Separated: Story = {
  args: {
    items: faqItems,
    variant: 'separated',
  },
};

export const Multiple: Story = {
  args: {
    items: faqItems,
    multiple: true,
  },
};

export const WithDisabled: Story = {
  args: {
    items: [
      ...faqItems,
      { key: 'admin', title: 'Admin Settings (restricted)', content: 'Only admins can view this.', disabled: true },
    ],
  },
};

export const PreExpanded: Story = {
  args: {
    items: faqItems,
    expandedKeys: ['what'],
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <div>
        <h3 style={{ marginBottom: '8px', fontSize: '14px', color: '#6b7280' }}>Default</h3>
        <Accordion items={faqItems} />
      </div>
      <div>
        <h3 style={{ marginBottom: '8px', fontSize: '14px', color: '#6b7280' }}>Bordered</h3>
        <Accordion items={faqItems} variant="bordered" />
      </div>
      <div>
        <h3 style={{ marginBottom: '8px', fontSize: '14px', color: '#6b7280' }}>Separated</h3>
        <Accordion items={faqItems} variant="separated" />
      </div>
    </div>
  ),
};
