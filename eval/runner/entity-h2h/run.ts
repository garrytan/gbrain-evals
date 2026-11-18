/**
 * The one runner for the entity-dedupe head-to-head (docs/benchmarks/2026-11-18-entity-dedupe-h2h-preregistration.md).
 * Every system and configuration runs through it on a world folder and writes one neutral output (score.ts):
 * { system, version, config, model, tiers: { auto, proposed } }, into a fresh --output folder with cell.json beside it.
 *
 *   world     --seed N [--per-family 20] --output DIR       write a world (people, companies, world.json)
 *             [--smoke]                                      the 2026-11-17 smoke's world instead: generator version 1,
 *                                                            people only, instance 0 of each family (2 per family by
 *                                                            default), ingested in ledger order; for re-smokes only
 *   labels    --world DIR --out FILE                         held-out page-to-entity labels; refuses any seed but 20261118
 *   dry-run   --seed N [--per-family 20]                     pages, pairs, the projected cost and stop of every system and
 *                                                            each memory system's pinned release (its entity-h2h bundle)
 *   run       --system S --config C --world DIR --output DIR [system options]
 *   choose    --system S --held-out DIR --out FILE CELL...    apply preregistration Amendment 2's rule to a memory
 *                                                            system's slice runs (default and every grid setting) and
 *                                                            record the tuned setting, or default (tuning.ts)
 *   stack-env --system S --config C [--choice FILE] | --output DIR
 *                                                            the environment that starts a memory system's stack in a
 *                                                            cell's setting (KEY=VALUE lines; vm-run.sh sources them)
 *   reconcile --output DIR [--proxy URL]                     close and check every attempt's ledger against the proxy log
 *   restart   --output DIR <paid options>                    memory system after a crash: page one, fresh namespace
 *   continue  --output DIR --stop-usd X <paid options>       memory system after a pause: page one, fresh namespace
 *   resume    --output DIR [--stop-usd X] <paid options>     matcher after a crash or pause: only pairs that need it
 *   score     --world DIR [--json-out FILE] CELL...          score finished cells for people and companies
 *
 * Systems:
 *   gbrain                 --gbrain-bin PATH --build LABEL [--sandbox unshare|none]: a fresh home and PGLite brain,
 *                          no keys and (with unshare -rn) no network; each source imported, then dedupe --preview
 *   splink, dedupe, zingg  --held-out DIR (a world at seed 20261118) [--label-budget 100] [--labeller-seed 1-5, dedupe
 *                          only] [--zingg-home DIR --spark-home DIR]: eval/adapters/er-h2h, people and companies apart
 *   ext-temporal-graph, ext-graph-pipeline, ext-extract-first, ext-memory-bank
 *                          --config default | tuning:<setting|default> | tuned --choice FILE  <paid options> --shim URL
 *                          [--drain-each] [--label L]: a tuning cell runs on the held-out seed at 5 per family only, a
 *                          tuned cell never on it and never when it is the default cell, and the shim must report the
 *                          cell's exact setting (tuning.ts)
 *   llm-matcher            --model provider:model <paid options> [--concurrency 4]
 * Paid options: --proxy URL --budget-ledger FILE --budget-run-id ID --usage-log FILE, naming the metering proxy's lease
 * (eval/runner/metering-proxy.ts --run-id ID --lease-usd N); the lease must hold no more than the cell's stop.
 *
 * Exit status: 0 done, 2 a refusal (WORLD_DIR_USED, IMPORT_INCOMPLETE, LEDGER_UNRECONCILED, STACK_CONFIG_MISMATCH,
 * TUNING_SEED, TUNING_CHOICE or TUNED_IS_DEFAULT, printed with its counts and a fix line), 3 an error, 4 paused (a ledger stop or the 345-page checkpoint), 5 failed (infrastructure): a
 * second failure of a cell, which only a dated amendment to the preregistration can reopen.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DECLARED_PERSON_ID_FIELD } from '../../generators/person-dedupe-gen.ts';
import { ProxyControl } from '../metering-proxy.ts';
import { SELECTIONS, checkFinderCoverage, parseFinderOutput } from '../person-dedupe.ts';
import { RunnerRefusal } from '../runner-refusal.ts';
import { blockPairs, pairId } from './blocker.ts';
import { lockCell, loadPath, markCrashed, readCell, reconcilePath, reconcileRun, requireReconciled, runBudget, runSpend, storePath, writeCell, type Attempt, type CellState, type PaidRun } from './ledger.ts';
import { MATCHER_VERSION, ask, matcherPrompt, pairBrain, pairPrompt, planPairs, type CallEvent } from './matcher.ts';
import { runMemoryAttempt, type AttemptEnd } from './memory.ts';
import {
  CHECKPOINT_PAGES, MATCHER_MODELS, MATCHER_USD_PER_PAIR, MAX_ATTEMPTS, MEMORY_KINDS, MEMORY_MODEL, MEMORY_USD_PER_PAGE, STOP_MULTIPLIER, TUNING_PER_FAMILY, TUNING_SETTINGS,
  matcherStop, memoryStop, type MatcherModel, type MemoryKind,
} from './rates.ts';
import { parseOutput, scoreOutput, scoreTable, type NeutralOutput, type OutputScore } from './score.ts';
import { HttpMemorySystem } from '../systems/http.ts';
import { checkStack, checkWorldFor, chooseSetting, configLabel, resolveConfig, stackEnv, tuningOf } from './tuning.ts';
import { DEV_SEED, HELD_OUT_SEED, SMOKE_PER_FAMILY, buildWorld, heldOutLabels, ingestOrder, loadWorld, manifestOf, opaque, readUsage, writeH2hWorld, type H2hWorld } from './world.ts';

export const CLASSIC = ['splink', 'dedupe', 'zingg'] as const;
export const SYSTEMS = ['gbrain', ...CLASSIC, ...MEMORY_KINDS, 'llm-matcher'] as const;
export const EXIT = { ok: 0, refusal: 2, error: 3, paused: 4, failed: 5 } as const;
const ADAPTERS = resolve(import.meta.dir, '../../adapters/er-h2h');
const BUNDLES = resolve(import.meta.dir, '../../../docs/comparison-systems');

type Args = { one: (f: string) => string | undefined; need: (f: string) => string; has: (f: string) => boolean; rest: string[] };
function parse(argv: string[]): Args {
  const one = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith(`${f}=`))?.slice(f.length + 1); };
  const flags = new Set(['--drain-each', '--json']);
  const rest = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--') || flags.has(argv[i - 1])));
  return { one, need: f => one(f) ?? (() => { throw new Error(`entity-h2h: ${f} is required`); })(), has: f => argv.includes(f), rest };
}

/** A fresh folder for a run's output: refuses (WORLD_DIR_USED) a folder that already has files. */
export function freshDir(dir: string): void {
  const used = existsSync(dir) ? readdirSync(dir).length : 0;
  if (used > 0) throw new RunnerRefusal('WORLD_DIR_USED', `entity-h2h: output folder ${dir} was used before`, { entries_in_folder: used }, 'pass a fresh --output');
  mkdirSync(dir, { recursive: true });
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const count = (n: number) => n.toLocaleString('en-US');

// ─── Dry run ───────────────────────────────────────────────────────────────

export interface DryRun { seed: number; per_family: number; lines: string[]; memory: Record<string, { version: string; lock_sha256: string | null; pages: number; projected_usd: number; stop_usd: number; tuning_pages: number; tuning_runs: number; tuning_stop_usd: number; cell_stops_usd: number }>; matcher: Record<string, { pairs: number; stop_usd: number }> }

/**
 * Each system's pages, pairs and cost line from the measured rates, for a world at a seed, with each memory system's
 * pinned release and lock read from its bundle's capability record (docs/comparison-systems/<kind>/entity-h2h). Writes
 * nothing and calls nothing.
 */
export function dryRun(seed: number, perFamily: number): DryRun {
  const w = buildWorld(seed, perFamily);
  const isPerson = (k: string) => w.people_gold.has(k);
  const split = (label: string, person: boolean) => w.pairs.filter(p => isPerson(p.a) === person && p.label === label).length;
  const blocking = blockPairs(w.pages.map(p => p.written));
  const cands = new Set(blocking.pairs.map(([a, b]) => pairId(a, b)));
  const missed = w.pairs.filter(p => !cands.has(pairId(p.a, p.b)));
  const tuning = buildWorld(HELD_OUT_SEED, TUNING_PER_FAMILY).pages.length;
  const lines = [
    `# entity-h2h dry run: seed ${seed}, ${perFamily} per family (no page written, no call made)`,
    `world: ${count(w.pages.length)} pages (${count(w.people.pages.length)} people, ${count(w.companies.pages.length)} companies); people ledger ${w.fingerprints.people.slice(0, 12)}, companies ledger ${w.fingerprints.companies.slice(0, 12)}`,
    `designed pairs: people ${split('different', true)} must-not-link and ${split('same', true)} must-link; companies ${split('different', false)} must-not-link and ${split('same', false)} must-link (${w.pairs.length} in all)`,
    `matcher blocker: ${count(blocking.pairs.length)} candidate pairs; ${blocking.crowded.length} keys on more than ${blocking.max_block_pages} pages dropped${blocking.crowded.length ? ` (${blocking.crowded.slice(0, 5).map(c => `${c.key} ${c.pages}`).join(', ')})` : ''}; not a candidate: ${missed.length} designed pairs (${missed.filter(p => p.label === 'same').length} must-link, ${missed.filter(p => p.label === 'different').length} must-not-link)`,
    '',
    `Memory systems (one page per session; stop = ${STOP_MULTIPLIER} x projected; pause check at ${CHECKPOINT_PAGES} pages; tuning, for a system with a documented dedupe setting = default plus each grid setting (at most ${TUNING_SETTINGS}) on the held-out seed at ${TUNING_PER_FAMILY} per family, ${count(tuning)} pages each, then one tuned run; preregistration Amendment 2):`,
  ];
  const memory: DryRun['memory'] = {};
  for (const kind of MEMORY_KINDS) {
    const pin = (JSON.parse(readFileSync(join(BUNDLES, kind, 'entity-h2h', 'capability.json'), 'utf8')) as { versions: { package: string; lock_sha256: string | null } }).versions;
    const version = /\b\d+\.\d+\.\d+\b/.exec(pin.package)?.[0];
    if (!version) throw new Error(`entity-h2h: no release version in ${kind}'s entity-h2h capability record (versions.package)`);
    const run = memoryStop(kind, w.pages.length), t = memoryStop(kind, tuning);
    const knob = tuningOf(kind).knob !== null, slices = knob ? Object.keys(tuningOf(kind).grid).length + 1 : 0;
    const cell = (knob ? 2 : 1) * run.stop_usd + slices * t.stop_usd;
    memory[kind] = { version, lock_sha256: pin.lock_sha256, pages: w.pages.length, projected_usd: run.projected_usd, stop_usd: run.stop_usd, tuning_pages: tuning, tuning_runs: slices, tuning_stop_usd: t.stop_usd, cell_stops_usd: cell };
    lines.push(`  ${kind.padEnd(20)} ${version.padEnd(7)} ${`(lock ${pin.lock_sha256?.slice(0, 12) ?? 'none'})`.padEnd(19)} ${MEMORY_MODEL}  $${MEMORY_USD_PER_PAGE[kind]}/page x ${count(w.pages.length)} pages = ${usd(run.projected_usd)} projected, ${knob ? `stop ${usd(run.stop_usd)} per run (default and tuned); tuning ${slices} slice runs x stop ${usd(t.stop_usd)}` : `stop ${usd(run.stop_usd)} (default only: no documented dedupe setting, so the tuned cell is the default cell)`}; sum of stops ${usd(cell)}`);
  }
  lines.push('', 'Language-model matcher (one call per candidate pair; stop = projected):');
  const matcher: DryRun['matcher'] = {};
  for (const model of MATCHER_MODELS) {
    const s = matcherStop(model, blocking.pairs.length);
    matcher[model] = { pairs: blocking.pairs.length, stop_usd: s.stop_usd };
    lines.push(`  ${model.padEnd(26)} $${MATCHER_USD_PER_PAIR[model]}/pair x ${count(blocking.pairs.length)} pairs = stop ${usd(s.stop_usd)}`);
  }
  const total = Object.values(memory).reduce((s, m) => s + m.cell_stops_usd, 0) + Object.values(matcher).reduce((s, m) => s + m.stop_usd, 0);
  lines.push('', `Keyless, no paid call: gbrain (${count(w.pages.length)} pages), Splink, dedupe (labeller seeds 1 to 5; full labels and 100 labels), Zingg (one run per config; full labels and 100 labels).`,
    `Sum of every paid stop at this world size: ${usd(total)} (stops are ceilings; projected spend is lower by the 1.5 margin on memory systems).`);
  return { seed, per_family: perFamily, lines, memory, matcher };
}

// ─── Keyless systems ───────────────────────────────────────────────────────

function cellRecord(system: string, config: string, model: string | null, w: H2hWorld, worldDir: string): CellState {
  const m = manifestOf(w);
  return { cell: 'entity-h2h', system, config, model, world_dir: resolve(worldDir), world: { seed: w.seed, per_family: w.per_family, pages: w.pages.length, people_ledger_sha256: m.people_ledger_sha256, company_ledger_sha256: m.company_ledger_sha256, ...(w.smoke ? { smoke: true as const } : {}) }, projected_usd: 0, stop_usd: 0, status: 'open', attempts: [] };
}

const keylessEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|_API_TOKEN$|^ANTHROPIC|^OPENAI|^PARTICLE|^VOYAGE|^GEMINI|^EXA/.test(k))) as Record<string, string>;

