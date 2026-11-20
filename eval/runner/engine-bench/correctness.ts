/**
 * engine-bench, correctness stage: the gate runners that hold gbrain's correctness contracts, run once per storage
 * engine, with the Rust engine held to the TypeScript engines' counts.
 *
 * Checks (correctnessChecks): N1 knowledge update (full), N5 forget residue (full), N6 visibility fuzz in process,
 * N6 over HTTP, N12 format fidelity and N14 large-page fidelity. Each runs as its own process per engine, with
 * GBRAIN_EVAL_ENGINE set to that engine, "--gbrain <checkout>@<ref>" passed through, "--output" pointed at a
 * per-check, per-engine directory, and LIFECYCLE_PG_URL and N14_PG_ADMIN_URL pointed at one shared Postgres admin URL
 * (a local pgvector container unless --pg-url names one). The child environment drops every provider key
 * (hermetic-env.ts), so the stage is keyless.
 *
 * What one run is:
 *   exit 69     refused (EvalEngineUnavailable), with the reason the runner printed. No receipt and no verdict.
 *   receipt     the runner's verdict plus each contract count named in correctnessChecks. A contract whose
 *               measurement is in the receipt's not_applicable list carries that record and its reason instead of a
 *               count. When every contract of a check is not_applicable on an engine, the check is unmeasured there.
 *   otherwise   error (no receipt, or exit 2 or 3), with the log tail.
 *
 * The parity rule (draft engine-bench preregistration): a check passes on Rust when its verdict is pass AND every
 * contract count equals the count on both TypeScript engines. Every contract is a count whose bar is zero, so when a
 * TypeScript engine fails a contract (a nonzero count, or the two TypeScript engines disagree), the stage records it
 * as a gbrain finding and Rust must be no worse than the better TypeScript engine on it. Without a Rust arm the stage
 * still compares PGLite and Postgres and reports every difference as a finding. A Rust run that errors (no usable
 * receipt) on a check a TypeScript engine completed fails that check; a cause traced to the harness or the machine
 * makes the run invalid instead, under the preregistration's stop rules.
 *
 * Rust stage verdict: fail when any check fails on Rust; refused when every check refused; pass when every check
 * passes; unmeasured otherwise (some checks passed and the rest refused or could not be measured).
 *
 *   bun eval/runner/engine-bench/correctness.ts --dev | --prereg <path> [--engines pglite,postgres,rust] [--gbrain <checkout>@<ref>]
 *     [--pg-url <admin url>] [--checks n1,n5,n6,n6-http,n12,n14] [--n14-tiers 2mb] [--out <dir>] [--work-dir <dir>]
 *
 * Exit: 0 when the stage ran (any Rust verdict but fail), 1 when Rust fails, 3 when a runner errored on any engine.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  EVAL_ENGINE_ENV, EVAL_ENGINE_REFUSED_EXIT, EVAL_ENGINES, rustAddonIdentity, rustEngineInBuild, type EvalEngineKind, type NotApplicable, type RustAddonIdentity,
} from '../eval-engine.ts';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from '../gbrain-under-test.ts';
import { strippedKeysIn } from '../hermetic-env.ts';
import { writeScrubbedJson } from '../receipt.ts';
import { N6_SQL_CHECKS } from '../n6-visibility-fuzz.ts';
import { countedRun, type CountedRun } from './counted.ts';
import { enginesFrom, startPgvectorContainer } from './surface-parity.ts';

export const CORRECTNESS_SCHEMA_VERSION = 'engine-bench-correctness/v1';
export const CORRECTNESS_RUNNER = 'engine-bench/correctness';
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const TYPESCRIPT_ENGINES: readonly EvalEngineKind[] = ['pglite', 'postgres'];

/** One contract count: the receipt path that holds it, and the not_applicable check that removes its measurement. */
export interface Contract { id: string; path: string; na_check?: string }
export interface CheckSpec { id: string; label: string; script: string; args: string[]; contracts: Contract[] }

