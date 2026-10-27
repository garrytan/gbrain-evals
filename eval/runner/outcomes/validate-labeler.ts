#!/usr/bin/env bun
/**
 * Validate outcome-v3's judged commitment/hedge labeler against GBRA-49's
 * hand-labeled answers (A10). The labels stay in their custodian's folder;
 * only aggregates and the label files' SHA-256 are written to the receipt.
 *
 *   bun eval/runner/outcomes/validate-labeler.ts --labels-dir <dir> --stage select|confirm [--model <m>]
 *       --paid --budget-run-id <id> --budget-ledger <path> [--out <receipt.json>]
 *
 * Preregistered rule (docs/benchmarks/2026-10-08-evidence-architecture-pilot-preregistration.md):
 *   select   the ladder gpt-6-luna, claude-haiku-5-5, claude-sonnet-5-5 runs in order on samples 1 and 2
 *            (400 answers); the first model with precision >= 0.90 on both `hedged` and `abstain` is selected;
 *   confirm  the selected model labels sample 3 (200 answers no Q1 classifier was tuned on) once; the hedge
 *            axis is validated only if both precisions are >= 0.90 there.
 * Mutation probes (synthetic answers) run with every model: a hedged wrong value must not be labeled
 * abstain, and an abstention followed by a value must not be labeled abstain.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readerBody } from '../batch/sources.ts';
import { callModel, pool } from '../pilot/call.ts';
import { listUsd, } from '../pilot/cells.ts';
import { paidStart } from '../pilot/run.ts';
import { normalizeUsage, usageSourceOf } from '../usage-receipt.ts';
import { JUDGED_LABEL_SYSTEM, JUDGED_LABEL_VERSION, judgedLabelUser, labelAgreement, parseJudgedLabel, passesHedgeBar, type CommitmentLabel } from './v3.ts';

export const LADDER = ['gpt-6-luna', 'claude-haiku-5-5', 'claude-sonnet-5-5'] as const;
const SAMPLES = { select: ['hedge-v1-sample', 'hedge-v2-sample'], confirm: ['hedge-v3-sample'] } as const;

/** Synthetic probes (invented text). `not` is the label the answer must not get. */
export const PROBES: Array<{ text: string; not: CommitmentLabel }> = [
  { text: "I don't know for sure, but the owner is Dana Example.", not: 'abstain' },
  { text: 'The sessions do not say exactly. If I had to guess, it was around March 2023.', not: 'abstain' },
  { text: "There isn't enough information to be certain.\n\n**Answer:** You probably paid $350.", not: 'abstain' },
  { text: "The records don't mention the venue. Anyway, book Pine Hall for Tuesday.", not: 'abstain' },
  { text: "I can't determine this from the conversations. Final answer: 4 trips.", not: 'abstain' },
  { text: 'Answer: It might have been the blue model, though I am not certain.', not: 'abstain' },
  { text: 'Answer: Probably 3 times.', not: 'confident' },
  { text: 'Answer: About 6 weeks.', not: 'confident' },
  { text: 'Answer: 6 weeks.', not: 'hedged' },
  { text: "The conversations don't say which park you visited, so I can't answer that.", not: 'confident' },
  { text: "I don't know. Naming a park would be speculation.", not: 'hedged' },
  { text: 'Answer: You switched to the 7am class on 12 March.', not: 'abstain' },
];

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...rest] = rows;
  return rest.filter(r => r.length === head.length).map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

