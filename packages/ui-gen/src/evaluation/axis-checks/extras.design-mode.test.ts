/**
 * Axis checks per `designMode`: the Stepper-adoption mandate names a
 * design-package component, so it stands down in `free` mode; the
 * behavioural multi-step rule (integer step state) fires in both modes.
 */
import { describe, expect, it } from 'vitest';
import { classifyAxes } from '../../classifier/index.js';
import { EXTRA_CHECKS } from './extras.js';
import type { AxisCheckInput } from './types.js';

const stepperAdopted = EXTRA_CHECKS.find((c) => c.id === 'layout.multi_step.stepper_adopted')!;
const statePresent = EXTRA_CHECKS.find((c) => c.id === 'layout.multi_step.state_present')!;

const WIZARD_WITHOUT_STEPPER = `
import React, { useState } from 'react';
interface Props { title: string }
export default function Component(props: Props) {
  const [step, setStep] = useState(0);
  return (
    <div>
      <ol aria-label="Progress">{['Welcome', 'Profile', 'Done'].map((s, i) => <li key={s} aria-current={i === step ? 'step' : undefined}>{s}</li>)}</ol>
      <button type="button" onClick={() => setStep((s) => s + 1)}>Next</button>
    </div>
  );
}`;

function input(designMode?: AxisCheckInput['designMode']): AxisCheckInput {
  return {
    sourceCode: WIZARD_WITHOUT_STEPPER,
    compiledCode: 'compiled',
    originalPrompt: 'onboarding wizard',
    classification: classifyAxes({ contract: {}, prompt: 'a multi-step onboarding wizard' }),
    ...(designMode !== undefined ? { designMode } : {}),
  };
}

describe('layout.multi_step.stepper_adopted — designMode', () => {
  it('fires in constrained mode (omitted and explicit) when <Stepper> is absent', () => {
    expect(stepperAdopted.run(input())).toHaveLength(1);
    expect(stepperAdopted.run(input('constrained'))).toHaveLength(1);
  });

  it('stands down in free mode — the primitive is optional there', () => {
    expect(stepperAdopted.run(input('free'))).toEqual([]);
  });

  it('the behavioural step-state rule fires identically in both modes', () => {
    expect(statePresent.run(input('free'))).toEqual(statePresent.run(input('constrained')));
    expect(statePresent.run(input('free'))).toEqual([]);
  });
});