/**
 * The contract counts per runner. Each is a safety contract the runner already gates on with "== 0"; the quality
 * floors and utility rates stay inside the runner's own verdict.
 *
 * | check   | runner                     | contract counts (receipt path)                                                         |
 * | n1      | n1-knowledge-update.ts     | data.metrics: stale_served, private_value_leaks, acknowledged_writes_lost              |
 * | n5      | n5-forget-residue.ts       | data.metrics: prohibited_active_outputs, reactivations, collateral_expirations,        |
 * |         |                            |   unauthorized_forgets_applied, private_canary_leaks                                   |
 * | n6      | n6-visibility-fuzz.ts      | data.metrics: content_leak_probes, existence_leak_probes, oracle_probes,               |
 * |         |                            |   gate_bypasses, sealed_chunk_violations (not_applicable on rust: raw SQL)             |
 * | n6-http | n6-postgres-http.ts        | data.verdict: leaks, oracles, accepted                                                 |
 * | n12     | n12-format-fidelity.ts     | data.honesty.fabricated, data.adapters.noise_leaks, data.adapters.invented_timestamps, |
 * |         |                            |   data.attendance.false_attended                                                       |
 * | n14     | n14-large-page-fidelity.ts | data.safety: crashes, responses_over_cap, roundtrip_byte_loss, presence_failures       |
 */
export function correctnessChecks(o: { n14Tiers?: string } = {}): CheckSpec[] {
  return [
    {
      id: 'n1', label: 'N1 knowledge update (full)', script: 'eval/runner/n1-knowledge-update.ts', args: [],
      contracts: [
        { id: 'stale_served', path: 'data.metrics.stale_served' },
        { id: 'private_value_leaks', path: 'data.metrics.private_value_leaks' },
        { id: 'acknowledged_writes_lost', path: 'data.metrics.acknowledged_writes_lost' },
      ],
    },
    {
      id: 'n5', label: 'N5 forget residue (full)', script: 'eval/runner/n5-forget-residue.ts', args: [],
      contracts: [
        { id: 'prohibited_active_outputs', path: 'data.metrics.prohibited_active_outputs' },
        { id: 'reactivations', path: 'data.metrics.reactivations' },
        { id: 'collateral_expirations', path: 'data.metrics.collateral_expirations' },
        { id: 'unauthorized_forgets_applied', path: 'data.metrics.unauthorized_forgets_applied' },
        { id: 'private_canary_leaks', path: 'data.metrics.private_canary_leaks' },
      ],
    },
    {
      id: 'n6', label: 'N6 visibility fuzz (in process)', script: 'eval/runner/n6-visibility-fuzz.ts', args: [],
      contracts: [
        { id: 'content_leak_probes', path: 'data.metrics.content_leak_probes' },
        { id: 'existence_leak_probes', path: 'data.metrics.existence_leak_probes' },
        { id: 'oracle_probes', path: 'data.metrics.oracle_probes' },
        { id: 'gate_bypasses', path: 'data.metrics.gate_bypasses' },
        { id: 'sealed_chunk_violations', path: 'data.metrics.sealed_chunk_violations', na_check: N6_SQL_CHECKS.sealed_chunks.check },
      ],
    },
    {
      id: 'n6-http', label: 'N6 over HTTP (gbrain serve --http)', script: 'eval/runner/n6-postgres-http.ts', args: [],
      contracts: [
        { id: 'leaks', path: 'data.verdict.leaks' },
        { id: 'oracles', path: 'data.verdict.oracles' },
        { id: 'accepted_invalid_principals', path: 'data.verdict.accepted' },
      ],
    },
    {
      id: 'n12', label: 'N12 format fidelity', script: 'eval/runner/n12-format-fidelity.ts', args: [],
      contracts: [
        { id: 'fabricated_turns', path: 'data.honesty.fabricated' },
        { id: 'noise_leaks', path: 'data.adapters.noise_leaks' },
        { id: 'invented_timestamps', path: 'data.adapters.invented_timestamps' },
        { id: 'false_attended', path: 'data.attendance.false_attended' },
      ],
    },
    {
      id: 'n14', label: 'N14 large-page fidelity', script: 'eval/runner/n14-large-page-fidelity.ts', args: ['--tiers', o.n14Tiers ?? '2mb'],
      contracts: [
        { id: 'crashes', path: 'data.safety.crashes' },
        { id: 'responses_over_cap', path: 'data.safety.responses_over_cap' },
        { id: 'roundtrip_byte_loss', path: 'data.safety.roundtrip_byte_loss' },
        { id: 'presence_failures', path: 'data.safety.presence_failures' },
      ],
    },
  ];
}

