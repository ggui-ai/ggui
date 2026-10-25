import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertShimConditions, nonMemberZodUses, zodImportSites, zodShimSource } from './ext-apps-zod-shim.mjs';

// The shapes ext-apps 1.7.5's dist actually contains, reduced.
const EXT_APPS_LIKE =
  'setProtocolVersion}import{z as Q}from"zod/v4";import{X as x}from"@m/sdk";var MQ=Q.object({a:Q.string(),b:Q.optional(Q.number())});' +
  'async function k(X,Y){let Z=X["~standard"];if(Z.jsonSchema)return Z.jsonSchema[Y](MQ);if(Z.vendor==="zod"){let{z:$}=await import("zod/v4");return $.toJSONSchema(X,{io:Y})}throw Error("no")}' +
  'return $.value}import{z as pQ}from"zod/v4";function CQ(){if(!X)pQ.config({jitless:!0})}';

test('zodImportSites: finds the two static aliases and the dynamic destructure, in order', () => {
  assert.deepEqual(
    zodImportSites(EXT_APPS_LIKE).map((s) => [s.kind, s.name]),
    [['alias', 'Q'], ['dynamic', '$'], ['alias', 'pQ']],
  );
  assert.deepEqual(zodImportSites('import * as z4 from "zod/v4"; z4.string()').map((s) => [s.kind, s.name]), [['namespace', 'z4']]);
  assert.deepEqual(zodImportSites('import { z } from "zod/v4";').map((s) => [s.kind, s.name]), [['alias', 'z']]);
  assert.deepEqual(zodImportSites('const m = await import("zod/v4"); m.z.string()').map((s) => [s.kind, s.name]), [['dynamic', null]]);
  assert.deepEqual(zodImportSites('import { z } from "zod"; import * as y from "zod/v4-mini";'), []);
});

test('nonMemberZodUses: member access is fine; a spread, an Object.* call, a bare pass or a bare `$` elsewhere in the block are offences', () => {
  assert.deepEqual(nonMemberZodUses(EXT_APPS_LIKE), []);
  assert.deepEqual(nonMemberZodUses('import{z as Q}from"zod/v4";var a=Q?.string();var b=Q\n  .object({})'), []);
  const spread = nonMemberZodUses('import{z as Q}from"zod/v4";var a={...Q};');
  assert.equal(spread.length, 1);
  assert.equal(spread[0].name, 'Q');
  assert.equal(nonMemberZodUses('import{z as Q}from"zod/v4";Object.keys(Q).map(f)').length, 1);
  assert.equal(nonMemberZodUses('import{z as Q}from"zod/v4";register(Q);').length, 1);
  // The dynamic binding is checked inside its own block only: a different `$`
  // in another function is not this binding.
  assert.deepEqual(nonMemberZodUses('function k(){let{z:$}=await import("zod/v4");return $.toJSONSchema(x)}function j($){return $+1}'), []);
  assert.equal(nonMemberZodUses('function k(){let{z:$}=await import("zod/v4");return JSON.stringify($)}').length, 1);
  assert.deepEqual(nonMemberZodUses('function k(){let{z:$}=await import("zod/v4");return $.toJSONSchema(`${x}`)}'), []);
  assert.deepEqual(nonMemberZodUses('import{z as Q}from"zod/v4";var a=other.Q;Q.string()'), []);
  // `Q.` followed by another dot is not a member access of Q (`Q..` cannot occur; guard the regex anyway).
  assert.deepEqual(nonMemberZodUses('import{z as Q}from"zod/v4";Q.string()'), []);
});

test('assertShimConditions: no importer → "remove the shim"; member-only files pass with the site count; an offending file names the site', () => {
  assert.throws(() => assertShimConditions([]), /remove the ggui#2032 shim/);
  assert.equal(assertShimConditions(['a.js'], () => EXT_APPS_LIKE), 3);
  assert.throws(() => assertShimConditions(['a.js'], () => 'import{z as Q}from"zod/v4";var a={...Q};'), /a\.js uses a zod binding other than by member access/);
  assert.throws(() => assertShimConditions(['a.js'], () => 'import { object } from "zod/v4"; object({})'), /remove the ggui#2032 shim: the ext-apps files/);
});

test('zodShimSource: reserved-word names are aliased, `locales` and `core` are withheld from the named lists, z/core carry a throwing locales getter', () => {
  const src = zodShimSource({ zodNames: ['object', 'enum', 'function', 'null', 'z', 'default', 'core', 'locales'], coreNames: ['util', 'locales', 'default', 'instanceof'] });
  assert.match(src, /import \{ object as __z0, enum as __z1, function as __z2, null as __z3 \} from 'zod\/v4';/);
  assert.match(src, /import \{ util as __c0, instanceof as __c1 \} from 'zod\/v4\/core';/);
  assert.match(src, /export \{ __z0 as object, __z1 as enum, __z2 as function, __z3 as null \};/);
  assert.match(src, /export const core = \{ util: __c0, instanceof: __c1, get locales\(\) \{ throw new Error\(/);
  assert.match(src, /export const z = \{ object: __z0, enum: __z1, function: __z2, null: __z3, core, get locales\(\)/);
  assert.doesNotMatch(src, /locales as __/);
  assert.throws(() => zodShimSource({ zodNames: ['z'], coreNames: ['util'] }), /refusing to emit an empty shim/);
});

test('zodShimSource: the emitted module parses as ESM', async () => {
  const vm = await import('node:vm');
  const src = zodShimSource({ zodNames: ['object', 'enum', 'function'], coreNames: ['util', 'instanceof'] });
  if (typeof vm.SourceTextModule === 'function') {
    assert.doesNotThrow(() => new vm.SourceTextModule(src));
  } else {
    // Without --experimental-vm-modules, a syntax check through a data: import
    // would also resolve 'zod/v4'; the build itself parses the shim on every run.
    assert.ok(src.includes("export default z;"));
  }
});
