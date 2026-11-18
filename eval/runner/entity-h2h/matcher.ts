/**
 * Entity-resolution head-to-head, LLM matcher baseline: block candidate pairs, then ask a model about each pair.
 *
 * Blocking: two pages are a candidate pair when they share any key: a normalised name token, the surname, an email,
 * an email domain, a LinkedIn URL or a GitHub handle. A key held by more than --max-block pages is dropped as too
 * crowded to block on (recorded). For each pair, one call: "Do these two pages describe the same real-world person or
 * company? Answer yes, no or unsure, then one line of reasons", with both pages in full. `yes` pairs are the auto tier,
 * `unsure` pairs the proposed tier; the scorer closes both transitively.
 *
 * Every call goes through a lease-mode metering proxy (eval/runner/metering-proxy.ts), which holds the keys, prices the
 * request before sending and writes one usage line per call. Each model uses its own proxy slot (matcher-<model>), so
 * the usage log splits by model. No call is resent.
 *
 *   bun eval/runner/entity-h2h/matcher.ts --world DIR --out DIR --usage-log FILE
 *     [--models openai:gpt-6.2-sol,anthropic:claude-opus-5-5,particle:particle-1] [--proxy http://127.0.0.1:8787]
 *     [--seed N] [--concurrency 4] [--max-block 50] [--limit-pairs N] [--blocking-only]
 *
 * --blocking-only prints the pair counts for the smoke world and for people worlds of per-family 5, 10 and 20 (the
 * full 1,380-page world; the generator's name pool runs out before per-family 40), without any model call.
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { asciiFold, generateLedger, parseWrittenPage, renderPage, PERSON_DEDUPE_DEFAULT_SEED, type WrittenPage } from '../../generators/person-dedupe-gen.ts';
import { compatRequest, compatSend, parseCompatResponse } from '../providers/openai-compatible.ts';
import { normalizeUsage, type NormalizedUsage } from '../usage-receipt.ts';
import { loadSmokeWorld, scoreReadout, usageByKey, type Readout } from './world.ts';

export const MATCHER_PROMPT = 'Do these two pages describe the same real-world person or company? Answer yes, no or unsure, then one line of reasons.';
export const DEFAULT_MODELS = ['openai:gpt-6.2-sol', 'anthropic:claude-opus-5-5', 'particle:particle-1'];
const ANTHROPIC_MAX_TOKENS = 4096;
const PROXY_HOLDS_KEY = 'dummy-key-the-proxy-injects-the-real-one';

/** The blocking keys of one page. */
export function blockingKeys(p: WrittenPage, nameTokens = true): string[] {
  const name = asciiFold(p.title).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length > 1);
  const keys = nameTokens ? name.map(t => `name:${t}`) : [];
  if (name.length) keys.push(`surname:${name.at(-1)}`);
  for (const e of p.emails) {
    const email = e.trim().toLowerCase();
    keys.push(`email:${email}`);
    const at = email.lastIndexOf('@');
    if (at > 0) keys.push(`domain:${email.slice(at + 1)}`);
  }
  if (p.linkedin) keys.push(`linkedin:${p.linkedin.toLowerCase()}`);
  if (p.github) keys.push(`github:${p.github.toLowerCase()}`);
  return [...new Set(keys)];
}

export function blockPairs(pages: readonly WrittenPage[], maxBlock = 50, nameTokens = true): { pairs: Array<[string, string]>; crowded: string[] } {
  const blocks = new Map<string, string[]>();
  for (const p of pages) for (const k of blockingKeys(p, nameTokens)) blocks.set(k, [...(blocks.get(k) ?? []), p.key]);
  const seen = new Set<string>(), pairs: Array<[string, string]> = [], crowded: string[] = [];
  for (const [k, members] of blocks) {
    if (members.length > maxBlock) { crowded.push(`${k} (${members.length})`); continue; }
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const [a, b] = [members[i], members[j]].sort();
      const id = `${a}|${b}`;
      if (a !== b && !seen.has(id)) { seen.add(id); pairs.push([a, b]); }
    }
  }
  return { pairs: pairs.sort((x, y) => x.join('|').localeCompare(y.join('|'))), crowded };
}

