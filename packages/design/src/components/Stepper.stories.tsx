import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Stepper } from './Stepper';
import { Button } from '../primitives/Button';
import { Row } from '../primitives/Row';
import { Stack } from '../primitives/Stack';
import { Text } from '../primitives/Text';

const meta: Meta<typeof Stepper> = {
  title: 'Components/Stepper',
  component: Stepper,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    orientation: {
      control: 'select',
      options: ['horizontal', 'vertical'],
    },
    current: { control: 'number' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const STEPS = ['Account', 'Profile', 'Preferences', 'Review'];

export const Default: Story = {
  args: {
    steps: STEPS,
    current: 1,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '560px' }}>
        <Story />
      </div>
    ),
  ],
};

export const FirstStep: Story = {
  args: {
    steps: STEPS,
    current: 0,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '560px' }}>
        <Story />
      </div>
    ),
  ],
};

export const LastStep: Story = {
  args: {
    steps: STEPS,
    current: 3,
  },
  decorators: [
    (Story) => (
      <div style={{ width: '560px' }}>
        <Story />
      </div>
    ),
  ],
};

export const Vertical: Story = {
  args: {
    steps: STEPS,
    current: 2,
    orientation: 'vertical',
  },
};

// Display-only contract in action: the story owns the step index in
// useState; Stepper just renders it. Clicking a marker (onStepClick)
// and the Back/Next buttons both go through the same setStep.
export const Wizard: Story = {
  render: () => {
    const [step, setStep] = useState(0);
    return (
      <Stack gap="lg" style={{ width: '560px' }}>
        <Stepper steps={STEPS} current={step} onStepClick={setStep} />
        <Text tone="muted">Step {step + 1} content: {STEPS[step]}</Text>
        <Row gap="sm" justify="end">
          <Button
            variant="ghost"
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
          >
            Back
          </Button>
          <Button
            disabled={step === STEPS.length - 1}
            onClick={() => setStep(step + 1)}
          >
            Next
          </Button>
        </Row>
      </Stack>
    );
  },
};
