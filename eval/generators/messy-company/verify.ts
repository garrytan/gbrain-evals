#!/usr/bin/env bun
/**
 * messy-company-v1 cross-model verification.
 *
 *   bun eval/generators/messy-company/verify.ts run [--only a,b] [--concurrency N]
 *   bun eval/generators/messy-company/verify.ts compare     # writes verification/disagreements.json
 *
 * Every page is checked by the model that did NOT write it. The verifier sees
 * the page with line numbers, a reference sheet about the world (people,
 * accounts, names and codes, ownership history) and neutral questions built
 * from the planned labels. It never sees a gold answer. `compare` diffs the
 * answers against the planned labels; each disagreement is then adjudicated
 * by reading the text, and the decision is recorded in
 * verification/adjudications.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { DATA, LEDGER, findAll, loadPlan, norm, pagePath, rawPath } from './generate.ts';
import { call, spent, type ModelId } from './llm.ts';
import type { PageSpec } from './pages.ts';
import { VERIFY_SYSTEM } from './prompts.ts';
import { ACCOUNTS, CLAIMS, EVENTS, OTHERS, PEOPLE, RECORDS, RETRACTIONS, STINTS, TEAMS, accountById, personById } from './world.ts';

const other = (m: string): ModelId => (m === 'openai:gpt-6.1-sol' ? 'gemini:gemini-4-argon' : 'openai:gpt-6.1-sol');

export function entityTable(split: string) {
  const rows: { id: string; name: string; kind: string; surfaces: { surface: string; kind?: string; note?: string; valid_from?: string; valid_to?: string; collides_with?: string[] }[] }[] = [];
  for (const a of ACCOUNTS) if ((a.cluster === 'north' || a.cluster === 'central') === (split === 'dev')) rows.push({ id: a.id, name: a.name, kind: 'customer account', surfaces: a.aliases });
  for (const o of OTHERS) if (o.kind !== 'self' && (o.split === 'both' || o.split === split)) rows.push({ id: o.id, name: o.name, kind: o.kind, surfaces: o.aliases.map(a => ({ ...a })) });
  return rows;
}

export function referenceSheet(p: PageSpec): string {
  const ents = entityTable(p.split);
  const accts = ACCOUNTS.filter(a => a.cluster === p.cluster || ents.some(e => e.id === a.id));
  const stints = STINTS.filter(s => accts.some(a => a.id === s.account));
  const who = (id: string) => id.startsWith('team-') ? `${TEAMS.find(t => t.id === id)!.name} (pooled team account)` : personById(id).name;
  return [
    'COMPANIES (id: name; kind; descriptors; region; names and codes people use):',
    ...ents.map(e => {
      const a = ACCOUNTS.find(x => x.id === e.id);
      const extra = a ? `; ${a.industry}; descriptors: ${a.descriptors.join(', ')}; region: ${a.region}${a.parent ? `; subsidiary of ${a.parent}` : ''}${a.renamed ? `; renamed ${a.renamed.former} -> ${a.renamed.to} on ${a.renamed.on}` : ''}` : '';
      return `- ${e.id}: ${e.name}; ${e.kind}${extra}; surfaces: ${e.surfaces.map(s => `"${s.surface}"${s.valid_from ? ` (from ${s.valid_from})` : ''}${s.valid_to ? ` (until ${s.valid_to})` : ''}`).join(', ')}`;
    }),
    '', 'PEOPLE:', ...PEOPLE.map(x => `- ${x.name} (${x.first}): ${x.role}${x.kind === 'contact' ? ` at ${accountById(x.org).name}` : ''}`),
    '', 'OWNERSHIP HISTORY (start inclusive, end exclusive; "?" = not recorded; open = still running). Roles: primary owner, team (pooled), acting (temporary cover; the primary stays owner of record), overlap (an informal period a belated note reports):',
    ...stints.map(s => `- ${s.account}: ${who(s.owner)}, ${s.role}, ${s.start ?? '?'} to ${s.end ?? 'open'}`),
  ].join('\n');
}

function numbered(text: string): string {
  return text.split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');
}

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

export interface EntityOcc { oid: string; surface: string; line: number }

/** Every occurrence of every known company surface (longest match wins). */
export function entityOccurrences(p: PageSpec, text: string): EntityOcc[] {
  const ents = entityTable(p.split);
  const surfaces = [...new Set(ents.flatMap(e => e.surfaces.map(s => s.surface)))].sort((a, b) => b.length - a.length);
  const taken: [number, number][] = [];
  const out: { i: number; surface: string }[] = [];
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, m => ' '.repeat(m.length));
  for (const s of surfaces) {
    const caseSensitive = s.length <= 4;
    for (const i of findAll(body, s)) {
      if (caseSensitive && norm(body).slice(i, i + s.length) !== norm(s)) continue;
      if (taken.some(([a, b]) => i < b && i + s.length > a)) continue;
      taken.push([i, i + s.length]);
      out.push({ i, surface: s });
    }
  }
  out.sort((a, b) => a.i - b.i);
  return out.map((o, k) => ({ oid: `e${k + 1}`, surface: o.surface, line: lineOf(text, o.i) }));
}

