import { describe, expect, it } from 'vitest';
import { installCommand } from './install-command.js';

describe('installCommand', () => {
  it('composes the gadget install command with an explicit registry', () => {
    expect(
      installCommand('gadget', '@acme/map-tools', '2.1.0', {
        registryHost: 'https://registry.example.test',
      }),
    ).toBe(
      'ggui gadget install @acme/map-tools@2.1.0 --registry=https://registry.example.test',
    );
  });

  it('composes the blueprint install command with an explicit registry', () => {
    expect(
      installCommand('blueprint', '@acme/widget', '1.0.0', {
        registryHost: 'https://registry.example.test',
      }),
    ).toBe(
      'ggui blueprint install @acme/widget@1.0.0 --registry=https://registry.example.test',
    );
  });

  it('omits the --registry flag when no registryHost is given', () => {
    expect(installCommand('gadget', '@acme/map-tools', '2.1.0')).toBe(
      'ggui gadget install @acme/map-tools@2.1.0',
    );
  });

  it('matches the publish flow wording — `ggui <kind> install <id>@<version> --registry=<url>`', () => {
    // Pin against the exact template the CLI publish path prints
    // (ggui-cli internal/artifact-publish.ts) so the two surfaces
    // cannot drift silently.
    const kind = 'gadget';
    const artifactId = '@scope/name';
    const version = '0.1.0';
    const registryUrl = 'https://r.example';
    expect(
      installCommand(kind, artifactId, version, { registryHost: registryUrl }),
    ).toBe(`ggui ${kind} install ${artifactId}@${version} --registry=${registryUrl}`);
  });
});
