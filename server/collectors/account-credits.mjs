import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseAccountCredits } from '../lib/account-credits.mjs';

const STATE = join(homedir(), '.claude.json');

// The state file also holds OAuth account details and per-project history.
// Only the parsed credit figures leave this function; the raw object is
// discarded here and never cached or logged.
export async function collectAccountCredits({ read = () => readFile(STATE, 'utf8'), now = Date.now } = {}) {
  return parseAccountCredits(JSON.parse(await read()), now());
}
