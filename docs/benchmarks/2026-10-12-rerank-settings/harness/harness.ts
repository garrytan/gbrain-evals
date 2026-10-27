// GBRA-86 reranker-settings eval harness: LongMemEval-S cleaned through the gbrain-defaults shim (pinned 846fa6dd,
// plus the semantic-cache-off line), one PGLite brain per haystack, providers through proxy.ts.
//   bun harness.ts select                       -> run/subset.json (preregistered selection)
//   bun harness.ts build --qids a,b --workers 3 -> build + capture (frozen candidate lists)
//   bun harness.ts cells --workers 3 [--only id,id] [--qids ...] -> offline rerank cells, rows to run/rows.ndjson
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type Subprocess } from 'bun';
import { loadLmeS } from '../evals/eval/runner/memory-qa/corpus.ts';
import { Sanitizer } from '../evals/eval/runner/systems/sanitize.ts';
import { HttpMemorySystem } from '../evals/eval/runner/systems/http.ts';
import { strictSources } from '../evals/eval/runner/systems/render.ts';
import { ndcgAtK, recallAllAtK, recallAnyAtK } from '../evals/eval/runner/metrics.ts';

const W = join(process.env.HOME!, '.capy/work/gbra86');
const ROOT = process.env.EVAL_ROOT ?? join(W, 'run');
const PROXY = `http://127.0.0.1:${process.env.PROXY_PORT ?? '8790'}`;
mkdirSync(join(ROOT, 'state'), { recursive: true });
const args = process.argv.slice(2);
const flag = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

import { CELLS_SPEC } from './cells-spec.ts';
export const CELLS = CELLS_SPEC;

const corpus = loadLmeS();
const sanitizer = new Sanitizer(corpus, 'gbra86');
const raw = JSON.parse(readFileSync(join(W, 'datasets/gbrain-evals/longmemeval/longmemeval_s_cleaned.json'), 'utf8')) as Array<{ question_id: string; answer_session_ids: string[] }>;
const goldOf = new Map(raw.map(q => [q.question_id, q.answer_session_ids]));
const qById = new Map(corpus.questions.map(q => [q.id, q]));
const convById = new Map(corpus.conversations.map(c => [c.id, c]));
const POLICY = { name: 'gbrain-defaults:fixed-evidence', mode: 'fixed-evidence', settings: { limit: 50, autocut: false, on_degraded: 'report' } } as any;

const control = (worker: string, body: Record<string, unknown>) => fetch(`${PROXY}/control/${worker}`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const statePath = (qid: string) => join(ROOT, 'state', `${qid}.json`);
const readState = (qid: string) => existsSync(statePath(qid)) ? JSON.parse(readFileSync(statePath(qid), 'utf8')) : null;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function probeText(qid: string): { text: string; source_id: string } {
  const conv = convById.get(qid)!;
  const plan = sanitizer.ingestPlan(conv);
  const last = plan.at(-1)!.input;
  const passage = [...last.turns].sort((x, y) => y.content.length - x.content.length)[0]!.content.slice(0, 300);
  return { text: passage, source_id: last.source_id };
}

async function startShim(worker: number): Promise<{ proc: Subprocess; sys: HttpMemorySystem }> {
  const port = 8700 + worker;
  const data = join(ROOT, 'shim', `w${worker}`);
  mkdirSync(data, { recursive: true });
  await control(`w${worker}`, { mode: 'install', phase: 'install' });
  const proc = spawn(['python3', join(W, 'shimcopy/gbrain-defaults/shim.py')], {
    cwd: join(W, 'shimcopy/gbrain-defaults'),
    env: {
      PATH: process.env.PATH!, SHIM_PORT: String(port), SHIM_DATA: data, GBRAIN_HOME: join(data, 'home'), GBRAIN_BIN: join(W, 'bin/gbrain'),
      GBRAIN_PROXY_BASE: `${PROXY}/w${worker}`, VOYAGE_API_KEY: 'dummy-voyage', OPENAI_API_KEY: 'dummy-openai', ANTHROPIC_API_KEY: 'dummy-anthropic',
      GBRAIN_DRAIN_WAIT_S: process.env.GBRAIN_DRAIN_WAIT_S ?? '660',
    },
    stdout: Bun.file(join(data, 'shim.out')), stderr: Bun.file(join(data, 'shim.err')),
  });
  const sys = new HttpMemorySystem(`http://127.0.0.1:${port}`, { markers: sanitizer.markers, ingestTimeoutMs: 3_600_000 });
  for (let i = 0; i < 600; i++) {
    try { const h = await sys.health(); if ((h as any).ok !== false && (h as any).reference_ready !== false) { await sys.capabilities(); return { proc, sys }; } } catch { /* booting */ }
    await Bun.sleep(1000);
  }
  throw new Error(`shim w${worker} did not come up`);
}

async function retrieveOnce(sys: HttpMemorySystem, ns: string, text: string) {
  const t0 = performance.now();
  try {
    const r = await sys.retrieve(ns, { text, query_time: null }, POLICY);
    return { ok: true as const, r, ms: performance.now() - t0 };
  } catch (e) { return { ok: false as const, error: String((e as Error).message).slice(0, 400), ms: performance.now() - t0 }; }
}

function score(qid: string, items: any[]) {
  const ns = sanitizer.ns(qid);
  const toSessions = (srcs: string[]) => srcs.map(s => sanitizer.sessionOf(ns, s)!);
  const gold = new Set(goldOf.get(qid)!);
  const at5 = toSessions(strictSources(items, 5).sources), at10 = toSessions(strictSources(items, 10).sources);
  return { r5: recallAllAtK(at5, gold, 5), r10: recallAllAtK(at10, gold, 10), any10: recallAnyAtK(at10, gold, 10), ndcg10: ndcgAtK(at10, new Map([...gold].map(g => [g, 1])), 10), top10: at10 };
}

async function pool<T>(items: T[], workers: number, fn: (item: T, w: number) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: workers }, async (_, w) => { while (queue.length) await fn(queue.shift()!, w); }));
}

