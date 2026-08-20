/**
 * Props-schema conformance — reference binding meta-test.
 *
 * Two jobs (the schema-conformance pattern):
 *   1. Pin the published catalog shape (count, id set, the incident
 *      sample's presence).
 *   2. Bind the catalog to the reference implementation
 *      (`@ggui-ai/protocol`'s builder / hash / classifier /
 *      schema-validator) and assert a clean report — the kit and the
 *      implementation grade each other; a divergence in EITHER is the
 *      canonical bug (VERSION-POLICY §2: the kit is the arbiter).
 */
import { describe, expect, it } from 'vitest';
import {
  buildEnforcedPropsSchema,
  classifyPropsSchemaProfile,
  jsonSchemaSchema,
  propsSpecSchema,
  validatePropsDataWithSchema,
} from '@ggui-ai/protocol';
import { computePropsSchemaHash } from '@ggui-ai/protocol/props-schema-hash';
import {
  propsSchemaConformanceCases,
  runPropsSchemaConformance,
} from './index.js';

describe('props-schema conformance catalog', () => {
  it('publishes the pinned case set', () => {
    expect(
      propsSchemaConformanceCases.map((c) => c.id).sort(),
    ).toEqual([
      'empty-closed-wrapper',
      'format-in-core-assertive',
      'format-out-of-list-full',
      'nullable-normalization',
      'nullable-object-closed',
      'out-of-core-pattern-full',
      'required-order-canonical',
      'scheduler-enum-authority',
    ]);
    // The live incident is pinned as a sample forever.
    const incident = propsSchemaConformanceCases.find(
      (c) => c.id === 'scheduler-enum-authority',
    )!;
    expect(
      incident.samples.some(
        (s) => s.props['status'] === 'booked' && s.valid === false,
      ),
    ).toBe(true);
  });

  it('reference implementation passes every obligation', () => {
    // The catalog is a polyglot JSON artifact — the external boundary.
    // Cases enter the reference implementation through the published
    // zod parsers (a validating parse, not a cast), which doubles as a
    // check that every authored case is schema-well-formed.
    const report = runPropsSchemaConformance({
      build: (propsSpec) => buildEnforcedPropsSchema(propsSpecSchema.parse(propsSpec)),
      hash: (schema) => computePropsSchemaHash(jsonSchemaSchema.parse(schema)),
      classify: (schema) =>
        classifyPropsSchemaProfile(jsonSchemaSchema.parse(schema)),
      validate: (props, schema) =>
        validatePropsDataWithSchema(props, jsonSchemaSchema.parse(schema)).valid,
    });
    expect(report.failures).toEqual([]);
    expect(report.total).toBe(8);
  });
});