export type EngineStatus = 'pass' | 'fail' | 'unmeasured' | 'refused' | 'error';
export interface ContractValue { value: number | null; not_applicable?: NotApplicable }
export interface EngineRun {
  engine: EvalEngineKind;
  exit_code: number | null;
  wall_ms: number;
  log: string;
  receipt?: string;
  receipt_verdict?: string;
  /** The gbrain commit the runner's receipt says it loaded (execution.product.loaded_git_head), not the declared pin. */
  gbrain_commit?: string | null;
  refusal_reason?: string;
  refusal_message?: string;
  error?: string;
  contracts: Record<string, ContractValue>;
  not_applicable: NotApplicable[];
}
export interface EngineRow extends EngineRun { status: EngineStatus }
export interface Finding { check: string; contract?: string; kind: 'typescript_contract_failure' | 'typescript_engines_differ' | 'typescript_verdict_fail'; detail: string }
export type RustVerdict = 'pass' | 'fail' | 'unmeasured' | 'refused';
export interface CheckRow {
  id: string;
  label: string;
  runner: string;
  args: string[];
  contracts: Contract[];
  engines: Partial<Record<EvalEngineKind, EngineRow>>;
  typescript: { compared: EvalEngineKind[]; differences: string[] };
  /** gaps: every step the Rust receipt lists as not_applicable, each a named gap whatever the verdict. */
  rust: { verdict: RustVerdict; reasons: string[]; gaps: NotApplicable[] } | null;
}
export interface CorrectnessReceipt {
  schema_version: typeof CORRECTNESS_SCHEMA_VERSION;
  runner: typeof CORRECTNESS_RUNNER;
  generated_at: string;
  gbrain: { version: string; product: ReturnType<typeof productIdentityFor>; overlay: Record<string, unknown> | null; rust_engine_in_build: boolean; rust_addon: RustAddonIdentity | null; spec: string | null };
  engines: EvalEngineKind[];
  rule: string;
  keyless: { child_env_stripped: string[]; provider_calls: 0 };
  checks: CheckRow[];
  findings: Finding[];
  summary: { rust: RustVerdict | null; errored: string[]; findings: number; wall_ms: Record<string, Partial<Record<EvalEngineKind, number>>>; total_wall_ms: number };
  environment: Record<string, unknown>;
  counted?: boolean;
  preregistration_attestation?: CountedRun['preregistration_attestation'];
}

export const PARITY_RULE = 'A check passes on Rust when its verdict is pass and every contract count equals the count on both TypeScript engines. When a TypeScript engine fails a contract (or the TypeScript engines disagree), that is a gbrain finding and Rust must be no worse than the better TypeScript engine. A contract whose measurement is not_applicable on an engine counts as neither; a check with every contract not_applicable is unmeasured there. Exit 69 is refused, never fail.';

function valueAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** The refusal a runner printed before exit 69 (evalEngineRefusalMessage), or null. */
export function parseRefusal(text: string): { reason: string; message: string } | null {
  const line = text.split('\n').reverse().find(l => l.startsWith('REFUSED: '));
  if (!line) return null;
  return { reason: /EvalEngineUnavailable \(([^)]+)\)/.exec(line)?.[1] ?? 'unknown', message: line.slice('REFUSED: '.length) };
}

