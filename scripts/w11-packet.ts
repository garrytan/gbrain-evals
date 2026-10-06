#!/usr/bin/env bun
/**
 * W11 review packets (2026-10 follow-up round): two self-contained HTML files Garry opens locally.
 *
 *   bun scripts/w11-packet.ts [outDir]     (default docs/benchmarks/2026-10-06-w11-review)
 *
 * - chronicle-review.html: the 38 labeled auto_chronicle events on their 28 pages, one card per page.
 * - cat35-review.html: the 24 Cat35 coverage pairs, blind to the judge's verdict, rated from the
 *   statement and the note the judge saw; the transcript paragraph appears only after a rating.
 *
 * Each page embeds its data as escaped JSON, renders every fixture string with textContent, blocks
 * network connections with a Content-Security-Policy, autosaves to localStorage under the packet's
 * SHA-256, imports earlier exports, and exports a JSON file (download plus clipboard). Scoring is
 * offline: scripts/w11-score.ts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCorpus, type GoldPage } from '../eval/runner/chronicle-lift.ts';

export const CHRONICLE_GOLD = 'eval/data/chronicle-lift-v1/gold-events.json';
export const CAT35_CALIBRATION = 'docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill/judge-calibration-2026-08-25.json';
const CAT35_ARTIFACTS = 'docs/benchmarks/2026-08-16-brainbench-cat35-transcript-distill/artifacts';
const CAT35_GOLD = 'eval/data/transcript-distill-v1/gold';
const CAT35_TRANSCRIPTS = 'eval/data/transcript-distill-v1/transcripts-txt';
export const CAT35_SEED = 20261006;

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** JSON safe to embed inside <script type="application/json">: no `<`, `>` or `&` survive literally. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const PT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export function chronicleData(root = process.cwd()) {
  const goldText = readFileSync(join(root, CHRONICLE_GOLD), 'utf8');
  const gold = JSON.parse(goldText) as { rules: string[]; timezone: string; pages: GoldPage[] };
  const pages = new Map(renderCorpus(join(root, 'eval/data/amara-life-v1')).map(p => [p.path.replace(/\.md$/, ''), p.content]));
  const cards = gold.pages.map(g => {
    const content = pages.get(g.slug);
    if (content === undefined) throw new Error(`no rendered page for ${g.slug}`);
    const start = /^start:\s*(\S+)/m.exec(content)?.[1] ?? null;
    const time = start ? { raw: start.replace(/[-:]/g, ''), utc_day: start.slice(0, 10), pacific: PT.format(new Date(start)).replace(',', '') } : null;
    return { slug: g.slug, class: g.class, page_date: g.page_date, content, time, events: g.events.map(e => ({ id: e.id, day: e.day, kind: e.kind, keywords: e.keywords, basis: e.basis })) };
  });
  return { packet: 'chronicle', title: 'auto_chronicle reference labels', rules: gold.rules, timezone: gold.timezone, label_files: { [CHRONICLE_GOLD]: sha256(goldText) }, cards };
}

const STOP = new Set(['about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'between', 'both', 'could', 'does', 'from', 'have', 'into', 'more', 'most', 'only', 'other', 'over', 'same', 'should', 'some', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until', 'very', 'want', 'wants', 'were', 'what', 'when', 'which', 'while', 'will', 'with', 'would', 'your', 'user']);

/** Search chips taken mechanically from the statement: distinct words of 4+ letters that aren't stopwords. */
export function chipsFor(statement: string): string[] {
  const words = statement.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) ?? [];
  return [...new Set(words.filter(w => !STOP.has(w.toLowerCase())))].slice(0, 8);
}

function paragraphAround(text: string, anchor: string): string {
  const paras = text.split(/\n\s*\n/);
  const needle = anchor.toLowerCase();
  const hit = paras.find(p => p.toLowerCase().includes(needle));
  if (hit) return hit.trim();
  const words = needle.split(/\s+/).filter(w => w.length > 4);
  const scored = paras.map(p => ({ p, n: words.filter(w => p.toLowerCase().includes(w)).length })).sort((a, b) => b.n - a.n);
  return scored[0]?.n ? scored[0].p.trim() : '(No transcript paragraph matched this statement.)';
}