async function build(qids: string[], workers: number) {
  const byWorker: string[][] = Array.from({ length: workers }, () => []);
  const todo = qids.filter(q => !readState(q)?.captured);
  todo.forEach((q, i) => byWorker[i % workers].push(q));
  await Promise.all(byWorker.map(async (list, w) => {
    if (!list.length) return;
    const { proc, sys } = await startShim(w);
    try {
      for (const qid of list) try {
        const t0 = performance.now();
        const ns = sanitizer.ns(qid);
        const prev = readState(qid);
        const st: any = prev ?? { qid, ns, worker: w };
        if (prev && prev.worker !== w) throw new Error(`${qid} was built on w${prev.worker}`);
        if (!st.built) {
          await control(`w${w}`, { mode: 'install', key: qid, phase: 'install' });
          await sys.reset(ns);
          await control(`w${w}`, { mode: 'build', key: qid, phase: 'build' });
          const plan = sanitizer.ingestPlan(convById.get(qid)!);
          let chars = 0;
          const failed: string[] = [];
          for (const step of plan) {
            try { await sys.ingestSession(ns, step.input, step.event_time); chars += step.input.turns.reduce((a, t) => a + t.content.length, 0); }
            catch (e) { failed.push(String((e as Error).message).slice(0, 200)); }
          }
          st.failed_sessions = failed;
          const fin = await sys.finishIngest(ns, 1800);
          st.built = fin.ready; st.sessions = plan.length; st.chars = chars; st.finish = { ready: fin.ready, completeness: fin.completeness, waited_ms: fin.waited_ms, liabilities: (fin.raw as any)?.background_liabilities ?? null };
          st.build_ms = Math.round(performance.now() - t0);
          writeFileSync(statePath(qid), JSON.stringify(st, null, 1));
          if (!fin.ready) { log(`w${w} ${qid} finish not ready`); continue; }
        }
        const probe = probeText(qid);
        st.capture = {};
        for (const [kind, text] of [['q', qById.get(qid)!.question], ['p', probe.text]] as const) {
          await control(`w${w}`, { mode: 'capture', key: `${qid}.${kind}`, phase: 'capture' });
          let res = await retrieveOnce(sys, ns, text);
          if (!res.ok) res = await retrieveOnce(sys, ns, text);
          st.capture[kind] = res.ok ? { ok: true, rows: res.r.items.length, classification: (res.r.raw as any)?.classification, frozen: existsSync(join(ROOT, 'frozen', `${qid}.${kind}.json`)) } : { ok: false, error: res.error };
        }
        st.captured = st.capture.q.frozen && st.capture.p.frozen;
        writeFileSync(statePath(qid), JSON.stringify(st, null, 1));
        log(`w${w} ${qid} built=${st.built} captured=${st.captured} failed_sessions=${st.failed_sessions?.length ?? 0} ${Math.round((performance.now() - t0) / 1000)}s`);
      } catch (e) { log(`w${w} ${qid} ERROR ${String((e as Error).message).slice(0, 300)}`); }
    } finally { proc.kill(); await proc.exited; }
  }));
}

