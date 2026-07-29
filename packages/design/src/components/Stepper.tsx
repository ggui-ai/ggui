import type { CSSProperties, ReactNode } from 'react';
import type { StepperProps } from './types';
import { Stack } from '../primitives/Stack';
import { Row } from '../primitives/Row';
import { Text } from '../primitives/Text';
import { Icon } from '../primitives/Icon';
import { Divider } from '../primitives/Divider';

type StepState = 'completed' | 'current' | 'upcoming';

const MARKER_SIZE = 28;

function stepState(index: number, current: number): StepState {
  if (index < current) return 'completed';
  if (index === current) return 'current';
  return 'upcoming';
}

/** Circle marker fill/border/foreground per step state — all through
 *  theme tokens so the operator's preset restyles every state. */
const markerStyles: Record<StepState, CSSProperties> = {
  completed: {
    backgroundColor: 'var(--ggui-color-primary-100, #e0f2fe)',
    border: '1px solid var(--ggui-color-primary-300, #7dd3fc)',
    color: 'var(--ggui-color-primary-700, #0369a1)',
  },
  current: {
    backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
    border: '1px solid var(--ggui-color-primary-600, #0284c7)',
    color: 'var(--ggui-color-onPrimary, #ffffff)',
  },
  upcoming: {
    backgroundColor: 'var(--ggui-color-surface, #fafafa)',
    border: '1px solid var(--ggui-color-outline, #d4d4d8)',
    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
  },
};

function Marker({ index, state }: { index: number; state: StepState }): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={{
        width: MARKER_SIZE,
        height: MARKER_SIZE,
        borderRadius: '50%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxSizing: 'border-box',
        transition: 'background-color 0.2s, border-color 0.2s, color 0.2s',
        ...markerStyles[state],
      }}
    >
      {state === 'completed' ? (
        <Icon name="check" size={16} tone="inherit" />
      ) : (
        <Text is="span" size="sm" weight="semibold" tone="inherit">
          {index + 1}
        </Text>
      )}
    </span>
  );
}

function StepLabel({ label, state }: { label: string; state: StepState }): ReactNode {
  return (
    <Text
      is="span"
      size="sm"
      weight={state === 'current' ? 'semibold' : 'normal'}
      tone={state === 'upcoming' ? 'muted' : 'default'}
    >
      {label}
    </Text>
  );
}

/**
 * Stepper — a display-only step indicator for multi-step flows.
 *
 * Assembles Row/Stack + Text + Icon + Divider into numbered markers
 * joined by connector lines. Completed steps show a check, the current
 * step is filled (and marked `aria-current="step"`), upcoming steps
 * are outlined and muted.
 *
 * Display-only by design: the component renders `steps` + `current`,
 * it never stores navigation state. The caller owns the step index
 * (typically `useState`) and moves it via its own controls or
 * `onStepClick`.
 */
export function Stepper({
  steps,
  current,
  orientation = 'horizontal',
  onStepClick,
  style,
  className,
}: StepperProps) {
  const renderStep = (label: string, index: number): ReactNode => {
    const state = stepState(index, current);
    const content = (
      <Row gap="sm" align="center">
        <Marker index={index} state={state} />
        <StepLabel label={label} state={state} />
      </Row>
    );
    if (onStepClick === undefined) {
      return (
        <span aria-current={state === 'current' ? 'step' : undefined}>
          {content}
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={() => onStepClick(index)}
        aria-current={state === 'current' ? 'step' : undefined}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          margin: 0,
          font: 'inherit',
          textAlign: 'inherit',
          cursor: 'pointer',
        }}
      >
        {content}
      </button>
    );
  };

  if (orientation === 'vertical') {
    return (
      <nav aria-label="Progress" className={className} style={style}>
        <Stack gap="none" align="start">
          {steps.map((label, index) => (
            <Stack key={index} gap="none" align="start">
              {index > 0 && (
                <span
                  style={{
                    width: MARKER_SIZE,
                    height: 16,
                    display: 'inline-flex',
                    justifyContent: 'center',
                  }}
                >
                  <Divider orientation="vertical" margin={0} />
                </span>
              )}
              {renderStep(label, index)}
            </Stack>
          ))}
        </Stack>
      </nav>
    );
  }

  return (
    <nav aria-label="Progress" className={className} style={style}>
      <Row gap="sm" align="center">
        {steps.map((label, index) => (
          <Row
            key={index}
            gap="sm"
            align="center"
            style={index > 0 ? { flex: 1 } : undefined}
          >
            {index > 0 && (
              <Divider style={{ flex: 1, minWidth: 16, margin: 0 }} />
            )}
            {renderStep(label, index)}
          </Row>
        ))}
      </Row>
    </nav>
  );
}