/** yes, no or unsure from the first word of an answer; null when it opens with none of them. */
export function verdictOf(text: string): 'yes' | 'no' | 'unsure' | null {
  const first = text.trim().replace(/^[^a-zA-Z]+/, '').split(/[^a-zA-Z]/)[0]?.toLowerCase();
  return first === 'yes' || first === 'no' || first === 'unsure' ? first : null;
}

export const pairPrompt = (a: string, b: string) => `${MATCHER_PROMPT}\n\nPage A:\n${a}\n\nPage B:\n${b}`;

interface Answer { text: string; usage: NormalizedUsage | null; model: string | null }

/** One call through the metering proxy's slot for this model. The proxy injects the key; the request carries none. */
export async function ask(model: string, prompt: string, proxy: string, slot: string, fetchImpl: typeof fetch = fetch): Promise<Answer> {
  const base = `${proxy.replace(/\/$/, '')}/${slot}`;
  const [provider, id] = [model.slice(0, model.indexOf(':')), model.slice(model.indexOf(':') + 1)];
  if (provider === 'particle') {
    const req = compatRequest(model, [{ role: 'user', content: prompt }], {}, { PARTICLE_BASE_URL: `${base}/particle/v1`, PARTICLE_API_KEY: PROXY_HOLDS_KEY });
    const r = await compatSend(req, { fetchImpl });
    return { text: r.text, usage: normalizeUsage('openai', r.usage), model: r.response_model };
  }
  const anthropic = provider === 'anthropic';
  if (!anthropic && provider !== 'openai') throw new Error(`matcher: no route for ${model}`);
  const res = await fetchImpl(anthropic ? `${base}/anthropic/v1/messages` : `${base}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(anthropic ? { 'anthropic-version': '2023-06-01', 'x-api-key': PROXY_HOLDS_KEY } : { authorization: `Bearer ${PROXY_HOLDS_KEY}` }) },
    body: JSON.stringify(anthropic ? { model: id, max_tokens: ANTHROPIC_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] } : { model: id, messages: [{ role: 'user', content: prompt }] }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as Record<string, any>;
  if (anthropic) return { text: (json.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(''), usage: normalizeUsage('anthropic', json.usage), model: json.model ?? null };
  const r = parseCompatResponse(json);
  return { text: r.text, usage: normalizeUsage('openai', r.usage), model: r.response_model };
}

const arg = (flag: string) => { const at = process.argv.indexOf(flag); return at >= 0 ? process.argv[at + 1] : undefined; };

async function main(): Promise<void> {
  const seed = Number(arg('--seed') ?? PERSON_DEDUPE_DEFAULT_SEED);
  const maxBlock = Number(arg('--max-block') ?? 50);
  const worldPages = (perFamily: number) => generateLedger(seed, perFamily).pages.map(p => parseWrittenPage(p.source, p.slug, renderPage(p)));
  const scale = Object.fromEntries([5, 10, 20].map(n => {
    const ps = worldPages(n), b = blockPairs(ps, maxBlock), s = blockPairs(ps, maxBlock, false);
    return [`per_family_${n}`, { pages: ps.length, pairs: b.pairs.length, pairs_per_page: b.pairs.length / ps.length, crowded_keys: b.crowded.length, without_given_name_tokens: { pairs: s.pairs.length, pairs_per_page: s.pairs.length / ps.length } }];
  }));
  const { ledger, pages } = loadSmokeWorld(resolve(arg('--world')!), seed);
  const texts = new Map(pages.map(p => [p.key, readFileSync(p.path, 'utf8')]));
  const written = pages.map(p => parseWrittenPage(p.source, p.slug, texts.get(p.key)!));
  const { pairs: allPairs, crowded } = blockPairs(written, maxBlock);
  const pairs = arg('--limit-pairs') ? allPairs.slice(0, Number(arg('--limit-pairs'))) : allPairs;
  const blocking = { smoke: { pages: pages.length, pairs: allPairs.length, pairs_per_page: allPairs.length / pages.length, crowded }, ...scale, max_block: maxBlock };
  console.log(JSON.stringify({ blocking }, null, 2));
  if (process.argv.includes('--blocking-only')) return;

  const out = resolve(arg('--out')!), usageLog = resolve(arg('--usage-log')!), proxy = arg('--proxy') ?? 'http://127.0.0.1:8787';
  const concurrency = Number(arg('--concurrency') ?? 4);
  mkdirSync(out, { recursive: true });
  const summary: Record<string, unknown> = { blocking, prompt: MATCHER_PROMPT, pairs_sent: pairs.length };
  for (const model of (arg('--models') ?? DEFAULT_MODELS.join(',')).split(',')) {
    const slot = `matcher-${model.slice(model.indexOf(':') + 1).replace(/[^a-z0-9.-]/gi, '-')}`;
    const calls = join(out, `${slot}.calls.jsonl`);
    const verdicts = new Map<string, 'yes' | 'no' | 'unsure' | null>();
    const errors: string[] = [];
    let next = 0;
    const started = performance.now();
    const startedAt = new Date().toISOString();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < pairs.length) {
        const [a, b] = pairs[next++];
        const t0 = performance.now();
        try {
          const r = await ask(model, pairPrompt(texts.get(a)!, texts.get(b)!), proxy, slot);
          const v = verdictOf(r.text);
          verdicts.set(`${a}|${b}`, v);
          appendFileSync(calls, JSON.stringify({ a, b, verdict: v, answer: r.text.slice(0, 600), usage: r.usage, response_model: r.model, ms: Math.round(performance.now() - t0) }) + '\n');
        } catch (e) {
          errors.push(`${a}|${b}: ${String((e as Error).message).slice(0, 300)}`);
          appendFileSync(calls, JSON.stringify({ a, b, error: String((e as Error).message).slice(0, 600), ms: Math.round(performance.now() - t0) }) + '\n');
        }
      }
    }));
    const wall = (performance.now() - started) / 1000;
    const tier = (want: string) => [...verdicts].filter(([, v]) => v === want).map(([k]) => k.split('|'));
    const readout: Readout = { system: 'llm-matcher', version: 'entity-h2h matcher v1', config: { blocking: 'name token, surname, email, email domain, linkedin, github', max_block: maxBlock, prompt: MATCHER_PROMPT, reasoning: 'provider default (particle-1: its default effort, high, sent explicitly)' }, model, tiers: { auto: tier('yes'), proposed: tier('unsure') } };
    writeFileSync(join(out, `${slot}.readout.json`), JSON.stringify(readout, null, 2) + '\n');
    const usage = usageByKey(usageLog, k => k === `slot:${slot}`, startedAt).get(`slot:${slot}`) ?? null;
    const score = scoreReadout(ledger, pages, readout);
    const counts = { yes: 0, no: 0, unsure: 0, unparsed: 0 };
    for (const v of verdicts.values()) counts[v ?? 'unparsed']++;
    summary[model] = { slot, calls: verdicts.size, errors, verdicts: counts, wall_s: wall, usage,
      sanity_score: Object.fromEntries(Object.entries(score).map(([t, s]) => [t, { false_merge: s.false_merge, precision: s.precision, recall: s.recall, b3: s.b3 }])) };
    console.log(`${model}: ${verdicts.size} answered, ${errors.length} errors, ${JSON.stringify(counts)}, $${usage?.usd.toFixed(4) ?? '?'}, ${wall.toFixed(0)}s`);
  }
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
}

if (import.meta.main) main().catch(e => { console.error(e); process.exit(1); });
