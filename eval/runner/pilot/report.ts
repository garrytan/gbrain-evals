/**
 * The wave 1 pilot table ($0): every cell's supported task success, outcome-v3
 * categories, dollars, tokens, discordance against A0 on the same reader, and
 * the timing cohort's synchronous latency, from the driver's state files.
 */
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { percentile } from '../metrics.ts';
import { axesFromJudged, category, summarize, HEDGE_AXIS, type OutcomeAxes } from '../outcomes/v3.ts';
import { BUDGETS, CHEAP, FRONTIER, OPUS, cellId, escalate, listUsd, qualityCells, type Reader } from './cells.ts';
import { loadPilotEvidence, pilotSplit } from './evidence.ts';
import { labelOf, LABEL_MODEL, STATE_DIR, type BuildRec, type JudgeRec, type ReadRec, type stores } from './run.ts';
import { readNdjson } from '../batch/sources.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null, d = 4) => (x === null ? null : Number(x.toFixed(d)));

export interface CellRow {
  cell: string; n: number; correct: number; accuracy: number;
  committed_wrong: number; committed_wrong_bound: number; abstained: number; execution_errors: number; hedged_wrong: number | null; unlabeled_wrong: number;
  usd_per_q: number; reader_usd_per_q: number; builder_usd_per_q: number; fallback_usd_per_q: number; escalation_rate: number | null;
  reader_input_tokens: number | null; reader_output_tokens: number | null; delivered_cl100k: number | null;
  builder_input_tokens: number | null; builder_output_tokens: number | null;
  discordance_vs_a0: { a0_right_arm_wrong: number; a0_wrong_arm_right: number } | null;
  over_budget: number | null; brief_fallbacks: number | null;
  digest_write_usd_per_q: number | null;
  p50_ms: number | null; p95_ms: number | null; p95_cold_ms: number | null; p95_hit_ms: number | null; timing_n: number;
}

interface PerQ { id: string; verdict: boolean | null; error: string | null; text: string; usd: number; readerUsd: number; builderUsd: number; fallbackUsd: number; escalated: boolean | null; rin: number | null; rout: number | null; delivered: number | null; bin: number | null; bout: number | null; overBudget: boolean | null; fellBack: boolean | null; digestWrite: number | null }

