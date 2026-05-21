import type { Meta, StoryObj } from '@storybook/react';
import { Image } from './Image';

const meta: Meta<typeof Image> = {
  title: 'Primitives/Media/Image',
  component: Image,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    objectFit: {
      control: 'select',
      options: ['cover', 'contain', 'fill', 'none', 'scale-down'],
    },
    width: { control: 'number' },
    height: { control: 'number' },
    radius: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    src: 'https://picsum.photos/400/300',
    alt: 'Sample image',
    width: 400,
    height: 300,
  },
};

export const Rounded: Story = {
  args: {
    src: 'https://picsum.photos/300/300',
    alt: 'Rounded image',
    width: 300,
    height: 300,
    borderRadius: 16,
  },
};

export const Contain: Story = {
  args: {
    src: 'https://picsum.photos/400/300',
    alt: 'Contained image',
    width: 300,
    height: 200,
    objectFit: 'contain',
  },
};

export const BrokenImage: Story = {
  args: {
    src: 'https://invalid-url-that-will-fail.example/image.png',
    alt: 'Broken image fallback',
    width: 300,
    height: 200,
  },
};

export const WithFallback: Story = {
  args: {
    src: 'https://invalid-url-that-will-fail.example/image.png',
    alt: 'Image with custom fallback',
    width: 300,
    height: 200,
    fallback: (
      <div
        style={{
          width: '300px',
          height: '200px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--ggui-color-surfaceVariant, #f4f4f5)',
          borderRadius: '8px',
          color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
          fontSize: '14px',
        }}
      >
        Custom fallback content
      </div>
    ),
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
        <Image src="https://picsum.photos/150/150?random=1" alt="Cover" width={150} height={150} objectFit="cover" />
        <Image src="https://picsum.photos/150/150?random=2" alt="Rounded" width={150} height={150} radius="lg" />
        <Image src="https://picsum.photos/150/150?random=3" alt="Circle" width={150} height={150} radius="50%" />
      </div>
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
        <Image src="https://picsum.photos/200/120?random=4" alt="Small" width={200} height={120} />
        <Image src="https://picsum.photos/200/120?random=5" alt="Contain" width={200} height={120} objectFit="contain" />
      </div>
    </div>
  ),
};
