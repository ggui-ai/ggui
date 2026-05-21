import type { Meta, StoryObj } from '@storybook/react';
import { Toast } from './Toast';

const meta: Meta<typeof Toast> = {
  title: 'Primitives/Notification/Toast',
  component: Toast,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['info', 'success', 'warning', 'error'],
    },
    duration: { control: 'number' },
    visible: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {
  args: {
    message: 'Your changes have been saved.',
    variant: 'info',
    duration: 0,
  },
};

export const Success: Story = {
  args: {
    message: 'File uploaded successfully.',
    variant: 'success',
    title: 'Upload Complete',
    duration: 0,
  },
};

export const Warning: Story = {
  args: {
    message: 'Your session will expire in 5 minutes.',
    variant: 'warning',
    title: 'Session Expiring',
    duration: 0,
  },
};

export const Error: Story = {
  args: {
    message: 'Failed to save changes. Please try again.',
    variant: 'error',
    title: 'Save Failed',
    duration: 0,
  },
};

export const WithTitle: Story = {
  args: {
    message: 'Your profile information has been updated.',
    variant: 'success',
    title: 'Profile Updated',
    duration: 0,
  },
};

export const Closable: Story = {
  args: {
    message: 'This toast can be dismissed.',
    variant: 'info',
    onClose: () => alert('Toast closed!'),
    duration: 0,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Toast message="Information message." variant="info" duration={0} />
      <Toast message="Operation completed." variant="success" title="Success" duration={0} />
      <Toast message="Proceed with caution." variant="warning" title="Warning" duration={0} />
      <Toast message="Something went wrong." variant="error" title="Error" duration={0} />
    </div>
  ),
};