/** Read one run's receipt into its verdict and contract counts. */
export function readRun(check: CheckSpec, run: Omit<EngineRun, 'contracts' | 'not_applicable'>, receipt: Record<string, unknown> | null): EngineRun {
  const contracts: Record<string, ContractValue> = {};
  const notApplicable = Array.isArray(receipt?.not_applicable) ? receipt.not_applicable as NotApplicable[] : [];
  for (const c of check.contracts) {
    const na = c.na_check ? notApplicable.find(n => n.check === c.na_check) : undefined;
    if (na) { contracts[c.id] = { value: null, not_applicable: na }; continue; }
    const v = receipt ? valueAt(receipt, c.path) : undefined;
    contracts[c.id] = { value: typeof v === 'number' ? v : null };
  }
  const loaded = receipt ? valueAt(receipt, 'execution.product.loaded_git_head') : undefined;
  return {
    ...run, contracts, not_applicable: notApplicable,
    ...(receipt && typeof receipt.verdict === 'string' ? { receipt_verdict: receipt.verdict } : {}),
    ...(receipt ? { gbrain_commit: typeof loaded === 'string' ? loaded : null } : {}),
  };
}

export function engineStatus(check: CheckSpec, run: EngineRun): EngineStatus {
  if (run.refusal_reason) return 'refused';
  if (!run.receipt || run.error) return 'error';
  const measured = check.contracts.filter(c => !run.contracts[c.id]?.not_applicable);
  if (measured.length === 0) return 'unmeasured';
  if (measured.some(c => run.contracts[c.id]?.value === null)) return 'error';
  return run.receipt_verdict === 'pass' ? 'pass' : run.receipt_verdict === 'fail' ? 'fail' : 'error';
}

/** Apply the parity rule to one check's runs. */
export function compareCheck(check: CheckSpec, runs: EngineRun[]): { row: CheckRow; findings: Finding[] } {
  const engines: Partial<Record<EvalEngineKind, EngineRow>> = {};
  for (const r of runs) engines[r.engine] = { ...r, status: engineStatus(check, r) };
  const findings: Finding[] = [];
  const ts = TYPESCRIPT_ENGINES.filter(k => engines[k]?.status === 'pass' || engines[k]?.status === 'fail');
  const differences: string[] = [];
  for (const k of ts) if (engines[k]!.status === 'fail') findings.push({ check: check.id, kind: 'typescript_verdict_fail', detail: `${check.id} verdict fail on ${k}` });
  for (const c of check.contracts) {
    const vals = ts.map(k => ({ k, v: engines[k]!.contracts[c.id]?.value })).filter((x): x is { k: EvalEngineKind; v: number } => typeof x.v === 'number');
    for (const { k, v } of vals) if (v !== 0) findings.push({ check: check.id, contract: c.id, kind: 'typescript_contract_failure', detail: `${c.id} = ${v} on ${k} (contract is 0)` });
    if (vals.length > 1 && new Set(vals.map(x => x.v)).size > 1) {
      const d = `${c.id}: ${vals.map(x => `${x.k} ${x.v}`).join(', ')}`;
      differences.push(d);
      findings.push({ check: check.id, contract: c.id, kind: 'typescript_engines_differ', detail: d });
    }
  }
  const rustRow = engines.rust;
  let rust: CheckRow['rust'] = null;
  if (rustRow) {
    const reasons: string[] = [];
    let verdict: RustVerdict;
    if (rustRow.status === 'refused') { verdict = 'refused'; reasons.push(`refused (${rustRow.refusal_reason})`); }
    else if (rustRow.status === 'error') { verdict = ts.length ? 'fail' : 'unmeasured'; reasons.push(`runner error: ${rustRow.error ?? 'no usable receipt'}`); }
    else if (rustRow.status === 'unmeasured') { verdict = 'unmeasured'; reasons.push('every contract not_applicable on rust'); }
    else {
      let failed = rustRow.status === 'fail';
      if (failed) reasons.push(`verdict ${rustRow.receipt_verdict}`);
      let compared = 0;
      for (const c of check.contracts) {
        const mine = rustRow.contracts[c.id];
        if (mine?.not_applicable) { reasons.push(`${c.id} not_applicable`); continue; }
        const refs = ts.map(k => engines[k]!.contracts[c.id]?.value).filter((v): v is number => typeof v === 'number');
        if (refs.length === 0) continue;
        compared++;
        const ok = refs.every(v => v === 0) ? mine!.value === 0 : mine!.value! <= Math.min(...refs);
        if (!ok) { failed = true; reasons.push(`${c.id} = ${mine!.value} on rust; TypeScript ${ts.map(k => `${k} ${engines[k]!.contracts[c.id]?.value}`).join(', ')}`); }
      }
      if (failed) verdict = 'fail';
      else if (compared === 0) { verdict = 'unmeasured'; reasons.push('no TypeScript engine measured this check, so there is no count to compare'); }
      else verdict = 'pass';
    }
    rust = { verdict, reasons, gaps: rustRow.not_applicable ?? [] };
  }
  return {
    row: { id: check.id, label: check.label, runner: check.script, args: check.args, contracts: check.contracts, engines, typescript: { compared: ts, differences }, rust },
    findings,
  };
}