export function cat35Data(root = process.cwd()) {
  const calText = readFileSync(join(root, CAT35_CALIBRATION), 'utf8');
  const cal = JSON.parse(calText) as { entries: Array<{ slot: string; item_id_or_ref: string; transcript_id: string; lane_hint: string; judge_verdict: string | null }> };
  const txtFiles = new Map<string, string>();
  for (const f of readdirSync(join(root, CAT35_TRANSCRIPTS)).filter(f => f.endsWith('.txt'))) {
    txtFiles.set(f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.txt$/, ''), readFileSync(join(root, CAT35_TRANSCRIPTS, f), 'utf8'));
  }
  const rows = cal.entries.filter(e => e.slot === 'coverage').map(e => {
    const gold = JSON.parse(readFileSync(join(root, CAT35_GOLD, `${e.transcript_id}.json`), 'utf8')) as { items: Array<{ item_id: string; statement: string; verbatim_anchor: string }> };
    const item = gold.items.find(i => i.item_id === e.item_id_or_ref);
    if (!item) throw new Error(`no gold item ${e.item_id_or_ref}`);
    const note = readFileSync(join(root, CAT35_ARTIFACTS, `${e.transcript_id}.${e.lane_hint}.md`), 'utf8');
    const transcript = txtFiles.get(e.transcript_id);
    if (transcript === undefined) throw new Error(`no transcript text for ${e.transcript_id}`);
    return { id: `${e.transcript_id}.${e.lane_hint}.${item.item_id}`, statement: item.statement, note, note_empty: note.trim().length === 0, context: paragraphAround(transcript, item.verbatim_anchor), chips: chipsFor(item.statement) };
  });
  const nonEmpty = seededShuffle(rows.filter(r => !r.note_empty), CAT35_SEED);
  const empty = seededShuffle(rows.filter(r => r.note_empty), CAT35_SEED + 1);
  return { packet: 'cat35', title: 'Cat35 coverage judge calibration', seed: CAT35_SEED, label_files: { [CAT35_CALIBRATION]: sha256(calText) }, publish_minimum: 12, rows: [...nonEmpty, ...empty] };
}

const STYLE = `
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fff;--muted:#666;--line:#ddd;--accent:#0a58ca;--warn:#9a3412;--ok:#166534}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--muted:#aaa;--line:#333;--accent:#7ab0ff;--warn:#fdba74;--ok:#86efac}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:1100px;margin:0 auto;padding:16px}header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px;z-index:2;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
header .progress{font-weight:600;margin-right:auto}button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);cursor:pointer}
button:focus-visible,input:focus-visible,textarea:focus-visible,label:focus-within{outline:3px solid var(--accent);outline-offset:2px}
.card{border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:16px 0}.card.current{border-color:var(--accent)}
.cols{display:grid;grid-template-columns:1fr;gap:12px}@media (min-width:900px){.cols{grid-template-columns:1fr 1fr}}
pre{white-space:pre-wrap;word-wrap:break-word;max-width:75ch;font:14px/1.45 ui-monospace,Menlo,monospace;margin:0}.scroll{max-height:60vh;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:8px}
.muted{color:var(--muted)}.warn{color:var(--warn)}.ok{color:var(--ok)}.choices{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.choices label{border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
.event{border-top:1px dashed var(--line);padding-top:8px;margin-top:8px}.fields{display:grid;gap:6px;margin:6px 0 0 16px}.fields input,.fields textarea,textarea{font:inherit;width:100%;max-width:60ch}
mark{background:#fde68a;color:#000}.status{font-size:14px}.chip{font-size:13px;padding:2px 8px}h1{font-size:22px}h2{font-size:18px;margin:4px 0}.hidden{display:none}
`;

