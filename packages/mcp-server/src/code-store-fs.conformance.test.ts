/**
 * `CodeStore` conformance runner for {@link FileSystemCodeStore}.
 *
 * The shared battery lives in `@ggui-ai/mcp-server-core/contract-tests`
 * so every implementation is held to one set of obligations. Impl-
 * specific behavior this suite deliberately does not cover — the
 * sharded on-disk layout, malformed-hash rejection, persistence across
 * a process restart — stays in `code-store-fs.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodeStoreConformance } from '@ggui-ai/mcp-server-core/contract-tests';
import { FileSystemCodeStore } from './code-store-fs.js';

const roots: string[] = [];

runCodeStoreConformance('FileSystemCodeStore', {
  create: async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-code-cache-conf-'));
    roots.push(root);
    return new FileSystemCodeStore({ root });
  },
  cleanup: async () => {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  },
});
