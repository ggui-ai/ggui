/**
 * `createGguiPushHandler` contract runner — OSS in-memory invocation.
 *
 * Plugs the shared portable suite into the baseline OSS deps shape
 * (`InMemorySessionStore` + `InMemoryKeyValueStore`). Any future
 * push-handler-conforming deployment (cloud pod testcontainers,
 * hosted SaaS adapter, custom self-host fork) invokes the SAME
 * `runPushHandlerContract` against its own deps factory and gets
 * automatic drift detection.
 *
 * The OSS baseline runs in the standard unit-test surface; cloud's
 * testcontainers track is the follow-up that proves DDB + Redis
 * adapters honor the same wire contract.
 */
import {
  InMemoryKeyValueStore,
  InMemorySessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { runPushHandlerContract } from './push-handler.contract.js';

runPushHandlerContract('OSS-in-memory', {
  createDeps: () => ({
    sessionStore: new InMemorySessionStore(),
    handshakeStore: new InMemoryKeyValueStore(),
  }),
});
