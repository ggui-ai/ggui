import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Modal } from './Modal';
import { Button } from '../primitives/Button';
import { Text } from '../primitives/Text';
import { Stack } from '../primitives/Stack';
import { Input } from '../primitives/Input';

const meta: Meta<typeof Modal> = {
  title: 'Compositions/Modal',
  component: Modal,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg', 'xl', 'full'],
    },
    closeOnOverlayClick: { control: 'boolean' },
    closeOnEscape: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Modal</Button>
        <Modal open={open} onClose={() => setOpen(false)} title="Modal Title">
          <Text>This is the modal content. You can put anything here.</Text>
        </Modal>
      </>
    );
  },
};

export const WithFooter: Story = {
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Modal with Footer</Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Confirm Action"
          footer={
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => setOpen(false)}>Confirm</Button>
            </div>
          }
        >
          <Text>Are you sure you want to proceed with this action?</Text>
        </Modal>
      </>
    );
  },
};

export const FormModal: Story = {
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open Form Modal</Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Create New Item"
          size="md"
          footer={
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={() => setOpen(false)}>Create</Button>
            </div>
          }
        >
          <Stack gap={16}>
            <Input label="Name" placeholder="Enter name" />
            <Input label="Email" type="email" placeholder="Enter email" />
            <Input label="Description" placeholder="Enter description" />
          </Stack>
        </Modal>
      </>
    );
  },
};

export const Sizes: Story = {
  render: function Render() {
    const [size, setSize] = useState<'sm' | 'md' | 'lg' | 'xl' | 'full' | null>(null);
    return (
      <>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button size="sm" onClick={() => setSize('sm')}>Small</Button>
          <Button size="sm" onClick={() => setSize('md')}>Medium</Button>
          <Button size="sm" onClick={() => setSize('lg')}>Large</Button>
          <Button size="sm" onClick={() => setSize('xl')}>XL</Button>
          <Button size="sm" onClick={() => setSize('full')}>Full</Button>
        </div>
        {size && (
          <Modal
            open={true}
            onClose={() => setSize(null)}
            title={`${size.toUpperCase()} Modal`}
            size={size}
          >
            <Text>This is a {size} sized modal.</Text>
          </Modal>
        )}
      </>
    );
  },
};

export const DangerModal: Story = {
  render: function Render() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="danger" onClick={() => setOpen(true)}>Delete Item</Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Delete Item"
          footer={
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setOpen(false)}>Delete</Button>
            </div>
          }
        >
          <Text>Are you sure you want to delete this item? This action cannot be undone.</Text>
        </Modal>
      </>
    );
  },
};
