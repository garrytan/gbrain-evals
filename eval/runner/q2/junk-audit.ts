/**
 * Q2 grammar gates on sets N and K: G1 (natural junk), G3 (conformance), G4 (guard loss) and G2 (relation-line
 * precision in arm B's ingest brains). Reuses the P5 H3 minting pass (line-grammar-junk-audit.ts mintDocs).
 *
 *   mint      write every page of a set through put_page on the build under test with line_grammar.enabled=true and
 *             record every minted line (custody work root only: line text never reaches --output)
 *   g2-sample draw G2's stratified sample from the grammar lines the write-then-answer runner extracted from arm B
 *   label     label, with q2-judge-v1 and both judges, every candidate mint on N (G1), every baseline mint the
 *             candidate does not keep on N and every baseline and candidate mint on K (G4, K precision), and the G2 sample
 *   score     compute the gates; the receipt carries counts, outcomes and hashes only
 *
 * Custodian mode (sealed): `--n-dir <custody dir>` (n-manifest.json) or `--k-file <custody k-pages.jsonl>`, with
 * --decision-id, --purpose, and explicit --output and --work outside every git worktree, validated before any custody
 * file is read. Development mode: `--dev` reads development N (vault dev part, BEAM dev conversations, the dev stress
 * and template pages) or the development K pages.
 *
 * Usage (repository root):
 *   bun eval/runner/q2/junk-audit.ts mint --set N|K --arm baseline|candidate --gbrain <checkout>@<ref> --work <dir> --output <dir>
 *     (--dev [--strata vault,stress,templates,beam] | --n-dir <dir> | --k-file <file>) [--decision-id <id> --purpose <text>] [--limit N]
 *   bun eval/runner/q2/junk-audit.ts g2-sample --work <dir> --output <dir> --grammar-lines <file>[,<file>...] --seed <frozen seed> [--size 300]
 *   bun eval/runner/q2/junk-audit.ts label --work <dir> --output <dir> --paid (--budget-usd N | --budget-run-id <id>) [--judges claude-opus-5-5,gpt-6.1-sol]
 *   bun eval/runner/q2/junk-audit.ts score --work <dir> --output <dir>
 * Each accepts --campaign <root> --step <id> --run <name> (the runbook's commands).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseEvalConfig } from '../eval-config.ts';
import { gbrainSpecFrom, importGbrain, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { withHermeticEnv } from '../hermetic-env.ts';
import { mintDocs, type DocRecord, type MintDoc, type MintedLine } from '../line-grammar-junk-audit.ts';
import { openP5Brain, p5Receipt } from '../p5-brain.ts';
import { Checkpoint, closePaid, flagValue, limitFlag, openPaid, type PaidSession } from '../p5-agent.ts';
import { receiptCost, type RunSummary } from '../budget-ledger.ts';
import { writeReceipt, type GateOutcome } from '../receipt.ts';
import { assertCustodyRoots, openCustodyFile } from '../sealed-confirmation-lib.ts';
import { campaignGuard } from './campaign.ts';
import { AttemptCheckpoint } from './checkpoints.ts';
import { stratifiedByModel, type GrammarLine } from './grammar-lines.ts';
import { Q2_JUDGE_PROMPT_SHA256, Q2_JUDGE_PROMPT_VERSION, Q2_LINE_JUDGES, labelLines, lineOutcome, type LineToLabel, type LineVerdict } from './judge.ts';
import { q2ItemClass, q2ListLines, Q2_ZERO_TOLERANCE_CLASSES } from './junk-classes.ts';
import { devKPages, parseKPages, probeNearMiss, scoreK, K_GUARD_DECOYS, K_H2_DECOYS, K_NEAR_MISS, type KPage } from './k-conformance.ts';
import { devNDocs, loadNSet, N_LIST_LINE_FLOOR, N_STRATA, STRESS_SHAPED_FLOOR, type NStratum } from './n-corpus.ts';
import { clusterBootstrapProportion, wilson, wilsonUpperPer100k } from './stats.ts';

export const CATEGORY = 'q2-grammar-gates';
export const DECISION_ID = 'q2-parser-gaps-2026-10';
export const G2_DEFAULT_SIZE = 300;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** One line's identity across builds: page, line number, text and what the parser read. */
export const mintId = (m: Pick<MintedLine, 'doc' | 'line' | 'text' | 'kind' | 'parsed'>) => sha(`${m.doc}\u0000${m.line}\u0000${m.text}\u0000${m.kind}\u0000${m.parsed}`).slice(0, 32);

export interface MintMeta {
  set: 'N' | 'K'; arm: 'baseline' | 'candidate'; sealed: boolean; set_sha256: string; build: { version: string; commit: string | null; ref: string | null };
  pages: number; near_miss_accepted?: Record<string, boolean>; beam_excluded?: unknown; strata?: unknown; eval_config: Record<string, unknown> | null; finished_at: string;
}

