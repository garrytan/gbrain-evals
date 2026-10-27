#!/usr/bin/env bun
/**
 * messy-company-v1 page generation.
 *
 *   bun eval/generators/messy-company/generate.ts plan            # write plan/world.json + plan/pages.json (refuses to change a frozen plan)
 *   bun eval/generators/messy-company/generate.ts pages [--only <slug,...>] [--limit N] [--concurrency N]
 *
 * Needs OPENAI_API_KEY and GEMINI_API_KEY for `pages`. Each page is written by
 * the model its plan names; mechanical checks run on every draft and a failed
 * draft is retried (at most 3 attempts) with the problems listed. Every
 * attempt, prompt and response is kept under raw/author/. LLM output is not
 * reproducible: the committed pages are canonical and this script documents
 * how they were made.
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { call, spent, type ModelId } from './llm.ts';
import { buildPages, type PageSpec } from './pages.ts';
import { AUTHOR_SYSTEM, authorPrompt } from './prompts.ts';
import * as W from './world.ts';

export const DATA = join(import.meta.dir, '../../data/messy-company-v1');
export const LEDGER = join(DATA, 'cost/ledger.jsonl');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function loadPlan(): PageSpec[] {
  return JSON.parse(readFileSync(join(DATA, 'plan/pages.json'), 'utf8')) as PageSpec[];
}

export function worldJson(): string {
  const { WORLD_ID, TODAY, SPLIT_OF, SELF, TEAMS, PEOPLE, ACCOUNTS, OTHERS, STINTS, HANDOFF_CORRECTIONS, RECORDS, EVENTS, CLAIMS, CLAIM_PAIRS, RETRACTIONS } = W;
  return JSON.stringify({ world_id: WORLD_ID, today: TODAY, split_of: SPLIT_OF, self: SELF, teams: TEAMS, people: PEOPLE, accounts: ACCOUNTS, others: OTHERS, stints: STINTS, handoff_corrections: HANDOFF_CORRECTIONS, records: RECORDS, events: EVENTS, claims: CLAIMS, claim_pairs: CLAIM_PAIRS, retractions: RETRACTIONS }, null, 2) + '\n';
}

function writePlan(force: boolean) {
  mkdirSync(join(DATA, 'plan'), { recursive: true });
  const world = worldJson();
  const pages = JSON.stringify(buildPages(), null, 2) + '\n';
  const lock = join(DATA, 'plan/PLAN.sha256');
  const next = `${sha(world)}  world.json\n${sha(pages)}  pages.json\n`;
  if (existsSync(lock) && readFileSync(lock, 'utf8') !== next && !force) {
    console.error('plan is frozen and the generated plan differs; rerun with --force only before any page exists');
    process.exit(1);
  }
  writeFileSync(join(DATA, 'plan/world.json'), world);
  writeFileSync(join(DATA, 'plan/pages.json'), pages);
  writeFileSync(lock, next);
  mkdirSync(join(DATA, 'prompts'), { recursive: true });
  writeFileSync(join(DATA, 'prompts/author-system.md'), AUTHOR_SYSTEM + '\n');
  console.log(next.trim());
}

// ─── Mechanical checks ──────────────────────────────────────────────

export const norm = (s: string) => s.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');

export function findAll(body: string, surface: string): number[] {
  const text = norm(body).toLowerCase();
  const needle = norm(surface).toLowerCase();
  const out: number[] = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const before = text[i - 1] ?? ' ', after = text[i + needle.length] ?? ' ';
    if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
    out.push(i);
  }
  return out;
}

const MONTHS = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|jun(e)?|jul(y)?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b\.?\s*\d/i;
const DATEISH = /\b20\d\d\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|tomorrow|last week|next week)\b/i;

export function longClause(body: string, days: number): { index: number; para: string } | null {
  const paras = body.split(/\n\s*\n/);
  const re = new RegExp(`\\b${days}\\b|${({ 120: 'one hundred twenty', 90: 'ninety' } as Record<number, string>)[days] ?? '@@'}`, 'i');
  let offset = 0;
  const hits: { index: number; para: string }[] = [];
  for (const p of paras) {
    if (re.test(p)) hits.push({ index: offset, para: p });
    offset += p.length + 2;
  }
  return hits.length === 1 ? hits[0] : hits.length > 1 ? { index: -1, para: hits.map(h => h.para).join('\n---\n') } : null;
}

export function checkPage(p: PageSpec, body: string): string[] {
  const problems: string[] = [];
  if (/^\s*---\n/.test(body)) problems.push('Remove the YAML frontmatter; output only the body.');
  if (/^\s*```/.test(body)) problems.push('Do not wrap the document in a code fence.');
  for (const m of p.mentions) {
    const n = findAll(body, m.surface).length;
    if (n === 0) problems.push(`The required phrase "${m.surface}" is missing; include it verbatim exactly once.`);
    if (n > 1) problems.push(`The required phrase "${m.surface}" appears ${n} times; use it exactly once.`);
  }
  for (const a of p.aliases) if (findAll(body, a).length === 0) problems.push(`Use "${a}" at least once.`);
  if (p.date === null) {
    const hit = body.match(MONTHS) ?? body.match(DATEISH);
    if (hit) problems.push(`This page must be undated, but it contains "${hit[0]}". Remove every date, year, month, weekday and relative date.`);
  }
  for (const m of p.mentions.filter(m => m.should_link && !m.should_link_public)) {
    const i = findAll(body, m.surface)[0];
    if (i === undefined) continue;
    const text = norm(body);
    const start = text.lastIndexOf('\n\n', i), end = text.indexOf('\n\n', i);
    const para = text.slice(start < 0 ? 0 : start, end < 0 ? text.length : end);
    for (const acc of m.accounts) for (const al of W.accountById(acc).aliases) {
      if (al.surface.length > 2 && findAll(para, al.surface).length) problems.push(`The paragraph with "${m.surface}" names "${al.surface}"; it must not identify the account.`);
    }
  }
  const rec = p.record ? W.RECORDS.find(r => r.id === p.record) : undefined;
  if (rec?.long) {
    if (body.length < rec.long.min_chars) problems.push(`The agreement is ${body.length} characters; it must be at least ${rec.long.min_chars}.`);
    const days = rec.sets.find(s => s.attr === 'notice_days')!.value as number;
    const c = longClause(body, days);
    if (!c) problems.push(`The ${days}-day rule is missing.`);
    else if (c.index < 0) problems.push(`The number of days (${days}) appears in more than one paragraph; it must appear only in the one rule.`);
    else {
      if (c.index / body.length < 0.55) problems.push(`The ${days}-day rule sits ${Math.round((100 * c.index) / body.length)}% of the way through; move it into an article after article 14, past the middle of the document.`);
      for (const w of rec.long.forbidden_words) if (new RegExp(`\\b${w}`, 'i').test(c.para)) problems.push(`The ${days}-day rule's paragraph uses the word "${w}"; rephrase it without that word.`);
    }
  }
  if (p.retraction) {
    const rt = W.RETRACTIONS.find(r => r.id === p.retraction)!;
    for (const v of [rt.wrong, rt.correct]) {
      const s = String(v);
      const variants = /^\d{4}-\d\d-\d\d$/.test(s) ? [s, s.slice(5)] : [s];
      if (!variants.some(x => body.includes(x)) && !/^\d{4}-/.test(s)) problems.push(`State the value ${s} in the retraction exchange.`);
    }
  }
  return problems;
}

// ─── Page rendering ─────────────────────────────────────────────────

export function frontmatter(p: PageSpec): string {
  const lines = ['---', `title: ${JSON.stringify(p.title)}`, `type: ${p.type}`];
  if (p.date) lines.push(`date: ${p.date}`);
  if (p.status) lines.push(`status: ${p.status}`);
  if (p.visibility) lines.push(`visibility: ${p.visibility}`);
  lines.push('---', '');
  return lines.join('\n');
}

export const pagePath = (p: PageSpec) => join(DATA, 'corpus', p.split, `${p.slug}.md`);
export const rawPath = (kind: 'author' | 'verify', slug: string) => join(DATA, 'raw', kind, `${slug}.json`);

function cleanBody(t: string): string {
  let s = t.replace(/\r\n/g, '\n').trim();
  s = s.replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/i, '$1').trim();
  return s + '\n';
}

async function generateOne(p: PageSpec): Promise<{ ok: boolean; attempts: number }> {
  const out = pagePath(p);
  if (existsSync(out)) return { ok: true, attempts: 0 };
  const rawFile = rawPath('author', p.slug);
  const record = existsSync(rawFile) ? JSON.parse(readFileSync(rawFile, 'utf8')) : { slug: p.slug, model: p.author, system_sha256: sha(AUTHOR_SYSTEM), attempts: [] as unknown[] };
  let feedback: string[] | undefined;
  const isLong = !!(p.record && W.RECORDS.find(r => r.id === p.record)?.long);
  for (let attempt = record.attempts.length + 1; attempt <= 3; attempt++) {
    const user = authorPrompt(p, feedback);
    const res = await call(p.author as ModelId, { system: AUTHOR_SYSTEM, user, maxOutput: isLong ? 24000 : 8000, effort: isLong ? 'medium' : 'low', purpose: 'author', key: p.slug, ledger: LEDGER });
    const body = cleanBody(res.text);
    const problems = checkPage(p, body);
    record.attempts.push({ attempt, model: res.model, prompt_user: user, response_text: res.text, usage: { input_tokens: res.input_tokens, output_tokens: res.output_tokens, thinking_tokens: res.thinking_tokens }, cost_usd: res.cost_usd, provider_meta: res.raw, checks: problems });
    mkdirSync(dirname(rawFile), { recursive: true });
    writeFileSync(rawFile, JSON.stringify(record, null, 2) + '\n');
    if (problems.length === 0) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, frontmatter(p) + body);
      return { ok: true, attempts: attempt };
    }
    feedback = problems;
  }
  return { ok: false, attempts: record.attempts.length };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (k: string) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'plan') writePlan(rest.includes('--force'));
  else if (cmd === 'pages') {
    let pages = loadPlan();
    const only = arg('--only')?.split(',');
    if (only) pages = pages.filter(p => only.includes(p.slug));
    if (arg('--limit')) pages = pages.slice(0, Number(arg('--limit')));
    const conc = Number(arg('--concurrency') ?? 6);
    const byModel = (m: string) => pages.filter(p => p.author === m);
    const failed: string[] = [];
    await Promise.all(['openai:gpt-6.1-sol', 'gemini:gemini-4-argon'].map(m => pool(byModel(m), conc, async p => {
      try {
        const r = await generateOne(p);
        if (!r.ok) failed.push(p.slug);
        console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${p.slug} (${p.author}, attempts ${r.attempts}) spent $${spent(LEDGER).toFixed(2)}`);
      } catch (e) {
        failed.push(p.slug);
        console.log(`ERR  ${p.slug}: ${(e as Error).message}`);
      }
    })));
    console.log(`done; failed ${failed.length}: ${failed.join(', ')}; total spent $${spent(LEDGER).toFixed(2)}`);
  } else {
    console.error('usage: generate.ts plan | pages [--only a,b] [--limit N] [--concurrency N]');
    process.exit(2);
  }
}