export function runClassic(system: typeof CLASSIC[number], a: Args, log: (s: string) => void): number {
  const config = a.need('--config'), worldDir = resolve(a.need('--world')), out = resolve(a.need('--output')), heldDir = resolve(a.need('--held-out'));
  const budget = a.one('--label-budget'), seed = a.one('--labeller-seed');
  if (system === 'dedupe' && !(seed && /^[1-5]$/.test(seed))) throw new Error('entity-h2h: dedupe runs at a fixed labeller seed: pass --labeller-seed 1, 2, 3, 4 or 5');
  if (system !== 'dedupe' && seed) throw new Error(`entity-h2h: ${system} takes no labeller seed${system === 'zingg' ? ' (Zingg has no seed setting; it runs once per configuration, a stated limit)' : ''}`);
  if (system === 'splink' && budget) throw new Error('entity-h2h: splink takes no labels (EM on the scored world), so no --label-budget');
  if (budget && !(Number.isInteger(Number(budget)) && Number(budget) > 0)) throw new Error('entity-h2h: --label-budget must be a whole number of labelled pairs');
  const w = loadWorld(worldDir), held = loadWorld(heldDir);
  if (w.seed === HELD_OUT_SEED) throw new Error(`entity-h2h: seed ${HELD_OUT_SEED} is the held-out tuning seed; nothing scored comes from it`);
  const labels = heldOutLabels(held);
  freshDir(out);
  const name = [config, budget ? `labels-${budget}` : 'labels-full', seed ? `labeller-seed-${seed}` : null].filter(Boolean).join('+');
  writeFileSync(join(out, 'labels.json'), JSON.stringify(labels) + '\n');
  const outputs: Array<{ version: string; tiers: { auto: string[][]; proposed?: string[][] } }> = [];
  for (const entity of ['people', 'companies']) {
    const file = join(out, `${entity}.json`);
    const args = ['run', '--directory', ADAPTERS, 'python', `${system}_arm.py`, '--config', `configs/${system}-${config}.json`, '--entity', entity, '--world', worldDir, '--held-out', heldDir, '--labels', join(out, 'labels.json'), '--out-file', file,
      ...(budget ? ['--label-budget', budget] : []), ...(seed ? ['--seed', seed] : []),
      ...(system === 'zingg' ? ['--zingg-home', a.need('--zingg-home'), '--spark-home', a.need('--spark-home')] : [])];
    log(`${system} ${name} ${entity}: uv ${args.slice(3).join(' ')}`);
    const r = spawnSync('uv', args, { env: keylessEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error(`entity-h2h: the ${system} arm failed on ${entity} (exit ${r.status ?? r.signal})`);
    outputs.push(JSON.parse(readFileSync(file, 'utf8')));
  }
  const output: NeutralOutput = { system, version: outputs[0].version, config: name, model: null, tiers: { auto: outputs.flatMap(o => o.tiers.auto), proposed: outputs.flatMap(o => o.tiers.proposed ?? []) } };
  parseOutput(output, new Set(w.pages.map(p => p.key)));
  writeFileSync(join(out, 'output.json'), JSON.stringify(output, null, 2) + '\n');
  writeCell(out, { ...cellRecord(system, name, null, w, worldDir), status: 'complete' });
  log(`${system} ${name}: auto groups ${output.tiers.auto.length}, proposed ${output.tiers.proposed.length} -> ${join(out, 'output.json')}`);
  return EXIT.ok;
}

export const ER_SCHEMA_PACK = 'er-bench';

/**
 * Declare the person pages' id field to the finder (finder contract, "How an id field is declared"): a declared id is a
 * key only when the active schema pack lists it in the person type's identity_keys, and writing it into the pages
 * declares nothing. Forks the active pack, sets identity_keys on its one person type, validates and activates the fork,
 * and refuses the cell unless gbrain then reports it active. Companies declare nothing: the generator writes no
 * company id field. Returns the pack identity line gbrain prints.
 */
function declareIdField(gbrain: (args: string[]) => string, home: string): string {
  const active = /^Active pack: (\S+)/m.exec(gbrain(['schema', 'active']))?.[1];
  if (!active) throw new Error('entity-h2h: gbrain schema active named no active pack');
  gbrain(['schema', 'fork', active, ER_SCHEMA_PACK]);
  const file = join(home, '.gbrain', 'schema-packs', ER_SCHEMA_PACK, 'pack.json');
  const pack = JSON.parse(readFileSync(file, 'utf8')) as { page_types: Array<{ name: string; identity_keys?: string[] }> };
  const person = pack.page_types.filter(t => t.name === 'person');
  if (person.length !== 1) throw new Error(`entity-h2h: pack ${ER_SCHEMA_PACK} (forked from ${active}) has ${person.length} person page types, not one`);
  person[0].identity_keys = [DECLARED_PERSON_ID_FIELD];
  writeFileSync(file, JSON.stringify(pack, null, 2) + '\n');
  gbrain(['schema', 'validate', ER_SCHEMA_PACK]);
  gbrain(['schema', 'use', ER_SCHEMA_PACK]);
  const now = gbrain(['schema', 'active']);
  if (!new RegExp(`^Active pack: ${ER_SCHEMA_PACK}\\b`, 'm').test(now))
    throw new RunnerRefusal('SCHEMA_PACK_INACTIVE', `entity-h2h: gbrain did not activate pack ${ER_SCHEMA_PACK}, so ${DECLARED_PERSON_ID_FIELD} would be no key; it reports ${JSON.stringify(now.split('\n')[0])}`, { packs_activated: 0 },
      `check gbrain schema use ${ER_SCHEMA_PACK} at this build, then rerun the cell on a fresh --output`);
  return /^Pack identity: (.+)$/m.exec(now)?.[1] ?? now.split('\n')[0];
}

export function runGbrain(a: Args, log: (s: string) => void): number {
  const worldDir = resolve(a.need('--world')), out = resolve(a.need('--output')), bin = a.need('--gbrain-bin'), build = a.need('--build');
  const sandbox = a.one('--sandbox') ?? 'unshare';
  if (sandbox !== 'unshare' && sandbox !== 'none') throw new Error('entity-h2h: --sandbox is unshare or none');
  const w = loadWorld(worldDir);
  freshDir(out);
  const pages = join(out, 'world');
  cpSync(worldDir, pages, { recursive: true });
  const home = join(out, 'home');
  mkdirSync(home);
  const env = { ...keylessEnv(), HOME: home };
  const gbrain = (args: string[]) => {
    const argv = sandbox === 'unshare' ? ['unshare', '-rn', bin, ...args] : [bin, ...args];
    const r = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`entity-h2h: gbrain ${args.join(' ')} failed (exit ${r.status ?? r.signal}): ${(r.stderr ?? '').slice(0, 500)}`);
    return r.stdout;
  };
  const lastJson = (s: string) => JSON.parse(s.trim().split('\n').filter(l => l.trim().startsWith('{')).at(-1) ?? 'null');
  gbrain(['init', '--pglite', '--no-embedding']);
  const schemaPack = declareIdField(gbrain, home);
  const sources = [...new Set(w.pages.map(p => p.source))].sort();
  for (const s of sources) {
    gbrain(['sources', 'add', s, '--path', join(pages, s)]);
    appendFileSync(join(out, 'imports.jsonl'), JSON.stringify(lastJson(gbrain(['import', join(pages, s), '--source', s, '--no-embed', '--json']))) + '\n');
  }
  const imports = readFileSync(join(out, 'imports.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  checkFinderCoverage(imports, w.pages);
  const finder = JSON.parse(gbrain(['dedupe', '--preview', '--json']));
  writeFileSync(join(out, 'finder.json'), JSON.stringify(finder, null, 2) + '\n');
  const groups = parseFinderOutput(finder, new Set(w.pages.map(p => p.key)));
  const auto = groups.filter(SELECTIONS['auto-link']).map(g => g.members);
  const autoSet = new Set(auto.map(g => g.join('|')));
  const output: NeutralOutput = { system: 'gbrain', version: build, config: 'chosen-rule', model: null, tiers: { auto, proposed: groups.filter(SELECTIONS.proposed).map(g => g.members).filter(g => !autoSet.has(g.join('|'))) } };
  writeFileSync(join(out, 'output.json'), JSON.stringify(output, null, 2) + '\n');
  writeCell(out, { ...cellRecord('gbrain', 'chosen-rule', null, w, worldDir), status: 'complete', schema_pack: schemaPack });
  rmSync(home, { recursive: true, force: true });
  log(`gbrain ${build}: ${imports.length} sources imported, auto groups ${auto.length}, proposed ${output.tiers.proposed.length}; confirm-list composition: bun eval/runner/person-dedupe.ts --finder-json ${join(out, 'finder.json')} --finder-imports ${join(out, 'imports.jsonl')} --finder-build ${build}`);
  return EXIT.ok;
}

// ─── Paid cells ────────────────────────────────────────────────────────────

function paidOf(a: Args, dir: string): { paid: PaidRun; proxy: string } {
  return { proxy: a.need('--proxy'), paid: { budget_ledger: storePath(dir, a.need('--budget-ledger')), run_id: a.need('--budget-run-id'), usage_log: storePath(dir, a.need('--usage-log')) } };
}

/** The proxy at --proxy must be the lease proxy writing this paid run, so its spend lands in the ledger the stop is checked against. */
async function checkProxy(proxy: string, dir: string, paid: PaidRun): Promise<void> {
  const st = await fetch(`${proxy.replace(/\/$/, '')}/__proxy/status`).then(r => r.json() as Promise<{ mode?: string; run_id?: string | null; lease_usd?: number }>, () => null);
  const budget = runBudget(dir, paid);
  if (!st || st.mode !== 'lease' || st.run_id !== paid.run_id || Math.abs((st.lease_usd ?? -1) - budget) > 1e-9)
    throw new Error(`entity-h2h: the proxy at ${proxy} serves ${st ? `run ${st.run_id} (${st.mode}, lease ${st.lease_usd})` : 'no status'}, not run ${paid.run_id} with its lease of ${usd(budget)}; point --proxy at the proxy started with --run-id ${paid.run_id}`);
}

/** The lease must hold no more than what is left of the cell's stop, and each attempt is its own paid run. */
function checkLease(dir: string, s: CellState, paid: PaidRun, prior: number): void {
  if (s.attempts.some(x => x.paid.run_id === paid.run_id)) throw new Error(`entity-h2h: paid run ${paid.run_id} already paid for an attempt of this cell; open each restart, continue or resume as its own paid run`);
  const budget = runBudget(dir, paid), left = s.stop_usd - prior;
  if (budget > left + 1e-9) throw new Error(`entity-h2h: lease ${paid.run_id} holds ${usd(budget)}, more than the ${usd(left)} left of the cell's stop (${usd(s.stop_usd)} less ${usd(prior)} already spent); open it with --lease-usd ${Math.floor(left * 100) / 100}`);
}

function newAttempt(s: CellState, kind: Attempt['kind'], paid: PaidRun, ns?: string): Attempt {
  const a: Attempt = { n: s.attempts.length + 1, kind, status: 'running', pid: process.pid, started_at: new Date().toISOString(), finished_at: null, paid, ...(ns ? { ns } : {}), done: 0, reason: null };
  s.attempts.push(a);
  return a;
}

const FAILED = new Set(['crashed', 'import_incomplete']);
function closeAttempt(dir: string, s: CellState, end: AttemptEnd, log: (l: string) => void): number {
  const last = s.attempts.at(-1)!;
  if (end === 'complete') return EXIT.ok;
  if (end === 'paused') { log(`paused: ${last.reason}. Report the measured rate, then reconcile and open a new paid run: run.ts continue|resume --output ${dir} --stop-usd <new stop> ...`); return EXIT.paused; }
  if (s.attempts.filter(x => FAILED.has(x.status)).length >= MAX_ATTEMPTS) {
    s.status = 'failed (infrastructure)'; writeCell(dir, s);
    log(`failed (infrastructure): attempt ${last.n} failed (${last.reason}) after a restart; a further attempt needs a dated amendment to the preregistration`);
    return EXIT.failed;
  }
  log(`attempt ${last.n} ${last.status}: ${last.reason}. Stop the proxy, reconcile, then restart from page one on a fresh namespace (one restart allowed).`);
  return EXIT.error;
}

/** A restart, continue or resume runs on the world the cell started on, never on a folder rewritten since. */
function requireSameWorld(dir: string, s: CellState, w: H2hWorld): void {
  const m = manifestOf(w);
  if (m.seed !== s.world.seed || m.pages !== s.world.pages || m.people_ledger_sha256 !== s.world.people_ledger_sha256 || m.company_ledger_sha256 !== s.world.company_ledger_sha256)
    throw new Error(`entity-h2h: ${s.world_dir} no longer holds the world the cell in ${dir} started on (seed ${s.world.seed}, ${s.world.pages} pages; found seed ${m.seed}, ${m.pages} pages or other ledgers); restore that world before any paid attempt`);
}

function openCell(dir: string): CellState {
  const s = readCell(dir);
  if (!s) throw new Error(`entity-h2h: ${dir} has no cell.json`);
  if (s.status === 'complete') throw new Error(`entity-h2h: the cell in ${dir} is complete`);
  return s;
}

function refuseFailed(s: CellState, dir: string): number | null {
  if (s.status !== 'failed (infrastructure)' && s.attempts.filter(x => FAILED.has(x.status)).length < MAX_ATTEMPTS) return null;
  s.status = 'failed (infrastructure)'; writeCell(dir, s);
  console.error(`entity-h2h: the cell in ${dir} is failed (infrastructure) after ${MAX_ATTEMPTS} failed attempts; a further attempt needs a dated amendment to the preregistration`);
  return EXIT.failed;
}

export async function memoryCell(mode: 'run' | 'restart' | 'continue', a: Args, log: (s: string) => void): Promise<number> {
  const dir = resolve(a.need('--output'));
  let s: CellState, w: H2hWorld, prior = 0, kind: Attempt['kind'];
  if (mode === 'run') {
    const system = a.need('--system') as MemoryKind, worldDir = resolve(a.need('--world'));
    const stack = resolveConfig(system, a.need('--config'), a.one('--choice'));
    w = loadWorld(worldDir);
    checkWorldFor(stack, w);
    freshDir(dir);
    const stop = memoryStop(system, w.pages.length);
    s = { ...cellRecord(system, configLabel(stack), MEMORY_MODEL, w, worldDir), projected_usd: stop.projected_usd, stop_usd: stop.stop_usd, stack };
    (s as CellState & { label: string }).label = a.one('--label') ?? `entity-h2h-${system}-${s.config}`;
    kind = 'first';
  } else {
    s = openCell(dir);
    w = loadWorld(s.world_dir);
    requireSameWorld(dir, s, w);
    markCrashed(s);
    const last = s.attempts.at(-1);
    if (last?.status === 'running') throw new Error(`entity-h2h: attempt ${last.n} of ${dir} is still running (pid ${last.pid})`);
    if (mode === 'restart' && last?.status === 'paused') throw new Error('entity-h2h: a paused cell goes on with continue (after reporting its measured rate), not restart');
    if (mode === 'continue' && last?.status !== 'paused') throw new Error(`entity-h2h: continue follows a pause; attempt ${last?.n} is ${last?.status}`);
    const failed = refuseFailed(s, dir);
    if (failed !== null) return failed;
    prior = requireReconciled(dir, s);
    if (mode === 'continue') {
      const stop = Number(a.need('--stop-usd'));
      if (!(stop > prior)) throw new Error(`entity-h2h: --stop-usd must be above the ${usd(prior)} the cell has spent`);
      const need = last!.checkpoint ? prior + last!.checkpoint.usd_per_page * w.pages.length : 0;
      if (stop < need) throw new Error(`entity-h2h: --stop-usd ${usd(stop)} is below the ${usd(need)} a continue needs: it starts again from page one, so it adds ${usd(need - prior)} (the measured $${last!.checkpoint!.usd_per_page.toFixed(5)} a page x ${w.pages.length} pages) to the ${usd(prior)} already spent; pass --stop-usd ${Math.ceil(need * 100) / 100} or more`);
      (s as CellState & { stops?: unknown[] }).stops = [...((s as CellState & { stops?: unknown[] }).stops ?? []), { from_usd: s.stop_usd, to_usd: stop, at: new Date().toISOString(), after_attempt: last!.n, checkpoint: last!.checkpoint ?? null }];
      s.stop_usd = stop;
    }
    kind = mode;
  }
  const { paid, proxy } = paidOf(a, dir);
  checkLease(dir, s, paid, prior);
  await checkProxy(proxy, dir, paid);
  const shim = a.need('--shim');
  const health = await new HttpMemorySystem(shim, { name: s.system }).health().catch(e => { throw new Error(`entity-h2h: the shim at ${shim} did not answer GET /health (${(e as Error).message}); no attempt was opened`); });
  checkStack(s.stack ?? resolveConfig(s.system, 'default'), health, shim);
  const label = (s as CellState & { label: string }).label;
  const release = lockCell(dir);
  try {
    const attempt = newAttempt(s, kind, paid, opaque('ns', label, String(s.attempts.length + 1)));
    writeCell(dir, s);
    log(`${s.system} ${s.config}: attempt ${attempt.n} (${kind}) on ${w.pages.length} pages, namespace ${attempt.ns}, stop ${usd(s.stop_usd)} (${usd(prior)} spent before)`);
    let end: AttemptEnd;
    try {
      end = await runMemoryAttempt({ dir, state: s, attempt, world: w, order: ingestOrder(w), shim, proxy: new ProxyControl(proxy), label, priorUsd: prior, drainEach: a.has('--drain-each'), log });
    } catch (e) {
      if (attempt.status === 'running') { attempt.status = 'crashed'; attempt.reason = String((e as Error).message).slice(0, 300); attempt.finished_at = new Date().toISOString(); }
      const failed = s.attempts.filter(x => FAILED.has(x.status)).length >= MAX_ATTEMPTS;
      if (failed) s.status = 'failed (infrastructure)';
      writeCell(dir, s);
      if (!(e instanceof RunnerRefusal)) throw e;
      console.error(e.message);
      if (failed) log(`failed (infrastructure): attempt ${attempt.n} failed after a restart; a further attempt needs a dated amendment to the preregistration`);
      return failed ? EXIT.failed : EXIT.refusal;
    }
    return closeAttempt(dir, s, end, log);
  } finally { release(); }
}

const slotOf = (model: string) => `matcher-${model.slice(model.indexOf(':') + 1).replace(/[^a-z0-9.-]/gi, '-')}`;
const readEvents = (dir: string): CallEvent[] => existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

export async function matcherCell(mode: 'run' | 'resume', a: Args, log: (s: string) => void, fetchImpl: typeof fetch = fetch): Promise<number> {
  const dir = resolve(a.need('--output'));
  let s: CellState, w: H2hWorld, prior = 0;
  if (mode === 'run') {
    const model = a.need('--model') as MatcherModel;
    if (!(MATCHER_MODELS as readonly string[]).includes(model)) throw new Error(`entity-h2h: the matcher's models are ${MATCHER_MODELS.join(', ')}`);
    const worldDir = resolve(a.need('--world'));
    w = loadWorld(worldDir);
    freshDir(dir);
    const pairs = blockPairs(w.pages.map(p => p.written));
    const stop = matcherStop(model, pairs.pairs.length);
    s = { ...cellRecord('llm-matcher', 'default', model, w, worldDir), projected_usd: stop.projected_usd, stop_usd: stop.stop_usd };
    writeFileSync(join(dir, 'pairs.json'), JSON.stringify({ blocker: pairs.blocker, max_block_pages: pairs.max_block_pages, crowded: pairs.crowded, pairs: pairs.pairs.length, world: s.world }, null, 2) + '\n');
  } else {
    s = openCell(dir);
    w = loadWorld(s.world_dir);
    requireSameWorld(dir, s, w);
    markCrashed(s);
    const last = s.attempts.at(-1);
    if (last?.status === 'running') throw new Error(`entity-h2h: attempt ${last.n} of ${dir} is still running (pid ${last.pid})`);
    prior = requireReconciled(dir, s);
    if (a.one('--stop-usd') !== undefined) {
      if (last?.status !== 'paused') throw new Error(`entity-h2h: --stop-usd raises the stop only after a pause, once its measured rate is reported; attempt ${last?.n} is ${last?.status}, so resume it without --stop-usd`);
      const stop = Number(a.one('--stop-usd'));
      if (!(stop > prior)) throw new Error(`entity-h2h: --stop-usd must be above the ${usd(prior)} the cell has spent`);
      s.stop_usd = stop;
    }
  }
  const model = s.model as MatcherModel;
  const { paid, proxy } = paidOf(a, dir);
  checkLease(dir, s, paid, prior);
  await checkProxy(proxy, dir, paid);
  const pairs = blockPairs(w.pages.map(p => p.written)).pairs;
  log(`llm-matcher ${model}: ${count(pairs.length)} candidate pairs (logged in pairs.json before any paid call); stop ${usd(s.stop_usd)}, ${usd(prior)} spent before`);
  const release = lockCell(dir);
  try {
    const attempt = newAttempt(s, mode === 'run' ? 'first' : 'resume', paid);
    writeCell(dir, s);
    const logged = () => new Set(s.attempts.flatMap(x => readUsage(loadPath(dir, x.paid.usage_log))).filter(u => u.outcome !== 'refused' && u.brain?.startsWith('pair:')).map(u => u.brain!));
    const plan = planPairs(pairs, readEvents(dir), logged());
    log(`attempt ${attempt.n}: ${plan.ask.length} pairs to ask (${plan.ask.filter(p => p.reask).length} asked again once), ${plan.settled} settled, ${plan.no_verdict.length} left without a verdict`);
    const { template, sha256 } = matcherPrompt();
    const text = new Map(w.pages.map(p => [p.key, p.text]));
    const slot = slotOf(model);
    let next = 0, stopped = false;
    const workers = Array.from({ length: Number(a.one('--concurrency') ?? 4) }, async () => {
      while (!stopped && next < plan.ask.length) {
        const { a: pa, b: pb, reask } = plan.ask[next++];
        const t0 = performance.now();
        if (reask) appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ a: pa, b: pb, attempt: attempt.n, reask, outcome: 'pending', verdict: null, status: null, detail: 'asked again; no result recorded', answer: '', usage: null, response_model: null, ms: 0 } satisfies CallEvent) + '\n');
        const r = await ask(model, pairPrompt(template, text.get(pa)!, text.get(pb)!), proxy, slot, pairBrain(pa, pb), fetchImpl);
        const ev: CallEvent = { a: pa, b: pb, attempt: attempt.n, reask, outcome: r.outcome, verdict: r.verdict, status: r.status, detail: r.detail, answer: r.text.slice(0, 600), usage: r.usage, response_model: r.model, ms: Math.round(performance.now() - t0) };
        appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(ev) + '\n');
        if (r.outcome === 'budget_refused') stopped = true;
        if (r.outcome === 'answer' || r.outcome === 'safety_stop') attempt.done++;
      }
    });
    await Promise.all(workers);
    const events = readEvents(dir);
    const after = planPairs(pairs, events, logged());
    attempt.finished_at = new Date().toISOString();
    if (stopped) {
      attempt.status = 'paused'; attempt.reason = `ledger stop: the proxy refused a pair for budget; the cell's stop is ${usd(s.stop_usd)}`;
      writeCell(dir, s);
      return closeAttempt(dir, s, 'paused', log);
    }
    if (after.ask.length) {
      attempt.status = 'crashed'; attempt.reason = `${after.ask.length} pairs have no verdict (${after.ask.filter(p => p.reask).length} were sent and can be asked again once)`;
      writeCell(dir, s);
      log(`attempt ${attempt.n}: ${attempt.reason}. Stop the proxy, reconcile, then resume.`);
      return EXIT.error;
    }
    const final = new Map<string, CallEvent>();
    for (const e of events) if (e.outcome === 'answer' || e.outcome === 'safety_stop') final.set(pairId(e.a, e.b), e);
    const tier = (v: string) => [...final.values()].filter(e => e.verdict === v).map(e => [e.a, e.b]);
    const output: NeutralOutput = { system: 'llm-matcher', version: MATCHER_VERSION, config: `default (prompt ${sha256.slice(0, 12)})`, model, tiers: { auto: tier('yes'), proposed: tier('unsure') } };
    writeFileSync(join(dir, 'output.json'), JSON.stringify(output, null, 2) + '\n');
    const designed = new Map(w.pairs.map(p => [pairId(p.a, p.b), p]));
    const outcomes: Record<string, number> = { yes: 0, no: 0, unsure: 0, unparsed: 0, safety_stop: 0, no_verdict: after.no_verdict.length };
    for (const e of final.values()) outcomes[e.outcome === 'safety_stop' ? 'safety_stop' : e.verdict ?? 'unparsed']++;
    const direct = [...final.values()].filter(e => designed.has(pairId(e.a, e.b)));
    const correct = direct.filter(e => (designed.get(pairId(e.a, e.b))!.label === 'same') === (e.verdict === 'yes') && e.verdict !== null && e.verdict !== 'unsure').length;
    const spend = s.attempts.reduce((t, x) => t + runSpend(dir, x.paid), 0);
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({
      model, prompt_sha256: sha256, pairs: pairs.length, outcomes, no_verdict: after.no_verdict, asked_again: events.filter(e => e.reask && e.outcome !== 'pending').length,
      errors_before_closure: { yes_on_must_not_link: direct.filter(e => e.verdict === 'yes' && designed.get(pairId(e.a, e.b))!.label === 'different').length, no_on_must_link: direct.filter(e => e.verdict === 'no' && designed.get(pairId(e.a, e.b))!.label === 'same').length },
      designed_pairs_decided: direct.length, correct_decisions: correct, spend_usd: spend, usd_per_correct_decision: correct ? spend / correct : null,
    }, null, 2) + '\n');
    attempt.status = 'complete'; s.status = 'complete';
    writeCell(dir, s);
    log(`llm-matcher ${model}: ${JSON.stringify(outcomes)}; ${usd(spend)} spent`);
    return EXIT.ok;
  } finally { release(); }
}

