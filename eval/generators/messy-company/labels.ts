#!/usr/bin/env bun
/**
 * messy-company-v1 labels: planned gold, checked against the written pages.
 *
 *   bun eval/generators/messy-company/labels.ts compare   # verification/disagreements.json (+ stats)
 *   bun eval/generators/messy-company/labels.ts build     # labels/<lane>/{dev,heldout}.jsonl; fails on any unadjudicated disagreement
 *
 * Gold comes from the frozen world plan through the oracle. Each labeled item
 * is compared with the answer of the model that did not write the page.
 * Agreement keeps the planned label. A disagreement must have a decision in
 * verification/adjudications.json, made by reading the page:
 *   keep      the text supports the planned label; the verifier was wrong
 *   relabel   the author drifted; the label changes to match the text
 *   drop      the text supports no clear label; the item is removed
 * Verifier-reported extra owner phrases are added only by an `add` decision.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DATA, findAll, loadPlan, longClause, norm, pagePath, rawPath } from './generate.ts';
import { addDays, governing } from './oracle.ts';
import type { PageSpec, ResolvedMention } from './pages.ts';
import { TASKS } from './tasks.ts';
import { entityOccurrences, entityTable, lineOf } from './verify.ts';
import { ACCOUNTS, CLAIMS, CLAIM_PAIRS, EVENTS, HANDOFF_CORRECTIONS, OTHERS, RECORDS, RETRACTIONS, SPLIT_OF, STINTS, TODAY, accountById, personById, type Attr } from './world.ts';

export const LANES = ['ownership', 'owner-phrases', 'aliases', 'entity-mentions', 'governing-records', 'document-status', 'timeline', 'changes', 'agent-tasks'] as const;

interface Item { key: string; lane: string; slug: string; split: string; planned: unknown; verifier: unknown; agree: boolean; context?: string }
export interface Adjudication { key: string; decision: 'keep' | 'relabel' | 'drop' | 'add' | 'reject'; label?: Record<string, unknown>; note: string }

const plan = () => loadPlan();
const text = (p: PageSpec) => readFileSync(pagePath(p), 'utf8');
const verdict = (p: PageSpec): any => { const f = rawPath('verify', p.slug); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).parsed ?? {} : null; };

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(s);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = /\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
export function sameValue(gold: unknown, got: unknown): boolean {
  if (got === null || got === undefined) return false;
  const g = String(gold), s = String(got);
  if (/^\d{4}-\d\d-\d\d$/.test(g)) return isoDate(s) === g;
  if (/^\d+(\.\d+)?$/.test(g)) {
    const nums = (s.replace(/,/g, '').match(/\d+(\.\d+)?/g) ?? []).map(Number);
    return nums.includes(Number(g));
  }
  const n = (x: string) => norm(x).toLowerCase().replace(/[^a-z0-9$%. ]/g, ' ').replace(/\s+/g, ' ').trim();
  return n(s).includes(n(g)) || n(g).includes(n(s));
}
const setEq = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

function contextLines(t: string, line: number, span = 2): string {
  const ls = t.split('\n');
  return ls.slice(Math.max(0, line - 1 - span), line + span).map((l, i) => `${Math.max(1, line - span) + i}| ${l}`).join('\n');
}

// ─── Entity gold per occurrence ─────────────────────────────────────

export function surfaceOwners(split: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of entityTable(split)) for (const s of e.surfaces) m.set(s.surface, [...(m.get(s.surface) ?? []), e.id]);
  return m;
}

// ─── Compare ────────────────────────────────────────────────────────

export function compareAll(): Item[] {
  const items: Item[] = [];
  for (const p of plan()) {
    if (!existsSync(pagePath(p))) continue;
    const t = text(p);
    const v = verdict(p);
    if (v === null) { items.push({ key: `missing:${p.slug}`, lane: 'all', slug: p.slug, split: p.split, planned: null, verifier: null, agree: false, context: 'no verification output' }); continue; }
    // owner phrases
    for (const m of p.mentions) {
      const ans = (v.owner_phrases ?? []).find((x: any) => x.mid === m.mid);
      const accs: string[] = ans?.refers_to_customer_account ? (ans.accounts ?? []) : [];
      const agree = !!ans && setEq(accs, m.accounts);
      const line = findAll(t, m.surface).map(i => lineOf(t, i))[0] ?? 0;
      items.push({ key: `op:${m.mid}`, lane: 'owner-phrases', slug: p.slug, split: p.split, planned: { surface: m.surface, accounts: m.accounts, reason: m.reason }, verifier: ans ?? null, agree, context: line ? contextLines(t, line) : 'phrase not found' });
    }
    for (const x of v.extra_owner_phrases ?? []) {
      if (!x?.phrase) continue;
      if (p.mentions.some(m => norm(m.surface).toLowerCase() === norm(String(x.phrase)).toLowerCase())) continue;
      items.push({ key: `xop:${p.slug}:${x.line}:${x.phrase}`, lane: 'owner-phrases', slug: p.slug, split: p.split, planned: null, verifier: x, agree: false, context: contextLines(t, Number(x.line) || 1) });
    }
    // entity mentions
    const owners = surfaceOwners(p.split);
    for (const o of entityOccurrences(p, t)) {
      const ans = (v.entities ?? []).find((x: any) => x.oid === o.oid);
      const intent = p.entity_intent[o.surface];
      const cands = owners.get(o.surface) ?? [];
      const gold = intent && intent !== 'mixed' ? intent : cands.length === 1 && !intent ? cands[0] : null;
      const got = ans?.entity ?? null;
      const agree = gold !== null && got === gold;
      items.push({ key: `ent:${p.slug}:${o.oid}`, lane: 'entity-mentions', slug: p.slug, split: p.split, planned: { surface: o.surface, line: o.line, entity: gold, candidates: cands, intent: intent ?? null }, verifier: ans ?? null, agree, context: contextLines(t, o.line, 1) });
    }
    // claims
    for (const cid of p.claims) {
      const c = CLAIMS.find(x => x.id === cid)!;
      const ans = (v.claims ?? []).find((x: any) => x.cid === cid);
      const agree = !!ans?.stated && sameValue(c.value, ans.value);
      items.push({ key: `cl:${p.slug}:${cid}`, lane: 'changes', slug: p.slug, split: p.split, planned: { value: c.value, attr: c.attr }, verifier: ans ?? null, agree, context: ans?.line ? contextLines(t, Number(ans.line)) : undefined });
    }
    // events
    for (const eid of p.events) {
      const e = EVENTS.find(x => x.id === eid)!;
      const ans = (v.events ?? []).find((x: any) => x.eid === eid);
      const agree = !!ans?.present && isoDate(ans.date) === e.date;
      items.push({ key: `ev:${p.slug}:${eid}`, lane: 'timeline', slug: p.slug, split: p.split, planned: { date: e.date, summary: e.summary }, verifier: ans ?? null, agree, context: ans?.line ? contextLines(t, Number(ans.line)) : undefined });
    }
    // ownership statements
    for (const acc of [...new Set(p.states_stints.map(id => STINTS.find(s => s.id === id)!.account))]) {
      const stints = p.states_stints.map(id => STINTS.find(s => s.id === id)!).filter(s => s.account === acc);
      const ans = (v.ownership ?? []).filter((x: any) => x.account === acc);
      const covered = stints.every(s => ans.some((a: any) => {
        const ownerName = s.owner.startsWith('team-') ? 'team' : personById(s.owner).first.toLowerCase();
        const okOwner = String(a.owner ?? '').toLowerCase().includes(ownerName === 'team' ? 'team' : ownerName) || (ownerName === 'team' && /pod|pool/i.test(String(a.owner ?? '')));
        const okStart = s.start === null || isoDate(a.start) === s.start || (s.role !== 'primary' && s.role !== 'team');
        return okOwner && okStart;
      }) || ans.some((a: any) => isoDate(a.end) === s.end && s.end !== null));
      items.push({ key: `own:${p.slug}:${acc}`, lane: 'ownership', slug: p.slug, split: p.split, planned: stints.map(s => ({ id: s.id, owner: s.owner, role: s.role, start: s.start, end: s.end })), verifier: ans, agree: covered });
    }
    // record
    if (p.record) {
      const r = RECORDS.find(x => x.id === p.record)!;
      const ans = v.record ?? {};
      items.push({ key: `st:${p.slug}`, lane: 'document-status', slug: p.slug, split: p.split, planned: r.status, verifier: ans.status ?? null, agree: ans.status === r.status, context: ans.status_evidence_line ? contextLines(t, Number(ans.status_evidence_line)) : undefined });
      if (r.signed) items.push({ key: `rs:${p.slug}`, lane: 'governing-records', slug: p.slug, split: p.split, planned: r.signed, verifier: ans.signed_date ?? null, agree: isoDate(ans.signed_date) === r.signed });
      if (r.effective) items.push({ key: `re:${p.slug}`, lane: 'governing-records', slug: p.slug, split: p.split, planned: r.effective, verifier: ans.effective_date ?? null, agree: isoDate(ans.effective_date) === r.effective });
      for (const set of r.sets) {
        const hits = (ans.terms ?? []).filter((x: any) => String(x.term).replace(/[^a-z_]/gi, '_').toLowerCase().includes(set.attr.split('_')[0]) || String(x.term) === set.attr);
        const hit = hits.find((x: any) => sameValue(set.value, x.value) && (!x.applies_to?.length || set.scope.some(a => x.applies_to.includes(a))));
        items.push({ key: `rv:${p.slug}:${set.attr}:${set.scope.join('+')}`, lane: 'governing-records', slug: p.slug, split: p.split, planned: { attr: set.attr, value: set.value, scope: set.scope }, verifier: hits, agree: !!hit, context: hit?.line ? contextLines(t, Number(hit.line), 0) : undefined });
      }
      if (r.long) {
        const days = r.sets.find(s => s.attr === 'notice_days')!.value as number;
        const c = longClause(t, days);
        const myLine = c && c.index >= 0 ? lineOf(t, c.index + 1) : null;
        const agree = !!myLine && Number(ans.deciding_days) === days && Math.abs(Number(ans.deciding_line) - myLine) <= 2;
        items.push({ key: `dp:${p.slug}`, lane: 'governing-records', slug: p.slug, split: p.split, planned: { days, line: myLine }, verifier: { line: ans.deciding_line, days: ans.deciding_days }, agree, context: myLine ? contextLines(t, myLine, 1) : undefined });
      }
    }
    if (p.retraction) {
      const rt = RETRACTIONS.find(x => x.id === p.retraction)!;
      const ans = v.retraction ?? {};
      items.push({ key: `rt:${p.slug}`, lane: 'changes', slug: p.slug, split: p.split, planned: { wrong: rt.wrong, correct: rt.correct }, verifier: ans, agree: sameValue(rt.wrong, ans.first_value) && sameValue(rt.correct, ans.corrected_value) });
    }
  }
  return items;
}

export function adjudications(): Map<string, Adjudication> {
  const f = join(DATA, 'verification/adjudications.json');
  const list: Adjudication[] = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
  return new Map(list.map(a => [a.key, a]));
}

function stats(items: Item[]) {
  const by: Record<string, { items: number; disagreements: number }> = {};
  for (const i of items) {
    if (i.key.startsWith('xop:')) continue;
    const k = i.lane;
    by[k] ??= { items: 0, disagreements: 0 };
    by[k].items++;
    if (!i.agree) by[k].disagreements++;
  }
  const total = Object.values(by).reduce((a, b) => ({ items: a.items + b.items, disagreements: a.disagreements + b.disagreements }), { items: 0, disagreements: 0 });
  return { by_lane: by, total, extra_owner_phrase_reports: items.filter(i => i.key.startsWith('xop:')).length };
}

// ─── Build labels ───────────────────────────────────────────────────

type Row = Record<string, unknown> & { split: string };

function write(lane: string, rows: Row[]) {
  const dir = join(DATA, 'labels', lane);
  mkdirSync(dir, { recursive: true });
  for (const split of ['dev', 'heldout']) {
    const rs = rows.filter(r => r.split === split);
    writeFileSync(join(dir, `${split}.jsonl`), rs.map(r => JSON.stringify(r)).join('\n') + (rs.length ? '\n' : ''));
  }
}

export function build(): Record<string, Record<string, number>> {
  const items = compareAll();
  const adj = adjudications();
  const open = items.filter(i => !i.agree && !adj.has(i.key));
  if (open.length) throw new Error(`${open.length} disagreements have no adjudication (first: ${open[0].key}); run compare and record decisions`);
  const agreeOf = (key: string) => { const i = items.find(x => x.key === key); return i ? { verifier_agreed: i.agree, ...(adj.has(key) ? { adjudication: adj.get(key)!.decision, adjudication_note: adj.get(key)!.note } : {}) } : { verifier_agreed: null }; };
  const pages = plan().filter(p => existsSync(pagePath(p)));
  const bySlug = new Map(pages.map(p => [p.slug, p]));
  const counts: Record<string, Record<string, number>> = {};

  // owner-phrases
  const op: Row[] = [];
  for (const p of pages) {
    const t = text(p);
    for (const m of p.mentions) {
      const key = `op:${m.mid}`;
      const a = adj.get(key);
      if (a?.decision === 'drop') continue;
      const lab = { ...m, ...(a?.decision === 'relabel' ? a.label : {}) } as ResolvedMention;
      const lines = findAll(t, m.surface).map(i => lineOf(t, i));
      op.push({ id: m.mid, split: p.split, slug: p.slug, surface: m.surface, lines, page_date: p.date, body_date: p.body_date ?? null, date_basis: lab.date_basis, visibility: p.visibility ?? 'public', owner: lab.owner, form: lab.form, intended_accounts: lab.accounts, should_link: lab.accounts.length > 0, should_link_public: lab.accounts.length > 0 && lab.should_link_public, reason: lab.reason, window_relation: lab.window_relation, stints: lab.stints, source: 'plan', ...agreeOf(key) });
    }
  }
  for (const [key, a] of adj) {
    if (!key.startsWith('xop:') || a.decision !== 'add') continue;
    const slug = key.split(':')[1];
    const p = bySlug.get(slug)!;
    const t = text(p);
    const lab = a.label as Record<string, any>;
    op.push({ id: `${slug}#x${op.filter(r => r.slug === slug).length + 1}`, split: p.split, slug, surface: lab.surface, lines: findAll(t, lab.surface).map(i => lineOf(t, i)), page_date: p.date, body_date: p.body_date ?? null, date_basis: p.body_date ? 'body' : p.date ? 'frontmatter' : 'undated', visibility: p.visibility ?? 'public', owner: lab.owner ?? null, form: lab.form ?? 'found', intended_accounts: lab.accounts, should_link: lab.accounts.length > 0, should_link_public: lab.accounts.length > 0 && (lab.should_link_public ?? true), reason: lab.reason, window_relation: lab.window_relation ?? 'n/a', stints: lab.stints ?? [], source: 'verification', verifier_agreed: null, adjudication: 'add', adjudication_note: a.note });
  }
  write('owner-phrases', op);

  // entity mentions
  const em: Row[] = [];
  for (const p of pages) {
    const t = text(p);
    const owners = surfaceOwners(p.split);
    const seenOnLine = new Map<string, number>();
    for (const o of entityOccurrences(p, t)) {
      const key = `ent:${p.slug}:${o.oid}`;
      const lineKey = `${o.line}|${o.surface}`;
      const occurrence = (seenOnLine.get(lineKey) ?? 0) + 1;
      seenOnLine.set(lineKey, occurrence);
      const it = items.find(i => i.key === key)!;
      const a = adj.get(key);
      if (a?.decision === 'drop') continue;
      const gold = a?.decision === 'relabel' ? (a.label!.entity as string) : (it.planned as any).entity ?? (it.verifier as any)?.entity;
      const cands = owners.get(o.surface) ?? [];
      const lookalike = ['Tansley', 'Tansleigh', 'Tansley Packaging', 'Quarendon', 'Quarrendon', 'Orlavine', 'Orlavene', 'Pellow', 'Pellucid'].includes(o.surface);
      em.push({ id: key.slice(4), split: p.split, slug: p.slug, line: o.line, surface: o.surface, occurrence, entity: gold === 'none' ? null : gold, surface_candidates: cands, ambiguous_surface: cands.length > 1, lookalike_surface: lookalike, gold_source: a ? 'adjudicated' : (it.planned as any).intent && (it.planned as any).intent !== 'mixed' ? 'plan_intent' : cands.length === 1 ? 'unique_surface' : 'verifier', ...agreeOf(key) });
    }
  }
  write('entity-mentions', em);

  // aliases: surface -> entity, true or false
  const al: Row[] = [];
  for (const split of ['dev', 'heldout']) {
    const ents = entityTable(split);
    const used = em.filter(r => r.split === split);
    const surfaces = [...new Set(ents.flatMap(e => e.surfaces.map(s => s.surface)))];
    for (const s of surfaces) {
      const owners = ents.filter(e => e.surfaces.some(x => x.surface === s));
      for (const e of ents.filter(e => e.kind === 'customer account' || owners.some(o => o.id === e.id) || e.surfaces.some(x => x.surface.toLowerCase().startsWith(s.toLowerCase().slice(0, 4))))) {
        const def = e.surfaces.find(x => x.surface === s);
        const usedFor = used.filter(r => r.surface === s && r.entity === e.id).map(r => r.slug as string);
        const isTrue = !!def;
        const nearMiss = !isTrue && (usedFor.length > 0 || norm(s).toLowerCase().slice(0, 5) === norm(e.name).toLowerCase().slice(0, 5) || owners.some(o => ACCOUNTS.find(a => a.id === o.id)?.parent === e.id || ACCOUNTS.find(a => a.id === e.id)?.parent === o.id));
        if (!isTrue && !nearMiss) continue;
        al.push({ id: `${split}:${s}->${e.id}`, split, surface: s, entity: e.id, valid: isTrue, kind: def?.kind ?? (usedFor.length ? 'typo_in_corpus' : 'lookalike_negative'), valid_from: def?.valid_from ?? null, valid_to: def?.valid_to ?? null, collides_with: owners.filter(o => o.id !== e.id).map(o => o.id), evidence_slugs: [...new Set(usedFor)].sort(), note: def?.note ?? (usedFor.length ? 'not an alias, but the corpus uses this surface for this entity as a typo; count it as a mention, not an alias' : 'look-alike or family surface that does not name this entity') });
      }
    }
  }
  write('aliases', al);

  // ownership windows
  const ow: Row[] = [];
  for (const s of STINTS) {
    const acc = accountById(s.account);
    const evidence = pages.filter(p => p.states_stints.includes(s.id)).filter(p => { const k = `own:${p.slug}:${s.account}`; const a = adj.get(k); return a?.decision !== 'drop'; }).map(p => ({ slug: p.slug, visibility: p.visibility ?? 'public', ...agreeOf(`own:${p.slug}:${s.account}`) }));
    ow.push({ id: s.id, split: SPLIT_OF[acc.cluster], account: s.account, owner: s.owner, owner_kind: s.owner.startsWith('team-') ? 'team' : 'person', role: s.role, start: s.start, start_bound: s.start_bound ?? null, end: s.end, evidence_visibility: s.evidence_visibility, evidence, corrections: HANDOFF_CORRECTIONS.filter(h => h.stint_ids.includes(s.id)).map(h => h.id), note: s.note ?? null });
  }
  for (const h of HANDOFF_CORRECTIONS) {
    const split = h.id.includes('north') ? 'dev' : 'heldout';
    const ann = pages.find(p => p.date === h.announced_on && p.kind === 'email' && p.split === split)?.slug ?? null;
    const cor = pages.find(p => p.date === h.corrected_on && p.kind === 'email' && p.split === split)?.slug ?? null;
    ow.push({ id: h.id, split, kind: 'corrected_announcement', announced: h.announced, corrected: h.corrected, announced_slug: ann, correction_slug: cor, governing_stints: h.stint_ids });
  }
  write('ownership', ow);

  // document status
  const ds: Row[] = [];
  for (const p of pages.filter(p => p.record)) {
    const r = RECORDS.find(x => x.id === p.record)!;
    const a = adj.get(`st:${p.slug}`);
    ds.push({ id: p.slug, split: p.split, slug: p.slug, record: r.id, kind: r.kind, status: a?.decision === 'relabel' ? a.label!.status : r.status, frontmatter_status: r.status_in_frontmatter ? r.status : null, status_in_frontmatter: r.status_in_frontmatter, drafted: r.drafted, signed: r.signed, effective: r.effective, governs: r.status === 'signed', ...agreeOf(`st:${p.slug}`) });
  }
  write('document-status', ds);

  // governing records
  const gr: Row[] = [];
  const recPage = (rid: string) => pages.find(p => p.record === rid)!;
  const passage = (rid: string, attr: Attr, account: string) => {
    const p = recPage(rid);
    const r = RECORDS.find(x => x.id === rid)!;
    const set = r.sets.find(s => s.attr === attr && s.scope.includes(account))!;
    const key = `rv:${p.slug}:${attr}:${set.scope.join('+')}`;
    const it = items.find(i => i.key === key);
    const a = adj.get(key);
    if (r.long && attr === 'notice_days') {
      const t = text(p); const c = longClause(t, set.value as number);
      const line = c && c.index >= 0 ? lineOf(t, c.index + 1) : null;
      return { slug: p.slug, line, quote: line ? t.split('\n')[line - 1].slice(0, 400) : null, chars_into_document: c?.index ?? null, document_chars: t.length, ...agreeOf(`dp:${p.slug}`) };
    }
    const hits = (it?.verifier as any[] | undefined) ?? [];
    const hit = a?.label?.line ? { line: a.label.line } : hits.find((x: any) => sameValue(set.value, x.value));
    const t = text(p);
    const line = hit?.line ? Number(hit.line) : null;
    return { slug: p.slug, line, quote: line ? t.split('\n')[line - 1]?.slice(0, 400) ?? null : null, ...agreeOf(key) };
  };
  for (const acc of ACCOUNTS) {
    const split = SPLIT_OF[acc.cluster];
    for (const attr of ['seats', 'price_per_seat', 'discount_pct', 'renewal_date', 'sla_tier', 'notice_days', 'payment_terms_days'] as Attr[]) {
      const recs = RECORDS.filter(r => r.sets.some(s => s.attr === attr && s.scope.includes(acc.id)));
      if (!recs.length) continue;
      const dates = new Set<string>([TODAY]);
      for (const r of recs) {
        if (r.effective) { dates.add(addDays(r.effective, -1)); dates.add(r.effective); }
        if (r.signed && r.effective && r.signed < r.effective) dates.add(addDays(r.signed, 1));
        if (r.status !== 'signed') dates.add(addDays(r.drafted, 1));
      }
      for (const d of [...dates].sort()) {
        const g = governing(acc.id, attr, d);
        if (!g) continue;
        const traps: string[] = [];
        const signedNotEffective = recs.filter(r => r.status === 'signed' && r.signed && r.signed <= d && r.effective! > d);
        if (signedNotEffective.length) traps.push('future_effective_signed_not_yet_in_force');
        if (recs.some(r => r.status !== 'signed' && r.drafted <= d)) traps.push('draft_or_unsigned_exists');
        if (recs.some(r => r.status === 'signed' && r.effective! <= d && r.id !== g.record.id)) traps.push('superseded_value_exists');
        if (g.record.accounts.length > 1 || recs.some(r => r.sets.some(s => s.attr === attr && s.scope.length === 1 && r.accounts.length === 1) && r.accounts[0] !== g.record.accounts[0])) traps.push('affiliate_or_partial_override');
        if (g.record.long && attr === 'notice_days') traps.push('deep_clause_no_lexical_overlap');
        const latestTouch = recs.filter(r => r.status === 'signed' && r.effective! <= d).sort((a, b) => b.effective!.localeCompare(a.effective!))[0];
        if (latestTouch && latestTouch.id !== g.record.id) traps.push('carried_forward_from_older_record');
        const misstated = CLAIMS.filter(c => c.account === acc.id && c.attr === attr && !c.correct).map(c => pages.find(p => p.claims.includes(c.id))?.slug).filter(Boolean);
        if (misstated.length) traps.push('misstated_elsewhere');
        const distractors = [...recs.filter(r => r.id !== g.record.id).map(r => recPage(r.id).slug), ...misstated];
        gr.push({ id: `${acc.id}:${attr}:${d}`, split, account: acc.id, attribute: attr, as_of: d, value: g.value, governing_record: g.record.id, governing_slug: recPage(g.record.id).slug, signed: g.record.signed, effective: g.record.effective, deciding_passage: passage(g.record.id, attr, acc.id), traps, distractor_slugs: [...new Set(distractors)].sort() });
      }
    }
  }
  write('governing-records', gr);

  // timeline
  const tl: Row[] = [];
  for (const e of EVENTS) {
    const split = e.accounts.length ? SPLIT_OF[accountById(e.accounts[0]).cluster] : 'heldout';
    const evidence = pages.filter(p => p.events.includes(e.id)).filter(p => adj.get(`ev:${p.slug}:${e.id}`)?.decision !== 'drop').map(p => ({ slug: p.slug, ...agreeOf(`ev:${p.slug}:${e.id}`) }));
    if (e.type === 'signing') for (const p of pages.filter(p => p.record && !p.events.includes(e.id))) {
      const r = RECORDS.find(x => x.id === p.record)!;
      if (r.signed === e.date && r.accounts.some(a => e.accounts.includes(a))) evidence.push({ slug: p.slug, ...agreeOf(`rs:${p.slug}`) });
    }
    tl.push({ id: e.id, split, date: e.date, type: e.type, accounts: e.accounts, participants: e.participants, summary: e.summary, evidence });
  }
  for (const h of HANDOFF_CORRECTIONS) {
    const split = h.id.includes('north') ? 'dev' : 'heldout';
    tl.push({ id: `${h.id}:announced-not-happened`, split, date: null, type: 'retracted_announcement', accounts: h.id.includes('north') ? ['tamsin'] : ['vantorre-group'], summary: `Announced but corrected: ${h.announced}. What happened: ${h.corrected}.`, negative_date: h.id.includes('north') ? '2025-10-06' : '2026-04-20', negative_type: 'handoff', evidence: [], negative: true });
  }
  write('timeline', tl);

  // changes / contradictions / compatible pairs + retractions
  const ch: Row[] = [];
  const claimLoc = (cid: string) => {
    const p = pages.find(pp => pp.claims.includes(cid));
    if (!p) return null;
    const it = items.find(i => i.key === `cl:${p.slug}:${cid}`);
    const a = adj.get(`cl:${p.slug}:${cid}`);
    if (a?.decision === 'drop') return null;
    const c = CLAIMS.find(x => x.id === cid)!;
    return { claim: cid, slug: p.slug, line: (it?.verifier as any)?.line ?? null, value: c.value, as_of: c.as_of, correct: c.correct, ...agreeOf(`cl:${p.slug}:${cid}`) };
  };
  const recordClaim = (cid: string) => {
    const c = CLAIMS.find(x => x.id === cid)!;
    const g = c.attr !== 'decision_maker' && c.attr !== 'arr' && c.attr !== 'monthly_fee' && c.attr !== 'renewal_quarter' && c.attr !== 'go_live' && c.attr !== 'site_count' ? governing(c.account, c.attr as Attr, c.as_of) : null;
    return g && sameValue(c.value, g.value) ? { claim: cid, slug: recPage(g.record.id).slug, line: null, value: c.value, as_of: c.as_of, correct: c.correct, source: 'governing record' } : null;
  };
  for (const pr of CLAIM_PAIRS) {
    const a = claimLoc(pr.a) ?? recordClaim(pr.a), b = claimLoc(pr.b) ?? recordClaim(pr.b);
    if (!a || !b) continue;
    const c = CLAIMS.find(x => x.id === pr.a)!;
    ch.push({ id: pr.id, split: SPLIT_OF[accountById(c.account).cluster], kind: 'pair', relation: pr.relation, account: c.account, a, b, note: pr.note });
  }
  for (const rt of RETRACTIONS) {
    const p = pages.find(pp => pp.retraction === rt.id);
    if (!p || adj.get(`rt:${p.slug}`)?.decision === 'drop') continue;
    const t = text(p);
    const lines = [rt.wrong, rt.correct].map(v => { const i = t.indexOf(String(v)); return i >= 0 ? lineOf(t, i) : null; });
    ch.push({ id: rt.id, split: SPLIT_OF[accountById(rt.account).cluster], kind: 'retraction', account: rt.account, attribute: rt.attr, slug: p.slug, retracted_value: rt.wrong, final_value: rt.correct, lines, note: rt.note, ...agreeOf(`rt:${p.slug}`) });
  }
  write('changes', ch);

  // agent tasks
  for (const t of TASKS) for (const s of t.evidence_slugs) if (!bySlug.has(s)) throw new Error(`task ${t.id}: evidence slug ${s} is not a page`);
  write('agent-tasks', TASKS.map(t => ({ ...t }) as Row));

  for (const lane of LANES) {
    const f = (s: string) => join(DATA, 'labels', lane, `${s}.jsonl`);
    counts[lane] = Object.fromEntries(['dev', 'heldout'].map(s => [s, existsSync(f(s)) ? readFileSync(f(s), 'utf8').split('\n').filter(Boolean).length : 0]));
  }
  return counts;
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'compare') {
    const items = compareAll();
    const adj = adjudications();
    const dis = items.filter(i => !i.agree);
    mkdirSync(join(DATA, 'verification'), { recursive: true });
    writeFileSync(join(DATA, 'verification/disagreements.json'), JSON.stringify(dis.map(d => ({ ...d, adjudicated: adj.get(d.key)?.decision ?? null })), null, 2) + '\n');
    const st = stats(items);
    writeFileSync(join(DATA, 'verification/stats.json'), JSON.stringify(st, null, 2) + '\n');
    console.log(JSON.stringify(st, null, 2));
    console.log(`open (unadjudicated): ${dis.filter(d => !adj.has(d.key)).length}`);
  } else if (cmd === 'build') {
    console.log(JSON.stringify(build(), null, 2));
  } else {
    console.error('usage: labels.ts compare | build');
    process.exit(2);
  }
}
