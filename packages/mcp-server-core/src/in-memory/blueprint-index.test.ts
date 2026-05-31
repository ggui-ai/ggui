import { runBlueprintIndexConformance } from '../contract-tests/blueprint-index.js';
import { InMemoryBlueprintIndex } from './blueprint-index.js';

runBlueprintIndexConformance(
  'InMemoryBlueprintIndex',
  () => new InMemoryBlueprintIndex(),
);