export function rustStageVerdict(rows: readonly CheckRow[]): RustVerdict | null {
  const v = rows.map(r => r.rust?.verdict).filter((x): x is RustVerdict => !!x);
  if (v.length === 0) return null;
  if (v.includes('fail')) return 'fail';
  if (v.every(x => x === 'refused')) return 'refused';
  if (v.every(x => x === 'pass')) return 'pass';
  return 'unmeasured';
}

/** The environment a runner child gets: this process's minus every provider key, plus the engine and the Postgres URL. */
export function runnerEnv(kind: EvalEngineKind, postgresUrl: string | undefined, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const strip = new Set(strippedKeysIn(env));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !strip.has(k)) out[k] = v;
  out[EVAL_ENGINE_ENV] = kind;
  if (postgresUrl) { out.LIFECYCLE_PG_URL = postgresUrl; out.N14_PG_ADMIN_URL = postgresUrl; }
  return out;
}

function runChild(cmd: string, args: string[], env: Record<string, string>, logPath: string, cwd: string): Promise<{ code: number | null; tail: string }> {
  return new Promise(res => {
    const log = createWriteStream(logPath);
    let tail = '';
    const keep = (b: Buffer) => { log.write(b); tail = (tail + b.toString('utf8')).slice(-16_000); };
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', e => { tail += `\nspawn error: ${e.message}`; });
    child.on('close', code => { log.end(() => res({ code, tail })); });
  });
}

export interface CorrectnessOptions {
  gut: GbrainUnderTest;
  engines: EvalEngineKind[];
  /** Admin URL of a Postgres server with pgvector, shared by every Postgres cell and the runners' report-only Postgres arms. */
  postgresUrl?: string;
  /** Per-check, per-engine runner output (receipts) and logs. A temp directory when omitted. */
  workDir?: string;
  /** When set, the stage receipt is written here as correctness-<timestamp>.json. */
  outDir?: string;
  /** The checks to run; correctnessChecks() by default. Tests pass fake runners here. */
  checks?: CheckSpec[];
  /** Directory the runner scripts resolve against. The repository root by default. */
  cwd?: string;
  environment?: Record<string, unknown>;
  /** From countedRun: whether this run counts, and its preregistration attestation. */
  run?: CountedRun;
  log?: (line: string) => void;
}