export async function reconcileCell(a: Args, log: (s: string) => void): Promise<number> {
  const dir = resolve(a.need('--output'));
  const s = readCell(dir);
  if (!s) throw new Error(`entity-h2h: ${dir} has no cell.json`);
  markCrashed(s);
  if (s.attempts.some(x => x.status === 'running')) throw new Error('entity-h2h: an attempt is still running; reconcile once its runner and proxy are down');
  writeCell(dir, s);
  for (const x of s.attempts) {
    const rec = await reconcileRun(dir, x.paid, a.one('--proxy') ?? null);
    x.reason = x.reason ?? null;
    log(`attempt ${x.n} run ${x.paid.run_id}: ${rec.entries} ledger entries, ${rec.log_lines} usage lines, ledger ${usd(rec.ledger_usd)}, log ${usd(rec.log_usd)}${rec.closed_open.length ? `, ${rec.closed_open.length} open reservations closed at full charge` : ''} -> ${reconcilePath(dir, x.paid.run_id)}`);
  }
  log(`cell spend toward its stop: ${usd(requireReconciled(dir, s))} of ${usd(s.stop_usd)}`);
  return EXIT.ok;
}

// ─── Score ─────────────────────────────────────────────────────────────────

export function scoreCells(a: Args, log: (s: string) => void): { code: number; scores: OutputScore[] } {
  const w = loadWorld(resolve(a.need('--world')));
  const known = new Set(w.pages.map(p => p.key));
  const cells = a.rest.slice(1);
  if (!cells.length) throw new Error('entity-h2h: score needs one or more cell folders');
  const scores = cells.map(dir => {
    const s = readCell(dir);
    if (!s) throw new Error(`entity-h2h: ${dir} has no cell.json`);
    if (s.status !== 'complete') throw new Error(`entity-h2h: ${dir} is ${s.status === 'open' ? `not complete (last attempt ${s.attempts.at(-1)?.status ?? 'none'})` : s.status}; a partial run is kept and never scored`);
    if (s.world.people_ledger_sha256 !== w.fingerprints.people || s.world.company_ledger_sha256 !== w.fingerprints.companies) throw new Error(`entity-h2h: ${dir} ran on another world (seed ${s.world.seed})`);
    const out = parseOutput(JSON.parse(readFileSync(join(dir, 'output.json'), 'utf8')), known);
    const candidates = out.system === 'llm-matcher' ? new Set(blockPairs(w.pages.map(p => p.written)).pairs.map(([x, y]) => pairId(x, y))) : undefined;
    const subjects = existsSync(join(dir, 'subjects.json')) ? (JSON.parse(readFileSync(join(dir, 'subjects.json'), 'utf8')) as Array<{ key: string; node: string | null }>).filter(x => !x.node).map(x => x.key) : undefined;
    return scoreOutput(w, out, { candidates, unresolved: subjects });
  });
  log(`# entity-h2h scores: seed ${w.seed}, ${w.per_family} per family, ${w.pages.length} pages\n`);
  log(scoreTable(scores));
  const spread = new Map<string, OutputScore[]>();
  for (const s of scores) if (s.system === 'dedupe') { const base = s.config.replace(/\+labeller-seed-\d+$/, ''); spread.set(base, [...(spread.get(base) ?? []), s]); }
  for (const [base, ss] of spread) for (const t of ['person', 'company'] as const) {
    const rates = ss.map(x => x.points.auto[t].false_merge.rate ?? 0);
    log(`dedupe ${base}, ${t}: false-merge rate across ${ss.length} labeller seeds ${(Math.min(...rates) * 100).toFixed(1)}% to ${(Math.max(...rates) * 100).toFixed(1)}%`);
  }
  const jsonOut = a.one('--json-out');
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ seed: w.seed, per_family: w.per_family, fingerprints: w.fingerprints, scores }, null, 2) + '\n');
  return { code: EXIT.ok, scores };
}