const metaPath = (work: string, set: string, arm: string) => join(work, `mint-${set}-${arm}.json`);
const docsPath = (work: string, set: string, arm: string) => join(work, `mint-${set}-${arm}.docs.jsonl`);

export function readMint(work: string, set: 'N' | 'K', arm: 'baseline' | 'candidate'): { meta: MintMeta; docs: DocRecord[] } | null {
  if (!existsSync(metaPath(work, set, arm))) return null;
  return { meta: JSON.parse(readFileSync(metaPath(work, set, arm), 'utf8')), docs: new Checkpoint<DocRecord>(docsPath(work, set, arm)).values() };
}

/** The build's parser with the active pack's verbs, exactly as put_page reads lines (for the near-miss probe). */
async function buildParser(gut: GbrainUnderTest, config: Record<string, string>): Promise<(text: string) => { relations: Array<{ type: string }> }> {
  const grammar = await importGbrain<{ parseLineGrammar: (t: string, o: { declaredTypes?: ReadonlySet<string> | null }) => { relations: Array<{ type: string }> } }>(gut, 'src/core/line-grammar.ts');
  const { loadActivePackForLocalEngine } = await importGbrain<{ loadActivePackForLocalEngine: (e: unknown, o: { sourceId: string }) => Promise<{ manifest?: { link_types: Array<{ name: string }> } } | null> }>(gut, 'src/core/schema-pack/best-effort.ts');
  const brain = await openP5Brain(gut, config);
  try {
    const pack = (await loadActivePackForLocalEngine(brain.engine, { sourceId: 'default' }))?.manifest ?? null;
    const declared = config['line_grammar.allow_undeclared_types'] === 'true' ? null : pack?.link_types.length ? new Set(pack.link_types.map(l => l.name)) : null;
    return text => grammar.parseLineGrammar(text, { declaredTypes: declared });
  } finally { await brain.close(); }
}

function roots(argv: readonly string[], sealed: boolean, campaignOutput: string | null): { output: string; work: string } {
  const output = campaignOutput ?? flagValue(argv, '--output');
  const work = flagValue(argv, '--work');
  if (sealed) { const r = assertCustodyRoots({ output, work, needsWork: true }); return { output: r.output, work: r.work! }; }
  if (!output || !work) throw new Error('pass --output <dir> and --work <dir> (the work root keeps minted line text; the output gets receipts)');
  mkdirSync(output, { recursive: true }); mkdirSync(work, { recursive: true });
  return { output: resolve(output), work: resolve(work) };
}

// ─── mint ───────────────────────────────────────────────────────────

