/**
 * BG1 validation (GST-2010), run in custody on a set that eval/custody/bg1/mint.sh rendered. It is keyless: the model
 * checks ran in render.ts, so this re-runs every deterministic gate from the files and the custody inputs alone, and
 * picks the kept list. It prints counts and hashes only, and writes a report of world ids, gate names and numbers
 * (never text) for the custody record and the manifest fill.
 *
 *   bun eval/custody/bg1/validate.ts [--bg1c] --set <out>/set --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json
 *       --report <path outside the set> [--target-tokens 200000] [--tolerance 0.15] [--n-final <n>] [--fake]
 *   bun eval/custody/bg1/validate.ts --bg1c --slot <31 to 96> --set <out>/set --seed-file <path>.bg1-seed
 *       --phrasing <path>.bg1-phrasing.json [--target-tokens 200000] [--tolerance 0.15]
 *
 *   bun eval/custody/bg1/validate.ts --bgw --batch <first slot> --set <out>/set --seed-file <path>.bgw-seed
 *       --phrasing <path>.bgw-phrasing.json (--report <path outside the set> | --slot <n>) [--target-tokens 200000]
 *       [--tolerance 0.15]
 *
 * Without --bg1c it validates BG1's set (slots 1 to 30); with it, BG1-C's (slots 31 to 96, mint.sh --bg1c;
 * docs/benchmarks/2026-11-19-changing-facts-confirmation-preregistration.md), whose --n-final is at most 40. With --bgw
 * it validates one Set W batch (the weekly outcome line, mint.sh --bgw; bg1-names.ts bgwBatchSlots): the batch's slots,
 * planned from Set W's seed and phrasing, and it takes no --n-final. Its kept list is the first 34 passing worlds, and
 * n_final is 34 when 34 pass, the number kept when every slot of the batch is accounted for with fewer passing (a short
 * batch), and absent otherwise. Either way a world directory outside the set's slots refuses the whole set, and each
 * world is planned from its own slot number.
 *
 * Gates per world, in slot order; a failure drops the world:
 *   - files: plan.json, questions.json and world.json are present and each carries the custody marker;
 *   - plan: plan.json is byte-identical to a fresh plan from the seed line, the slot and the phrasing set, so nothing
 *     edited it after the mint;
 *   - gold: questions.json is byte-identical to the questions the oracles give for that plan, and every question's gold
 *     values and evidence sessions follow from its stratum's oracle over the plan (goldFields);
 *   - sessions: world.json holds the plan's sessions (ids, days and times) and each passes checkSession against its
 *     brief;
 *   - length: the world's cl100k tokens are within the target plus or minus the tolerance (default 15%);
 *   - duplicate: no earlier world in the set has the same world bytes;
 *   - renderer: world.json was not written by a template renderer (render.ts --fake or the generator's fixtures), unless
 *     --fake declares the run a drill, so a drill's worlds never pass a real validation and reach a manifest fill.
 * A slot that render.ts dropped (its <out>/render/<id>.json record) is listed with the gate "render". Kept: the first
 * --n-final passing worlds in slot order, or every passing world without it. Each world's entry records the SHA-256 of
 * its files as validated, so eval/custody/bg1/fill-manifest.ts can refuse files that changed since, and controls_dropped,
 * the control characters render.ts removed from that world (its render/<id>.json record; null when the record holds no
 * count), which counts.controls_dropped sums and the printed line repeats.
 *
 * --slot (BG1-C and Set W only) is the same gates for one written world, the duplicate gate against every earlier slot's world in
 * the set, run by mint.sh --bg1c after each slot so its kept count is the validated count and the mint tops up past a
 * world that fails (the kept set is the first 40 slots that pass validation). It writes a counts-only record,
 * <out>/render/<id>.validation.json (status pass or fail, the failed gates, sessions, tokens and controls_dropped), prints one line and
 * exits 0 on a pass and 12 on a fail.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, BG1_TARGET_TOKENS, buildQuestions, goldFields, PlanError, renderBriefs, worldTokens, type QuestionRecord, type World } from '../../generators/changing-facts-gen.ts';
import { BG1_CONVERSATIONS, BG1_N_CAP, BG1C_CONVERSATIONS, BG1C_N_FINAL, BGW_BATCH_KEPT, bgwBatchIds, bgwSlotOf } from '../../runner/bg1/types.ts';
import { BG1_TEMPLATE_RENDERERS } from '../../runner/memory-qa/corpus.ts';
import { checkSession, readPhrasing, readSeedLine, RenderRefusal, sealedPlan, type SealedKind } from './render.ts';

export const VALIDATION_SCHEMA = 'gbrain-evals/bg1-validation/v1';
export const WORLD_FILES = ['plan.json', 'questions.json', 'world.json'] as const;
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';

/** The control characters render.ts dropped from a world, from its render record; null without a record or a count. */
function controlsDropped(record: string): number | null {
  if (!existsSync(record)) return null;
  const n = (JSON.parse(readFileSync(record, 'utf8')) as { controls_dropped?: unknown }).controls_dropped;
  return typeof n === 'number' ? n : null;
}