// ─── Command line ──────────────────────────────────────────────────────────

/** Runs one command; returns the exit status. Refusals print their one line and return 2. */
export async function cli(argv: string[], log: (s: string) => void = s => console.log(s), fetchImpl: typeof fetch = fetch): Promise<number> {
  const a = parse(argv);
  const cmd = argv[0];
  try {
    switch (cmd) {
      case 'world': {
        const smoke = a.has('--smoke');
        const w = writeH2hWorld(resolve(a.need('--output')), Number(a.need('--seed')), Number(a.one('--per-family') ?? (smoke ? SMOKE_PER_FAMILY : 20)), smoke);
        log(`world: seed ${w.seed}, ${w.per_family} per family${w.smoke ? ', the 2026-11-17 smoke world' : ''}, ${w.pages.length} pages -> ${a.need('--output')}`);
        return EXIT.ok;
      }
      case 'labels': {
        const labels = heldOutLabels(loadWorld(resolve(a.need('--world'))));
        writeFileSync(a.need('--out'), JSON.stringify(labels) + '\n');
        log(`labels: held-out seed ${labels.seed}, ${Object.keys(labels.entities).length} pages -> ${a.need('--out')}`);
        return EXIT.ok;
      }
      case 'dry-run': {
        const d = dryRun(Number(a.one('--seed') ?? DEV_SEED), Number(a.one('--per-family') ?? 20));
        if (a.has('--json')) log(JSON.stringify(d, null, 2)); else for (const l of d.lines) log(l);
        return EXIT.ok;
      }
      case 'run': {
        const system = a.need('--system');
        if (!(SYSTEMS as readonly string[]).includes(system)) throw new Error(`entity-h2h: --system must be one of ${SYSTEMS.join(', ')}`);
        if (system === 'gbrain') return runGbrain(a, log);
        if ((CLASSIC as readonly string[]).includes(system)) return runClassic(system as typeof CLASSIC[number], a, log);
        if (system === 'llm-matcher') return await matcherCell('run', a, log, fetchImpl);
        return await memoryCell('run', a, log);
      }
      case 'restart': case 'continue': return await memoryCell(cmd, a, log);
      case 'resume': return await matcherCell('resume', a, log, fetchImpl);
      case 'reconcile': return await reconcileCell(a, log);
      case 'score': return scoreCells(a, log).code;
      case 'choose': {
        const system = a.need('--system');
        const { choice, scores } = chooseSetting(system, resolve(a.need('--held-out')), a.rest.slice(1), resolve(a.need('--out')));
        log(scoreTable(scores));
        for (const c of choice.candidates) log(`  ${c.setting.padEnd(18)} false merges ${c.false_merge.k}/${c.false_merge.n}, must-link recall ${c.recall.k}/${c.recall.n}, distance ${c.distance}, ${c.eligible ? 'eligible' : 'outside the recall bound'}`);
        log(choice.setting === 'default'
          ? `choice: ${system} keeps default, so its tuned cell is its default cell and nothing more runs (${choice.rule}) -> ${a.need('--out')}`
          : `choice: ${system} tuned runs ${choice.setting} ${JSON.stringify(choice.settings)} (${choice.rule}) -> ${a.need('--out')}`);
        return EXIT.ok;
      }
      case 'stack-env': {
        const out = a.one('--output');
        const cell = out ? readCell(resolve(out)) : null;
        if (out && !cell) throw new Error(`entity-h2h: ${out} has no cell.json`);
        const system = cell ? cell.system : a.need('--system');
        tuningOf(system);
        const stack = cell ? (cell.stack ?? resolveConfig(system, 'default')) : resolveConfig(system, a.need('--config'), a.one('--choice'));
        for (const l of stackEnv(system, stack)) log(l);
        return EXIT.ok;
      }
      default: throw new Error('usage: bun eval/runner/entity-h2h/run.ts world|labels|dry-run|run|reconcile|restart|continue|resume|score|choose|stack-env ... (see the header of this file)');
    }
  } catch (e) {
    if (e instanceof RunnerRefusal) { console.error(e.message); return EXIT.refusal; }
    throw e;
  }
}

if (import.meta.main) {
  cli(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e instanceof Error ? e.message : e); process.exit(EXIT.error); });
}
