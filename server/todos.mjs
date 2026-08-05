import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LANES = new Set(['idea', 'doing', 'done']);
const SEED = [
  { id: 1, text: 'Route bulk transcript cleanup to Haiku — Sonnet is overkill', lane: 'idea', tag: 'Usage' },
  { id: 2, text: 'Cron: weekly digest of all Cowork project status', lane: 'idea', tag: 'Crons' },
  { id: 3, text: 'Rewrite the nightly-sync cron so it retries on 429', lane: 'doing', tag: 'Crons' }
];

export function createTodoStore(path) {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        if (Array.isArray(parsed)) return parsed;
      } catch { /* fall through to seed */ }
      await this.write(SEED);
      return SEED;
    },
    async write(todos) {
      if (!Array.isArray(todos)) throw new Error('todos must be an array');
      for (const t of todos) {
        if (!LANES.has(t.lane)) throw new Error(`unknown lane: ${t.lane}`);
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(todos, null, 2));
      return todos;
    }
  };
}