function questions(p: PageSpec, text: string) {
  const q: Record<string, unknown> = {};
  const date = p.date ?? 'none (undated page)';
  q.page_date = date;
  q.owner_phrases = p.mentions.map(m => ({ mid: m.mid, phrase: m.surface, lines: findAll(text, m.surface).map(i => lineOf(text, i)) }));
  q.entity_occurrences = entityOccurrences(p, text);
  q.claims = p.claims.map(cid => { const c = CLAIMS.find(x => x.id === cid)!; return { cid, question: `What does the page say about ${accountById(c.account).name}'s ${c.attr.replace(/_/g, ' ')}?` }; });
  q.events = p.events.map(eid => { const e = EVENTS.find(x => x.id === eid)!; return { eid, question: `Does the page describe this: "${e.summary}"? If so, on what date does the text place it?` }; });
  q.ownership = [...new Set(p.states_stints.map(id => STINTS.find(s => s.id === id)!.account))].map(acc => ({ account: acc, question: `According to this page alone, who manages ${accountById(acc).name}, in what role, and from/until when?` }));
  if (p.record) {
    const r = RECORDS.find(x => x.id === p.record)!;
    q.record = { question: 'Is this document signed, an unsigned version, or a draft? Judge from the body text, not the title alone. Give its signed date and effective date if stated, and the value of each of these terms it sets.', terms: [...new Set(r.sets.map(s => s.attr))], ...(r.long ? { deciding_question: 'Which line states how many days ahead a party must act so that the agreement does not continue into another period, and how many days?' } : {}) };
  }
  if (p.retraction) {
    const rt = RETRACTIONS.find(x => x.id === p.retraction)!;
    q.retraction = { question: `A value for ${accountById(rt.account).name}'s ${rt.attr.replace(/_/g, ' ')} is stated and then corrected. What was first stated, what was the corrected value, and on which lines?` };
  }
  return q;
}

