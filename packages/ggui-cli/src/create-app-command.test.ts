import { describe, it, expect } from 'vitest';
import { parseCreateAppFlags } from './create-app-command.js';

describe('parseCreateAppFlags', () => {
  it('parses --name', () => {
    expect(parseCreateAppFlags(['app', '--name', 'Shop'])).toEqual({ name: 'Shop' });
  });
  it('errors on unknown subcommand', () => {
    expect(parseCreateAppFlags(['widget']).error).toMatch(/unknown/i);
  });
  it('accepts bare "app" with no flags', () => {
    expect(parseCreateAppFlags(['app'])).toEqual({});
  });
});
