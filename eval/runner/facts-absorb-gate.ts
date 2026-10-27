/**
 * Facts-absorb quality gate (R2, 10x plan wave 0): does a cheaper
 * `facts.extraction_model` keep the facts gbrain's background extractor saves
 * as good as the shipped default?
 *
 * Each arm is a fresh PGLite brain behind `gbrain serve` (stdio MCP), the path
 * an agent uses. The agent writes the facts-absorb world's sessions
 * (eval/generators/facts-absorb-gen.ts) as `note` pages with put_page. The
 * write queues the real `facts-absorb` job, which `gbrain jobs work` drains
 * after the session closes (PGLite cannot host a worker beside serve). Then a
 * fresh process reads every stored fact back (the restart), and the scorer
 * (facts-absorb/score.ts) matches them to the world's answer key: recall,
 * precision, attribution, correction handling. Parse failures come from the
 * job results and the facts:absorb rows of ingest_log; the resolved model is
 * read from gbrain's own call ledger (GBRAIN_AI_CALL_LOG) at the facts-absorb
 * invocation, not taken from the requested setting.
 *
 * Arms are `label=spec`:
 *   label=default                    leave facts.extraction_model unset (the shipped default)
 *   label=<provider:model>           gbrain config set facts.extraction_model <provider:model>
 *   label=disabled                   mutant: facts.extraction_enabled false
 *   label=drop:<provider:model>      mutant: the model is called, and the proxy replaces every
 *                                    chat response's output with {"facts":[]}
 * The first arm is the baseline; every later arm is judged against it by the
 * preregistered rule (score.ts `decide`). Mutants must fail.
 *
 * Usage:
 *   bun eval/runner/facts-absorb-gate.ts --gbrain <checkout>@<ref> \
 *     --arms sonnet46=default,luna=openai:gpt-6-luna,haiku55=anthropic:claude-haiku-5-5,disabled=disabled,drop=drop:openai:gpt-6-luna \
 *     [--seeds 60,61] [--prereg <path>] [--sample-reads 30] --budget-usd <n> [--budget-ledger <path>] --out <dir>
 * Paid arms refuse to start without --prereg (its sha256 goes in the receipt).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { GbrainSlot, McpClient, MeteringProxy, GBRAIN_EMBED_MODEL, type Meter } from './cat40/gbrain-arm.ts';
import { runCli } from './lifecycle/drivers.ts';
import { prepareBuild } from './lifecycle/builds.ts';
import { budgetOptionsFrom, startPaidRun } from './budget-ledger.ts';
import { generateFactsAbsorbWorld, renderSessionNote, type FactsAbsorbWorld } from '../generators/facts-absorb-gen.ts';
import { decide, scoreArm, valueToken, type ArmScore, type ArmValidity, type StoredFact, type Verdict } from './facts-absorb/score.ts';
import { Rng } from '../generators/seeded.ts';
import { scrubMachinePaths } from './receipt.ts';
import { scoreSalienceCoverage } from './cat35-judges.ts';
import { pairedNatural, type NaturalPage } from './facts-absorb/natural.ts';

export const SHIPPED_DEFAULT_MODEL = 'anthropic:claude-sonnet-4-6';
export const DROPPED_OUTPUT = '{"facts":[]}';
/** Extraction outcomes that mean the model's output could not be used. */
export const PARSE_REASONS = ['malformed_output', 'parse_failure', 'truncated_output', 'non_terminal_stop'] as const;

export type ArmSpec = { label: string; kind: 'default' | 'model' | 'disabled' | 'drop'; model: string | null };

export function parseArms(spec: string): ArmSpec[] {
  return spec.split(',').map(s => {
    const [label, value] = s.split('=') as [string, string];
    if (!label || !value) throw new Error(`arm "${s}" is not label=spec`);
    if (value === 'default') return { label, kind: 'default', model: null };
    if (value === 'disabled') return { label, kind: 'disabled', model: null };
    if (value.startsWith('drop:')) return { label, kind: 'drop', model: value.slice(5) };
    if (!value.includes(':')) throw new Error(`arm "${s}": model must be provider:model`);
    return { label, kind: 'model', model: value };
  });
}

