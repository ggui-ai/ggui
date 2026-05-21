import type { Meta, StoryObj } from '@storybook/react';
import { Alert } from './Alert';

const meta: Meta<typeof Alert> = {
  title: 'Primitives/Feedback/Alert',
  component: Alert,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['info', 'success', 'warning', 'error'],
    },
    closable: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {
  args: {
    children: 'A new version of the software is available.',
    variant: 'info',
    title: 'Update Available',
  },
};

export const Success: Story = {
  args: {
    children: 'Your account has been created successfully.',
    variant: 'success',
    title: 'Account Created',
  },
};

export const Warning: Story = {
  args: {
    children: 'Your subscription will expire in 3 days.',
    variant: 'warning',
    title: 'Expiring Soon',
  },
};

export const Error: Story = {
  args: {
    children: 'Unable to connect to the server. Please check your connection.',
    variant: 'error',
    title: 'Connection Error',
  },
};

export const Closable: Story = {
  args: {
    children: 'This alert can be dismissed.',
    variant: 'info',
    closable: true,
    onClose: () => alert('Alert closed!'),
  },
};

export const WithoutTitle: Story = {
  args: {
    children: 'A simple informational message without a title.',
    variant: 'info',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Alert variant="info" title="Info">Informational message.</Alert>
      <Alert variant="success" title="Success">Operation completed successfully.</Alert>
      <Alert variant="warning" title="Warning">Please review before proceeding.</Alert>
      <Alert variant="error" title="Error">Something went wrong.</Alert>
    </div>
  ),
};