async function cells(qids: string[], workers: number, only: string[] | null, repeat: string | null) {
  const cellList = only ? CELLS.filter(c => only.includes(c.id)) : CELLS;
  const outFile = join(ROOT, repeat ? `rows-${repeat}.ndjson` : 'rows.ndjson');
  const done = new Set<string>();
  if (existsSync(outFile)) for (const l of readFileSync(outFile, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); if (r.ok) done.add(`${r.qid}.${r.kind}.${r.cell}`); }
  const byWorker: string[][] = Array.from({ length: workers }, () => []);
  for (const q of qids) { const st = readState(q); if (st?.captured) byWorker[st.worker]?.push(q); }
  await Promise.all(byWorker.map(async (list, w) => {
    if (!list.length) return;
    const { proc, sys } = await startShim(w);
    try {
      for (const qid of list) {
        const ns = sanitizer.ns(qid);
        const probe = probeText(qid);
        for (const cell of cellList) for (const [kind, text] of [['q', qById.get(qid)!.question], ['p', probe.text]] as const) {
          if (done.has(`${qid}.${kind}.${cell.id}`)) continue;
          await control(`w${w}`, { mode: 'cell', key: `${qid}.${kind}`, cell, phase: `cell:${cell.id}` });
          let res = await retrieveOnce(sys, ns, text);
          let retried = false;
          if (!res.ok || (res.r.raw as any)?.classification?.outcome !== 'scored') { retried = true; const again = await retrieveOnce(sys, ns, text); if (again.ok) res = again; }
          const row: any = { qid, kind, cell: cell.id, category: qById.get(qid)!.category, retried, ms: Math.round(res.ms) };
          if (res.ok) {
            const cls = (res.r.raw as any)?.classification;
            row.ok = true; row.outcome = cls?.outcome; row.reasons = cls?.reasons ?? []; row.rows = res.r.items.length;
            row.top_rerank_score = (res.r.raw as any)?.meta?.crag?.top_rerank_score ?? null;
            if (kind === 'q') Object.assign(row, score(qid, res.r.items));
            else row.found = res.r.items.some((i: any) => i.source_ids.includes(probe.source_id));
          } else { row.ok = false; row.error = res.error; }
          appendFileSync(outFile, JSON.stringify(row) + '\n');
        }
        log(`w${w} ${qid} cells done`);
      }
    } finally { proc.kill(); await proc.exited; }
  }));
}

const cmd = args[0];
if (cmd === 'select') {
  const k = Number(flag('k', '250'));
  const ordered = [...corpus.questions].sort((a, b) => (sha(`gbra86|${a.id}`) < sha(`gbra86|${b.id}`) ? -1 : 1));
  const byType = new Map<string, string[]>();
  for (const q of ordered) byType.set(q.category, [...(byType.get(q.category) ?? []), q.id]);
  const total = corpus.questions.length;
  const quotas = [...byType.entries()].map(([t, ids]) => ({ t, ids, exact: (k * ids.length) / total }));
  quotas.forEach(q => (q as any).take = Math.floor(q.exact));
  let left = k - quotas.reduce((a, q: any) => a + q.take, 0);
  for (const q of [...quotas].sort((a, b) => (b.exact % 1) - (a.exact % 1) || (a.t < b.t ? -1 : 1))) if (left-- > 0) (q as any).take++;
  const picked = new Set(quotas.flatMap((q: any) => q.ids.slice(0, q.take)));
  const subset = ordered.map(q => q.id).filter(id => picked.has(id));
  writeFileSync(join(ROOT, `subset-k${k}.json`), JSON.stringify({ k, rule: "per question type, floor(k*share) then largest remainder (ties by type name); within a type, ascending sha256('gbra86|'+question_id)", per_type: Object.fromEntries(quotas.map((q: any) => [q.t, q.take])), question_ids: subset }, null, 1));
  console.log(JSON.stringify({ k, per_type: Object.fromEntries(quotas.map((q: any) => [q.t, q.take])), first: subset.slice(0, 6), hash_order_first: ordered.slice(0, 6).map(q => q.id) }));
} else if (cmd === 'build') {
  const qids = flag('qids')!.includes(',') || !existsSync(flag('qids')!) ? flag('qids')!.split(',') : JSON.parse(readFileSync(flag('qids')!, 'utf8')).question_ids;
  await build(qids, Number(flag('workers', '3')));
} else if (cmd === 'cells') {
  const qids = flag('qids')!.includes(',') || !existsSync(flag('qids')!) ? flag('qids')!.split(',') : JSON.parse(readFileSync(flag('qids')!, 'utf8')).question_ids;
  await cells(qids, Number(flag('workers', '3')), flag('only')?.split(',') ?? null, flag('repeat') ?? null);
} else console.log('usage: select | build | cells');
process.exit(0);