/** Replace the model output of a chat response with an empty facts list (Anthropic messages, OpenAI chat and responses). */
export function dropChatOutput(text: string): { text: string; dropped: boolean } {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return { text, dropped: false }; }
  let dropped = false;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if ((o.type === 'text' || o.type === 'output_text') && typeof o.text === 'string') { o.text = DROPPED_OUTPUT; dropped = true; }
    if (o.type === 'tool_use' && o.input && typeof o.input === 'object') { o.input = { facts: [] }; dropped = true; }
    if (o.role === 'assistant' && typeof o.content === 'string') { o.content = DROPPED_OUTPUT; dropped = true; }
    if (typeof o.output_text === 'string') { o.output_text = DROPPED_OUTPUT; dropped = true; }
    for (const k of Object.keys(o)) if (k !== 'usage') walk(o[k]);
  };
  walk(body);
  return { text: JSON.stringify(body), dropped };
}

interface CallLine { kind: string; model: string; outcome: string; input_tokens: number | 'unknown'; output_tokens: number | 'unknown'; effect?: string; job_name?: string; job_id?: number }
interface JobRow { id: number; name: string; status: string; attempts_made: number; result: Record<string, unknown> | null; error_text: string | null; data: Record<string, unknown> }
interface IngestRow { source_type: string; source_ref: string; summary: string }

const tokens = (v: number | 'unknown') => (typeof v === 'number' ? v : 0);

