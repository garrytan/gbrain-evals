/**
 * The synchronous timing cohort (A5): a stratified random subsample of the
 * pilot questions, every interactive design at the 2,000-token budget,
 * executed one request at a time in a seeded random order of (question, cell)
 * units, with no answer cache anywhere. Each unit records end-to-end
 * wall-clock timers for retrieval (replayed captures: 0, not measured),
 * builder, reader, labeler and fallback calls, plus whether the provider
 * served the reader's prompt from its cache. CACHE sends its cold request
 * and then the same request again inside the provider TTL.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readNdjson, readerBody, seededPermutation, stratifiedSample } from '../batch/sources.ts';
import { JUDGED_LABEL_SYSTEM, judgedLabelUser, parseJudgedLabel } from '../outcomes/v3.ts';
import { callModel } from './call.ts';
import { CHEAP, FRONTIER, cacheBody, cellId, escalate, frontierBody, listUsd, type Cheap, type Reader } from './cells.ts';
import { loadPilotEvidence, pilotSplit, withEvidence, PILOT_SEED } from './evidence.ts';
import { briefFor, digestFor, LABEL_MODEL, STATE_DIR, textKey, type BriefModule, type stores } from './run.ts';
import { normalizeUsage, usageSourceOf } from '../usage-receipt.ts';
import { readerRequest } from './run.ts';

export const COHORT_SIZE = 24;
export const COHORT_BUDGET = 2000;

export function cohortIds(): string[] {
  const ev = loadPilotEvidence();
  const { pilot } = pilotSplit();
  return stratifiedSample(new Map(pilot.map(id => [id, ev.get(id)!.report_type])), COHORT_SIZE, PILOT_SEED + 1).ids;
}

export function cohortCells(): string[] {
  const out: string[] = [];
  for (const r of FRONTIER) out.push(cellId.a0(r), cellId.cache(r), cellId.trunc(COHORT_BUDGET, r));
  for (const c of CHEAP) out.push(cellId.direct(c));
  for (const c of CHEAP) for (const r of FRONTIER) out.push(cellId.fallback(c, r), cellId.brief(COHORT_BUDGET, c, r), cellId.digest(COHORT_BUDGET, c, r));
  return out;
}

const usageOf = (model: string, raw: Record<string, unknown> | null) => normalizeUsage(usageSourceOf(`${model.startsWith('claude') ? 'anthropic' : 'openai'}:${model}`), raw);

export async function runCohort(argv: string[], s: ReturnType<typeof stores>, mod: BriefModule, log: (l: string) => void, stateDir = STATE_DIR, plan: { ids: string[]; cells: string[]; seed: number } = { ids: cohortIds(), cells: cohortCells(), seed: PILOT_SEED + 2 }): Promise<void> {
  const ev = loadPilotEvidence();
  const path = join(stateDir, 'cohort.ndjson');
  mkdirSync(stateDir, { recursive: true });
  const done = new Set(readNdjson(path).filter(r => !r.warm).map(r => `${r.cell}|${r.question_id}`));
  const units = seededPermutation(plan.ids.flatMap(id => plan.cells.map(cell => `${cell}|${id}`)), plan.seed).filter(u => !done.has(u));
  log(`cohort: ${units.length} units`);
  const put = (rec: Record<string, unknown>) => appendFileSync(path, JSON.stringify({ ...rec, at: new Date().toISOString() }) + '\n');
  let k = 0;
  for (const unit of units) {
    const [cell, id] = unit.split('|');
    const q = ev.get(id)!;
    const t: Record<string, number> = { retrieval_ms: 0, builder_ms: 0, reader_ms: 0, label_ms: 0, fallback_ms: 0 };
    let usd = 0, error: string | null = null, cacheHit = false, cacheRead = 0;
    const read = async (model: string, body: Record<string, unknown>) => {
      const r = await callModel(body, { lane: 'pilot-cohort', role: 'reader', question_id: id }, { retries: 0 });
      const u = usageOf(model, r.usage);
      usd += listUsd(model, u);
      if (r.status !== 'succeeded') error = r.error ?? r.status;
      cacheRead = u?.cache_read ?? 0;
      cacheHit = cacheRead > 0;
      return { r, u };
    };
    const [kind] = cell.split(/[@:]/);
    try {
      if (kind === 'a0' || kind === 'trunc' || kind === 'digest' || kind === 'direct') {
        const req = kind === 'digest'
          ? (() => { const c = cell.split(':'); const x = digestFor(mod, q, sess => s.builds.get(`digest@${COHORT_BUDGET / 5}:${c[1]}:${sess.session_id}#${textKey(sess.body).slice(0, 12)}`), COHORT_BUDGET); return { model: c[2], body: frontierBody(c[2], withEvidence(q, x.evidence)) }; })()
          : readerRequest(cell, q, s, mod)!;
        const { r } = await read(req.model, req.body);
        t.reader_ms = r.latency_ms;
      } else if (kind === 'brief') {
        const [head, builder, reader] = cell.split(':') as [string, Cheap, Reader];
        const budget = Number(head.split('@')[1]);
        const sessions = q.sessions.map(x => ({ session_id: x.session_id, ...(x.date ? { date: x.date } : {}), body: x.body }));
        const p = mod.buildBriefPrompt({ question: q.question, questionDate: q.question_date, sessions, budgetTokens: budget });
        const b = await callModel(readerBody(builder, p), { lane: 'pilot-cohort', role: 'builder', question_id: id }, { retries: 0 });
        t.builder_ms = b.latency_ms;
        usd += listUsd(builder, usageOf(builder, b.usage));
        const brief = briefFor(mod, q, b.status === 'succeeded' ? { status: 'succeeded', text: b.text ?? '' } as any : undefined, budget);
        const { r } = await read(reader, frontierBody(reader, withEvidence(q, brief.evidence)));
        t.reader_ms = r.latency_ms;
      } else if (kind === 'fallback') {
        const [cheap, reader] = cell.slice('fallback:'.length).split('>') as [Cheap, Reader];
        const c = await callModel(readerBody(cheap, q.capture), { lane: 'pilot-cohort', role: 'reader', question_id: id }, { retries: 0 });
        t.reader_ms = c.latency_ms;
        usd += listUsd(cheap, usageOf(cheap, c.usage));
        let label = null;
        if (c.status === 'succeeded' && c.text) {
          const l = await callModel(readerBody(LABEL_MODEL, { system: JUDGED_LABEL_SYSTEM, user: judgedLabelUser(c.text) }), { lane: 'pilot-cohort', role: 'judge', question_id: id }, { retries: 0 });
          t.label_ms = l.latency_ms;
          usd += listUsd(LABEL_MODEL, usageOf(LABEL_MODEL, l.usage));
          label = l.status === 'succeeded' ? parseJudgedLabel(l.text ?? '') : null;
        }
        if (escalate({ error: c.status === 'succeeded' && c.finish === 'stop' && c.text ? null : 'cheap_error', label })) {
          const f = await callModel(frontierBody(reader, q.capture), { lane: 'pilot-cohort', role: 'reader', question_id: id }, { retries: 0 });
          t.fallback_ms = f.latency_ms;
          usd += listUsd(reader, usageOf(reader, f.usage));
          if (f.status !== 'succeeded') error = f.error ?? f.status;
        }
      } else if (kind === 'cache') {
        const reader = cell.slice('cache:'.length) as Reader;
        const body = cacheBody(reader, q.capture, `pilot-${id}`);
        const cold = await read(reader, body);
        put({ cell, question_id: id, warm: false, ...t, reader_ms: cold.r.latency_ms, total_ms: cold.r.latency_ms, cache_hit: cacheHit, cache_read: cacheRead, cache_write: cold.u?.cache_write ?? 0, usage: cold.u, usd, error });
        usd = 0;
        const warm = await read(reader, body);
        put({ cell, question_id: id, warm: true, ...t, reader_ms: warm.r.latency_ms, total_ms: warm.r.latency_ms, cache_hit: cacheHit, cache_read: cacheRead, cache_write: warm.u?.cache_write ?? 0, usage: warm.u, usd, error });
        if (++k % 25 === 0) log(`cohort: ${k}/${units.length}`);
        continue;
      }
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const total = t.retrieval_ms + t.builder_ms + t.reader_ms + t.label_ms + t.fallback_ms;
    put({ cell, question_id: id, warm: false, ...t, total_ms: total, cache_hit: cacheHit, cache_read: cacheRead, usd, error });
    if (++k % 25 === 0) log(`cohort: ${k}/${units.length}`);
  }
}