const RUNTIME = String.raw`
const DATA = JSON.parse(document.getElementById('packet-data').textContent);
const SHA = document.getElementById('packet-data').dataset.sha;
const KEY = 'w11:' + DATA.packet + ':' + SHA;
const el = (tag, attrs = {}, ...kids) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); } for (const c of kids) if (c != null) n.append(c); return n; };
let state = { reviewer: '', answers: {}, extras: {}, rule_disagreement: '', submitted: false };
let saveStatus = 'not saved yet';
let current = 0;
function keepPlace(fn) { const y = window.scrollY; fn(); window.scrollTo(0, y); }
function load() { try { const s = localStorage.getItem(KEY); if (s) state = Object.assign(state, JSON.parse(s)); saveStatus = s ? 'restored from this computer' : saveStatus; } catch (e) { saveStatus = 'this browser blocks saving: export before closing'; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); saveStatus = 'saved on this computer'; } catch (e) { saveStatus = 'could not save on this computer (' + e.name + '): export before closing'; } renderStatus(); }
function exportObject() { return { schema: 'w11-labels/1', packet: DATA.packet, packet_sha256: SHA, label_files: DATA.label_files, seed: DATA.seed ?? null, reviewer: state.reviewer, exported_at: new Date().toISOString(), submitted: state.submitted, rule_disagreement: state.rule_disagreement, answers: state.answers, extras: state.extras }; }
async function doExport() {
  const text = JSON.stringify(exportObject(), null, 2);
  const name = 'w11-labels-' + DATA.packet + '-' + new Date().toISOString().slice(0, 10) + '.json';
  let msg = [];
  try { const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: name }); document.body.append(a); a.click(); a.remove(); msg.push('downloaded ' + name); } catch (e) { msg.push('download failed (' + e.name + ')'); }
  try { await navigator.clipboard.writeText(text); msg.push('copied to the clipboard'); } catch (e) { msg.push('clipboard unavailable: copy from the box below'); showPlain(text); }
  saveStatus = 'exported, not yet received (' + msg.join('; ') + '). Paste or attach it in the Capy thread.'; renderStatus();
}
function showPlain(text) { const box = document.getElementById('plain'); box.classList.remove('hidden'); box.querySelector('textarea').value = text; }
function doImport(file) {
  file.text().then(t => {
    let obj; try { obj = JSON.parse(t); } catch (e) { alert('That file is not JSON.'); return; }
    if (obj.schema !== 'w11-labels/1' || obj.packet !== DATA.packet) { alert('That export belongs to another packet.'); return; }
    if (obj.packet_sha256 !== SHA) { alert('That export was made from a different version of this packet; it was not imported.'); return; }
    for (const [path, h] of Object.entries(DATA.label_files)) if ((obj.label_files || {})[path] !== h) { alert('Label file hash mismatch for ' + path + '; not imported.'); return; }
    if (typeof obj.answers !== 'object' || obj.answers === null) { alert('No answers in that file.'); return; }
    state = { reviewer: String(obj.reviewer || ''), answers: obj.answers, extras: obj.extras || {}, rule_disagreement: String(obj.rule_disagreement || ''), submitted: !!obj.submitted };
    save(); render();
  });
}
function renderStatus() { const s = document.getElementById('status'); if (s) s.textContent = saveStatus; const p = document.getElementById('progress'); if (p) p.textContent = progressText(); }
function header(intro) {
  const h = el('header', {},
    el('span', { class: 'progress', id: 'progress' }),
    el('label', {}, 'Your name ', el('input', { value: state.reviewer, oninput: e => { state.reviewer = e.target.value; save(); }, 'aria-label': 'Reviewer name' })),
    el('button', { onclick: doExport, title: 'Download a JSON file and copy it to the clipboard' }, 'Export answers'),
    el('label', { class: 'chip' }, 'Import answers ', el('input', { type: 'file', accept: 'application/json', onchange: e => e.target.files[0] && doImport(e.target.files[0]) })),
    el('button', { onclick: submitSection }, state.submitted ? 'Submitted' : 'Submit this section'),
    el('span', { class: 'status muted', id: 'status' }));
  return h;
}
function submitSection() {
  if (state.submitted) return;
  const s = summary();
  if (!confirm('Submit this section?\n\n' + s + '\n\nSubmitted answers lock; a later change becomes a dated amendment. Export afterwards and paste the file into the Capy thread.')) return;
  state.submitted = true; save(); render();
}
document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea')) return;
  const cards = [...document.querySelectorAll('.card[data-id]')]; if (!cards.length) return;
  let i = Math.min(current, cards.length - 1);
  if (e.key === 'j' || e.key === 'k') { cards[i].classList.remove('current'); i = Math.max(0, Math.min(cards.length - 1, i + (e.key === 'j' ? 1 : -1))); current = i; cards[i].classList.add('current'); cards[i].scrollIntoView({ block: 'start' }); cards[i].querySelector('input')?.focus(); e.preventDefault(); return; }
  const map = { '1': 0, '2': 1, '3': 2, 'n': 3 }; if (!(e.key in map)) return;
  const groups = [...cards[i].querySelectorAll('[role=radiogroup]')];
  const target = groups.find(g => ![...g.querySelectorAll('input')].some(x => x.checked)) || groups[0];
  const radios = target ? [...target.querySelectorAll('input[type=radio]:not(:disabled)')] : [];
  const r = radios[map[e.key]]; if (r) { r.click(); e.preventDefault(); }
});
`;

