/**
 * Free protocol smoke: every dataset x mode x provider through the real
 * launcher, providers and scorer, with every model request answered by the
 * local stub upstream (no key, no spend). It proves the plumbing for each
 * combination: ingest, completion barrier, retrieval, the dataset's prompt
 * builder, delivered-context counting, the leak check, judging and receipts.
 * Scores from stub models mean nothing and are not reported.
 *
 *   bun eval/runner/harness-smoke.ts [--providers gbrain,comparator] [--datasets a,b] [--modes rag,agent]
 *
 * Writes eval/reports/harness-smoke/summary.json and exits 1 when any
 * combination fails.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CellSpec } from './harness-cell.ts';
import { REPO_ROOT } from './harness-env.ts';

export const SMOKE_DATASETS: Array<{ dataset: string; split: string; questions: CellSpec['questions']; modes: CellSpec['mode'][] }> = [
  { dataset: 'longmemeval', split: 's', questions: { limit: 2 }, modes: ['rag', 'agentic-rag', 'agent'] },
  { dataset: 'locomo', split: 'locomo10', questions: { limit: 2 }, modes: ['rag', 'agentic-rag', 'agent'] },
  { dataset: 'beam', split: '100k', questions: { limit: 2 }, modes: ['rag', 'agentic-rag', 'agent'] },
  { dataset: 'personamem', split: '32k', questions: { limit: 2 }, modes: ['rag', 'agentic-rag', 'agent'] },
  { dataset: 'lifebench', split: 'en', questions: { limit: 2 }, modes: ['rag', 'agentic-rag', 'agent'] },
  { dataset: 'precisionmembench', split: 'single-turn', questions: { limit: 2 }, modes: ['retrieval'] },
];

const ANSWER = 'gemini:gemini-3.6-flash';
const JUDGE = 'gemini:gemini-3.6-flash';
const BEAM_JUDGE = 'gemini:gemini-3.5-flash';
/** gbrain's native Google path has no base-URL override, so gbrain `think` runs on a model the proxy can meter. */
const AGENT_ANSWER = 'openai:gpt-6-luna';

export function smokeSpec(d: (typeof SMOKE_DATASETS)[number], mode: CellSpec['mode'], provider: 'gbrain' | 'comparator'): CellSpec {
  const answer = mode === 'agent' ? AGENT_ANSWER : ANSWER;
  const spec: CellSpec = {
    dataset: d.dataset, split: d.split, provider, mode, lane: 'raw', seal: 'fixture', target_tokens: null,
    models: { answer, judge: d.dataset === 'beam' ? BEAM_JUDGE : JUDGE },
    budget_usd: 5, questions: d.questions, k: 10,
    note: 'protocol smoke against the stub upstream; not evidence',
    provider_config: provider === 'gbrain' ? { token_budget: 4000, ...(mode === 'agent' ? { think_model: answer } : {}) } : {},
  };
  if (provider === 'gbrain' && mode === 'agent') spec.gbrain_credentials = ['voyage', 'openai'];
  return spec;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const list = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1].split(',') : null; };
  const providers = (list('--providers') ?? ['gbrain', 'comparator']) as Array<'gbrain' | 'comparator'>;
  const datasets = list('--datasets');
  const modes = list('--modes');
  const out = join(REPO_ROOT, 'eval/reports/harness-smoke');
  const cells = join(out, 'cells');
  const specs = join(out, 'specs');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(specs, { recursive: true });
  const rows: Array<Record<string, unknown>> = [];
  for (const d of SMOKE_DATASETS.filter(x => !datasets || datasets.includes(x.dataset))) {
    for (const mode of d.modes.filter(m => !modes || modes.includes(m))) {
      for (const provider of providers) {
        const name = `${d.dataset}-${mode}-${provider}`;
        const specPath = join(specs, `${name}.json`);
        writeFileSync(specPath, JSON.stringify(smokeSpec(d, mode, provider), null, 2));
        const t0 = Date.now();
        const p = Bun.spawnSync([process.execPath, 'eval/runner/harness-cell.ts', 'run', specPath, '--stub-upstream', '--cells-dir', cells],
          { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
        const err = p.stderr.toString();
        const id = /\[cell\] (\S+):/.exec(err)?.[1];
        const summaryPath = id ? join(cells, id, 'summary.json') : null;
        const summary = summaryPath && existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
        const counts = summary?.score?.counts ?? {};
        const failures = (counts.answer_failure ?? 0) + (counts.retrieval_failure ?? 0) + (counts.judge_failure ?? 0) + (counts.incomplete_ingest ?? 0) + (counts.missing ?? 0);
        const ok = p.exitCode === 0 && !!summary && summary.score.complete && failures === 0;
        rows.push({ dataset: d.dataset, split: d.split, mode, provider, ok, cell_id: id ?? null, seconds: Math.round((Date.now() - t0) / 1000),
          counts, inserted_kinds: summary?.delivered_context?.inserted_kinds ?? null, error: ok ? null : err.split('\n').filter(Boolean).slice(-6).join(' | ') });
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} (${rows.at(-1)!.seconds}s)${ok ? '' : `: ${rows.at(-1)!.error}`}`);
      }
    }
  }
  const failed = rows.filter(r => !r.ok).length;
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ generated_at: new Date().toISOString(), combinations: rows.length, failed, rows }, null, 2) + '\n');
  console.log(`${rows.length - failed}/${rows.length} combinations passed; eval/reports/harness-smoke/summary.json`);
  process.exit(failed ? 1 : 0);
}