export async function runCorrectness(o: CorrectnessOptions): Promise<{ receipt: CorrectnessReceipt; file?: string }> {
  const engines = [...new Set(o.engines)];
  for (const k of engines) if (!(EVAL_ENGINES as readonly string[]).includes(k)) throw new Error(`unknown engine ${k}`);
  const checks = o.checks ?? correctnessChecks();
  const workDir = resolve(o.workDir ?? mkdtempSync(join(tmpdir(), 'engine-bench-correctness-')));
  const cwd = o.cwd ?? REPO_ROOT;
  const log = o.log ?? (() => {});
  const spec = o.gut.overlay ? `${o.gut.overlay.checkout}@${o.gut.overlay.ref}` : null;
  const expectedCommit = productIdentityFor(o.gut).loaded_git_head;
  const rows: CheckRow[] = [];
  const findings: Finding[] = [];
  const wall: Record<string, Partial<Record<EvalEngineKind, number>>> = {};
  const t0 = Date.now();
  for (const check of checks) {
    const runs: EngineRun[] = [];
    for (const kind of engines) {
      const output = join(workDir, `${check.id}-${kind}`);
      mkdirSync(output, { recursive: true });
      const logPath = join(workDir, `${check.id}-${kind}.log`);
      rmSync(join(output, 'receipt.json'), { force: true });
      const args = [check.script, ...check.args, ...(spec ? ['--gbrain', spec] : []), '--output', output];
      log(`[correctness] ${check.id} on ${kind}: bun ${args.join(' ')}`);
      const start = Date.now();
      const { code, tail } = await runChild(process.execPath, args, runnerEnv(kind, o.postgresUrl), logPath, cwd);
      const base = { engine: kind, exit_code: code, wall_ms: Date.now() - start, log: logPath };
      (wall[check.id] ??= {})[kind] = base.wall_ms;
      let run: EngineRun;
      if (code === EVAL_ENGINE_REFUSED_EXIT) {
        const refusal = parseRefusal(tail);
        run = readRun(check, { ...base, refusal_reason: refusal?.reason ?? 'unknown', refusal_message: refusal?.message ?? tail.slice(-400) }, null);
      } else {
        const receiptPath = join(output, 'receipt.json');
        let receipt: Record<string, unknown> | null = null;
        try { if (existsSync(receiptPath)) receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { receipt = null; }
        const usable = receipt && (code === 0 || code === 1);
        const error = usable ? {} : { error: `exit ${code}${receipt ? '' : ', no receipt'}: ${tail.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` };
        run = readRun(check, { ...base, ...(receipt ? { receipt: receiptPath } : {}), ...error }, receipt);
        if (usable && (!run.gbrain_commit || !expectedCommit || run.gbrain_commit !== expectedCommit)) run.error = `ran gbrain ${run.gbrain_commit ?? 'unknown'}, expected ${expectedCommit ?? 'unknown'}`;
      }
      runs.push(run);
      log(`[correctness] ${check.id} on ${kind}: exit ${code} in ${Math.round(run.wall_ms / 1000)}s${run.refusal_reason ? ` refused (${run.refusal_reason})` : ''}`);
    }
    const { row, findings: f } = compareCheck(check, runs);
    rows.push(row);
    findings.push(...f);
  }
  const receipt: CorrectnessReceipt = {
    schema_version: CORRECTNESS_SCHEMA_VERSION,
    runner: CORRECTNESS_RUNNER,
    generated_at: new Date().toISOString(),
    gbrain: { version: o.gut.version, product: productIdentityFor(o.gut), overlay: overlaySummary(o.gut), rust_engine_in_build: rustEngineInBuild(o.gut), rust_addon: engines.includes('rust') ? rustAddonIdentity(o.gut) : null, spec },
    engines,
    rule: PARITY_RULE,
    keyless: { child_env_stripped: strippedKeysIn(process.env), provider_calls: 0 },
    checks: rows,
    findings,
    summary: {
      rust: rustStageVerdict(rows),
      errored: rows.flatMap(r => Object.values(r.engines).filter(e => e!.status === 'error').map(e => `${r.id}:${e!.engine}`)),
      findings: findings.length,
      wall_ms: wall,
      total_wall_ms: Date.now() - t0,
    },
    environment: o.environment ?? {},
    ...o.run,
  };
  if (!o.outDir) return { receipt };
  const file = join(o.outDir, `correctness-${receipt.generated_at.replace(/[:.]/g, '-')}.json`);
  writeScrubbedJson(file, receipt);
  return { receipt, file };
}

export function summaryLines(r: CorrectnessReceipt): string[] {
  const lines = [`correctness: gbrain ${r.gbrain.version}, engines ${r.engines.join(',')}, rust ${r.summary.rust ?? 'not run'}, ${r.findings.length} finding(s), ${Math.round(r.summary.total_wall_ms / 1000)}s`];
  for (const c of r.checks) {
    const cells = Object.values(c.engines).map(e => `${e!.engine} ${e!.status}${e!.refusal_reason ? ` (${e!.refusal_reason})` : ''} ${Math.round(e!.wall_ms / 1000)}s`);
    lines.push(`  ${c.id}: ${cells.join(', ')}${c.rust ? `; rust ${c.rust.verdict}${c.rust.gaps.length ? `, ${c.rust.gaps.length} gap(s)` : ''}` : ''}`);
    for (const g of c.rust?.gaps ?? []) lines.push(`    gap: ${g.check}: ${g.reason.slice(0, 160)}`);
  }
  for (const f of r.findings) lines.push(`  finding ${f.check}${f.contract ? `.${f.contract}` : ''}: ${f.detail}`);
  return lines;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0) return argv[i + 1];
  return argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(argv: string[]): Promise<number> {
  const run = countedRun(argv, REPO_ROOT);
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  if (!gut.overlay) throw new Error('correctness needs --gbrain <checkout>@<ref>: every check must run the named gbrain commit, and without an overlay no run has a commit to match, so every run would error at the end.');
  const engines = enginesFrom(argv);
  const all = correctnessChecks({ n14Tiers: flag(argv, '--n14-tiers') });
  const only = flag(argv, '--checks')?.split(',').map(s => s.trim()).filter(Boolean);
  for (const id of only ?? []) if (!all.some(c => c.id === id)) throw new Error(`--checks: ${id} is not a check. Use ${all.map(c => c.id).join(', ')}.`);
  const checks = only ? all.filter(c => only.includes(c.id)) : all;
  const outDir = resolve(flag(argv, '--out') ?? join(REPO_ROOT, 'eval/reports/engine-bench/correctness'));
  let postgresUrl = flag(argv, '--pg-url');
  let container: Awaited<ReturnType<typeof startPgvectorContainer>> | null = null;
  const environment: Record<string, unknown> = { platform: `${process.platform}-${process.arch}`, bun: Bun.version };
  try {
    if (!postgresUrl) {
      container = await startPgvectorContainer();
      postgresUrl = container.url;
      environment.postgres = { source: 'local container', image: 'pgvector/pgvector:pg16', image_digest: container.image_digest };
    } else {
      environment.postgres = { source: '--pg-url' };
    }
    const workDir = flag(argv, '--work-dir');
    const { receipt, file } = await runCorrectness({ gut, engines, postgresUrl, workDir: workDir && resolve(workDir), outDir, checks, environment, run, log: l => console.log(l) });
    for (const l of summaryLines(receipt)) console.log(l);
    console.log(`receipt: ${relative(process.cwd(), file!)}`);
    if (receipt.summary.errored.length) return 3;
    return receipt.summary.rust === 'fail' ? 1 : 0;
  } finally {
    container?.stop();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(e instanceof Error ? e.message : e); process.exit(3); });
}
