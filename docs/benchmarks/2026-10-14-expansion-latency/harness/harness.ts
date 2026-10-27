// GBRA-94 query-expansion eval harness: LongMemEval-S cleaned through the gbrain-defaults shim (pinned 846fa6dd, plus
// the GBRA-86 semantic-cache-off line and the GBRA-94 per-arm env patch), one PGLite brain per haystack, every
// provider call through proxy.ts (embeddings and reranker frozen per text / per pair; expansion live per arm).
//   bun harness.ts build --qids <file|a,b> --workers 4
//   bun harness.ts arms  --qids <file|a,b> --screen-qids subset-k90.json --workers 4 [--only A1,B] [--out rows.ndjson]
// Arms run interleaved: for each question, every arm in an order rotated by question index, so provider latency drift
// over the run hits every arm alike.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type Subprocess } from 'bun';
import { loadLmeS } from '../evals/eval/runner/memory-qa/corpus.ts';
import { Sanitizer } from '../evals/eval/runner/systems/sanitize.ts';
import { HttpMemorySystem } from '../evals/eval/runner/systems/http.ts';
import { strictSources } from '../evals/eval/runner/systems/render.ts';
import { ndcgAtK, recallAllAtK, recallAnyAtK } from '../evals/eval/runner/metrics.ts';
import { ARMS, type Arm } from './arms-spec.ts';
import { cleanRead } from './rules.ts';

