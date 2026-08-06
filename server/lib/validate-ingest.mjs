// The ingest endpoints used to cache whatever JSON arrived — a bare string, a
// number, an object where an array was expected — and every consumer downstream
// assumed a shape nobody checked. Validate here, once, and cache only fields we
// know how to render: an unrecognised field cannot then reach the page as if it
// were a measurement.

const MAX_ITEMS = 500;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' && v.trim() !== '' && v.length <= 200;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isBool = v => typeof v === 'boolean';
const isDate = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const opt = (v, pred) => v === undefined || v === null || pred(v);

const fail = error => ({ ok: false, error });
const pass = value => ({ ok: true, value });

function validateCron(c, i) {
  if (!isObject(c)) return fail(`crons[${i}] is not an object`);
  if (!isText(c.name)) return fail(`crons[${i}].name must be a non-empty string`);
  if (!opt(c.label, isText)) return fail(`crons[${i}].label must be a string`);
  if (!opt(c.schedule, isText)) return fail(`crons[${i}].schedule must be a string`);
  if (!opt(c.last, isText)) return fail(`crons[${i}].last must be a string`);
  if (!opt(c.ok, isBool)) return fail(`crons[${i}].ok must be a boolean`);
  if (!opt(c.nextRunAt, isNum)) return fail(`crons[${i}].nextRunAt must be a number`);
  return pass({
    name: c.name,
    label: c.label ?? c.name,
    schedule: c.schedule ?? 'Reported from elsewhere',
    // `ok` stays undefined when the feed did not say — the UI renders that as
    // "Unknown", never as a pass.
    ok: c.ok ?? undefined,
    nextRunAt: c.nextRunAt ?? null,
    last: c.last ?? undefined
  });
}

function validateProject(p, i) {
  if (!isObject(p)) return fail(`projects[${i}] is not an object`);
  if (!isText(p.name)) return fail(`projects[${i}].name must be a non-empty string`);
  if (!opt(p.tool, isText)) return fail(`projects[${i}].tool must be a string`);
  if (!opt(p.detail, isText)) return fail(`projects[${i}].detail must be a string`);
  if (!opt(p.running, isBool)) return fail(`projects[${i}].running must be a boolean`);
  if (!opt(p.tasks, isNum)) return fail(`projects[${i}].tasks must be a number`);
  return pass({
    name: p.name,
    tool: p.tool ?? 'Ingested',
    running: p.running ?? undefined,
    detail: p.detail ?? 'reported from elsewhere',
    tasks: p.tasks ?? null
  });
}

const CREDIT_NUMBERS = ['balance', 'spent', 'monthlyLimit', 'promoAmount'];
const CREDIT_DATES = ['resetsOn', 'promoExpiresOn', 'updatedAt'];

function validateCredits(body) {
  if (!isObject(body)) return fail('credits must be an object');
  const value = {};
  for (const k of CREDIT_NUMBERS) {
    if (!opt(body[k], isNum)) return fail(`credits.${k} must be a number`);
    if (body[k] !== undefined && body[k] !== null) value[k] = body[k];
  }
  for (const k of CREDIT_DATES) {
    if (!opt(body[k], isDate)) return fail(`credits.${k} must be a date string`);
    if (body[k] !== undefined && body[k] !== null) value[k] = body[k];
  }
  if (Object.keys(value).length === 0) return fail('credits carried no recognised field');
  return pass(value);
}

function validateList(body, itemFn, name) {
  if (!Array.isArray(body)) return fail(`${name}s must be an array`);
  if (body.length > MAX_ITEMS) return fail(`${name}s must be at most ${MAX_ITEMS} entries`);
  const value = [];
  for (let i = 0; i < body.length; i++) {
    const r = itemFn(body[i], i);
    if (!r.ok) return r;
    value.push(r.value);
  }
  return pass(value);
}

export function validateIngest(kind, body) {
  if (kind === 'crons') return validateList(body, validateCron, 'cron');
  if (kind === 'projects') return validateList(body, validateProject, 'project');
  if (kind === 'credits') return validateCredits(body);
  return fail(`unknown ingest feed: ${kind}`);
}