async function cmdMint(argv: string[], log: (s: string) => void): Promise<void> {
  const set = flagValue(argv, '--set') as 'N' | 'K';
  const arm = flagValue(argv, '--arm') as 'baseline' | 'candidate';
  if (set !== 'N' && set !== 'K') throw new Error('--set must be N or K');
  if (arm !== 'baseline' && arm !== 'candidate') throw new Error('--arm must be baseline or candidate');
  const nDir = flagValue(argv, '--n-dir');
  const kFile = flagValue(argv, '--k-file');
  const dev = argv.includes('--dev');
  if ([dev, !!nDir, !!kFile].filter(Boolean).length !== 1) throw new Error('pass exactly one of --dev, --n-dir <custody dir> or --k-file <custody file>');
  if ((set === 'N' && kFile) || (set === 'K' && nDir)) throw new Error('--n-dir goes with --set N and --k-file with --set K');
  const sealed = !dev;
  const campaign = campaignGuard(argv);
  const decisionId = flagValue(argv, '--decision-id');
  const purpose = flagValue(argv, '--purpose');
  if (sealed && (!decisionId || !purpose)) throw new Error('custodian mode needs --decision-id and --purpose, recorded in the access log before any custody file is read');
  const { output, work } = roots(argv, sealed, campaign?.output ?? null);
  const config = { ...parseEvalConfig(), 'line_grammar.enabled': 'true' };
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  const startedAt = new Date().toISOString();

  let docs: MintDoc[]; let setSha: string; let kPages: KPage[] | null = null; let extra: Partial<MintMeta> = {};
  if (set === 'N') {
    if (sealed) {
      const n = loadNSet(nDir!, { decisionId: decisionId!, purpose: purpose! });
      docs = n.docs; setSha = n.manifest_sha256; extra = { beam_excluded: n.beam_excluded, strata: n.strata };
    } else {
      const strata = (flagValue(argv, '--strata') ?? 'vault,stress,templates').split(',') as NStratum[];
      for (const s of strata) if (!N_STRATA.includes(s)) throw new Error(`unknown stratum ${s}`);
      docs = devNDocs(strata); setSha = sha(JSON.stringify(docs.map(d => [d.id, sha(d.content)])));
      extra = { strata: strata.map(id => ({ id, files: docs.filter(d => d.corpus === id).length, source: 'development material' })) };
    }
  } else {
    if (sealed) { const { bytes, sha256 } = openCustodyFile({ file: kFile!, flag: '--k-file', decisionId, purpose }); kPages = parseKPages(bytes.toString('utf8')); setSha = sha256; }
    else { kPages = devKPages(); setSha = sha(JSON.stringify(kPages)); }
    docs = kPages.map(p => ({ id: p.id, corpus: 'k', slug: p.slug, content: p.content }));
    writeFileSync(join(work, 'k-pages.jsonl'), kPages.map(p => JSON.stringify(p)).join('\n') + '\n');
  }
  const limit = limitFlag(argv);
  if (limit !== null) docs = docs.slice(0, limit);
  const other = readMint(work, set, arm === 'baseline' ? 'candidate' : 'baseline');
  if (other && other.meta.set_sha256 !== setSha) throw new Error(`the ${other.meta.arm} arm in ${work} minted a different ${set} (sha256 ${other.meta.set_sha256.slice(0, 12)}, now ${setSha.slice(0, 12)}); both arms must read the same set`);
  log(`mint ${set} ${arm}: gbrain ${gut.version}${gut.overlay ? ` ${gut.overlay.build.commit.slice(0, 12)}` : ''}, ${docs.length} pages (${sealed ? 'custody' : 'development'})`);
  const ckpt = new Checkpoint<DocRecord>(docsPath(work, set, arm));
  let harnessError: string | null = null;
  let configRecord: Record<string, unknown> | null = null;
  let accepted: Record<string, boolean> | undefined;
  try {
    configRecord = await mintDocs(gut, docs, config, ckpt, log, q2ListLines, q2ItemClass);
    if (set === 'K') accepted = await withHermeticEnv(CATEGORY, async () => probeNearMiss(await buildParser(gut, config)));
  } catch (e) { harnessError = (e as Error).message; }
  const records = ckpt.values().filter(r => docs.some(d => `${d.corpus}|${d.id}` === r.key));
  const meta: MintMeta = { set, arm, sealed, set_sha256: setSha, build: { version: gut.version, commit: gut.overlay?.build.commit ?? null, ref: gut.overlay?.ref ?? null }, pages: docs.length,
    ...(accepted ? { near_miss_accepted: accepted } : {}), ...extra, eval_config: configRecord, finished_at: new Date().toISOString() };
  if (!harnessError) writeFileSync(metaPath(work, set, arm), JSON.stringify(meta, null, 2) + '\n');
  const errors = records.filter(r => r.error).length;
  const receipt = p5Receipt({
    category: `${CATEGORY}-mint`, gut, startedAt, rows: [], harnessError: harnessError ?? (errors ? `${errors} page(s) failed the write or the count cross-check; rerun the same command to retry them after fixing the cause` : null),
    accounting: { planned: docs.length, attempted: records.length, scored: records.length - errors, errors },
    summary: { set, arm, pages: docs.length, list_lines: records.reduce((a, r) => a + r.list_lines, 0), minted: records.reduce((a, r) => a + r.minted.length, 0), ...(accepted ? { near_miss_accepted: accepted } : {}), ...(extra.beam_excluded ? { beam_excluded: extra.beam_excluded } : {}) },
    basis: 'hermetic minting pass: put_page on in-memory PGLite, no model call',
    resolvedConfig: { set, arm, sealed, set_sha256: setSha, eval_config: configRecord ?? { requested: config }, line_text: 'kept in the work root only' },
  });
  writeReceipt(join(output, 'receipt.json'), receipt);
  campaign?.finish(join(output, 'receipt.json'), 0);
  log(`receipt: ${join(output, 'receipt.json')}`);
  if (receipt.run_status === 'error') throw new Error(String((receipt.data as { harness_error: string }).harness_error));
}

// ─── g2-sample ──────────────────────────────────────────────────────

export interface G2Sample { seed: number; size: number; stratum_sha256: string; relation: { allocation: Record<string, { lines: number; drawn: number }>; lines: GrammarLine[] }; fact: { allocation: Record<string, { lines: number; drawn: number }>; lines: GrammarLine[] } }

export function drawG2(lines: readonly GrammarLine[], seed: number, size = G2_DEFAULT_SIZE): G2Sample {
  const armB = lines.filter(l => l.arm === 'B');
  const rel = stratifiedByModel(armB.filter(l => l.kind === 'relation'), size, seed);
  const fact = stratifiedByModel(armB.filter(l => l.kind === 'fact'), size, seed + 1000);
  return { seed, size, stratum_sha256: sha(armB.map(l => l.id).sort().join('\n')), relation: { allocation: rel.allocation, lines: rel.sample }, fact: { allocation: fact.allocation, lines: fact.sample } };
}

