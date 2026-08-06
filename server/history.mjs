import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MONTH = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const DEFAULT_RETENTION = 30 * 24 * 3600 * 1000;

export function createHistory({ dir, now = () => Date.now(), retentionMs = DEFAULT_RETENTION } = {}) {
  let records = [];

  const trim = () => {
    const cutoff = now() - retentionMs;
    records = records.filter(r => r.t >= cutoff).sort((a, b) => a.t - b.t);
  };

  const monthFile = t => join(dir, `usage-history-${MONTH(t)}.jsonl`);

  const loadFile = async path => {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return []; // a month with no readings is normal, not an error
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (Number.isFinite(r?.t)) out.push(r);
      } catch { /* a corrupt line costs that line, never the file */ }
    }
    return out;
  };

  return {
    monthFile,

    async append(record) {
      await mkdir(dir, { recursive: true });
      await appendFile(monthFile(record.t), `${JSON.stringify(record)}\n`);
      records.push(record);
      trim();
    },

    recent(sinceMs) {
      return records.filter(r => r.t >= sinceMs);
    },

    async warm() {
      const t = now();
      const prev = new Date(t);
      prev.setMonth(prev.getMonth() - 1);
      const loaded = [
        ...(await loadFile(monthFile(prev.getTime()))),
        ...(await loadFile(monthFile(t)))
      ];
      records = loaded;
      trim();
    }
  };
}