export interface WorldResult { id: string; status: 'pass' | 'fail'; failed: string[]; sessions: number; tokens: number | null; world_sha256: string | null; files_sha256: Record<string, string>; controls_dropped: number | null }
export interface ValidationReport {
  schema: string; target_tokens: number; tolerance: number; worlds: WorldResult[]; kept: string[]; n_final: number | null;
  counts: { checked: number; passed: number; failed: number; render_dropped: number; controls_dropped: number };
}

/** The gates one world fails, given its directory and its plan inputs; empty when it passes. */
export function validateWorld(dir: string, slot: number, seedLine: string, phrasing: ReturnType<typeof readPhrasing>, opts: { targetTokens: number; tolerance: number; kind?: SealedKind; drill?: boolean }): { failed: string[]; sessions: number; tokens: number | null; worldText: string | null } {
  const files = WORLD_FILES.map(f => join(dir, f));
  if (files.some(f => !existsSync(f))) return { failed: ['files'], sessions: 0, tokens: null, worldText: null };
  const [planText, questionsText, worldText] = files.map(f => readFileSync(f, 'utf8'));
  const failed = new Set<string>();
  if ([planText, questionsText, worldText].some(t => !t.includes(BG1_CUSTODY_MARKER))) failed.add('files');
  let plan;
  try { plan = sealedPlan(seedLine, slot, phrasing, opts.kind); } catch (e) { if (e instanceof PlanError) return { failed: ['plan'], sessions: 0, tokens: null, worldText }; throw e; }
  if (json(plan) !== planText) failed.add('plan');
  const questions = buildQuestions(plan, phrasing);
  if (json(questions) !== questionsText) failed.add('gold');
  let stored: QuestionRecord[] = [];
  try { stored = JSON.parse(questionsText) as QuestionRecord[]; } catch { failed.add('gold'); }
  for (const q of stored) {
    try {
      const g = goldFields(plan, q);
      if (JSON.stringify([g.gold_values, g.stale_values, g.decoy_values, g.evidence_sessions]) !== JSON.stringify([q.bg1.gold_values, q.bg1.stale_values, q.bg1.decoy_values, q.evidence_sessions])) failed.add('gold');
    } catch { failed.add('gold'); }
  }
  let world: World | null = null;
  try { world = JSON.parse(worldText) as World; } catch { failed.add('sessions'); }
  const briefs = renderBriefs(plan, opts.targetTokens);
  if (!world || !Array.isArray(world.sessions) || world.id !== plan.id || world.sessions.length !== plan.sessions.length
    || world.sessions.some((s, i) => s.id !== plan.sessions[i].id || s.day !== plan.sessions[i].day || s.time !== plan.sessions[i].time || checkSession(briefs[i], s.turns).length > 0)) failed.add('sessions');
  if (world && BG1_TEMPLATE_RENDERERS.includes(world.renderer) && !opts.drill) failed.add('renderer');
  const tokens = world && !failed.has('sessions') ? worldTokens(world) : null;
  if (tokens !== null && Math.abs(tokens - opts.targetTokens) > opts.tolerance * opts.targetTokens) failed.add('length');
  return { failed: [...failed].sort(), sessions: world?.sessions?.length ?? 0, tokens, worldText };
}

/** A sealed world id's mint slot: bg1- and three digits, or Set W's bgw- and four digits. */
const slotOf = (id: string) => bgwSlotOf(id) ?? Number(id.slice('bg1-'.length));