async function cmdG2Sample(argv: string[], log: (s: string) => void): Promise<void> {
  const campaign = campaignGuard(argv);
  const files = (flagValue(argv, '--grammar-lines') ?? '').split(',').filter(Boolean);
  const seed = Number(flagValue(argv, '--seed'));
  if (!files.length || !Number.isInteger(seed)) throw new Error('g2-sample needs --grammar-lines <file>[,...] (written by write-then-answer.ts in its work root) and the frozen --seed');
  const { output, work } = roots(argv, true, campaign?.output ?? null);
  const lines = files.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as GrammarLine));
  const sample = drawG2(lines, seed, Number(flagValue(argv, '--size') ?? G2_DEFAULT_SIZE));
  writeFileSync(join(work, 'g2-sample.json'), JSON.stringify(sample) + '\n');
  const summary = { seed, stratum_sha256: sample.stratum_sha256, relation_allocation: sample.relation.allocation, fact_allocation: sample.fact.allocation };
  writeFileSync(join(output, 'g2-sample-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  campaign?.finish(join(output, 'g2-sample-summary.json'), 0);
  log(`G2 sample: ${sample.relation.lines.length} relation lines, ${sample.fact.lines.length} fact lines; ${JSON.stringify(sample.relation.allocation)}`);
}

// ─── label ──────────────────────────────────────────────────────────

const toLabel = (m: MintedLine): LineToLabel => ({ id: mintId(m), kind: m.kind, parsed: m.parsed, text: m.text, context: m.context });

/** Every line the gates need labeled: candidate N mints, baseline N mints the candidate does not keep, all K mints, the G2 sample. */
export function linesToLabel(work: string): { lines: LineToLabel[]; parts: Record<string, number> } {
  const byId = new Map<string, LineToLabel>();
  const parts: Record<string, number> = {};
  const add = (part: string, ls: LineToLabel[]) => { parts[part] = ls.length; for (const l of ls) byId.set(l.id, l); };
  const nc = readMint(work, 'N', 'candidate'), nb = readMint(work, 'N', 'baseline'), kc = readMint(work, 'K', 'candidate'), kb = readMint(work, 'K', 'baseline');
  const mints = (x: ReturnType<typeof readMint>) => (x?.docs ?? []).flatMap(d => d.minted);
  const candN = new Set(mints(nc).map(mintId));
  add('N candidate mints (G1)', mints(nc).map(toLabel));
  add('N baseline-only mints (G4)', mints(nb).filter(m => !candN.has(mintId(m))).map(toLabel));
  add('K baseline mints (G4)', mints(kb).map(toLabel));
  add('K candidate mints (precision)', mints(kc).map(toLabel));
  if (existsSync(join(work, 'g2-sample.json'))) {
    const s = JSON.parse(readFileSync(join(work, 'g2-sample.json'), 'utf8')) as G2Sample;
    add('G2 relation sample', s.relation.lines.map(l => ({ id: l.id, kind: l.kind, parsed: l.parsed, text: l.text, context: l.context })));
    add('G2 fact sample (reported)', s.fact.lines.map(l => ({ id: l.id, kind: l.kind, parsed: l.parsed, text: l.text, context: l.context })));
  }
  return { lines: [...byId.values()], parts };
}

async function cmdLabel(argv: string[], log: (s: string) => void): Promise<void> {
  const campaign = campaignGuard(argv);
  const { output, work } = roots(argv, true, campaign?.output ?? null);
  const judges = (flagValue(argv, '--judges') ?? Q2_LINE_JUDGES.join(',')).split(',');
  const { lines, parts } = linesToLabel(work);
  const ckpt = new AttemptCheckpoint<{ verdict: LineVerdict }>(join(work, 'labels.jsonl'));
  const todo = lines.filter(l => judges.some(j => ckpt.todo([`${l.id}|${j}`]).length));
  log(`label: ${lines.length} lines (${Object.entries(parts).map(([k, v]) => `${k} ${v}`).join('; ')}), ${todo.length} still need a label`);
  let paid: PaidSession | null = null; let summary: RunSummary | null = null; let err: string | null = null;
  if (todo.length) {
    paid = openPaid(argv, CATEGORY, Number(flagValue(argv, '--estimate-usd') ?? (todo.length * judges.length * 0.02).toFixed(2)), join(work, 'budget-run.json'), log);
    try { await labelLines(todo, ckpt, { judges, log, exhausted: () => !!paid?.guard.exhausted }); } catch (e) { err = (e as Error).message; }
    finally { summary = closePaid(paid, !err); }
  }
  const counts = ckpt.counts(lines.flatMap(l => judges.map(j => `${l.id}|${j}`)));
  const report = { judges, judge_prompt: Q2_JUDGE_PROMPT_VERSION, judge_prompt_sha256: Q2_JUDGE_PROMPT_SHA256, lines: lines.length, parts, label_states: counts, spend_usd: ckpt.spendUsd(), error: err };
  writeFileSync(join(output, 'label-summary.json'), JSON.stringify({ ...report, ...(summary ? { cost: receiptCost(summary) } : {}) }, null, 2) + '\n');
  campaign?.finish(join(output, 'label-summary.json'), summary ? receiptCost(summary).usd : 0);
  if (err || counts.retryable || counts.not_started) {
    log(`label incomplete: ${counts.retryable + counts.not_started} (line, judge) pairs left${err ? ` (${err})` : ''}; cumulative label spend $${ckpt.spendUsd().toFixed(2)}. Resume with the same command.`);
    process.exitCode = 3;
  }
}

// ─── score ──────────────────────────────────────────────────────────

const gate = (g: Omit<GateOutcome, 'denominators'> & { denominators?: GateOutcome['denominators'] }, d: GateOutcome['denominators']): GateOutcome => ({ ...g, denominators: g.denominators ?? d });

/** G1 from the candidate's N mints and their labels. */
export function scoreG1(docs: readonly DocRecord[], outcome: (id: string) => 'correct' | 'wrong' | 'unlabeled'): { gates: GateOutcome[]; summary: Record<string, unknown> } {
  const minted = docs.flatMap(d => d.minted.map(m => ({ m, stratum: d.corpus, o: outcome(mintId(m)) })));
  const listLines = docs.reduce((a, d) => a + d.list_lines, 0);
  const errors = docs.filter(d => d.error).length;
  const stressShaped = docs.filter(d => d.corpus === 'stress').reduce((a, d) => a + (d.zero_tolerance_list_lines.template_slot ?? 0) + (d.zero_tolerance_list_lines.usage_label ?? 0), 0);
  const wrong = minted.filter(x => x.o === 'wrong').length;
  const unlabeled = minted.filter(x => x.o === 'unlabeled').length;
  const zt = minted.filter(x => x.m.zero_tolerance);
  const stressWrong = minted.filter(x => x.stratum === 'stress' && x.o === 'wrong').length;
  const per100k = wilsonUpperPer100k(wrong, listLines);
  const d = { planned: minted.length, attempted: minted.length, scored: minted.length - unlabeled, errors: unlabeled };
  const pageD = { planned: docs.length, attempted: docs.length, scored: docs.length - errors, errors };
  const blocked = errors ? { outcome: 'blocked' as const, reason: `${errors} page(s) of N failed the write or the count cross-check, so their lines are unmeasured` } : null;
  const needLabels = unlabeled ? { outcome: 'not_run' as const, reason: `${unlabeled} minted line(s) still lack a label from every judge; rerun label` } : null;
  const floorOk = listLines >= N_LIST_LINE_FLOOR && stressShaped >= STRESS_SHAPED_FLOOR;
  const gates: GateOutcome[] = [
    gate({ gate: 'G1.material_floor', outcome: floorOk ? 'pass' : 'insufficient', threshold: `N holds >= ${N_LIST_LINE_FLOOR} list lines and the stress stratum >= ${STRESS_SHAPED_FLOOR} template- or label-shaped list lines`, observed: listLines,
      ...(floorOk ? {} : { failed_threshold: listLines < N_LIST_LINE_FLOOR ? `list lines ${listLines} < ${N_LIST_LINE_FLOOR}` : `stress template- or label-shaped lines ${stressShaped} < ${STRESS_SHAPED_FLOOR}` }) }, pageD),
    gate({ gate: 'G1.zero_tolerance', ...(blocked ?? { outcome: zt.length ? 'fail' : 'pass' }), threshold: 'zero-tolerance classes minted = 0, exact', observed: zt.length, ...(zt.length && !blocked ? { failed_threshold: 'zero-tolerance classes minted = 0' } : {}) }, { planned: minted.length, attempted: minted.length, scored: minted.length, errors: 0 }),
    gate({ gate: 'G1.stress_wrong', ...(blocked ?? (stressWrong ? { outcome: 'fail' as const } : needLabels ?? { outcome: 'pass' as const })), threshold: 'stress stratum wrong mints = 0, exact', observed: stressWrong, ...(stressWrong && !blocked ? { failed_threshold: 'stress wrong mints = 0' } : {}) }, d),
    gate({ gate: 'G1.wrong_per_100k', ...(blocked ?? needLabels ?? { outcome: per100k <= 2 ? 'pass' as const : 'fail' as const }), threshold: 'Wilson 95% upper bound of wrong mints <= 2 per 100,000 list lines', observed: per100k,
      ...(!blocked && !needLabels && per100k > 2 ? { failed_threshold: `Wilson upper ${per100k.toFixed(3)} > 2 per 100,000` } : {}) }, d),
  ];
  const affected = new Set(minted.filter(x => x.o === 'wrong').map(x => `${x.stratum}|${x.m.doc}`)).size;
  const pagesWithList = docs.filter(d => d.list_lines > 0).length;
  const correct = minted.filter(x => x.o === 'correct').length;
  return { gates, summary: {
    pages: docs.length, pages_with_list_lines: pagesWithList, list_lines: listLines, minted: minted.length, wrong, unlabeled, correct, stress_template_or_label_lines: stressShaped,
    wilson_upper_per_100k: per100k, affected_page_rate: pagesWithList ? affected / pagesWithList : null,
    precision: minted.length >= 30 && !unlabeled ? { correct, minted: minted.length, ...wilson(correct, minted.length) } : { note: minted.length < 30 ? 'fewer than 30 mints; precision not reported' : 'labels incomplete' },
    zero_tolerance_by_class: Object.fromEntries(Q2_ZERO_TOLERANCE_CLASSES.map(c => [c, zt.filter(x => x.m.zero_tolerance === c).length])),
    by_stratum: Object.fromEntries([...new Set(docs.map(d => d.corpus))].sort().map(s => [s, { pages: docs.filter(d => d.corpus === s).length, list_lines: docs.filter(d => d.corpus === s).reduce((a, d) => a + d.list_lines, 0),
      minted: minted.filter(x => x.stratum === s).length, wrong: minted.filter(x => x.stratum === s && x.o === 'wrong').length, correct: minted.filter(x => x.stratum === s && x.o === 'correct').length,
      relation_mints: minted.filter(x => x.stratum === s && x.m.kind === 'relation').length, fact_mints: minted.filter(x => x.stratum === s && x.m.kind === 'fact').length }])),
    page_errors: errors,
  } };
}

/** G4: of baseline mints both judges call correct (N and K), the share the candidate keeps (same line, same parse). */
export function scoreG4(sets: Array<{ set: string; baseline: readonly DocRecord[]; candidate: readonly DocRecord[] }>, outcome: (id: string) => 'correct' | 'wrong' | 'unlabeled'): { gate: GateOutcome; summary: Record<string, unknown> } {
  let correct = 0, kept = 0, unlabeled = 0, total = 0;
  const per: Record<string, { baseline_correct: number; kept: number; lost: number; unlabeled: number }> = {};
  for (const s of sets) {
    const cand = new Set(s.candidate.flatMap(d => d.minted).map(mintId));
    const p = (per[s.set] = { baseline_correct: 0, kept: 0, lost: 0, unlabeled: 0 });
    for (const m of s.baseline.flatMap(d => d.minted)) {
      total++;
      const o = outcome(mintId(m));
      if (o === 'unlabeled') { unlabeled++; p.unlabeled++; continue; }
      if (o !== 'correct') continue;
      correct++; p.baseline_correct++;
      if (cand.has(mintId(m))) { kept++; p.kept++; } else p.lost++;
    }
  }
  const share = correct ? kept / correct : null;
  const d = { planned: total, attempted: total, scored: total - unlabeled, errors: unlabeled };
  const g: GateOutcome = unlabeled ? { gate: 'G4.guard_loss', outcome: 'not_run', threshold: 'share of judge-correct baseline mints the candidate keeps >= 0.99', observed: share, denominators: d, reason: `${unlabeled} baseline mint(s) lack labels; rerun label` }
    : !correct ? { gate: 'G4.guard_loss', outcome: 'insufficient', threshold: 'share of judge-correct baseline mints the candidate keeps >= 0.99', observed: null, denominators: d, failed_threshold: 'at least one judge-correct baseline mint on N and K' }
    : { gate: 'G4.guard_loss', outcome: share! >= 0.99 ? 'pass' : 'fail', threshold: 'share of judge-correct baseline mints the candidate keeps >= 0.99', observed: share, denominators: d, ...(share! < 0.99 ? { failed_threshold: `kept ${kept}/${correct} = ${share!.toFixed(4)} < 0.99` } : {}) };
  return { gate: g, summary: { baseline_correct: correct, kept, lost: correct - kept, share, per_set: per } };
}

/** G3 gates from the K score. */
export function g3Gates(k: ReturnType<typeof scoreK>): GateOutcome[] {
  const d = { planned: k.relation.valid, attempted: k.relation.valid, scored: k.relation.valid, errors: 0 };
  const decoyClasses = [...K_H2_DECOYS, ...K_GUARD_DECOYS, ...K_NEAR_MISS.filter(c => !k.near_miss_accepted[c])];
  const decoyMinted = decoyClasses.reduce((a, c) => a + (k.decoys[c]?.minted ?? 0), 0);
  const decoyN = decoyClasses.reduce((a, c) => a + (k.decoys[c]?.candidates ?? 0), 0);
  const insufficient = k.below_minimum.length ? { outcome: 'insufficient' as const, failed_threshold: `K class minimums: ${k.below_minimum.join('; ')}` } : null;
  const recallOk = k.relation.recall !== null && k.relation.recall >= 0.98 && k.relation.wilson_lower >= 0.95;
  return [
    { gate: 'G3.relation_recall', ...(insufficient ?? { outcome: recallOk ? 'pass' : 'fail' }), threshold: 'valid relation candidates: recall >= 0.98 and Wilson lower bound >= 0.95', observed: k.relation.recall, denominators: d,
      ...(!insufficient && !recallOk ? { failed_threshold: `recall ${k.relation.recall?.toFixed(4)} (Wilson lower ${k.relation.wilson_lower.toFixed(4)}) vs >= 0.98 and >= 0.95` } : {}) },
    { gate: 'G3.decoys', ...(insufficient ?? { outcome: decoyMinted ? 'fail' : 'pass' }), threshold: `every decoy class minted = 0, exact (${decoyClasses.join(', ')})`, observed: decoyMinted, denominators: { planned: decoyN, attempted: decoyN, scored: decoyN, errors: 0 },
      ...(!insufficient && decoyMinted ? { failed_threshold: `decoys minted: ${decoyClasses.filter(c => k.decoys[c]?.minted).map(c => `${c} ${k.decoys[c].minted}`).join(', ')}` } : {}) },
  ];
}

/** G2 from the labeled sample: Wilson lower bound >= 0.95, fewer than 150 lines is insufficient. */
export function scoreG2(sample: G2Sample, outcome: (id: string) => 'correct' | 'wrong' | 'unlabeled', o: { seed: number; draws: number } = { seed: 20261006, draws: 10_000 }): { gate: GateOutcome; summary: Record<string, unknown> } {
  const rel = sample.relation.lines.map(l => ({ l, o: outcome(l.id) }));
  const unlabeled = rel.filter(x => x.o === 'unlabeled').length;
  const n = rel.length, k = rel.filter(x => x.o === 'correct').length;
  const w = wilson(k, n);
  const d = { planned: n, attempted: n, scored: n - unlabeled, errors: unlabeled };
  const threshold = 'relation-line precision Wilson lower bound >= 0.95 (n >= 150)';
  const g: GateOutcome = n < 150 ? { gate: 'G2.relation_precision', outcome: 'insufficient', threshold, observed: n ? k / n : null, denominators: d, failed_threshold: `sample n = ${n} < 150` }
    : unlabeled ? { gate: 'G2.relation_precision', outcome: 'not_run', threshold, observed: null, denominators: d, reason: `${unlabeled} sampled line(s) lack labels; rerun label` }
    : { gate: 'G2.relation_precision', outcome: w.lower >= 0.95 ? 'pass' : 'fail', threshold, observed: w.lower, denominators: d, ...(w.lower < 0.95 ? { failed_threshold: `Wilson lower ${w.lower.toFixed(4)} < 0.95 (${k}/${n})` } : {}) };
  const brains = new Map<string, { k: number; n: number }>();
  for (const x of rel) if (x.o !== 'unlabeled') { const key = `${x.l.corpus}|${x.l.model}|${x.l.ingest}`; const c = brains.get(key) ?? { k: 0, n: 0 }; c.n++; if (x.o === 'correct') c.k++; brains.set(key, c); }
  const facts = sample.fact.lines.map(l => outcome(l.id));
  const models = [...new Set(rel.map(x => x.l.model))].sort();
  return { gate: g, summary: { n, correct: k, wilson, wilson_lower: w.lower, wilson_upper: w.upper, by_brain_cluster: clusterBootstrapProportion([...brains.values()], o),
    per_model: Object.fromEntries(models.map(m => { const xs = rel.filter(x => x.l.model === m && x.o !== 'unlabeled'); const c = xs.filter(x => x.o === 'correct').length; return [m, { n: xs.length, correct: c, ...wilson(c, xs.length) }]; })),
    fact_precision_reported: { n: facts.filter(f => f !== 'unlabeled').length, correct: facts.filter(f => f === 'correct').length }, allocation: sample.relation.allocation } };
}

async function cmdScore(argv: string[], log: (s: string) => void): Promise<void> {
  const campaign = campaignGuard(argv);
  const { output, work } = roots(argv, true, campaign?.output ?? null);
  const ckpt = new AttemptCheckpoint<{ verdict: LineVerdict }>(join(work, 'labels.jsonl'));
  const judges = (flagValue(argv, '--judges') ?? Q2_LINE_JUDGES.join(',')).split(',');
  const outcome = (id: string) => lineOutcome(id, ckpt, judges);
  const nc = readMint(work, 'N', 'candidate'), nb = readMint(work, 'N', 'baseline'), kc = readMint(work, 'K', 'candidate'), kb = readMint(work, 'K', 'baseline');
  const gates: GateOutcome[] = [];
  const summary: Record<string, unknown> = {};
  const notRun = (g: string, threshold: string, why: string): GateOutcome => ({ gate: g, outcome: 'not_run', threshold, observed: null, denominators: { planned: 0, attempted: 0, scored: 0, errors: 0 }, reason: why });
  if (nc) { const g1 = scoreG1(nc.docs, outcome); gates.push(...g1.gates); summary.g1 = g1.summary; }
  else gates.push(notRun('G1', 'see preregistration G1', 'no candidate mint of N in the work root; run mint --set N --arm candidate'));
  if (kc) {
    const kPages = existsSync(join(work, 'k-pages.jsonl')) ? parseKPages(readFileSync(join(work, 'k-pages.jsonl'), 'utf8')) : null;
    if (!kPages) gates.push(notRun('G3', 'see preregistration G3', 'the work root has no k-pages.jsonl copy; rerun mint --set K'));
    else {
      const k = scoreK(kPages, kc.docs.flatMap(d => d.minted.map(m => ({ doc: d.doc, text: m.text, kind: m.kind, parsed: m.parsed }))), kc.meta.near_miss_accepted as Record<'colon_type' | 'bold_type' | 'backtick_type', boolean>);
      gates.push(...g3Gates(k)); summary.g3 = k;
    }
  } else gates.push(notRun('G3', 'see preregistration G3', 'no candidate mint of K; run mint --set K --arm candidate'));
  if (nc && nb && kc && kb) { const g4 = scoreG4([{ set: 'N', baseline: nb.docs, candidate: nc.docs }, { set: 'K', baseline: kb.docs, candidate: kc.docs }], outcome); gates.push(g4.gate); summary.g4 = g4.summary; }
  else gates.push(notRun('G4.guard_loss', 'share of judge-correct baseline mints the candidate keeps >= 0.99', 'needs baseline and candidate mints of both N and K'));
  if (existsSync(join(work, 'g2-sample.json'))) { const g2 = scoreG2(JSON.parse(readFileSync(join(work, 'g2-sample.json'), 'utf8')), outcome); gates.push(g2.gate); summary.g2 = g2.summary; }
  else gates.push(notRun('G2.relation_precision', 'relation-line precision Wilson lower bound >= 0.95 (n >= 150)', 'no G2 sample; run g2-sample after the arm-B ingest'));
  const kPrecision = kc ? (() => { const os = kc.docs.flatMap(d => d.minted).map(m => outcome(mintId(m))); const c = os.filter(x => x === 'correct').length; return { minted: os.length, correct: c, unlabeled: os.filter(x => x === 'unlabeled').length }; })() : null;
  summary.k_mint_precision_reported = kPrecision;
  const gut = resolveGbrainUnderTest(null);
  const receipt = p5Receipt({
    category: CATEGORY, gut, startedAt: new Date().toISOString(), rows: [], harnessError: null, summary, gates,
    accounting: { planned: gates.length, attempted: gates.filter(g => g.outcome !== 'not_run').length, scored: gates.filter(g => g.outcome !== 'not_run' && g.outcome !== 'blocked').length, errors: gates.filter(g => g.outcome === 'blocked').length },
    basis: 'scoring only: counts from the work root; no model call',
    resolvedConfig: { decision_id: DECISION_ID, judges, judge_prompt: Q2_JUDGE_PROMPT_VERSION, judge_prompt_sha256: Q2_JUDGE_PROMPT_SHA256, disagreement: 'counts as wrong; no adjudication',
      builds: Object.fromEntries([['N-candidate', nc], ['N-baseline', nb], ['K-candidate', kc], ['K-baseline', kb]].filter(([, x]) => x).map(([k, x]) => [k, { ...(x as { meta: MintMeta }).meta.build, set_sha256: (x as { meta: MintMeta }).meta.set_sha256 }])),
      near_miss_accepted_by_frozen_build: kc?.meta.near_miss_accepted ?? null, beam_excluded: nc?.meta.beam_excluded ?? null },
  });
  writeReceipt(join(output, 'receipt.json'), receipt);
  campaign?.finish(join(output, 'receipt.json'), 0);
  for (const g of gates) log(`${g.gate}: ${g.outcome}${g.failed_threshold ? ` (${g.failed_threshold})` : g.reason ? ` (${g.reason})` : ''}`);
  log(`receipt: ${join(output, 'receipt.json')}`);
}

async function main(argv: string[]): Promise<void> {
  const log = (s: string) => process.stderr.write(`[q2-grammar] ${s}\n`);
  const cmd = argv[0];
  if (cmd === 'mint') return cmdMint(argv.slice(1), log);
  if (cmd === 'g2-sample') return cmdG2Sample(argv.slice(1), log);
  if (cmd === 'label') return cmdLabel(argv.slice(1), log);
  if (cmd === 'score') return cmdScore(argv.slice(1), log);
  throw new Error('usage: junk-audit.ts mint|g2-sample|label|score ... (see the header of eval/runner/q2/junk-audit.ts)');
}

if (import.meta.main) main(process.argv.slice(2)).catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(3); });