export async function buildReport(s: ReturnType<typeof stores>, identity: Record<string, unknown>, opts: { stateDir?: string; ids?: string[] } = {}) {
  const ev = loadPilotEvidence();
  const ids = opts.ids ?? pilotSplit().pilot;
  const read = (cell: string, id: string) => s.reads.get(`${cell}|${id}`);
  const judge = (cell: string, id: string) => s.judges.get(`${cell}|${id}`);
  const labelUsd = (text: string) => labelOf(s, text)?.usd ?? 0;
  const haystack = JSON.parse(readFileSync(join(ROOT, 'docs/benchmarks/2026-10-06-longmemeval-w10-manifests/w10c-sol-full.meta.json'), 'utf8')) as Record<string, { sessions: number; chars: number }>;
  const builds = new Map(s.builds.values().map(b => [b.key, b]));

  const perQuestion = (cell: string): PerQ[] | null => {
    const [kind] = cell.split(/[@:]/);
    if (kind === 'fallback') {
      const [cheap, reader] = cell.slice('fallback:'.length).split('>');
      return ids.map(id => {
        const c = read(cellId.direct(cheap as any), id), f = read(cellId.a0(reader as Reader), id);
        if (!c || !f) return null as unknown as PerQ;
        const label = c.error ? null : labelOf(s, c.text)?.label ?? null;
        const up = escalate({ error: c.error, label });
        const pick = up ? f : c;
        const pickJ = up ? judge(f.cell, id) : judge(c.cell, id);
        const lu = c.error ? 0 : labelUsd(c.text);
        return { id, verdict: pickJ?.verdict ?? null, error: pick.error ?? (pickJ ? pickJ.error === 'reader_error' ? pick.error : pickJ.error : 'not_judged'), text: pick.text, usd: c.usd + lu + (up ? f.usd : 0), readerUsd: c.usd, builderUsd: 0, fallbackUsd: lu + (up ? f.usd : 0), escalated: up, rin: (c.usage?.input_total ?? 0) + (up ? f.usage?.input_total ?? 0 : 0), rout: (c.usage?.output_total ?? 0) + (up ? f.usage?.output_total ?? 0 : 0), delivered: c.delivered_cl100k, bin: null, bout: null, overBudget: null, fellBack: null, digestWrite: null };
      });
    }
    const src = kind === 'cache' ? cellId.a0(cell.slice('cache:'.length) as Reader) : cell;
    return ids.map(id => {
      const r = read(src, id), j = judge(src, id);
      if (!r) return null as unknown as PerQ;
      const builderUsd = Number(r.meta?.builder_usd ?? 0);
      let bin: number | null = null, bout: number | null = null, digestWrite: number | null = null;
      if (kind === 'brief') {
        const b = builds.get(`brief@${cell.split('@')[1].split(':')[0]}:${cell.split(':')[1]}:${id}`);
        bin = b?.usage?.input_total ?? null; bout = b?.usage?.output_total ?? null;
      }
      if (kind === 'digest') {
        const budget = Number(cell.split('@')[1].split(':')[0]);
        const builder = cell.split(':')[1];
        const q = ev.get(id)!;
        const recs = q.sessions.map(x => [...builds.values()].find(b => b.kind === 'digest' && b.builder === builder && b.budget === Math.floor(budget / 5) && b.session_id === x.session_id)).filter((b): b is BuildRec => !!b);
        bin = recs.reduce((a, b) => a + (b.usage?.input_total ?? 0), 0); bout = recs.reduce((a, b) => a + (b.usage?.output_total ?? 0), 0);
        const hs = haystack[id];
        const retrievedChars = q.sessions.reduce((a, x) => a + x.body.length, 0);
        const inUsd = recs.reduce((a, b) => a + (b.usage ? listUsd(builder, { ...b.usage, output_total: 0 }) : 0), 0);
        const outUsd = recs.reduce((a, b) => a + b.usd, 0) - inUsd;
        digestWrite = hs && recs.length ? inUsd * (hs.chars / Math.max(1, retrievedChars)) + (outUsd / recs.length) * hs.sessions : null;
      }
      return { id, verdict: j?.verdict ?? null, error: r.error ?? (j ? (j.error === 'reader_error' ? r.error : j.error) : 'not_judged'), text: r.text, usd: r.usd + builderUsd, readerUsd: r.usd, builderUsd, fallbackUsd: 0, escalated: null, rin: r.usage?.input_total ?? null, rout: r.usage?.output_total ?? null, delivered: r.delivered_cl100k, bin, bout, overBudget: typeof r.meta?.over_budget === 'boolean' ? r.meta.over_budget as boolean : null, fellBack: kind === 'brief' ? r.meta?.mode === 'fallback_full_text' : null, digestWrite };
    });
  };

  const timing = existsSync(join(opts.stateDir ?? STATE_DIR, 'cohort.ndjson')) ? readNdjson(join(opts.stateDir ?? STATE_DIR, 'cohort.ndjson')) : [];
  const cells = [...qualityCells(), ...[...new Set(s.reads.values().map(r => r.cell).filter(c => c.endsWith(OPUS)))].sort((a, b) => Number(b.startsWith('a0:')) - Number(a.startsWith('a0:')) || a.localeCompare(b))];
  const a0 = new Map<string, Map<string, boolean>>();
  const rows: CellRow[] = [];
  const outcomeRows: Record<string, OutcomeAxes[]> = {};
  for (const cell of cells) {
    const pq = perQuestion(cell);
    if (!pq || pq.some(x => !x)) continue;
    const axesRows = pq.map(x => axesFromJudged({ answerable: ev.get(x.id)!.answerable, executionError: x.error, judgeCorrect: x.error ? null : x.verdict, label: x.error ? null : labelOf(s, x.text)?.label ?? null }));
    outcomeRows[cell] = axesRows;
    const sum = summarize(axesRows, HEDGE_AXIS.validated);
    const correct = new Map(pq.map((x, k) => [x.id, category(axesRows[k]) === 'correct']));
    if (cell.startsWith('a0:')) a0.set(cell.slice(3), correct);
    const reader = cell.startsWith('direct:') ? null : (cell.split(/[:>]/).at(-1) as string);
    const ref = reader ? a0.get(reader) : null;
    const t = timing.filter(r => r.cell === cell && !r.error);
    const lat = t.map(r => r.total_ms as number);
    const def = (xs: (number | null)[]) => (xs.every(x => x === null) ? null : mean(xs.filter((x): x is number => x !== null)));
    rows.push({
      cell, n: pq.length, correct: sum.correct, accuracy: round(sum.correct / pq.length)!,
      committed_wrong: sum.committed_wrong, committed_wrong_bound: sum.committed_wrong + sum.abstained, abstained: sum.abstained, execution_errors: sum.execution_errors, hedged_wrong: sum.hedged_wrong, unlabeled_wrong: sum.unlabeled_wrong,
      usd_per_q: round(mean(pq.map(x => x.usd))!, 6)!, reader_usd_per_q: round(mean(pq.map(x => x.readerUsd))!, 6)!, builder_usd_per_q: round(mean(pq.map(x => x.builderUsd))!, 6)!, fallback_usd_per_q: round(mean(pq.map(x => x.fallbackUsd))!, 6)!,
      escalation_rate: pq[0].escalated === null ? null : round(pq.filter(x => x.escalated).length / pq.length),
      reader_input_tokens: round(def(pq.map(x => x.rin)), 1), reader_output_tokens: round(def(pq.map(x => x.rout)), 1), delivered_cl100k: round(def(pq.map(x => x.delivered)), 1),
      builder_input_tokens: round(def(pq.map(x => x.bin)), 1), builder_output_tokens: round(def(pq.map(x => x.bout)), 1),
      discordance_vs_a0: ref && !cell.startsWith('a0:') ? { a0_right_arm_wrong: pq.filter(x => ref.get(x.id) && !correct.get(x.id)).length, a0_wrong_arm_right: pq.filter(x => !ref.get(x.id) && correct.get(x.id)).length } : null,
      over_budget: pq[0].overBudget === null ? null : pq.filter(x => x.overBudget).length,
      brief_fallbacks: pq[0].fellBack === null ? null : pq.filter(x => x.fellBack).length,
      digest_write_usd_per_q: round(def(pq.map(x => x.digestWrite)), 6),
      p50_ms: lat.length ? Math.round(percentile(lat, 50)) : null, p95_ms: lat.length ? Math.round(percentile(lat, 95)) : null,
      p95_cold_ms: t.some(r => !r.cache_hit) ? Math.round(percentile(t.filter(r => !r.cache_hit).map(r => r.total_ms), 95)) : null,
      p95_hit_ms: t.some(r => r.cache_hit) ? Math.round(percentile(t.filter(r => r.cache_hit).map(r => r.total_ms), 95)) : null,
      timing_n: t.length,
    });
  }
  const spend = {
    builders: round(s.builds.values().reduce((a, b) => a + b.usd, 0), 4),
    readers_sync: round(s.reads.values().filter(r => r.source === 'sync').reduce((a, r) => a + r.usd, 0), 4),
    judges: round(s.judges.values().reduce((a, j) => a + j.usd, 0), 4),
    labels: round(s.labels.values().reduce((a, l) => a + l.usd, 0), 4),
    cohort: round(timing.reduce((a, r) => a + (r.usd ?? 0), 0), 4),
  };
  return { schema: 'wave1-pilot-report/v1', identity, ids_sha256: new Bun.CryptoHasher('sha256').update(ids.join('\n')).digest('hex'), n_questions: ids.length, label_model: LABEL_MODEL, hedge_axis: HEDGE_AXIS, budgets: BUDGETS, cheap: CHEAP, frontier: FRONTIER, rows, spend_list_usd: spend };
}