const SHAPE = `Return JSON with exactly these keys (omit sections that have no questions):
{
  "date_used": "YYYY-MM-DD or null: the date the text is about. If the body says the events happened on a different date than page_date, use the body's date.",
  "owner_phrases": [{"mid": "...", "refers_to_customer_account": true|false, "accounts": ["account id", ...], "reading": "names the account(s) via who owns/covers/used to own them" | "ambiguous: could be more than one account" | "no account matches" | "not about a customer account (a login, device, HR/expense account, a narrative 'account of', a vendor relationship, an employer)" , "note": "short reason"}],
  "extra_owner_phrases": [{"line": n, "phrase": "...", "accounts": ["..."], "note": "..."}],
  "entities": [{"oid": "...", "entity": "entity id from COMPANIES, or none", "note": "only when unsure"}],
  "claims": [{"cid": "...", "stated": true|false, "value": "as stated", "line": n}],
  "events": [{"eid": "...", "present": true|false, "date": "YYYY-MM-DD or null", "line": n}],
  "ownership": [{"account": "...", "owner": "name or team or null", "role": "primary|acting|team|overlap|unclear", "start": "YYYY-MM-DD or null", "end": "YYYY-MM-DD or null", "line": n}],
  "record": {"status": "signed|unsigned|draft", "status_evidence_line": n, "signed_date": "YYYY-MM-DD or null", "effective_date": "YYYY-MM-DD or null", "terms": [{"term": "...", "applies_to": ["account id"], "value": "...", "line": n}], "deciding_line": n, "deciding_days": n},
  "retraction": {"first_value": "...", "corrected_value": "...", "lines": [n]}
}
For owner_phrases: decide what the phrase refers to on date_used, using the OWNERSHIP HISTORY and company descriptors in the reference sheet together with the page text. A phrase that fits two accounts the person owned on that date, with nothing on the page to pick one, is ambiguous: refers_to_customer_account=false and accounts=[]. A phrase about the person's own login, laptop, HR or expense account, or a narrative ("her account of the meeting") is not about a customer account. A contact's employer ("Thea's company") does refer to that customer account.
For extra_owner_phrases: list any OTHER phrase on the page that refers to a customer account through a person or team (possessives such as "X's account/customer/client/renewal", "the account X runs", "her biggest customer"), excluding the ones in owner_phrases. Use [] if none.`;

async function verifyOne(p: PageSpec): Promise<boolean> {
  const out = rawPath('verify', p.slug);
  if (existsSync(out)) return true;
  const file = pagePath(p);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const qs = questions(p, text);
  const user = ['REFERENCE SHEET', referenceSheet(p), '', 'PAGE (line-numbered; frontmatter included)', numbered(text), '', 'QUESTIONS', JSON.stringify(qs, null, 2), '', SHAPE].join('\n');
  const model = other(p.author);
  const res = await call(model, { system: VERIFY_SYSTEM, user, json: true, maxOutput: 12000, effort: 'medium', purpose: 'verify', key: p.slug, ledger: LEDGER });
  let parsed: unknown = null;
  try { parsed = JSON.parse(res.text.replace(/^```json\s*|\s*```$/g, '')); } catch { parsed = null; }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ slug: p.slug, author: p.author, verifier: model, questions: qs, prompt_user_sha256: new Bun.CryptoHasher('sha256').update(user).digest('hex'), response_text: res.text, parsed, usage: { input_tokens: res.input_tokens, output_tokens: res.output_tokens, thinking_tokens: res.thinking_tokens }, cost_usd: res.cost_usd }, null, 2) + '\n');
  return parsed !== null;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'run') {
    let pages = loadPlan();
    const only = arg('--only')?.split(',');
    if (only) pages = pages.filter(p => only.includes(p.slug));
    mkdirSync(join(DATA, 'prompts'), { recursive: true });
    writeFileSync(join(DATA, 'prompts/verify-system.md'), VERIFY_SYSTEM + '\n\n' + SHAPE + '\n');
    const conc = Number(arg('--concurrency') ?? 6);
    const failed: string[] = [];
    await Promise.all(['openai:gpt-6.1-sol', 'gemini:gemini-4-argon'].map(m => pool(pages.filter(p => other(p.author) === m), conc, async p => {
      try { if (!(await verifyOne(p))) failed.push(p.slug); } catch (e) { failed.push(p.slug); console.log(`ERR ${p.slug}: ${(e as Error).message}`); }
    })));
    console.log(`verify done; failed ${failed.length}: ${failed.join(', ')}; spent $${spent(LEDGER).toFixed(2)}`);
  } else {
    console.error('usage: verify.ts run [--only a,b] [--concurrency N]');
    process.exit(2);
  }
}
