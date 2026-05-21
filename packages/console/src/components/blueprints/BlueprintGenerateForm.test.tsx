/**
 * MVB-7 — generate-form submit shape test.
 *
 * Asserts the form pipes the operator's inputs to
 * `ggui_ops_generate_blueprint` with the correct shape (persona +
 * seedPrompt + context parsed JSON + generator override + setAsOperator
 * Default).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { DataContract } from '@ggui-ai/protocol';
import { BlueprintGenerateForm } from './BlueprintGenerateForm.js';

afterEach(() => {
  cleanup();
});

const mockContract = { intent: 'create-task' } as DataContract;

describe('BlueprintGenerateForm', () => {
  it('submits with persona + seedPrompt + generator + setAsOperatorDefault', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ blueprintId: 'bp-new' });
    render(
      <BlueprintGenerateForm
        contract={mockContract}
        contractHash="hash-a"
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^persona$/i), {
      target: { value: 'minimalist' },
    });
    fireEvent.change(screen.getByLabelText(/seed prompt/i), {
      target: { value: 'glass card with rounded corners' },
    });
    fireEvent.change(screen.getByLabelText(/^generator$/i), {
      target: { value: 'ui-gen-advanced-opus-4-7' },
    });
    fireEvent.click(
      screen.getByLabelText(/pin as operator default for this contract/i),
    );
    fireEvent.click(
      screen.getByRole('button', { name: /generate →/i }),
    );
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });
    expect(onSubmit).toHaveBeenCalledWith({
      contract: mockContract,
      persona: 'minimalist',
      seedPrompt: 'glass card with rounded corners',
      generator: 'ui-gen-advanced-opus-4-7',
      setAsOperatorDefault: true,
    });
  });

  it('parses context JSON and folds it into the payload', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ blueprintId: 'bp-new' });
    render(
      <BlueprintGenerateForm
        contract={mockContract}
        contractHash="hash-a"
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/context/i), {
      target: { value: '{"locale": "en", "density": "compact"}' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /generate →/i }),
    );
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });
    const call = onSubmit.mock.calls[0]?.[0] as { context?: unknown };
    expect(call.context).toEqual({ locale: 'en', density: 'compact' });
  });

  it('surfaces JSON parse errors inline without submitting', () => {
    const onSubmit = vi.fn();
    render(
      <BlueprintGenerateForm
        contract={mockContract}
        contractHash="hash-a"
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByLabelText(/context/i), {
      target: { value: 'not json' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: /generate →/i }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/context JSON parse failed/i)).toBeTruthy();
  });

  it('omits optional fields from the payload when empty', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ blueprintId: 'bp-new' });
    render(
      <BlueprintGenerateForm
        contract={mockContract}
        contractHash="hash-a"
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /generate →/i }),
    );
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });
    // Empty form submits with just contract — every other axis is
    // strictly optional, and the schema's `.strict()` posture means
    // emitting empty strings would 400 on the server.
    expect(onSubmit).toHaveBeenCalledWith({ contract: mockContract });
  });
});
