/**
 * Rebuild the memory proof wave's cell ledger from measured usage.
 *
 *   bun eval/runner/harness-ledger.ts --plan eval/harness-provider/ledger/plan.json \
 *     --inputs eval/harness-provider/ledger/inputs.json --cells-dir eval/reports/harness-cells \
 *     --out eval/harness-provider/ledger/ledger.json --md eval/harness-provider/LEDGER.md
 *
 * Rates come from the paid acceptance cells' proxy logs (tokens per stage,
 * per model), never from guesses, except where a line says "assumed". Each
 * plan item is questions x systems x targets x readers (+ ingest per system),
 * priced at list prices from eval/runner/budget-ledger.ts.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatPrice, embeddingPrice } from './harness-cell.ts';

export interface StageUsage { requests: number; input_tokens: number; output_tokens: number; usd: number }

export interface MeasuredCell {
  cell_id: string;
  provider: string;
  answer_model: string;
  questions: number;
  document_tokens_cl100k: number;
  target: number | null;
  delivered_mean: number;
  stages: Record<string, Record<string, StageUsage>>; // stage -> model -> usage
  total_usd: number;
}

/** Aggregate a cell's proxy log by stage (from the request tag) and model. */
export function measureCell(dir: string): MeasuredCell {
  const cell = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const stages: MeasuredCell['stages'] = {};
  let total = 0;
  for (const line of readFileSync(join(dir, 'proxy/requests.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const stage = r.tag ? String(r.tag).split('/')[1] : r.label === 'harness' ? 'other' : 'ingest';
    const key = `${r.provider}:${r.model}`;
    const s = ((stages[stage] ??= {})[key] ??= { requests: 0, input_tokens: 0, output_tokens: 0, usd: 0 });
    s.requests++; s.input_tokens += r.input_tokens ?? 0; s.output_tokens += r.output_tokens ?? 0; s.usd += r.actual_usd ?? 0;
    total += r.actual_usd ?? 0;
  }
  return {
    cell_id: cell.cell_id, provider: cell.spec.provider, answer_model: cell.spec.models.answer, questions: cell.resolved.questions,
    document_tokens_cl100k: cell.resolved.document_tokens_cl100k, target: cell.spec.target_tokens,
    delivered_mean: summary.delivered_context.mean, stages, total_usd: total,
  };
}

export interface Rates {
  /** Reader input tokens per cl100k token of prompt (delivered context plus template), by reader: the provider tokenizer and request framing. */
  reader_input_ratio: Record<string, number>;
  /** Answer output tokens per question, by reader. */
  answer_output_tokens: Record<string, number>;
  judge_in_per_call: number;
  judge_out_per_call: number;
  /** gbrain embedding tokens per cl100k document token (provider tokenizer, chunking). */
  gbrain_embed_ratio: number;
  gbrain_embedding_model: string;
  /** Comparator extraction tokens per cl100k document token, or null when not measured. */
  comparator_ingest: { model: string; in_ratio: number; out_ratio: number; measured: boolean } | null;
  /** cl100k prompt-template tokens around the context in the measured cells' final prompts. */
  measured_prompt_overhead_cl100k?: number;
  sources: string[];
}

export function deriveRates(cells: MeasuredCell[], fallback: Partial<Rates>): Rates {
  const sources: string[] = [];
  const outputs: Record<string, number> = {};
  const ratio: Record<string, number> = {};
  const promptOverhead = fallback.measured_prompt_overhead_cl100k ?? 277;
  let jIn = 0, jOut = 0, jCalls = 0, embTok = 0, embDoc = 0, embModel = '';
  let comparator: Rates['comparator_ingest'] = null;
  for (const c of cells) {
    sources.push(c.cell_id);
    for (const [model, u] of Object.entries(c.stages.answer ?? {})) {
      outputs[model] = u.output_tokens / Math.max(1, u.requests);
      ratio[model] = (u.input_tokens / Math.max(1, u.requests)) / (c.delivered_mean + promptOverhead);
    }
    for (const u of Object.values(c.stages.judge ?? {})) { jIn += u.input_tokens; jOut += u.output_tokens; jCalls += u.requests; }
    if (c.provider === 'gbrain') {
      for (const [model, u] of Object.entries(c.stages.ingest ?? {})) { embTok += u.input_tokens; embDoc += c.document_tokens_cl100k; embModel = model; }
    }
    if (c.provider === 'comparator') {
      const chat = Object.entries(c.stages.ingest ?? {}).filter(([m]) => !/embed|voyage/.test(m));
      const inTok = chat.reduce((s, [, u]) => s + u.input_tokens, 0);
      const outTok = chat.reduce((s, [, u]) => s + u.output_tokens, 0);
      if (chat.length) comparator = { model: chat[0][0], in_ratio: inTok / c.document_tokens_cl100k, out_ratio: outTok / c.document_tokens_cl100k, measured: true };
    }
  }
  return {
    reader_input_ratio: { ...(fallback.reader_input_ratio ?? {}), ...ratio },
    measured_prompt_overhead_cl100k: promptOverhead,
    answer_output_tokens: { ...(fallback.answer_output_tokens ?? {}), ...outputs },
    judge_in_per_call: jCalls ? jIn / jCalls : fallback.judge_in_per_call ?? 1200,
    judge_out_per_call: jCalls ? jOut / jCalls : fallback.judge_out_per_call ?? 300,
    gbrain_embed_ratio: embDoc ? embTok / embDoc : fallback.gbrain_embed_ratio ?? 1.4,
    gbrain_embedding_model: embModel ? `voyage:${embModel.split(':').pop()}` : fallback.gbrain_embedding_model ?? 'voyage:voyage-4',
    comparator_ingest: comparator ?? fallback.comparator_ingest ?? null,
    sources,
  };
}

export interface PlanItem {
  line: number;
  name: string;
  /** Dataset split keys from the inputs file and the fraction of each used. */
  data: Array<{ split: string; fraction: number }>;
  systems: Array<'gbrain' | 'comparator'>;
  targets: number[];
  readers: string[];
  /** Answer calls per question (agentic modes make several). */
  calls_per_question?: number;
  /** Whether this item ingests (false when it reuses another item's stores). */
  ingest?: boolean;
  /** gbrain write-time LLM extraction (facts lanes) priced like the comparator's extraction. */
  gbrain_extraction?: boolean;
  repeats?: number;
  /** Only the judge runs (a joint re-judge of answers that already exist). */
  judge_only?: boolean;
  /** A fixed dollar figure for work this lane cannot measure (e.g. the coding-agent benchmark). */
  fixed_usd?: number;
  /** Reader input tokens given directly (B suites report their own volumes). */
  reader_input_tokens?: number;
  reader_output_tokens_per_call?: number;
  reader_calls?: number;
  note?: string;
}

export interface Inputs { [split: string]: { questions: number; units: number; document_tokens_cl100k: number; task_type: string; judge_calls: number } }

export const EXTRA_PRICES: Record<string, { input: number; output: number }> = {};

const price = (model: string) => {
  const p = chatPrice(model) ?? EXTRA_PRICES[model];
  if (!p) throw new Error(`no list price for ${model}; register it in eval/runner/budget-ledger.ts before pricing the ledger`);
  return p;
};

export function priceItem(item: PlanItem, inputs: Inputs, rates: Rates, judgeModels: Record<string, string>, promptOverhead: Record<string, number> = {}) {
  if (item.fixed_usd !== undefined) return { usd: item.fixed_usd, parts: { fixed: item.fixed_usd } };
  const parts: Record<string, number> = {};
  const add = (k: string, v: number) => { parts[k] = (parts[k] ?? 0) + v; };
  const repeats = item.repeats ?? 1;
  if (item.reader_input_tokens !== undefined) {
    for (const reader of item.readers) {
      const p = price(reader);
      add(`answer ${reader}`, (item.reader_input_tokens * p.input + (item.reader_calls ?? 0) * (item.reader_output_tokens_per_call ?? 0) * p.output) / 1e6);
    }
  }
  for (const d of item.data) {
    const inp = inputs[d.split];
    if (!inp) throw new Error(`no ledger inputs for ${d.split}`);
    const questions = inp.questions * d.fraction;
    const docTokens = inp.document_tokens_cl100k * d.fraction;
    for (const system of item.systems) {
      if (item.ingest !== false && !item.judge_only) {
        if (system === 'gbrain') {
          const e = embeddingPrice(rates.gbrain_embedding_model) ?? 0;
          add('ingest gbrain embeddings', docTokens * rates.gbrain_embed_ratio * e / 1e6);
        }
        const extraction = system === 'comparator' || item.gbrain_extraction;
        if (extraction) {
          const ci = rates.comparator_ingest;
          if (!ci) throw new Error('comparator ingest rate is not measured and no fallback was given');
          const p = price(ci.model);
          add(`ingest ${system} extraction`, docTokens * (ci.in_ratio * p.input + ci.out_ratio * p.output) / 1e6);
        }
      }
      for (const target of item.targets) {
        for (const reader of item.judge_only ? ['(judge only)'] : item.readers) {
          if (!item.judge_only) {
          const p = price(reader);
          const calls = questions * (item.calls_per_question ?? 1);
          const out = rates.answer_output_tokens[reader];
          const r = rates.reader_input_ratio[reader];
          if (out === undefined || r === undefined) throw new Error(`no measured usage for reader ${reader}`);
          const overhead = promptOverhead[d.split.split(':')[0]] ?? promptOverhead.default ?? 300;
          add(`answer ${reader}`, calls * (r * (target + overhead) * p.input + out * p.output) / 1e6);
          }
          if (inp.task_type === 'open') {
            const judge = judgeModels[d.split.split(':')[0]] ?? judgeModels.default;
            const jp = price(judge);
            const jcalls = inp.judge_calls * d.fraction;
            add(`judge ${judge}`, jcalls * (rates.judge_in_per_call * jp.input + rates.judge_out_per_call * jp.output) / 1e6);
          }
        }
      }
    }
  }
  for (const k of Object.keys(parts)) parts[k] *= repeats;
  return { usd: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const plan = JSON.parse(readFileSync(flag('--plan')!, 'utf8')) as { cap_usd: number; spent_usd: number; judge_models: Record<string, string>; prompt_overhead_cl100k: Record<string, number>; fallback_rates: Partial<Rates>; cells: string[]; items: PlanItem[]; reader_alternatives: string[]; primary_reader: string };
  const inputs = JSON.parse(readFileSync(flag('--inputs')!, 'utf8')) as Inputs;
  Object.assign(EXTRA_PRICES, (plan as { extra_prices?: Record<string, { input: number; output: number }> }).extra_prices ?? {});
  const cellsDir = flag('--cells-dir') ?? 'eval/reports/harness-cells';
  const measured = plan.cells.filter(id => existsSync(join(cellsDir, id, 'summary.json'))).map(id => measureCell(join(cellsDir, id)));
  const rates = deriveRates(measured, plan.fallback_rates);
  const rows = plan.items.map(item => ({ ...item, ...priceItem(item, inputs, rates, plan.judge_models, plan.prompt_overhead_cl100k) }));
  const total = rows.reduce((s, r) => s + r.usd, 0) + plan.spent_usd;
  const alternatives = plan.reader_alternatives.map(reader => {
    const swapped = plan.items.map(it => it.readers.includes(plan.primary_reader) ? { ...it, readers: it.readers.map(r => r === plan.primary_reader ? reader : r) } : it);
    return { reader, total_usd: swapped.reduce((s, it) => s + priceItem(it, inputs, rates, plan.judge_models, plan.prompt_overhead_cl100k).usd, 0) + plan.spent_usd };
  });
  const out = { generated_at: new Date().toISOString(), cap_usd: plan.cap_usd, spent_usd: plan.spent_usd, total_usd: total, within_cap: total <= plan.cap_usd, rates, measured, rows, alternatives };
  writeFileSync(flag('--out')!, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify({ total_usd: Number(total.toFixed(2)), cap_usd: plan.cap_usd, within_cap: out.within_cap, lines: rows.map(r => [r.line, r.name, Number(r.usd.toFixed(2))]), alternatives: alternatives.map(a => [a.reader, Number(a.total_usd.toFixed(2))]) }, null, 1));
}