export function validateSet(setDir: string, seedLine: string, phrasing: ReturnType<typeof readPhrasing>, opts: { targetTokens: number; tolerance: number; nFinal: number | null; bg1c?: boolean; bgwBatch?: number; drill?: boolean }): ValidationReport {
  const bgw = opts.bgwBatch !== undefined;
  const ids: readonly string[] = bgw ? bgwBatchIds(opts.bgwBatch!) : opts.bg1c ? BG1C_CONVERSATIONS : BG1_CONVERSATIONS;
  const worldsDir = join(setDir, 'worlds');
  const present = existsSync(worldsDir) ? readdirSync(worldsDir).sort() : [];
  const stray = present.filter(d => !ids.includes(d));
  if (stray.length) throw new RenderRefusal(`the set holds ${stray.length} director(ies) under worlds/ that are not ${bgw ? `batch bgw-${opts.bgwBatch}'s` : opts.bg1c ? 'BG1-C' : 'BG1'} mint slots`);
  const recordDir = join(dirname(setDir), 'render');
  const results: WorldResult[] = [];
  const seen = new Set<string>();
  let renderDropped = 0;
  ids.forEach(id => {
    const record = join(recordDir, `${id}.json`);
    if (!present.includes(id)) {
      if (existsSync(record) && (JSON.parse(readFileSync(record, 'utf8')) as { status?: string }).status === 'dropped') {
        renderDropped++;
        results.push({ id, status: 'fail', failed: ['render'], sessions: 0, tokens: null, world_sha256: null, files_sha256: {}, controls_dropped: null });
      }
      return;
    }
    const r = validateWorld(join(worldsDir, id), slotOf(id), seedLine, phrasing, { ...opts, kind: bgw ? 'bgw' : 'bg1' });
    const hash = r.worldText === null ? null : sha256(r.worldText);
    if (hash !== null && seen.has(hash)) r.failed.push('duplicate');
    if (hash !== null) seen.add(hash);
    const files_sha256 = Object.fromEntries(WORLD_FILES.filter(f => existsSync(join(worldsDir, id, f))).map(f => [f, sha256(readFileSync(join(worldsDir, id, f)))]));
    results.push({ id, status: r.failed.length ? 'fail' : 'pass', failed: r.failed, sessions: r.sessions, tokens: r.tokens, world_sha256: hash, files_sha256, controls_dropped: controlsDropped(record) });
  });
  const passing = results.filter(r => r.status === 'pass').map(r => r.id);
  const kept = bgw ? passing.slice(0, BGW_BATCH_KEPT) : opts.nFinal === null ? passing : passing.slice(0, opts.nFinal);
  const nFinal = !bgw ? opts.nFinal : kept.length === BGW_BATCH_KEPT ? BGW_BATCH_KEPT : kept.length && results.length === ids.length ? kept.length : null;
  return { schema: VALIDATION_SCHEMA, target_tokens: opts.targetTokens, tolerance: opts.tolerance, worlds: results, kept, n_final: nFinal,
    counts: { checked: results.length - renderDropped, passed: passing.length, failed: results.length - passing.length, render_dropped: renderDropped, controls_dropped: results.reduce((n, w) => n + (w.controls_dropped ?? 0), 0) } };
}

/** One BG1-C slot's gates (--slot): validateWorld, then the duplicate gate against every earlier slot's world in the set. */
export function validateSlot(argv: string[]): { pass: boolean; line: string } {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const set = flag('--set'), seedFile = flag('--seed-file'), phrasingFile = flag('--phrasing'), slot = Number(flag('--slot'));
  const batch = bgwBatchOf(argv);
  const kind: SealedKind = batch === null ? 'bg1' : 'bgw';
  if (!argv.includes('--bg1c') && batch === null) throw new RenderRefusal('--slot is BG1-C\'s check of one minted world (mint.sh --bg1c), so it needs --bg1c, or Set W\'s (mint.sh --bgw), which needs --bgw --batch <first slot>');
  if (!set || !seedFile || !phrasingFile) throw new RenderRefusal(`usage: (--bg1c | --bgw --batch <first slot>) --slot <n> --set <dir> --seed-file <path>.${kind}-seed --phrasing <path>.${kind}-phrasing.json [--target-tokens <n>] [--tolerance <x>]`);
  const ids: readonly string[] = batch === null ? BG1C_CONVERSATIONS : bgwBatchIds(batch);
  const id = ids.find(c => slotOf(c) === slot);
  if (!id) throw new RenderRefusal(batch === null ? '--slot must be one of BG1-C\'s slots, 31 to 96' : `--slot must be one of batch bgw-${batch}'s slots, ${batch} to ${slotOf(ids.at(-1)!)}`);
  const targetTokens = Number(flag('--target-tokens') ?? BG1_TARGET_TOKENS), tolerance = Number(flag('--tolerance') ?? 0.15);
  if (!(targetTokens >= 1000) || !(tolerance > 0 && tolerance < 1)) throw new RenderRefusal('--target-tokens must be at least 1000 and --tolerance between 0 and 1');
  const worldsDir = join(resolve(set), 'worlds');
  if (!existsSync(join(worldsDir, id, 'world.json'))) throw new RenderRefusal(`${id} has no written world to validate`);
  const r = validateWorld(join(worldsDir, id), slot, readSeedLine(resolve(seedFile), kind), readPhrasing(resolve(phrasingFile), kind), { targetTokens, tolerance, kind, drill: argv.includes('--fake') });
  const hash = r.worldText === null ? null : sha256(r.worldText);
  const earlier = ids.slice(0, ids.indexOf(id)).filter(e => WORLD_FILES.every(f => existsSync(join(worldsDir, e, f))));
  if (hash !== null && earlier.some(e => sha256(readFileSync(join(worldsDir, e, 'world.json'))) === hash)) r.failed.push('duplicate');
  const status = r.failed.length ? 'fail' : 'pass';
  const controls = controlsDropped(join(dirname(resolve(set)), 'render', `${id}.json`));
  const record = join(dirname(resolve(set)), 'render', `${id}.validation.json`);
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(`${record}.tmp`, json({ schema: VALIDATION_SCHEMA, world: id, slot, mode: argv.includes('--fake') ? 'drill' : 'real', status, failed: r.failed, sessions: r.sessions, tokens: r.tokens, target_tokens: targetTokens, tolerance, world_sha256: hash, controls_dropped: controls }), { mode: 0o600 });
  renameSync(`${record}.tmp`, record);
  return { pass: status === 'pass', line: `bg1-validate slot=${slot} world=${id} status=${status} gates=${r.failed.join(',') || 'none'} tokens=${r.tokens ?? 'none'} controls_dropped=${controls ?? 'none'}` };
}

/**
 * --bgw's batch, its first slot from --batch; null without --bgw. Refuses --bgw without a batch, a batch that is not a
 * Set W slot or that would run past its seed set, and --bgw beside --bg1c.
 */
function bgwBatchOf(argv: string[]): number | null {
  if (!argv.includes('--bgw')) return null;
  if (argv.includes('--bg1c')) throw new RenderRefusal('--bgw and --bg1c name two different sealed sets; give one');
  const i = argv.indexOf('--batch'), raw = i >= 0 ? argv[i + 1] : undefined;
  if (!raw || !/^\d{4}$/.test(raw)) throw new RenderRefusal('--bgw needs --batch <first slot>, the four-digit first slot of the batch (1001 for the first)');
  try { bgwBatchIds(Number(raw)); } catch (e) { throw new RenderRefusal((e as Error).message); }
  return Number(raw);
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

export function main(argv: string[]): { report: ValidationReport; line: string } {
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const set = flag('--set'), seedFile = flag('--seed-file'), phrasingFile = flag('--phrasing'), reportPath = flag('--report');
  if (!set || !seedFile || !phrasingFile || !reportPath) throw new RenderRefusal('usage: --set <dir> --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json --report <path> [--target-tokens <n>] [--tolerance <x>] [--n-final <n>]');
  if (inside(resolve(reportPath), resolve(set))) throw new RenderRefusal('--report must be outside --set');
  const targetTokens = Number(flag('--target-tokens') ?? BG1_TARGET_TOKENS), tolerance = Number(flag('--tolerance') ?? 0.15);
  const nFinal = flag('--n-final') === undefined ? null : Number(flag('--n-final'));
  if (!(targetTokens >= 1000) || !(tolerance > 0 && tolerance < 1)) throw new RenderRefusal('--target-tokens must be at least 1000 and --tolerance between 0 and 1');
  const bg1c = argv.includes('--bg1c'), cap = bg1c ? BG1C_N_FINAL : BG1_N_CAP;
  const batch = bgwBatchOf(argv), kind: SealedKind = batch === null ? 'bg1' : 'bgw';
  if (batch !== null && nFinal !== null) throw new RenderRefusal(`--bgw takes no --n-final: a Set W batch keeps its first ${BGW_BATCH_KEPT} passing worlds`);
  if (nFinal !== null && !(Number.isInteger(nFinal) && nFinal >= 1 && nFinal <= cap)) throw new RenderRefusal(`--n-final must be a whole number from 1 to ${cap}`);
  const report = validateSet(resolve(set), readSeedLine(resolve(seedFile), kind), readPhrasing(resolve(phrasingFile), kind), { targetTokens, tolerance, nFinal, bg1c, drill: argv.includes('--fake'), ...(batch === null ? {} : { bgwBatch: batch }) });
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  const text = json(report);
  writeFileSync(resolve(reportPath), text, { mode: 0o600 });
  const gates = Object.entries(report.worlds.flatMap(w => w.failed).reduce<Record<string, number>>((m, g) => ({ ...m, [g]: (m[g] ?? 0) + 1 }), {})).sort(([a], [b]) => (a < b ? -1 : 1)).map(([g, n]) => `${g}:${n}`).join(',') || 'none';
  return { report, line: `bg1-validate checked=${report.counts.checked} passed=${report.counts.passed} failed=${report.counts.failed} render_dropped=${report.counts.render_dropped} kept=${report.kept.length} gates=${gates} controls_dropped=${report.counts.controls_dropped} report_sha256=${sha256(text).slice(0, 16)}` };
}

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    if (argv.includes('--slot')) { const r = validateSlot(argv); console.log(r.line); process.exit(r.pass ? 0 : 12); }
    console.log(main(argv).line);
    process.exit(0);
  } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof RenderRefusal ? `bg1-validate refused: ${e.message}\n` : `bg1-validate error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(e instanceof RenderRefusal ? 2 : 1);
  }
}
