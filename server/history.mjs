import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MONTH = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// How much history the server holds in memory to serve sparklines.
//
// COUPLED CONSTANT — three places must agree or a change here silently does
// nothing: `server.mjs` asks the store for exactly this span, and
// `usage-panel.mjs` caps a sparkline's range to it (a series can never be wider
// than the window it is drawn from). Both import this value; do not re-type it.
export const RETENTION_MS = 30 * 24 * 3600 * 1000;

export function createHistory({ dir, now = () => Date.now(), retentionMs = RETENTION_MS } = {}) {
  let records = [];
  // Spec §10: "history file unreadable → the store reports it". Without this,
  // an unwritable or unreadable `data/` is indistinguishable from a month with
  // no readings, and every panel reassures the reader that waiting will fill it.
  let readError = null;
  let writeError = null;

  const trim = () => {
    const cutoff = now() - retentionMs;
    records = records.filter(r => r.t >= cutoff).sort((a, b) => a.t - b.t);
  };

  const monthFile = t => join(dir, `usage-history-${MONTH(t)}.jsonl`);

  const loadFile = async path => {
    let text;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      // ENOENT is normal: a month with no readings has no file. Anything else —
      // EACCES, EISDIR, EIO — means we could not find out what is in there, and
      // that is not the same claim as "there was no usage".
      if (err?.code !== 'ENOENT') readError = err?.code ?? err?.message ?? 'read failed';
      return [];
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
      try {
        await mkdir(dir, { recursive: true });
        await appendFile(monthFile(record.t), `${JSON.stringify(record)}\n`);
      } catch (err) {
        // The caller keeps the reading and logs; the store remembers that the
        // trend it is serving is now knowingly incomplete, so the page can say
        // so instead of quietly showing a shorter line.
        writeError = err?.code ?? err?.message ?? 'write failed';
        throw err;
      }
      writeError = null;
      records.push(record);
      trim();
    },

    // `ok: false` means we could not find out, which is a different state from
    // "nothing recorded yet" and must be rendered differently.
    status() {
      return { ok: readError === null && writeError === null, readError, writeError };
    },

    recent(sinceMs) {
      return records.filter(r => r.t >= sinceMs);
    },

    async warm() {
      readError = null; // a fresh load re-establishes whether the files are readable
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