const W = process.env.GBRA94_WORK ?? (() => { throw new Error('set GBRA94_WORK to the work directory (gbrain/, evals/, shimcopy/, bin/, datasets/)'); })();
const ROOT = process.env.EVAL_ROOT ?? join(W, 'run');
const PROXY = `http://127.0.0.1:${process.env.PROXY_PORT ?? '8790'}`;
mkdirSync(join(ROOT, 'state'), { recursive: true });
const args = process.argv.slice(2);
const flag = (name: string, dflt?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

const corpus = loadLmeS();
const sanitizer = new Sanitizer(corpus, 'gbra86');
const raw = JSON.parse(readFileSync(join(W, 'datasets/gbrain-evals/longmemeval/longmemeval_s_cleaned.json'), 'utf8')) as Array<{ question_id: string; answer_session_ids: string[] }>;
const goldOf = new Map(raw.map(q => [q.question_id, q.answer_session_ids]));
const qById = new Map(corpus.questions.map(q => [q.id, q]));
const convById = new Map(corpus.conversations.map(c => [c.id, c]));
const policy = (expand: boolean | undefined) => ({ name: 'gbrain-defaults:fixed-evidence', mode: 'fixed-evidence', settings: { limit: 50, autocut: false, on_degraded: 'report', ...(expand === undefined ? {} : { expand }) } }) as any;

const control = (worker: string, body: Record<string, unknown>) => fetch(`${PROXY}/control/${worker}`, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
const statePath = (qid: string) => join(ROOT, 'state', `${qid}.json`);
const readState = (qid: string) => existsSync(statePath(qid)) ? JSON.parse(readFileSync(statePath(qid), 'utf8')) : null;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const armEnvFile = (w: number) => join(ROOT, 'shim', `w${w}`, 'arm-env.json');

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
  writeFileSync(armEnvFile(worker), '{}');
  await control(`w${worker}`, { mode: 'install', phase: 'install' });
  const proc = spawn(['python3', join(W, 'shimcopy/gbrain-defaults/shim.py')], {
    cwd: join(W, 'shimcopy/gbrain-defaults'),
    env: {
      PATH: process.env.PATH!, SHIM_PORT: String(port), SHIM_DATA: data, GBRAIN_HOME: join(data, 'home'), GBRAIN_BIN: join(W, 'bin/gbrain'),
      GBRAIN_PROXY_BASE: `${PROXY}/w${worker}`, SHIM_ARM_ENV_FILE: armEnvFile(worker),
      VOYAGE_API_KEY: 'dummy-voyage', OPENAI_API_KEY: 'dummy-openai', ANTHROPIC_API_KEY: 'dummy-anthropic', GOOGLE_GENERATIVE_AI_API_KEY: 'dummy-google',
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

async function retrieveOnce(sys: HttpMemorySystem, ns: string, text: string, expand: boolean | undefined) {
  const t0 = performance.now();
  try {
    const r = await sys.retrieve(ns, { text, query_time: null }, policy(expand));
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

async function build(qids: string[], workers: number) {
  const byWorker: string[][] = Array.from({ length: workers }, () => []);
  const todo = qids.filter(q => !readState(q)?.built);
  todo.forEach((q, i) => byWorker[i % workers].push(q));
  await Promise.all(byWorker.map(async (list, w) => {
    if (!list.length) return;
    const { proc, sys } = await startShim(w);
    try {
      for (const qid of list) try {
        const t0 = performance.now();
        const ns = sanitizer.ns(qid);
        const st: any = readState(qid) ?? { qid, ns, worker: w };
        if (st.worker !== w) throw new Error(`${qid} was started on w${st.worker}`);
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
        const fin = await sys.finishIngest(ns, 1800);
        Object.assign(st, { failed_sessions: failed, built: fin.ready, sessions: plan.length, chars, finish: { ready: fin.ready, completeness: fin.completeness, waited_ms: fin.waited_ms }, build_ms: Math.round(performance.now() - t0) });
        writeFileSync(statePath(qid), JSON.stringify(st, null, 1));
        log(`w${w} ${qid} built=${st.built} failed_sessions=${failed.length} ${Math.round((performance.now() - t0) / 1000)}s`);
      } catch (e) { log(`w${w} ${qid} ERROR ${String((e as Error).message).slice(0, 300)}`); }
    } finally { proc.kill(); await proc.exited; }
  }));
}

async function arms(qids: string[], workers: number, only: string[] | null, outName: string, screenQids: Set<string>) {
  const armList: Arm[] = only ? ARMS.filter(a => only.includes(a.id)) : ARMS;
  const outFile = join(ROOT, outName);
  const done = new Set<string>();
  if (existsSync(outFile)) for (const l of readFileSync(outFile, 'utf8').split('\n')) if (l) { const r = JSON.parse(l); if (r.ok) done.add(`${r.qid}.${r.kind}.${r.arm}`); }
  const order = new Map(qids.map((q, i) => [q, i]));
  const byWorker: string[][] = Array.from({ length: workers }, () => []);
  for (const q of qids) { const st = readState(q); if (st?.built) byWorker[st.worker]?.push(q); }
  await Promise.all(byWorker.map(async (list, w) => {
    if (!list.length) return;
    const { proc, sys } = await startShim(w);
    try {
      for (const qid of list) {
        const ns = sanitizer.ns(qid);
        const probe = probeText(qid);
        const question = qById.get(qid)!.question;
        const rot = order.get(qid)! % armList.length;
        for (const arm of [...armList.slice(rot), ...armList.slice(0, rot)]) {
          if (arm.screen && !screenQids.has(qid)) continue;
          if (done.has(`${qid}.q.${arm.id}`) && done.has(`${qid}.p.${arm.id}`)) continue;
          writeFileSync(armEnvFile(w), JSON.stringify(arm.env(`${PROXY}/w${w}`)));
          // Uncounted warm-up on the fresh serve (expansion off, the arm-B request), so counted queries run warm.
          await control(`w${w}`, { mode: 'arm', arm: 'warmup', key: `${qid}.warm`, phase: 'warmup' });
          await retrieveOnce(sys, ns, question, false);
          for (const [kind, text] of [['q', question], ['p', probe.text]] as const) {
            if (done.has(`${qid}.${kind}.${arm.id}`)) continue;
            await control(`w${w}`, { mode: 'arm', arm: arm.id, key: `${qid}.${kind}`, phase: `arm:${arm.id}` });
            let res = await retrieveOnce(sys, ns, text, arm.expand);
            let retried = false;
            if (!res.ok || !cleanRead((res.r.raw as any)?.classification, arm.expand === false)) { retried = true; const again = await retrieveOnce(sys, ns, text, arm.expand); if (again.ok) res = again; }
            const row: any = { qid, kind, arm: arm.id, category: qById.get(qid)!.category, retried, ms: Math.round(res.ms), t: Date.now() };
            if (res.ok) {
              const rawr = res.r.raw as any;
              const cls = rawr?.classification;
              row.ok = true; row.outcome = cls?.outcome; row.reasons = cls?.reasons ?? []; row.rows = res.r.items.length;
              row.gbrain_ms = rawr?.gbrain_ms ?? null;
              row.expansion_applied = rawr?.meta?.expansion_applied ?? null;
              row.timings = rawr?.meta?.stage_timings ?? rawr?.meta?.timings ?? null;
              if (kind === 'q') Object.assign(row, score(qid, res.r.items));
              else row.found = res.r.items.some((i: any) => i.source_ids.includes(probe.source_id));
            } else { row.ok = false; row.error = res.error; }
            appendFileSync(outFile, JSON.stringify(row) + '\n');
          }
        }
        log(`w${w} ${qid} arms done`);
      }
    } finally { writeFileSync(armEnvFile(w), '{}'); proc.kill(); await proc.exited; }
  }));
}

const qidsArg = () => { const v = flag('qids')!; return v.includes(',') || !existsSync(v) ? v.split(',') : JSON.parse(readFileSync(v, 'utf8')).question_ids as string[]; };
const cmd = args[0];
if (cmd === 'build') await build(qidsArg(), Number(flag('workers', '4')));
else if (cmd === 'arms') await arms(qidsArg(), Number(flag('workers', '4')), flag('only')?.split(',') ?? null, flag('out', 'rows.ndjson')!,
  new Set(flag('screen-qids') ? JSON.parse(readFileSync(flag('screen-qids')!, 'utf8')).question_ids : []));
else console.log('usage: build | arms');
process.exit(0);