/** Read a brain from a fresh process (after every gbrain process exited): facts, jobs and the facts:absorb failure log. */
function readBrain(buildDir: string, dataDir: string): { facts: Array<StoredFact & Record<string, unknown>>; jobs: JobRow[]; ingest: IngestRow[] } {
  const pglite = join(buildDir, 'node_modules/@electric-sql/pglite/dist');
  const script = `const { PGlite } = await import(${JSON.stringify(`${pglite}/index.js`)}); const { vector } = await import(${JSON.stringify(`${pglite}/vector/index.js`)}); const { pg_trgm } = await import(${JSON.stringify(`${pglite}/contrib/pg_trgm.js`)});
const db = await PGlite.create({ dataDir: ${JSON.stringify(dataDir)}, extensions: { vector, pg_trgm } });
const facts = (await db.query("SELECT id, fact, kind, entity_slug, attributed_to, context, source, notability, confidence, valid_from, expired_at, superseded_by, claim_metric, claim_value, visibility FROM facts ORDER BY id")).rows;
const jobs = (await db.query("SELECT id, name, status, attempts_made, result, error_text, data FROM minion_jobs ORDER BY id")).rows;
const ingest = (await db.query("SELECT source_type, source_ref, summary FROM ingest_log ORDER BY id")).rows;
await db.close(); process.stdout.write(JSON.stringify({ facts, jobs, ingest }));`;
  const out = execFileSync('bun', ['-e', script], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const parsed = JSON.parse(out) as { facts: Array<StoredFact & Record<string, unknown>>; jobs: JobRow[]; ingest: IngestRow[] };
  for (const f of parsed.facts) f.claim_value = f.claim_value === null || f.claim_value === undefined ? null : Number(f.claim_value);
  return parsed;
}

/** The seeds' worlds as one corpus (page slugs carry the seed; claim ids repeat across seeds, so claims are keyed by id and page). */
export function combineWorlds(seeds: readonly number[]): FactsAbsorbWorld {
  const worlds = seeds.map(seed => generateFactsAbsorbWorld({ seed }));
  return {
    ...worlds[0], seed: seeds[0], fingerprint: worlds.map(w => w.fingerprint).join('+'),
    sessions: worlds.flatMap(w => w.sessions), claims: worlds.flatMap(w => w.claims), rejections: worlds.flatMap(w => w.rejections), asides: worlds.flatMap(w => w.asides),
  };
}

export const sampleReadSummary = (rows: Awaited<ReturnType<typeof readSample>>) => ({ checked: rows.length, all_found: rows.filter(s => s.found.length === s.expected.length).length, rows });

export function parseFailureCounts(jobs: readonly JobRow[], ingest: readonly IngestRow[]) {
  const facts = jobs.filter(j => j.name === 'facts-absorb');
  const reasonOf = (j: JobRow) => {
    const r = j.result?.skipped_reason;
    if (typeof r === 'string') return r;
    const e = j.error_text ?? '';
    return PARSE_REASONS.find(p => e.includes(p)) ?? null;
  };
  const failures = facts.filter(j => (PARSE_REASONS as readonly string[]).includes(reasonOf(j) ?? ''));
  const logged = new Set(ingest.filter(r => r.source_type.includes('facts') && PARSE_REASONS.some(p => r.summary.startsWith(p))).map(r => r.source_ref));
  const slugOf = (j: JobRow) => String(j.data?.slug ?? '');
  const unhandled = failures.filter(j => j.status === 'completed' && !logged.has(slugOf(j)) && ![...logged].some(ref => ref.includes(slugOf(j))));
  return {
    jobs: facts.length,
    completed: facts.filter(j => j.status === 'completed').length,
    not_completed: facts.filter(j => j.status !== 'completed').map(j => ({ id: j.id, status: j.status, error: (j.error_text ?? '').slice(0, 300) })),
    parse_failures: failures.length,
    parse_failures_logged: failures.length - unhandled.length,
    unhandled_parse_failures: unhandled.length,
    skipped_reasons: Object.fromEntries([...new Set(facts.map(reasonOf).filter(Boolean))].map(r => [r, facts.filter(j => reasonOf(j) === r).length])),
  };
}

/** Natural-prose stratum: the Cat 35 transcript-distill-v1 transcripts (written by Claude Opus 4.5, development data) with planted salient items. */
export interface NaturalTranscript { slug: string; id: string; content: string; items: Array<{ item_id: string; statement: string }> }

export function loadNaturalTranscripts(dir = join(import.meta.dir, '../data/transcript-distill-v1')): NaturalTranscript[] {
  const txt = readdirSync(join(dir, 'transcripts-txt')).sort();
  return readdirSync(join(dir, 'gold')).sort().flatMap(f => {
    const g = JSON.parse(readFileSync(join(dir, 'gold', f), 'utf8')) as { transcript_id: string; base_ts: string; items: Array<{ item_id: string; statement: string }> };
    if (!g.items.length) return [];
    const file = txt.find(t => t.endsWith(`-${g.transcript_id}.txt`))!;
    const date = g.base_ts.slice(0, 10);
    const body = readFileSync(join(dir, 'transcripts-txt', file), 'utf8');
    const content = ['---', 'type: note', `date: ${JSON.stringify(date)}`, `title: ${JSON.stringify(`Conversation on ${date}`)}`, '---', '', body].join('\n');
    return [{ slug: `conversations/td-${g.transcript_id}`, id: g.transcript_id, content, items: g.items.map(i => ({ item_id: i.item_id, statement: i.statement })) }];
  });
}

/**
 * Product read path in a fresh process: a seeded sample of recalled claims (amounts excluded) read back through
 * `gbrain call recall {grep: <value>}`; `found` lists the matched facts the operation returned.
 */
export async function readSample(world: FactsAbsorbWorld, score: Pick<ArmScore, 'claims'>, run: GbrainSlot['run'], n: number) {
  const rng = new Rng(7);
  const recalled = rng.shuffle(score.claims.filter(c => c.recalled)).slice(0, n);
  const rows: Array<{ claim: string; page: string; token: string; expected: number[]; found: number[] }> = [];
  for (const c of recalled) {
    const claim = world.claims.find(x => x.id === c.id && x.page === c.page)!;
    if (claim.amount !== undefined) continue;
    const token = valueToken(claim);
    const r = await runCli(run, ['call', 'recall', JSON.stringify({ grep: token, limit: 100 })], 120_000);
    let found: number[] = [];
    try { found = (JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { facts: Array<{ id: number }> }).facts.map(f => Number(f.id)); } catch { /* recorded as not found */ }
    rows.push({ claim: c.id, page: c.page, token, expected: c.fact_ids, found: c.fact_ids.filter(id => found.includes(id)) });
  }
  return rows;
}

async function runArm(arm: ArmSpec, world: FactsAbsorbWorld, natural: readonly NaturalTranscript[], buildDir: string, root: string, proxy: MeteringProxy, opts: { workerConcurrency: number; sampleReads: number; judgeModel: string }) {
  const slot = new GbrainSlot(`fa-${arm.label}`, root, buildDir, proxy.port, 'full');
  const callLog = join(slot.dir, 'ai-calls.jsonl');
  slot.run.env.GBRAIN_AI_CALL_LOG = callLog;
  for (const d of ['home', 'uh']) mkdirSync(join(slot.dir, d), { recursive: true });
  const cli = async (args: string[], timeout = 600_000) => {
    const r = await runCli(slot.run, args, timeout);
    if (r.code !== 0) throw new Error(`gbrain ${args.join(' ')} failed (${r.code}): ${(r.stdout + r.stderr).slice(-800)}`);
    return r;
  };
  const dataDir = join(slot.dir, 'home', 'brain.pglite');
  await cli(['init', '--pglite', '--path', dataDir, '--embedding-model', GBRAIN_EMBED_MODEL, '--non-interactive']);
  if (arm.kind === 'disabled') await cli(['config', 'set', 'facts.extraction_enabled', 'false']);
  if (arm.model) await cli(['config', 'set', 'facts.extraction_model', arm.model]);
  writeFileSync(callLog, '');
  const meterKey = `arm:${arm.label}`;
  proxy.bind(slot.id, meterKey);
  const client = new McpClient(slot.run, ['--surface', 'full']);
  await client.start();
  const t0 = Date.now();
  let writeErrors = 0;
  for (const s of world.sessions) {
    const r = await client.call('put_page', { slug: s.slug, content: renderSessionNote(s) });
    if (r.startsWith('Error')) { writeErrors++; process.stderr.write(`[facts-absorb] put_page ${s.slug}: ${r.slice(0, 200)}\n`); }
  }
  for (const t of natural) {
    const r = await client.call('put_page', { slug: t.slug, content: t.content });
    if (r.startsWith('Error')) { writeErrors++; process.stderr.write(`[facts-absorb] put_page ${t.slug}: ${r.slice(0, 200)}\n`); }
  }
  const writeS = (Date.now() - t0) / 1000;
  await client.close();
  const d0 = Date.now();
  const work = await runCli(slot.run, ['jobs', 'work', '--concurrency', String(opts.workerConcurrency)], 3 * 3_600_000);
  const drainS = (Date.now() - d0) / 1000;
  const warnings = (work.stdout + work.stderr).split('\n').filter(l => l.includes('[facts-extract] WARN'));
  // Restart: every gbrain process has exited; a fresh process reads the brain.
  const brain = readBrain(buildDir, dataDir);
  const ids = new Set(brain.facts.map(f => f.id));
  const inserted = brain.jobs.filter(j => j.name === 'facts-absorb').flatMap(j => (Array.isArray(j.result?.fact_ids) ? j.result!.fact_ids as number[] : []));
  const unreadable = inserted.filter(id => !ids.has(id));
  const naturalSlugs = new Set(natural.map(t => t.slug));
  const onNatural = (f: StoredFact) => [...naturalSlugs].find(sl => (f.context ?? '').startsWith(sl)) ?? null;
  const score = scoreArm(world, brain.facts.filter(f => !onNatural(f)));
  // Natural stratum: the Cat 35 coverage judge decides which planted items the stored facts cover.
  const naturalPages: NaturalPage[] = [];
  for (const t of natural) {
    const facts = brain.facts.filter(f => !f.expired_at && onNatural(f) === t.slug);
    const document = facts.map(f => `- [${String(f.kind ?? 'fact')}] ${f.fact}`).join('\n');
    if (!facts.length) { naturalPages.push({ page: t.slug, items: t.items.length, full: 0, partial: 0, judge_failed: 0, facts: 0, verdicts: [] }); continue; }
    const j = await scoreSalienceCoverage({ lane: 'facts-absorb', transcript_id: t.id, document, items: t.items }, { model: opts.judgeModel });
    naturalPages.push({ page: t.slug, items: t.items.length, full: j.verdicts.filter(v => v.status === 'FULL').length, partial: j.verdicts.filter(v => v.status === 'PARTIAL').length, judge_failed: j.judge_failed_ids.length, facts: facts.length, verdicts: j.verdicts.map(v => ({ item_id: v.item_id, status: v.status })) });
  }
  const sampleReads = await readSample(world, score, slot.run, opts.sampleReads);
  proxy.unbind(slot.id);
  const meter: Meter = await proxy.finalize(meterKey);
  const lines = readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as CallLine);
  const extraction = lines.filter(l => l.kind === 'chat' && (l.effect === 'facts-absorb' || l.job_name === 'facts-absorb'));
  const otherChat = lines.filter(l => l.kind === 'chat' && !extraction.includes(l));
  const resolvedModels = [...new Set(extraction.map(l => l.model))];
  const expectedModel = arm.kind === 'default' ? SHIPPED_DEFAULT_MODEL : arm.model;
  const parse = parseFailureCounts(brain.jobs, brain.ingest);
  const validity: ArmValidity = {
    unhandled_parse_failures: parse.unhandled_parse_failures,
    resolved_model_matches: arm.kind === 'disabled' ? extraction.length === 0 : resolvedModels.length === 1 && resolvedModels[0] === expectedModel,
    unreadable_after_restart: unreadable.length,
    jobs_not_completed: parse.not_completed.length,
  };
  return {
    arm, expected_model: expectedModel, resolved_models_at_facts_invocation: resolvedModels,
    pages: world.sessions.length, write_errors: writeErrors, write_wall_s: writeS, job_drain_s: drainS,
    extraction_calls: extraction.length, extraction_input_tokens: extraction.reduce((a, l) => a + tokens(l.input_tokens), 0), extraction_output_tokens: extraction.reduce((a, l) => a + tokens(l.output_tokens), 0),
    extraction_outcomes: Object.fromEntries([...new Set(extraction.map(l => l.outcome))].map(o => [o, extraction.filter(l => l.outcome === o).length])),
    other_chat_calls: otherChat.map(l => `${l.model} ${l.effect ?? l.job_name ?? ''}`),
    parse, extractor_warnings: warnings.length, extractor_warning_samples: warnings.slice(0, 5),
    facts_stored: brain.facts.length, facts_active: brain.facts.filter(f => !f.expired_at).length, inserted_by_jobs: inserted.length, unreadable_after_restart: unreadable,
    sample_reads: sampleReadSummary(sampleReads),
    validity, totals: score.totals, natural: naturalPages, user_claims_attributed_to_assistant: score.user_claims_attributed_to_assistant, facts_without_page: score.facts_without_page,
    usd: Number(meter.usd.toFixed(4)), usd_by_model: meter.byModel, unpriced_requests: meter.unpriced, undrained_requests: meter.undrained ?? 0,
    score, facts: brain.facts, ingest_log: brain.ingest,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const out = flag('--out');
  if (!out) throw new Error('usage: --gbrain <checkout>@<ref> --arms <label=spec,...> --out <dir> --budget-usd <n> (or --rescore / --reread with --out)');
  const arms = parseArms(flag('--arms') ?? 'sonnet46=default,luna=openai:gpt-6-luna,haiku55=anthropic:claude-haiku-5-5,disabled=disabled,drop=drop:openai:gpt-6-luna');
  if (argv.includes('--rescore')) {
    // Score the facts a finished run stored again with the current scorer (no model calls, no brain access); the receipt is untouched.
    const receipt = JSON.parse(readFileSync(join(resolve(out), 'receipt.json'), 'utf8')) as { world: { seeds: number[] }; baseline: string; arms: Array<{ arm: ArmSpec; validity: ArmValidity; natural: NaturalPage[] }> };
    const w = combineWorlds(receipt.world.seeds);
    const naturalSlugs = loadNaturalTranscripts().map(t => t.slug);
    const scored = receipt.arms.map(a => {
      const saved = JSON.parse(readFileSync(join(resolve(out), `arm-${a.arm.label}.json`), 'utf8')) as { facts: StoredFact[] };
      return { ...a, score: scoreArm(w, saved.facts.filter(f => !naturalSlugs.some(sl => (f.context ?? '').startsWith(sl)))) };
    });
    const [base, ...rest] = scored;
    const verdicts = rest.map(r => {
      const verdict = decide(base.score, r.score, r.validity);
      const n = pairedNatural(base.natural, r.natural);
      verdict.checks.push({ name: 'natural-prose recall harm check', pass: n.pass, detail: n.detail });
      verdict.pass = verdict.checks.every(c => c.pass);
      return { label: r.arm.label, mutant: r.arm.kind === 'disabled' || r.arm.kind === 'drop', verdict };
    });
    const result = { scorer: 'facts-absorb/score.ts at rescore time', totals: Object.fromEntries(scored.map(a => [a.arm.label, a.score.totals])), verdicts, mutants_fail: verdicts.filter(v => v.mutant).every(v => !v.verdict.pass) };
    writeFileSync(join(resolve(out), 'rescore.json'), JSON.stringify(result, null, 2));
    for (const a of scored) writeFileSync(join(resolve(out), `rescore-arm-${a.arm.label}.json`), JSON.stringify({ arm: a.arm, score: a.score }, null, 2));
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (argv.includes('--reread')) {
    // Re-run only the sample reads against the brains a finished run left behind (no model calls).
    const receiptFile = join(resolve(out), 'receipt.json');
    const receipt = JSON.parse(readFileSync(receiptFile, 'utf8')) as { world: { seeds: number[] }; arms: Array<{ arm: ArmSpec }> };
    const root = resolve(flag('--root') ?? join(process.env.HOME ?? '.', '.capy/work/facts-absorb-gate', basename(resolve(out))));
    const w = combineWorlds(receipt.world.seeds);
    const reread: Record<string, ReturnType<typeof sampleReadSummary>> = {};
    for (const { arm } of receipt.arms) {
      const saved = JSON.parse(readFileSync(join(resolve(out), `arm-${arm.label}.json`), 'utf8')) as { score: ArmScore };
      const slot = new GbrainSlot(`fa-${arm.label}`, root, join(root, 'builds', 'under-test'), 1, 'full');
      reread[arm.label] = sampleReadSummary(await readSample(w, saved.score, slot.run, Number(flag('--sample-reads') ?? 30)));
    }
    writeFileSync(join(resolve(out), 'sample-reads-reread.json'), JSON.stringify(reread, null, 2));
    console.log(JSON.stringify(Object.fromEntries(Object.entries(reread).map(([k, v]) => [k, { checked: v.checked, all_found: v.all_found }]))));
    return;
  }
  const spec = flag('--gbrain');
  if (!spec) throw new Error('usage: --gbrain <checkout>@<ref> --arms <label=spec,...> --out <dir> --budget-usd <n>');
  const prereg = flag('--prereg');
  if (!prereg && !argv.includes('--smoke')) throw new Error('paid arms need --prereg <path> (the preregistration, hashed into the receipt), or --smoke for an uncounted setup check');
  const seeds = (flag('--seeds') ?? '60,61').split(',').map(Number);
  const world = combineWorlds(seeds);
  const limit = flag('--pages') ? Number(flag('--pages')) : undefined;
  world.sessions = world.sessions.slice(0, limit);
  if (limit) {
    const keep = new Set(world.sessions.map(s => s.slug));
    world.claims = world.claims.filter(c => keep.has(c.page)); world.rejections = world.rejections.filter(r => keep.has(r.page)); world.asides = world.asides.filter(a => keep.has(a.page));
  }
  const natural = argv.includes('--no-natural') ? [] : loadNaturalTranscripts().slice(0, flag('--natural') ? Number(flag('--natural')) : undefined);
  const judgeModel = flag('--judge-model') ?? 'openai:gpt-6.1-sol';
  const [repo, ref] = spec.split('@') as [string, string];
  const root = resolve(flag('--root') ?? join(process.env.HOME ?? '.', '.capy/work/facts-absorb-gate', basename(resolve(out))));
  mkdirSync(root, { recursive: true });
  mkdirSync(resolve(out), { recursive: true });
  const build = prepareBuild(resolve(repo), { label: 'under-test', ref: ref ?? 'HEAD', description: 'gbrain under test' }, join(root, 'builds'));
  const log = (s: string) => process.stderr.write(`[facts-absorb] ${s}\n`);
  const { run: budget } = startPaidRun('facts-absorb-gate', { ...budgetOptionsFrom(argv), estimateUsd: null, log });
  const dropSlots = new Set(arms.filter(a => a.kind === 'drop').map(a => `fa-${a.label}`));
  const drops = { chat_responses: 0, dropped: 0 };
  const proxy = new MeteringProxy({
    transform: (slot, target, text) => {
      if (!dropSlots.has(slot) || !/\/(messages|chat\/completions|responses)(\?|$)/.test(target)) return text;
      drops.chat_responses++;
      const r = dropChatOutput(text);
      if (r.dropped) drops.dropped++;
      return r.text;
    },
  });
  proxy.start();
  const results: Array<Awaited<ReturnType<typeof runArm>>> = [];
  try {
    for (const arm of arms) {
      const allowance = budget.allowance(Number(flag('--arm-allowance-usd') ?? 8), `facts-absorb arm ${arm.label}`);
      proxy.allowances.set(`fa-${arm.label}`, allowance);
      try { results.push(await runArm(arm, world, natural, build.dir, root, proxy, { workerConcurrency: Number(flag('--worker-concurrency') ?? 4), sampleReads: Number(flag('--sample-reads') ?? 30), judgeModel })); }
      finally { proxy.allowances.delete(`fa-${arm.label}`); allowance.close(); }
      const r = results.at(-1)!;
      log(`${arm.label}: ${JSON.stringify({ resolved: r.resolved_models_at_facts_invocation, totals: r.totals, validity: r.validity, usd: r.usd })}`);
    }
  } finally { proxy.stop(); }
  const summary = budget.close({ finish: results.length === arms.length });
  const [base, ...rest] = results;
  const verdicts: Array<{ label: string; mutant: boolean; verdict: Verdict }> = rest.map(r => {
    const verdict = decide(base.score as ArmScore, r.score as ArmScore, r.validity);
    if (natural.length) {
      const n = pairedNatural(base.natural, r.natural);
      verdict.checks.push({ name: 'natural-prose recall harm check', pass: n.pass, detail: n.detail });
      verdict.pass = verdict.checks.every(c => c.pass);
    }
    return { label: r.arm.label, mutant: r.arm.kind === 'disabled' || r.arm.kind === 'drop', verdict };
  });
  const receipt = {
    schema: 'facts-absorb-gate-v1',
    gbrain: { repo, ref: ref ?? 'HEAD', commit: build.commit, version: build.version, tree: build.tree, verified: build.verified },
    preregistration: prereg ? { path: prereg, sha256: createHash('sha256').update(readFileSync(prereg)).digest('hex') } : null,
    smoke: !prereg,
    natural: { corpus: 'transcript-distill-v1', transcripts: natural.map(t => t.id), items: natural.reduce((a, t) => a + t.items.length, 0), judge_model: judgeModel },
    world: { generator: world.generator_version, seeds, fingerprint: world.fingerprint, pages: world.sessions.length, claims: world.claims.length, rejections: world.rejections.length, asides: world.asides.length },
    embedding_model: GBRAIN_EMBED_MODEL, drop_mutant_responses: drops,
    baseline: base.arm.label,
    verdicts,
    mutants_fail: verdicts.filter(v => v.mutant).every(v => !v.verdict.pass),
    arms: results.map(({ score, facts, ingest_log, ...r }) => r),
    budget: summary,
  };
  writeFileSync(join(resolve(out), 'receipt.json'), JSON.stringify(scrubMachinePaths(receipt), null, 2));
  for (const r of results) writeFileSync(join(resolve(out), `arm-${r.arm.label}.json`), JSON.stringify({ arm: r.arm, score: r.score, facts: r.facts, ingest_log: r.ingest_log }, null, 2));
  console.log(JSON.stringify({ verdicts: verdicts.map(v => ({ label: v.label, mutant: v.mutant, pass: v.verdict.pass, checks: v.verdict.checks })), mutants_fail: receipt.mutants_fail, budget: summary }, null, 2));
}

if (import.meta.main) await main();