const CHRONICLE_UI = String.raw`
const OUTCOMES = [['supported', 'Supported as written'], ['error', 'Has an error'], ['cant_tell', "Can't tell"]];
const ERRORS = [['date', 'date'], ['description', 'description or person'], ['not_event', 'not an event'], ['keywords', "keywords wouldn't identify it"]];
const events = DATA.cards.flatMap(c => c.events.map(e => e.id));
function answered(id) { const a = state.answers[id]; if (!a || !a.outcome) return false; if (a.outcome === 'error') { const errs = a.errors || []; if (!errs.length) return false; if (errs.includes('date') && !/^\d{4}-\d{2}-\d{2}$/.test(a.corrected_day || '')) return false; } return true; }
function progressText() { const n = events.filter(answered).length; const pages = DATA.cards.filter(c => c.events.every(e => answered(e.id))).length; return 'Chronicle ' + pages + '/' + DATA.cards.length + ' pages · ' + n + '/' + events.length + ' events'; }
function summary() { const vals = events.map(id => state.answers[id]?.outcome); const added = Object.values(state.extras).flat().length; return 'Answered ' + events.filter(answered).length + ' of ' + events.length + ' (supported ' + vals.filter(v => v === 'supported').length + ', with an error ' + vals.filter(v => v === 'error').length + ", can't tell " + vals.filter(v => v === 'cant_tell').length + '); unanswered ' + events.filter(id => !answered(id)).length + '; missed events added ' + added + '.'; }
function eventBlock(card, ev) {
  const a = state.answers[ev.id] || (state.answers[ev.id] = {});
  const lock = state.submitted;
  const fields = el('div', { class: 'fields' + (a.outcome === 'error' ? '' : ' hidden') });
  for (const [k, label] of ERRORS) fields.append(el('label', {}, Object.assign(el('input', { type: 'checkbox', onchange: e => { a.errors = (a.errors || []).filter(x => x !== k).concat(e.target.checked ? [k] : []); save(); render(); } }), { checked: (a.errors || []).includes(k), disabled: lock }), ' ' + label));
  if ((a.errors || []).includes('date')) fields.append(el('label', {}, 'Correct UTC day (required) ', Object.assign(el('input', { type: 'date', oninput: e => { a.corrected_day = e.target.value; save(); } }), { value: a.corrected_day || '', disabled: lock })));
  if ((a.errors || []).some(x => x === 'description' || x === 'keywords')) {
    fields.append(el('label', {}, 'Correct description ', Object.assign(el('input', { oninput: e => { a.corrected_description = e.target.value; save(); } }), { value: a.corrected_description || '', disabled: lock })));
    fields.append(el('label', {}, 'Keywords that identify it (comma-separated) ', Object.assign(el('input', { oninput: e => { a.corrected_keywords = e.target.value; save(); } }), { value: a.corrected_keywords || '', disabled: lock })));
  }
  fields.append(el('label', {}, 'Note (optional) ', Object.assign(el('input', { oninput: e => { a.note = e.target.value; save(); } }), { value: a.note || '', disabled: lock })));
  const choices = el('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Verdict for ' + ev.id });
  OUTCOMES.forEach(([k, label], i) => choices.append(el('label', {}, Object.assign(el('input', { type: 'radio', name: ev.id, onchange: () => { a.outcome = k; save(); render(); } }), { checked: a.outcome === k, disabled: lock }), ' ' + (i < 2 ? (i + 1) + ' ' : 'N ') + label)));
  return el('div', { class: 'event' },
    el('div', {}, el('strong', { text: ev.day }), ' ', el('span', { class: 'muted', text: ev.kind + ' · keywords: ' + ev.keywords.join(', ') })),
    el('div', { class: 'muted', text: 'Why it is labeled: ' + ev.basis }), choices, fields);
}
function missedBlock(card) {
  const list = state.extras[card.slug] || (state.extras[card.slug] = []);
  const wrap = el('div', { class: 'event' }, el('div', { class: 'muted', text: 'An anchor event the labels missed on this page (optional). All three fields are required to add one.' }));
  list.forEach((m, i) => wrap.append(el('div', {}, el('span', { text: m.day + ' · ' + m.description + ' · keywords: ' + m.keywords.join(', ') }), state.submitted ? null : el('button', { onclick: () => { list.splice(i, 1); save(); render(); } }, 'Remove'))));
  if (!state.submitted) {
    const d = el('input', { type: 'date', 'aria-label': 'Missed event UTC day' }), t = el('input', { placeholder: 'description', 'aria-label': 'Missed event description' }), k = el('input', { placeholder: 'keywords, comma-separated', 'aria-label': 'Missed event keywords' });
    wrap.append(el('div', { class: 'fields' }, d, t, k, el('button', { onclick: () => { const kw = k.value.split(',').map(s => s.trim()).filter(Boolean); if (!d.value || !t.value.trim() || !kw.length) { alert('Day, description and keywords are all required.'); return; } list.push({ day: d.value, description: t.value.trim(), keywords: kw }); save(); render(); } }, 'Add missed event')));
  }
  return wrap;
}
function render() { keepPlace(draw); }
function draw() {
  const root = document.getElementById('app'); root.replaceChildren();
  root.append(header());
  const main = el('main');
  main.append(el('h1', { text: 'auto_chronicle reference labels: about 15 minutes' }),
    el('p', { text: 'You are checking the 38 events an agent labeled as expected on 28 pages of a fictional week (the amara-life-v1 corpus). For each event, say whether it is right as written. Partial work is fine: answers save on this computer as you go, and Export writes a file you paste or attach in the Capy thread.' }),
    el('p', { class: 'muted', text: 'What this checks: the labels the experiment scored against, and events the labels missed on these 28 pages. What it does not check: the 36 questions, the 116 other pages, or whether the events help an agent.' }),
    el('h2', { text: 'The label rules' }), el('ul', {}, ...DATA.rules.map(r => el('li', { text: r }))),
    el('p', { class: 'warn', text: 'Dates are UTC days (gbrain\'s default chronicle.tz). Calendar invites show their raw DTSTART, UTC day and Pacific time. Mark "date" as an error only if the UTC day is wrong; if you disagree with a rule itself, say so once in the box below instead of marking every row.' }),
    el('label', {}, 'Disagreement with a rule (optional) ', Object.assign(el('textarea', { rows: 2, oninput: e => { state.rule_disagreement = e.target.value; save(); } }), { value: state.rule_disagreement, disabled: state.submitted })),
    el('p', { class: 'muted', text: 'Keys: 1 supported, 2 has an error, N can\'t tell (first unanswered event on the current card); J and K move between cards.' }));
  DATA.cards.forEach((card, i) => {
    const c = el('section', { class: 'card' + (i === current ? ' current' : ''), 'data-id': card.slug, onclick: () => { current = i; } },
      el('h2', { text: (i + 1) + '. ' + card.slug + ' (' + card.class + ', page date ' + card.page_date + ')' }),
      card.time ? el('p', { class: 'warn', text: 'DTSTART ' + card.time.raw + ' · UTC day ' + card.time.utc_day + ' · Pacific ' + card.time.pacific }) : null,
      el('div', { class: 'scroll' }, el('pre', { text: card.content })));
    for (const ev of card.events) c.append(eventBlock(card, ev));
    c.append(missedBlock(card));
    main.append(c);
  });
  main.append(el('div', { id: 'plain', class: 'hidden' }, el('p', { text: 'Copy this text and paste it into the Capy thread:' }), el('textarea', { rows: 10 })));
  root.append(main); renderStatus();
}
load(); render();
`;

