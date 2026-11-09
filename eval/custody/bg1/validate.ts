/**
 * BG1 validation (GST-2010), run in custody on a set that eval/custody/bg1/mint.sh rendered. It is keyless: the model
 * checks ran in render.ts, so this re-runs every deterministic gate from the files and the custody inputs alone, and
 * picks the kept list. It prints counts and hashes only, and writes a report of world ids, gate names and numbers
 * (never text) for the custody record and the manifest fill.
 *
 *   bun eval/custody/bg1/validate.ts --set <out>/set --seed-file <path>.bg1-seed --phrasing <path>.bg1-phrasing.json
 *       --report <path outside the set> [--target-tokens 200000] [--tolerance 0.15] [--n-final <n>]
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
 *   - duplicate: no earlier world in the set has the same world bytes.
 * A slot that render.ts dropped (its <out>/render/<id>.json record) is listed with the gate "render". Kept: the first
 * --n-final passing worlds in slot order, or every passing world without it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { BG1_CUSTODY_MARKER, BG1_TARGET_TOKENS, buildQuestions, goldFields, PlanError, renderBriefs, worldTokens, type QuestionRecord, type World } from '../../generators/changing-facts-gen.ts';
import { BG1_CONVERSATIONS, BG1_N_CAP } from '../../runner/bg1/types.ts';
import { checkSession, readPhrasing, readSeedLine, RenderRefusal, sealedPlan } from './render.ts';

export const VALIDATION_SCHEMA = 'gbrain-evals/bg1-validation/v1';
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';

export interface WorldResult { id: string; status: 'pass' | 'fail'; failed: string[]; sessions: number; tokens: number | null; world_sha256: string | null }
export interface ValidationReport {
  schema: string; target_tokens: number; tolerance: number; worlds: WorldResult[]; kept: string[]; n_final: number | null;
  counts: { checked: number; passed: number; failed: number; render_dropped: number };
}

/** The gates one world fails, given its directory and its plan inputs; empty when it passes. */
export function validateWorld(dir: string, slot: number, seedLine: string, phrasing: ReturnType<typeof readPhrasing>, opts: { targetTokens: number; tolerance: number }): { failed: string[]; sessions: number; tokens: number | null; worldText: string | null } {
  const files = ['plan.json', 'questions.json', 'world.json'].map(f => join(dir, f));
  if (files.some(f => !existsSync(f))) return { failed: ['files'], sessions: 0, tokens: null, worldText: null };
  const [planText, questionsText, worldText] = files.map(f => readFileSync(f, 'utf8'));
  const failed = new Set<string>();
  if ([planText, questionsText, worldText].some(t => !t.includes(BG1_CUSTODY_MARKER))) failed.add('files');
  let plan;
  try { plan = sealedPlan(seedLine, slot, phrasing); } catch (e) { if (e instanceof PlanError) return { failed: ['plan'], sessions: 0, tokens: null, worldText }; throw e; }
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
  const tokens = world && !failed.has('sessions') ? worldTokens(world) : null;
  if (tokens !== null && Math.abs(tokens - opts.targetTokens) > opts.tolerance * opts.targetTokens) failed.add('length');
  return { failed: [...failed].sort(), sessions: world?.sessions?.length ?? 0, tokens, worldText };
}

export function validateSet(setDir: string, seedLine: string, phrasing: ReturnType<typeof readPhrasing>, opts: { targetTokens: number; tolerance: number; nFinal: number | null }): ValidationReport {
  const worldsDir = join(setDir, 'worlds');
  const present = existsSync(worldsDir) ? readdirSync(worldsDir).sort() : [];
  const stray = present.filter(d => !BG1_CONVERSATIONS.includes(d));
  if (stray.length) throw new RenderRefusal(`the set holds ${stray.length} director(ies) under worlds/ that are not BG1 mint slots`);
  const recordDir = join(dirname(setDir), 'render');
  const results: WorldResult[] = [];
  const seen = new Set<string>();
  let renderDropped = 0;
  BG1_CONVERSATIONS.forEach((id, i) => {
    const record = join(recordDir, `${id}.json`);
    if (!present.includes(id)) {
      if (existsSync(record) && (JSON.parse(readFileSync(record, 'utf8')) as { status?: string }).status === 'dropped') {
        renderDropped++;
        results.push({ id, status: 'fail', failed: ['render'], sessions: 0, tokens: null, world_sha256: null });
      }
      return;
    }
    const r = validateWorld(join(worldsDir, id), i + 1, seedLine, phrasing, opts);
    const hash = r.worldText === null ? null : sha256(r.worldText);
    if (hash !== null && seen.has(hash)) r.failed.push('duplicate');
    if (hash !== null) seen.add(hash);
    results.push({ id, status: r.failed.length ? 'fail' : 'pass', failed: r.failed, sessions: r.sessions, tokens: r.tokens, world_sha256: hash });
  });
  const passing = results.filter(r => r.status === 'pass').map(r => r.id);
  const kept = opts.nFinal === null ? passing : passing.slice(0, opts.nFinal);
  return { schema: VALIDATION_SCHEMA, target_tokens: opts.targetTokens, tolerance: opts.tolerance, worlds: results, kept, n_final: opts.nFinal,
    counts: { checked: results.length - renderDropped, passed: passing.length, failed: results.length - passing.length, render_dropped: renderDropped } };
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
  if (nFinal !== null && !(Number.isInteger(nFinal) && nFinal >= 1 && nFinal <= BG1_N_CAP)) throw new RenderRefusal(`--n-final must be a whole number from 1 to ${BG1_N_CAP}`);
  const report = validateSet(resolve(set), readSeedLine(resolve(seedFile)), readPhrasing(resolve(phrasingFile)), { targetTokens, tolerance, nFinal });
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  const text = json(report);
  writeFileSync(resolve(reportPath), text, { mode: 0o600 });
  const gates = Object.entries(report.worlds.flatMap(w => w.failed).reduce<Record<string, number>>((m, g) => ({ ...m, [g]: (m[g] ?? 0) + 1 }), {})).sort(([a], [b]) => (a < b ? -1 : 1)).map(([g, n]) => `${g}:${n}`).join(',') || 'none';
  return { report, line: `bg1-validate checked=${report.counts.checked} passed=${report.counts.passed} failed=${report.counts.failed} render_dropped=${report.counts.render_dropped} kept=${report.kept.length} gates=${gates} report_sha256=${sha256(text).slice(0, 16)}` };
}

if (import.meta.main) {
  try { console.log(main(process.argv.slice(2)).line); process.exit(0); } catch (error) {
    const e = error as Error;
    process.stderr.write(e instanceof RenderRefusal ? `bg1-validate refused: ${e.message}\n` : `bg1-validate error class=${e.name} sha256=${sha256(String(e.message)).slice(0, 16)}\n`);
    process.exit(e instanceof RenderRefusal ? 2 : 1);
  }
}
