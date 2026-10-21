import { useState } from 'react';
import { useTick } from '../hooks/useTick.js';
import { localToday } from '../lib/due.js';
import {
  PRIORITIES, TITLE_MAX, cardTitle, cardDetail, editFields, applyEdit, newItem, withPriority, withDue, areaOptions,
  ownerOf, agentOf, ownerChips, boardView, priorityFilters, moves, dueLook, showingLine
} from '../lib/orbit/board.js';
import { agentColors } from '../lib/orbit/page.js';
import { Avatar } from './Avatar.jsx';
import { newId } from './useBoard.js';

const BAR = { P0: '#FF6B5C', P1: '#FF7A45', P2: '#F8F7F3', P3: '#A9B4CB', none: 'rgba(248, 247, 243, 0.3)' };
const BAR_LABEL = { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3', none: 'no priority' };

// ---- the band under the title, on the Board tab ----

export function BoardBand({ board, roster, totals, filters }) {
  const chips = ownerChips(board.todos, roster);
  const parts = Object.entries(totals.byPriority).filter(([, n]) => n > 0);
  return (
    <div className="o-boardband">
      <div className="o-bb-counts">
        <div className="o-bb-open">
          <span className="o-bb-big">{board.loaded ? totals.open : '—'}</span>
          <h2 className="o-mono o-eyebrow-night o-bb-label">Open on<br />the board</h2>
        </div>
        <div className="o-pri-bar" aria-hidden="true">
          {parts.map(([p, n]) => <span key={p} style={{ width: `${(n / Math.max(totals.open, 1)) * 100}%`, background: BAR[p] }} />)}
        </div>
        <div className="o-bb-legend">
          {parts.map(([p, n]) => <span key={p}><b>{n}</b> {BAR_LABEL[p]}</span>)}
          <span><b>{totals.doing}</b> doing</span>
          <span><b>{totals.done}</b> done</span>
        </div>
      </div>
      <div role="group" aria-label="Show one owner's items" className="o-bb-owners">
        <span className="o-mono o-eyebrow-night">By owner · tap one to see only theirs</span>
        {chips.length === 0
          ? <span className="o-sub-night">{roster.agents.length === 0 ? 'Owners appear once config.json has a roster.' : 'No open item has an owner yet.'}</span>
          : (
            <div className="o-owner-chips">
              {chips.map(c => {
                const on = filters.owner === c.key;
                return (
                  <button key={c.key} type="button" aria-pressed={on} className="o-owner-chip"
                    style={{ borderColor: on ? agentColors(c.index).night : 'transparent' }}
                    onClick={() => filters.setOwner(on ? null : c.key)}>
                    <Avatar agent={c} size={40} tone="night" />
                    <span className="o-owner-text">
                      <span className="o-owner-name">{c.name}</span>
                      <span className="o-mono o-owner-n">{c.open} open</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}

// ---- one card ----

const domId = (prefix, id) => `${prefix}-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}`;

function Chip({ on, onClick, children, label }) {
  return <button type="button" aria-pressed={on} aria-label={label} className={`o-mono o-chip${on ? ' o-chip-on' : ''}`} onClick={onClick}>{children}</button>;
}

function Card({ item, roster, today, open, onToggle, items, update, standalone = false, where }) {
  const [draft, setDraft] = useState(null); // null: not editing
  const [busy, setBusy] = useState(false);
  const title = cardTitle(item);
  const detail = cardDetail(item);
  const agent = agentOf(ownerOf(item, roster), roster);
  const due = dueLook(item, today);
  const pri = PRIORITIES.includes(item.priority) ? item.priority : null;
  const done = item.lane === 'done';
  const bodyId = domId(`${where}-body`, item.id);
  const dueId = domId(`${where}-due`, item.id);

  const commit = async () => {
    if (!applyEdit(item, draft)) { setDraft(null); return; }
    setBusy(true);
    const ok = await update(item.id, t => applyEdit(t, draft));
    setBusy(false);
    // A failed save keeps the form open, so nothing typed is lost.
    if (ok) setDraft(null);
  };

  const head = (
    <>
      <Avatar agent={agent} fallback={item.tag} size={32} />
      <span className="o-card-main">
        <span className="o-card-top">
          <span className="o-card-title">{title.text || '(no text)'}</span>
          <span className={`o-mono o-pri o-pri-${pri ?? 'none'}`} title={pri ? `Priority ${pri}` : 'No priority'}>{pri ?? '–'}</span>
        </span>
        {!open && detail && <span className="o-card-snippet">{detail}</span>}
        <span className="o-card-meta">
          <span className="o-mono o-card-tag">{item.tag || 'No area'}</span>
          {due && <span className={`o-mono o-due o-due-${due.tone}`} title={due.title}>{due.label}</span>}
        </span>
      </span>
    </>
  );

  return (
    <article className={`o-card${done ? ' o-card-done' : ''}${open ? ' o-card-open' : ''}`}>
      {standalone
        ? <div className="o-card-head">{head}</div>
        : <button type="button" className="o-card-head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>{head}</button>}
      {open && (
        <div className="o-card-body" id={bodyId}>
          {detail && <p className="o-card-detail">{detail}</p>}
          <span className="o-card-owner">{agent ? agent.name : 'No owner'} · {item.tag || 'No area'} · {done ? 'Done' : item.lane === 'doing' ? 'Doing' : 'Ideas'}</span>
          <div role="group" aria-label="Priority" className="o-field-row">
            <span className="o-mono o-field-label">Priority</span>
            {[...PRIORITIES, 'none'].map(p => (
              <Chip key={p} on={(pri ?? 'none') === p} label={p === 'none' ? 'No priority' : undefined}
                onClick={() => update(item.id, t => ((PRIORITIES.includes(t.priority) ? t.priority : 'none') === p ? null : withPriority(t, p)))}>
                {p === 'none' ? 'None' : p}
              </Chip>
            ))}
          </div>
          <div className="o-field-row">
            <label htmlFor={dueId} className="o-mono o-field-label">Due</label>
            {/* Saved when the field is left, not on each change: typing a year
                digit by digit would otherwise save four dates. */}
            <input id={dueId} key={item.due ?? ''} type="date" className="o-input o-input-date" defaultValue={item.due ?? ''}
              onBlur={e => { const v = e.target.value; if (v !== (item.due ?? '')) update(item.id, t => withDue(t, v)); }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
            {item.due && <button type="button" className="o-btn o-btn-quiet" onClick={() => update(item.id, t => withDue(t, ''))}>Clear</button>}
          </div>
          {draft && (
            <div className="o-edit" onKeyDown={e => { if (e.key === 'Escape') setDraft(null); }}>
              <label htmlFor={domId(`${where}-title`, item.id)} className="o-mono o-field-label">Title</label>
              <input id={domId(`${where}-title`, item.id)} className="o-input" value={draft.title} maxLength={TITLE_MAX}
                placeholder={title.fallback ? title.text : 'A short title'} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
              <label htmlFor={domId(`${where}-detail`, item.id)} className="o-mono o-field-label">Detail</label>
              <textarea id={domId(`${where}-detail`, item.id)} className="o-input o-textarea" rows={4} value={draft.detail}
                onChange={e => setDraft(d => ({ ...d, detail: e.target.value }))} />
              <label htmlFor={domId(`${where}-tag`, item.id)} className="o-mono o-field-label">Area</label>
              <select id={domId(`${where}-tag`, item.id)} className="o-input" value={draft.tag} onChange={e => setDraft(d => ({ ...d, tag: e.target.value }))}>
                {!draft.tag && <option value="">No area</option>}
                {areaOptions(items, draft.tag).map(a => <option key={a} value={a}>{a}</option>)}
              </select>
              <div className="o-actions">
                <button type="button" className="o-btn o-btn-solid" disabled={busy} onClick={commit}>Save</button>
                <button type="button" className="o-btn o-btn-quiet" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          )}
          <div className="o-actions">
            {moves(item.lane).map(m => (
              <button key={m.label} type="button" className={`o-btn ${m.main ? 'o-btn-solid' : 'o-btn-quiet'}`}
                onClick={() => update(item.id, t => (t.lane === m.to ? null : { ...t, lane: m.to }))}>{m.label}</button>
            ))}
            {!draft && <button type="button" className="o-btn o-btn-quiet" onClick={() => setDraft(editFields(item))}>Edit text</button>}
          </div>
        </div>
      )}
    </article>
  );
}

// ---- the New item form ----

function NewItemForm({ areas, onAdd, onCancel }) {
  const [f, setF] = useState(() => ({ title: '', detail: '', tag: areas[0] ?? '', priority: 'P2', due: '', lane: 'idea' }));
  const [busy, setBusy] = useState(false);
  const empty = !f.title.trim();
  const set = key => e => { const v = e.target.value; setF(prev => ({ ...prev, [key]: v })); };
  const pick = (key, v) => () => setF(prev => ({ ...prev, [key]: v }));
  const submit = async e => {
    e.preventDefault();
    if (empty || busy) return;
    setBusy(true);
    await onAdd(f);
    setBusy(false);
  };
  return (
    <section aria-labelledby="o-new" className="o-panel o-form">
      <form onSubmit={submit} className="o-form-inner">
        <h2 id="o-new" className="o-h2 o-h2-day">New item</h2>
        <div className="o-form-grid">
          <div className="o-field">
            <label htmlFor="o-new-title" className="o-mono o-field-label">Title</label>
            <input id="o-new-title" className="o-input" value={f.title} onChange={set('title')} maxLength={TITLE_MAX} placeholder="What needs doing" />
          </div>
          <div className="o-field">
            <label htmlFor="o-new-tag" className="o-mono o-field-label">Area</label>
            <select id="o-new-tag" className="o-input" value={f.tag} onChange={set('tag')}>
              {areas.length === 0 && <option value="">No area</option>}
              {areas.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="o-field o-field-wide">
            <label htmlFor="o-new-detail" className="o-mono o-field-label">Detail</label>
            <textarea id="o-new-detail" className="o-input o-textarea" rows={2} value={f.detail} onChange={set('detail')} placeholder="Optional" />
          </div>
          <div role="group" aria-label="Priority" className="o-field-row">
            <span className="o-mono o-field-label">Priority</span>
            {PRIORITIES.map(p => <Chip key={p} on={f.priority === p} onClick={pick('priority', p)}>{p}</Chip>)}
          </div>
          <div className="o-field-row">
            <label htmlFor="o-new-due" className="o-mono o-field-label">Due</label>
            <input id="o-new-due" type="date" className="o-input o-input-date" value={f.due} onChange={set('due')} />
            {f.due && <button type="button" className="o-btn o-btn-quiet" onClick={pick('due', '')}>Clear</button>}
          </div>
          <div role="group" aria-label="Lane" className="o-field-row">
            <span className="o-mono o-field-label">Lane</span>
            <Chip on={f.lane === 'idea'} onClick={pick('lane', 'idea')}>Ideas</Chip>
            <Chip on={f.lane === 'doing'} onClick={pick('lane', 'doing')}>Doing</Chip>
          </div>
        </div>
        <div className="o-actions">
          <button type="submit" className="o-btn o-btn-accent" disabled={empty || busy}>Add to the board</button>
          <button type="button" className="o-btn o-btn-quiet" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

// ---- the tab ----

function Lane({ id, title, count, children, empty, footer }) {
  return (
    <section aria-labelledby={id} className="o-lane">
      <div className="o-lane-head">
        <h3 id={id} className="o-mono o-lane-title">{title}</h3>
        <span className="o-mono o-lane-count">{count}</span>
      </div>
      {children}
      {empty && <span className="o-lane-empty">Nothing here with these filters.</span>}
      {footer}
    </section>
  );
}

export function BoardTab({ board, roster, filters, focus, focusWhy, onOpen, onCloseFocus }) {
  const today = localToday(new Date(useTick(60 * 1000)));
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState(false);
  const items = board.todos;
  const view = boardView(items, { owner: filters.owner, priority: filters.priority, sort: filters.sort, ideasAll: filters.ideasAll, roster });
  const areas = areaOptions(items);
  const lead = roster.agents[0] ?? null;
  const focusItem = focus ? items.find(t => String(t.id) === focus) : null;

  // Change one item; `change` returns the new item, or null for no change.
  const update = (id, change) => board.save(list => {
    let changed = false;
    const next = list.map(t => {
      if (String(t.id) !== String(id)) return t;
      const u = change(t);
      if (!u || u === t) return t;
      changed = true;
      return u;
    });
    return changed ? next : null;
  });

  const add = async f => {
    const item = newItem(f, newId());
    if (!item) return false;
    const ok = await board.save(list => [...list, item]);
    if (ok) { setForm(false); onOpen(String(item.id), 'added'); }
    return ok;
  };

  const card = (t, where) => (
    <Card key={`${where}-${t.id}`} item={t} roster={roster} today={today} items={items} update={update} where={where}
      open={openId === String(t.id)} onToggle={() => setOpenId(id => (id === String(t.id) ? null : String(t.id)))} />
  );

  return (
    <main className="o-wrap o-main o-board">
      <div className="o-controls">
        <button type="button" className="o-btn o-btn-accent o-new" onClick={() => setForm(true)} disabled={!board.loaded}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
          New item
        </button>
        <div role="group" aria-label="Priority filter" className="o-field-row">
          <span className="o-mono o-field-label">Priority</span>
          {priorityFilters(items).map(p => (
            <Chip key={p.label} on={filters.priority === p.key} onClick={() => filters.setPriority(p.key)}>{p.label}</Chip>
          ))}
        </div>
        <div role="group" aria-label="Sort" className="o-field-row">
          <span className="o-mono o-field-label">Sort</span>
          <Chip on={filters.sort === 'priority'} onClick={() => filters.setSort('priority')}>Priority</Chip>
          <Chip on={filters.sort === 'due'} onClick={() => filters.setSort('due')}>Due date</Chip>
        </div>
      </div>

      {board.error && (
        <div className="o-board-error" role="alert">
          <span>{board.error}</span>
          {board.loaded && <button type="button" className="o-btn o-btn-quiet" onClick={board.clearError}>Dismiss</button>}
        </div>
      )}

      {form && <NewItemForm areas={areas} onAdd={add} onCancel={() => setForm(false)} />}

      <div className="o-showing">
        <span>{board.loaded ? showingLine(view.showing) : 'Loading the board…'}</span>
        <span>Tap a card to open it.{lead ? ` Only you and ${lead.name} write the board.` : ''}</span>
      </div>

      {focus && (
        <section aria-labelledby="o-focus" className="o-focus">
          <div className="o-panel-head">
            <h2 id="o-focus" className="o-h2 o-h2-accent">{focusWhy === 'added' ? 'Just added' : 'Linked item'}</h2>
            <button type="button" className="o-btn o-btn-quiet" onClick={onCloseFocus}>Close</button>
          </div>
          {focusItem
            ? <Card item={focusItem} roster={roster} today={today} items={items} update={update} where="focus" open standalone />
            : <p className="o-note">{board.loaded ? 'That item is not on the board any more.' : 'Loading the board…'}</p>}
        </section>
      )}

      {board.loaded && (
        <div className="o-lanes">
          <Lane id="o-lane-doing" title="Doing" count={view.doing.length} empty={view.doing.length === 0}>
            {view.doing.map(t => card(t, 'doing'))}
          </Lane>
          <Lane id="o-lane-ideas" title="Ideas" count={view.ideas.total} empty={view.ideas.total === 0}
            footer={view.ideas.more && (
              <button type="button" className="o-btn o-btn-quiet o-more" onClick={() => filters.setIdeasAll(!filters.ideasAll)}>
                {filters.ideasAll ? 'Show fewer' : `Show all ${view.ideas.total}`}
              </button>
            )}>
            {view.ideas.shown.map(t => card(t, 'ideas'))}
          </Lane>
          <Lane id="o-lane-done" title="Done" count={view.done.total} empty={view.done.total === 0}
            footer={view.done.older > 0 && (
              <span className="o-lane-note">{view.done.older} older done item{view.done.older === 1 ? ' is' : 's are'} not shown.</span>
            )}>
            {view.done.shown.map(t => card(t, 'done'))}
          </Lane>
        </div>
      )}
    </main>
  );
}