const CAT35_UI = String.raw`
const LABELS = [['FULL', 'Fully conveyed'], ['PARTIAL', 'Partly conveyed'], ['ABSENT', 'Not conveyed'], ['CANT_TELL', "Can't tell"]];
function eligible(r) { const a = state.answers[r.id]; return !r.note_empty && a && a.rating && a.rating !== 'CANT_TELL'; }
function progressText() { const done = DATA.rows.filter(r => state.answers[r.id]?.rating).length; const el12 = DATA.rows.filter(eligible).length; return 'Cat35 ' + done + '/' + DATA.rows.length + ' rated · ' + el12 + ' of ' + DATA.publish_minimum + ' eligible ratings needed to publish'; }
function summary() { const vals = DATA.rows.map(r => state.answers[r.id]?.rating); return 'Rated ' + vals.filter(Boolean).length + ' of ' + DATA.rows.length + ' (fully ' + vals.filter(v => v === 'FULL').length + ', partly ' + vals.filter(v => v === 'PARTIAL').length + ', not ' + vals.filter(v => v === 'ABSENT').length + ", can't tell " + vals.filter(v => v === 'CANT_TELL').length + '); eligible ratings ' + DATA.rows.filter(eligible).length + ' (publishing needs ' + DATA.publish_minimum + ').'; }
function highlight(pre, text, term) { pre.replaceChildren(); if (!term) { pre.textContent = text; return 0; } const lower = text.toLowerCase(), t = term.toLowerCase(); let i = 0, n = 0, first = null; while (true) { const j = lower.indexOf(t, i); if (j < 0) break; pre.append(text.slice(i, j)); const m = el('mark', { text: text.slice(j, j + t.length) }); if (!first) first = m; pre.append(m); i = j + t.length; n++; } pre.append(text.slice(i)); first?.scrollIntoView({ block: 'center' }); return n; }
function rowCard(r, i) {
  const a = state.answers[r.id] || (state.answers[r.id] = {});
  const lock = state.submitted;
  const pre = el('pre');
  const count = el('span', { class: 'muted' });
  const find = el('input', { placeholder: 'find in the note', 'aria-label': 'Find in the note', oninput: e => { count.textContent = ' ' + highlight(pre, r.note, e.target.value) + ' matches'; } });
  highlight(pre, r.note, '');
  const chips = el('div', { class: 'choices' }, ...r.chips.map(c => el('button', { class: 'chip', onclick: () => { find.value = c; find.dispatchEvent(new Event('input')); } }, c)));
  const choices = el('div', { class: 'choices', role: 'radiogroup', 'aria-label': 'Rating for row ' + (i + 1) });
  LABELS.forEach(([k, label], j) => choices.append(el('label', {}, Object.assign(el('input', { type: 'radio', name: r.id, onchange: () => { a.rating = k; a.rated_at = a.rated_at || new Date().toISOString(); save(); render(); } }), { checked: a.rating === k, disabled: lock }), ' ' + (j < 3 ? (j + 1) + ' ' : 'N ') + label)));
  const after = a.rating ? el('div', { class: 'event' },
    el('div', { class: 'muted', text: 'Context, shown only after you rate (the judge did not see this). It never changes your rating above.' }),
    el('div', { class: 'scroll' }, el('pre', { text: r.context })),
    el('label', {}, Object.assign(el('input', { type: 'checkbox', onchange: e => { a.context_changes_answer = e.target.checked; save(); } }), { checked: !!a.context_changes_answer, disabled: lock }), ' Seeing this context would change my answer'),
    el('label', {}, ' Note (optional) ', Object.assign(el('input', { oninput: e => { a.note = e.target.value; save(); } }), { value: a.note || '', disabled: lock }))) : null;
  return el('section', { class: 'card' + (i === current ? ' current' : ''), 'data-id': r.id, onclick: () => { current = i; } },
    el('h2', { text: 'Row ' + (i + 1) + ' of ' + DATA.rows.length + ': does this note convey the statement?' }),
    el('p', {}, el('strong', { text: 'Statement: ' }), r.statement),
    r.note_empty ? el('p', { class: 'warn', text: 'This lane wrote no note for this transcript.' }) : el('div', {}, el('div', {}, find, count), chips, el('div', { class: 'scroll' }, pre)),
    choices, after);
}
function render() { keepPlace(draw); }
function draw() {
  const root = document.getElementById('app'); root.replaceChildren();
  root.append(header());
  const main = el('main');
  main.append(el('h1', { text: 'Cat35 coverage judge calibration (optional; timebox 30 minutes)' }),
    el('p', { text: 'Each row is a statement from a fictional working session and the note one memory lane wrote from it. Rate whether the note conveys the statement, the same question the judge answered. You see what the judge saw; the judge\'s own verdict is hidden. After you rate, the transcript paragraph appears as context. Rows are in a fixed random order, so stopping early still gives a fair sample. 12 eligible ratings (a non-empty note, not "can\'t tell") are needed before anything is published.' }),
    el('p', { class: 'muted', text: 'What this checks: agreement of the coverage judge with a person. It does not check the 16 grounding and distractor rows (they have no judge verdict) or the usability judge.' }),
    el('p', { class: 'muted', text: 'Keys: 1 fully, 2 partly, 3 not conveyed, N can\'t tell; J and K move between rows.' }));
  DATA.rows.forEach((r, i) => main.append(rowCard(r, i)));
  main.append(el('div', { id: 'plain', class: 'hidden' }, el('p', { text: 'Copy this text and paste it into the Capy thread:' }), el('textarea', { rows: 10 })));
  root.append(main); renderStatus();
}
load(); render();
`;

