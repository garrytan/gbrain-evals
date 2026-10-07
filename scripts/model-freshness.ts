#!/usr/bin/env bun
/**
 * Model freshness and price check, run by hand before a paid run (needs provider keys; not in CI).
 *
 *   bun scripts/model-freshness.ts [--models a,b,c]
 *
 * Reads OpenAI's and Anthropic's model lists (free metadata endpoints), finds the newest model of each
 * family the eval rules name (Opus, Sonnet, Fable, GPT), and compares them with the models a run will
 * call (default: the 2026-10 follow-up round's set). Prints a fix command for every problem.
 *
 * Exit 0: every called model is priced and no newer family model exists.
 * Exit 0 with warnings: a newer model of a family exists (never a reason to change a frozen arm).
 * Exit 1: a called model has no price in this repository's ledger or in gbrain's table (blocks the run).
 * Exit 2: a provider's model list could not be read.
 */
import { chatPrice } from '../eval/runner/budget-ledger.ts';

export const ROUND_MODELS = [
  'anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-fable-5-1',
  'openai:gpt-6.1-sol', 'openai:gpt-6-luna', 'openai:gpt-5.4', 'openai:gpt-4o-2024-08-06',
];

export interface ListedModel { provider: 'openai' | 'anthropic'; id: string; created: number }
export type Family = 'opus' | 'sonnet' | 'fable' | 'gpt';

/** Family and version of a model id, or null for ids the rules don't name (mini, luna, dated snapshots, tools). */
export function classify(m: ListedModel): { family: Family; version: number[] } | null {
  if (m.provider === 'anthropic') {
    const hit = /^claude-(opus|sonnet|fable)-(\d+)(?:-(\d{1,2}))?$/.exec(m.id);
    return hit ? { family: hit[1] as Family, version: [Number(hit[2]), Number(hit[3] ?? 0)] } : null;
  }
  const hit = /^gpt-(\d+)(?:\.(\d+))?-(sol|astra)$/.exec(m.id) ?? /^gpt-(\d+)(?:\.(\d+))?$/.exec(m.id);
  return hit ? { family: 'gpt', version: [Number(hit[1]), Number(hit[2] ?? 0)] } : null;
}

const cmp = (a: number[], b: number[]) => (a[0]! - b[0]!) || (a[1]! - b[1]!);

/** Newest id per family by version, then by provider creation time. */
export function newestByFamily(models: ListedModel[]): Record<Family, string | null> {
  const best: Record<Family, { id: string; version: number[]; created: number } | null> = { opus: null, sonnet: null, fable: null, gpt: null };
  for (const m of models) {
    const c = classify(m);
    if (!c) continue;
    const cur = best[c.family];
    if (!cur || cmp(c.version, cur.version) > 0 || (cmp(c.version, cur.version) === 0 && m.created > cur.created)) best[c.family] = { id: m.id, version: c.version, created: m.created };
  }
  return { opus: best.opus?.id ?? null, sonnet: best.sonnet?.id ?? null, fable: best.fable?.id ?? null, gpt: best.gpt?.id ?? null };
}

export interface FreshnessReport { warnings: string[]; blocking: string[] }

export function assess(called: string[], listed: ListedModel[], priced: (id: string) => boolean): FreshnessReport {
  const warnings: string[] = [];
  const blocking: string[] = [];
  const newest = newestByFamily(listed);
  const calledIds = new Set(called.map(c => c.split(':').pop()!));
  for (const [family, id] of Object.entries(newest)) {
    if (id && !calledIds.has(id)) warnings.push(`newer ${family} model listed: ${id} (not in this run's models; add it at the next preregistration, never to a frozen arm)`);
  }
  for (const c of called) {
    if (!priced(c)) blocking.push(`${c} has no price: register it in CHAT_PRICE_OVERRIDES in eval/runner/budget-ledger.ts (and pass --price-input/--price-output to harnesses that read gbrain's table), with the provider's pricing page as the source`);
  }
  return { warnings, blocking };
}

async function listModels(): Promise<ListedModel[]> {
  const out: ListedModel[] = [];
  const oa = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` } });
  if (!oa.ok) throw new Error(`OpenAI model list: HTTP ${oa.status}`);
  for (const m of ((await oa.json()) as { data: Array<{ id: string; created: number }> }).data) out.push({ provider: 'openai', id: m.id, created: m.created });
  const an = await fetch('https://api.anthropic.com/v1/models?limit=1000', { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-version': '2023-06-01' } });
  if (!an.ok) throw new Error(`Anthropic model list: HTTP ${an.status}`);
  for (const m of ((await an.json()) as { data: Array<{ id: string; created_at: string }> }).data) out.push({ provider: 'anthropic', id: m.id, created: Date.parse(m.created_at) / 1000 });
  return out;
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--models');
  const called = flag > 0 ? process.argv[flag + 1]!.split(',') : ROUND_MODELS;
  let listed: ListedModel[];
  try {
    listed = await listModels();
  } catch (e) {
    console.error(`model-freshness: ${(e as Error).message}; check the provider key and retry`);
    process.exit(2);
  }
  const priced = (id: string) => chatPrice(id) !== undefined;
  const report = assess(called, listed, priced);
  for (const w of report.warnings) console.log(`warning: ${w}`);
  for (const b of report.blocking) console.error(`blocking: ${b}`);
  console.log(JSON.stringify({ newest: newestByFamily(listed), called, ...report }, null, 2));
  process.exit(report.blocking.length ? 1 : 0);
}
