import { describe, expect, it } from 'vitest';
import * as root from './index.js';
import { generatorBuild, type UiGenBuild } from './generator-build.js';

describe('the build identity is on the public surface — a stamp outside this package names the same digests the generator stamps', () => {
  it('the root exports `generatorBuild`, and it is the same function the generator uses', () => {
    expect(typeof root.generatorBuild).toBe('function');
    expect(root.generatorBuild).toBe(generatorBuild);
  });

  it('both design modes yield their own two template digests, 64 hex each, and differ where the templates differ', () => {
    const constrained: UiGenBuild = root.generatorBuild('constrained');
    const free: UiGenBuild = root.generatorBuild('free');
    for (const b of [constrained, free]) {
      expect(b.digests.promptTemplateSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(b.digests.boilerplateTemplateSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(constrained.mode).toBe('constrained');
    expect(free.mode).toBe('free');
    expect(constrained.digests.promptTemplateSha256).not.toBe(free.digests.promptTemplateSha256);
  });
});
