import { describe, expect, it } from 'vitest';
import { composeOAuthUserId } from './oauth-user-id.js';

describe('composeOAuthUserId', () => {
  it('joins providerId and subject with a colon', () => {
    expect(composeOAuthUserId({ providerId: 'guuey', providerSubject: 'g_abc' })).toBe('guuey:g_abc');
  });
});