export function renderPacket(data: { packet: string; title: string }, ui: string): { html: string; sha: string } {
  const json = embedJson(data);
  const sha = sha256(json);
  const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${data.title.replace(/[<>&"]/g, '')}: review packet</title>
<style>${STYLE}</style></head>
<body><noscript>This review packet needs JavaScript; it makes no network requests.</noscript><div id="app"></div>
<script type="application/json" id="packet-data" data-sha="${sha}">${json}</script>
<script>${RUNTIME}${ui}</script>
</body></html>
`;
  return { html, sha };
}

if (import.meta.main) {
  const outDir = process.argv[2] ?? 'docs/benchmarks/2026-10-06-w11-review';
  mkdirSync(outDir, { recursive: true });
  const chronicle = renderPacket(chronicleData(), CHRONICLE_UI);
  const cat35 = renderPacket(cat35Data(), CAT35_UI);
  writeFileSync(join(outDir, 'chronicle-review.html'), chronicle.html);
  writeFileSync(join(outDir, 'cat35-review.html'), cat35.html);
  writeFileSync(join(outDir, 'packets.json'), JSON.stringify({ generated_by: 'scripts/w11-packet.ts', chronicle: { file: 'chronicle-review.html', data_sha256: chronicle.sha }, cat35: { file: 'cat35-review.html', data_sha256: cat35.sha, seed: CAT35_SEED } }, null, 2) + '\n');
  console.log(`wrote ${outDir}/chronicle-review.html (data ${chronicle.sha.slice(0, 12)}) and cat35-review.html (data ${cat35.sha.slice(0, 12)})`);
}
