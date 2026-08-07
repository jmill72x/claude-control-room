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
      // A record with no usable timestamp has no month to live in: MONTH() would
      // yield `NaN-NaN` and the write would create a file nothing ever reads again.
      // This is a contract violation, not bad input to tolerate — say so loudly.
      if (!Number.isFinite(record?.t)) {
        throw new TypeError(`history record needs a finite t, got ${record?.t}`);
      }
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
      const here = new Date(t);
      const loaded = [];
      // Walk back far enough to cover the whole retention window, not a fixed two
      // months: a caller with 90-day retention would otherwise never see its oldest
      // month. 28 days is the shortest possible month, so this always over-reaches
      // rather than under-reaches, and a month with no file simply yields nothing.
      const months = Math.max(2, Math.ceil(retentionMs / (28 * 24 * 3600 * 1000)) + 1);
      for (let back = months - 1; back >= 0; back--) {
        // Constructed from (year, month, 1) rather than setMonth(): setMonth does
        // not clamp, so 31 March minus one month is 3 March, not February — which
        // silently loaded the current month twice and the previous one never.
        const m = new Date(here.getFullYear(), here.getMonth() - back, 1).getTime();
        loaded.push(...(await loadFile(monthFile(m))));
      }
      records = loaded;
      trim();
    }
  };
}
