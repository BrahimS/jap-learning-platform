import { listDatasets, loadJsonlDataset } from '../src/services/ai/evaluators/framework.js';
import { join } from 'node:path';

const dir = join(import.meta.dirname, 'datasets');
let total = 0;
for (const name of listDatasets(dir)) {
  const cases = loadJsonlDataset(join(dir, `${name}.jsonl`));
  total += cases.length;
  console.log(`${name}: ${cases.length} cases`);
}
console.log(`total: ${total}`);