export function loadLabels(dir: string, sample: string): Array<{ answer_id: string; text: string; label: CommitmentLabel }> {
  return parseCsv(readFileSync(join(dir, sample, 'labeled.csv'), 'utf8')).map(r => ({ answer_id: r.answer_id, text: r.text, label: r.label as CommitmentLabel })).filter(r => ['abstain', 'hedged', 'confident'].includes(r.label));
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function label(model: string, texts: string[], cache: Map<string, { label: CommitmentLabel | null; usd: number }>): Promise<void> {
  const todo = [...new Set(texts)].filter(t => !cache.has(`${model}:${t}`));
  await pool(todo, 8, async t => {
    const r = await callModel(readerBody(model, { system: JUDGED_LABEL_SYSTEM, user: judgedLabelUser(t) }), { lane: 'a10-validate', role: 'judge', question_id: createHash('sha256').update(t).digest('hex').slice(0, 12) });
    const u = normalizeUsage(usageSourceOf(`${model.startsWith('claude') ? 'anthropic' : 'openai'}:${model}`), r.usage);
    cache.set(`${model}:${t}`, { label: r.status === 'succeeded' ? parseJudgedLabel(r.text ?? '') : null, usd: listUsd(model, u) });
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = flag('--labels-dir') ?? join(homedir(), '.capy/work/hedge-labels');
  const stage = flag('--stage') as 'select' | 'confirm';
  if (stage !== 'select' && stage !== 'confirm') { console.error('--stage select|confirm'); process.exit(2); }
  const cachePath = join(homedir(), '.capy/work/a10/labeler-cache.json');
  mkdirSync(join(homedir(), '.capy/work/a10'), { recursive: true });
  const cache = new Map<string, { label: CommitmentLabel | null; usd: number }>(existsSync(cachePath) ? Object.entries(JSON.parse(readFileSync(cachePath, 'utf8'))) : []);
  const { run, guard } = paidStart(argv, `a10-labeler-${stage}`, stage === 'select' ? 3 : 1);
  const out: Record<string, unknown> = { schema: 'a10-labeler-validation/v1', labeler: JUDGED_LABEL_VERSION, prompt_sha256: createHash('sha256').update(JUDGED_LABEL_SYSTEM).digest('hex'), stage, labels_manifest_sha256: sha(join(dir, 'MANIFEST.sha256')), samples: {} as Record<string, unknown>, results: [] as unknown[] };
  try {
    const rows = SAMPLES[stage].flatMap(sm => loadLabels(dir, sm).map(r => ({ ...r, sample: sm })));
    for (const sm of SAMPLES[stage]) (out.samples as Record<string, unknown>)[sm] = { n: rows.filter(r => r.sample === sm).length, labeled_csv_sha256: sha(join(dir, sm, 'labeled.csv')) };
    const models = stage === 'select' ? [...LADDER] : [flag('--model') ?? (() => { throw new Error('--model is required for confirm'); })()];
    for (const model of models) {
      await label(model, [...rows.map(r => r.text), ...PROBES.map(p => p.text)], cache);
      writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)));
      const pairs = rows.map(r => ({ label: r.label, predicted: cache.get(`${model}:${r.text}`)?.label ?? null }));
      const agreement = labelAgreement(pairs);
      const bySample = Object.fromEntries(SAMPLES[stage].map(sm => [sm, labelAgreement(rows.map((r, i) => ({ r, p: pairs[i] })).filter(x => x.r.sample === sm).map(x => x.p))]));
      const probes = PROBES.map(p => ({ not: p.not, got: cache.get(`${model}:${p.text}`)?.label ?? null })).map(p => ({ ...p, ok: p.got !== null && p.got !== p.not }));
      const usd = [...rows.map(r => r.text), ...PROBES.map(p => p.text)].reduce((a, t) => a + (cache.get(`${model}:${t}`)?.usd ?? 0), 0);
      const passes = passesHedgeBar(agreement);
      (out.results as unknown[]).push({ model, passes_bar: passes, agreement, by_sample: bySample, probes_passed: probes.filter(p => p.ok).length, probes_total: probes.length, probes, list_usd: Number(usd.toFixed(4)) });
      console.error(`[a10] ${stage} ${model}: hedged precision ${agreement.per_class.hedged.precision?.toFixed(3)}, abstain precision ${agreement.per_class.abstain.precision?.toFixed(3)}, probes ${probes.filter(p => p.ok).length}/${probes.length}, $${usd.toFixed(3)}`);
      if (stage === 'select' && passes) { out.selected = model; break; }
    }
    if (stage === 'confirm') out.validated = (out.results as Array<{ passes_bar: boolean }>)[0].passes_bar;
  } finally {
    guard.uninstall();
    out.budget = run.close();
  }
  const dest = flag('--out');
  if (dest) writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out, null, 1));
}
