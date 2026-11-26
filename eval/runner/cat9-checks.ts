/**
 * Cat 9 free checks: build a brain from a scenario's `setup`, then run its
 * `checks` with the gbrain CLI and compare the output to a fixed expectation.
 * No agent, no judge, no provider key.
 *
 * A Cat 9 scenario (eval/runner/cat9-workflows.ts WorkflowScenario) may carry
 * two optional fields next to its judged rubric:
 *
 *   setup   steps that build the brain state the scenario needs, in order:
 *           { run: [argv...], stdin?, brain?, member?, capture?, allow_fail? }
 *           runs `gbrain <argv>` (as `member` under GBRAIN_ENFORCED_MEMBER
 *           when given); { capture_time: name } records the current time;
 *           { remove_datastore: brain } moves a brain's PGLite directory away.
 *   checks  { id, description, run, expect, requires?, known_failure? }: one
 *           CLI call and the result it must give. `expect` is mechanical
 *           (exit code, JSON paths, text that must or must not appear), so the
 *           same output always gives the same verdict.
 *
 * A scenario that applies to some engines only lists them in `engines`, with
 * the reason in `engines_note`; on any other engine its checks report
 * engine_not_supported_by_runner with that reason and nothing runs.
 *
 * Each scenario gets fresh brains (one PGLite brain per name used, `A` by
 * default) under a throwaway GBRAIN_HOME and its own copy of the fixture
 * corpus, because gbrain writes ownership markers into a source folder. Every
 * provider key is removed from the child environment, so a brain is
 * keyword-only. A check or step that needs something the free run cannot give
 * (an embedding provider, a model, a running MCP server, an injected fault, a
 * hand-built fixture) lists it in `requires` and is reported as not run, with
 * that reason, never as a pass.
 *
 * Verdicts per check: pass; fail; expected_fail (failed on an audit finding
 * named in known_failure); unexpected_pass (a known failure now passes, so the
 * finding may be fixed); not_run; error (the harness could not run it, for
 * example a setup step failed). A known failure is a label for the reader: it
 * never turns a fail into a pass.
 *
 * Engines: GBRAIN_EVAL_ENGINE=pglite|postgres|rust picks the engine each fresh
 * brain is created on (eval/runner/eval-engine.ts; unset means PGLite, as
 * before). PGLite brains come from `gbrain init --pglite`, Postgres brains from
 * `gbrain init --url` on a scratch database created through `--pg-url` or
 * LIFECYCLE_PG_URL and dropped afterwards, and Rust brains from a rust CLI
 * config plus `gbrain init --migrate-only` (gbrain init has no Rust flag). On
 * Postgres the `postgres` requirement is met. A step the engine cannot run (a
 * PGLite-only datastore step, or a CLI call that stops on the engine's typed
 * refusal) makes the affected checks engine_not_supported_by_runner, never a
 * pass or a fail.
 *
 * Usage: bun eval/runner/cat9-workflows.ts --checks [--gbrain <checkout>[@ref]] [--scenarios <file>] [--only id,id] [--output <dir>] [--pg-url <admin url>] [--json]
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HERMETIC_KEY_PATTERN, HERMETIC_STRIPPED_KEYS, redactUrlPasswords } from './hermetic-env.ts';
import { ENGINE_NOT_SUPPORTED_BY_RUNNER, ENGINE_REFUSAL_TEXT_RE, EVAL_ENGINES, EvalEngineUnavailable, cliEngineConfig, redactConnection, rustAddonEnv, type EvalEngineKind } from './eval-engine.ts';

// ─── Types ────────────────────────────────────────────────────────────

/** Things a free run does not have. A check or step that needs one is not run. */
export const CAT9_REQUIREMENTS = ['embeddings', 'llm', 'mcp_server', 'fault_injection', 'postgres', 'sql_scan', 'fixture_build'] as const;
export type Cat9Requirement = typeof CAT9_REQUIREMENTS[number];

export const REQUIREMENT_REASONS: Record<Cat9Requirement, string> = {
  embeddings: 'needs an embedding provider key (a keyed brain); the free run is keyword-only',
  llm: 'needs a model call; the free run sends none',
  mcp_server: 'needs a long-running `gbrain serve` and an MCP client; the free run calls the CLI only',
  fault_injection: 'needs a lookup failure injected into gbrain; the free run has no fault hook',
  postgres: 'needs a Postgres engine; the free run uses PGLite',
  sql_scan: 'needs a direct SQL scan of the brain; the free run reads the CLI only',
  fixture_build: 'needs a brain state the free runner does not build yet (see the setup note)',
};

export interface Cat9RunStep {
  /** gbrain argv without the leading `gbrain`. `{corpus}`, `{home:<brain>}` and captured `{name}` are substituted. */
  run: string[];
  /** File fed to stdin, relative to the corpus copy (for example `puts/pat.md`). */
  stdin?: string;
  /** Named brain; default `A`. Each name is its own GBRAIN_HOME. */
  brain?: string;
  /**
   * Run the call as this brain member: the child gets GBRAIN_ENFORCED_MEMBER=<member>, so gbrain applies that member's
   * read and write rules to the local CLI (gbrain docs/guides/enforced-member.md). Omitted: the trusted local CLI.
   */
  member?: string;
  /** Captured variable name -> JSON path into stdout. */
  capture?: Record<string, string>;
  /** A setup step that may exit non-zero (setup only). */
  allow_fail?: boolean;
  requires?: Cat9Requirement[];
  note?: string;
}
export interface Cat9TimeStep { capture_time: string }
export interface Cat9RemoveDatastoreStep { remove_datastore: string }
export interface Cat9ManualStep { manual: string; requires: Cat9Requirement[] }
/** Read a JSON file the brain wrote (for example a source's ownership marker) and capture values from it. */
export interface Cat9ReadJsonStep { read_json: string; capture: Record<string, string> }
export type Cat9SetupStep = Cat9RunStep | Cat9TimeStep | Cat9RemoveDatastoreStep | Cat9ManualStep | Cat9ReadJsonStep;

export const SETUP_KINDS = ['run', 'capture_time', 'remove_datastore', 'manual', 'read_json'] as const;

export const JSON_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'exists', 'absent', 'empty', 'nonempty', 'includes', 'excludes', 'all_match', 'some_match', 'length'] as const;
export type Cat9JsonOp = typeof JSON_OPS[number];
/** Ops that compare against `value`; the rest take none. */
const OPS_WITH_VALUE = new Set<string>(['eq', 'ne', 'gt', 'gte', 'lt', 'includes', 'excludes', 'all_match', 'some_match', 'length']);
export const EXPECT_KEYS = ['exit', 'json', 'stdout_includes', 'stdout_excludes', 'stderr_excludes', 'output_includes', 'output_excludes', 'lines', 'datastore_absent'] as const;
export interface Cat9JsonAssertion { path: string; op: Cat9JsonOp; value?: unknown }

export interface Cat9Expect {
  exit?: 'zero' | 'nonzero';
  /** Assertions on stdout parsed as JSON (a parse failure fails every assertion). */
  json?: Cat9JsonAssertion[];
  stdout_includes?: string[];
  stdout_excludes?: string[];
  stderr_excludes?: string[];
  /** stdout and stderr together. */
  output_includes?: string[];
  output_excludes?: string[];
  /**
   * Rules for the output lines (stdout and stderr) that start with `prefix`,
   * for example the `Fix:` line of an error. At least one such line must exist.
   */
  lines?: Array<{ prefix: string; includes?: string[]; excludes?: string[] }>;
  /** The brain's PGLite directory must not exist after the call (no silent re-create). */
  datastore_absent?: string;
}

export interface Cat9Check extends Omit<Cat9RunStep, 'allow_fail' | 'run'> {
  id: string;
  /** What the check expects, in plain words (the audit's expectation). */
  description: string;
  /** Omitted, with `not_mechanized`, when no exact CLI call exists yet; such a check never runs. */
  run?: string[];
  expect?: Cat9Expect;
  /** Why the check has no `run` yet. */
  not_mechanized?: string;
  /** The audit finding this check is expected to fail on, at the audited build. */
  known_failure?: { finding: string; note: string };
  /**
   * Earlier checks in the same scenario whose writes this check observes. When given (even empty), it replaces the
   * brain-wide rule: the check does not run, and reports engine_not_supported_by_runner, when a check it depends on was
   * refused by the engine or not supported; a check with no refused dependency keeps its own result, pass or fail.
   */
  depends_on?: string[];
}

export type Cat9CheckStatus = 'pass' | 'fail' | 'expected_fail' | 'unexpected_pass' | 'not_run' | 'error' | typeof ENGINE_NOT_SUPPORTED_BY_RUNNER;

export interface Cat9CheckRow {
  scenario_id: string;
  check_id: string;
  status: Cat9CheckStatus;
  finding: string | null;
  /** Why it failed, was not run, or errored. Empty for a plain pass. */
  reasons: string[];
  exit_code: number | null;
  argv: string[] | null;
  /** First 600 characters of stdout and stderr, temp paths masked. */
  stdout_head?: string;
  stderr_head?: string;
}

export interface ExecResult { exit: number; stdout: string; stderr: string }
export type GbrainExec = (argv: string[], opts: { home: string; cwd: string; stdin?: string; env?: Record<string, string> }) => ExecResult;

/** The checks-related part of a scenario; WorkflowScenario carries these as optional fields. */
export interface Cat9CheckedScenario {
  id: string;
  setup?: Cat9SetupStep[];
  checks?: Cat9Check[];
  requires?: Cat9Requirement[];
  /** The engines the scenario applies to; omitted means every engine. */
  engines?: EvalEngineKind[];
  /** Why the scenario applies to `engines` only; required with `engines`. */
  engines_note?: string;
}

// ─── Pure helpers ─────────────────────────────────────────────────────

/**
 * Read a dotted path: `a.b`, `a.0.b`, `length` on an array, and `[*]` to map
 * the rest of the path over an array (`[*].slug` gives every slug).
 */
export function jsonPath(value: unknown, path: string): unknown {
  if (path === '' || path === '.') return value;
  const parts = path.replace(/\[\*\]/g, '.[*]').split('.').filter(p => p !== '');
  const walk = (v: unknown, i: number): unknown => {
    if (i >= parts.length) return v;
    const p = parts[i];
    if (p === '[*]') return Array.isArray(v) ? v.map(x => walk(x, i + 1)) : undefined;
    if (p === 'length' && (Array.isArray(v) || typeof v === 'string')) return walk(v.length, i + 1);
    if (v === null || typeof v !== 'object') return undefined;
    return walk((v as Record<string, unknown>)[p], i + 1);
  };
  return walk(value, 0);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** One JSON assertion; returns a failure reason or null. */
export function checkJsonAssertion(doc: unknown, a: Cat9JsonAssertion): string | null {
  const got = jsonPath(doc, a.path);
  const show = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? 'undefined' : s.length > 160 ? `${s.slice(0, 160)}...` : s; };
  const fail = (why: string) => `json ${a.path} ${a.op}${a.value === undefined ? '' : ` ${show(a.value)}`}: ${why} (got ${show(got)})`;
  switch (a.op) {
    case 'eq': return same(got, a.value) ? null : fail('not equal');
    case 'ne': return got !== undefined && !same(got, a.value) ? null : fail('equal or missing');
    case 'gt': return typeof got === 'number' && got > Number(a.value) ? null : fail('not greater');
    case 'gte': return typeof got === 'number' && got >= Number(a.value) ? null : fail('not greater or equal');
    case 'lt': return typeof got === 'number' && got < Number(a.value) ? null : fail('not less');
    case 'length': return Array.isArray(got) && got.length === Number(a.value) ? null : fail('wrong length');
    case 'exists': return got !== undefined && got !== null ? null : fail('missing');
    case 'absent': return got === undefined || got === null ? null : fail('present');
    case 'empty': return Array.isArray(got) && got.length === 0 ? null : fail('not an empty array');
    case 'nonempty': return Array.isArray(got) && got.length > 0 ? null : fail('not a non-empty array');
    case 'includes': return Array.isArray(got) && got.some(x => same(x, a.value)) ? null : fail('value not in array');
    case 'excludes': return Array.isArray(got) && !got.some(x => same(x, a.value)) ? null : fail(Array.isArray(got) ? 'value in array' : 'not an array');
    case 'some_match': {
      if (!Array.isArray(got)) return fail('not an array');
      const re = new RegExp(String(a.value));
      return got.some(x => typeof x === 'string' && re.test(x)) ? null : fail('no value matches');
    }
    case 'all_match': {
      // Never vacuous: an empty or missing array fails.
      if (!Array.isArray(got) || got.length === 0) return fail('no values to match');
      const re = new RegExp(String(a.value));
      const bad = got.filter(x => typeof x !== 'string' || !re.test(x));
      return bad.length === 0 ? null : fail(`${bad.length} value(s) do not match`);
    }
    default:
      // Fail closed: an op the engine does not know is never a pass.
      return fail(`unknown op ${JSON.stringify((a as { op: unknown }).op)}`);
  }
}

/** Problems with one expectation: unknown keys or ops, missing operands, or nothing to check. */
export function validateExpect(e: unknown, where: string): string[] {
  const out: string[] = [];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [`${where}: expect must be an object`];
  const x = e as Record<string, unknown>;
  const keys = Object.keys(x);
  if (keys.length === 0) out.push(`${where}: expect is empty`);
  for (const k of keys) if (!(EXPECT_KEYS as readonly string[]).includes(k)) out.push(`${where}: unknown expect key ${JSON.stringify(k)}`);
  if (x.exit !== undefined && x.exit !== 'zero' && x.exit !== 'nonzero') out.push(`${where}: exit must be zero or nonzero`);
  for (const k of ['stdout_includes', 'stdout_excludes', 'stderr_excludes', 'output_includes', 'output_excludes']) {
    if (x[k] === undefined) continue;
    if (!Array.isArray(x[k]) || (x[k] as unknown[]).length === 0 || (x[k] as unknown[]).some(v => typeof v !== 'string' || v === '')) out.push(`${where}: ${k} must be a non-empty list of non-empty strings`);
  }
  if (x.json !== undefined) {
    if (!Array.isArray(x.json) || x.json.length === 0) out.push(`${where}: json must be a non-empty list`);
    else for (const a of x.json as Record<string, unknown>[]) {
      if (typeof a?.path !== 'string') out.push(`${where}: json assertion needs a path`);
      if (!(JSON_OPS as readonly string[]).includes(String(a?.op))) out.push(`${where}: unknown json op ${JSON.stringify(a?.op)}`);
      else if (OPS_WITH_VALUE.has(String(a.op)) !== ('value' in a)) out.push(`${where}: json op ${a.op} ${OPS_WITH_VALUE.has(String(a.op)) ? 'needs' : 'takes no'} value`);
    }
  }
  if (x.lines !== undefined) {
    if (!Array.isArray(x.lines) || x.lines.length === 0) out.push(`${where}: lines must be a non-empty list`);
    else for (const l of x.lines as Record<string, unknown>[]) {
      if (typeof l?.prefix !== 'string' || l.prefix === '') out.push(`${where}: a lines rule needs a prefix`);
      for (const k of Object.keys(l ?? {})) if (!['prefix', 'includes', 'excludes'].includes(k)) out.push(`${where}: unknown lines key ${JSON.stringify(k)}`);
    }
  }
  if (x.datastore_absent !== undefined && typeof x.datastore_absent !== 'string') out.push(`${where}: datastore_absent names a brain`);
  return out;
}

/** A line that opens a JSON document, as opposed to a `[gbrain] ...` style notice. */
const JSON_START = /^(\{|\[\s*$|\[\s*[\[{"\d\-\]]|\[\s*(true|false|null)\b)/;

/**
 * Parse stdout as JSON. Leading notice lines are skipped up to the first line
 * that opens a JSON document; that document is then parsed from there to the
 * end, or to its last closing line when notices follow it. A document that
 * fails to parse is a failure: the parser never looks for JSON inside it.
 */
export function parseJsonOutput(stdout: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = stdout.trim();
  try { return { ok: true, value: JSON.parse(trimmed) }; } catch { /* fall through */ }
  const lines = trimmed.split('\n');
  const start = lines.findIndex(l => JSON_START.test(l));
  if (start < 0) return { ok: false };
  let end = lines.length;
  while (end > start + 1 && !/^[}\]]/.test(lines[end - 1])) end--;
  for (const stop of new Set([lines.length, end])) {
    try { return { ok: true, value: JSON.parse(lines.slice(start, stop).join('\n')) }; } catch { /* next stop */ }
  }
  return { ok: false };
}

/** Compare one CLI result to an expectation. Returns every failed condition. */
export function evaluateExpect(expect: Cat9Expect, r: ExecResult, ctx: { datastoreExists?: (brain: string) => boolean } = {}): string[] {
  const reasons: string[] = [];
  if (expect.exit === 'zero' && r.exit !== 0) reasons.push(`exit ${r.exit}, expected 0`);
  if (expect.exit === 'nonzero' && r.exit === 0) reasons.push('exit 0, expected non-zero');
  const output = `${r.stdout}\n${r.stderr}`;
  for (const s of expect.stdout_includes ?? []) if (!r.stdout.includes(s)) reasons.push(`stdout lacks ${JSON.stringify(s)}`);
  for (const s of expect.stdout_excludes ?? []) if (r.stdout.includes(s)) reasons.push(`stdout has ${JSON.stringify(s)}`);
  for (const s of expect.stderr_excludes ?? []) if (r.stderr.includes(s)) reasons.push(`stderr has ${JSON.stringify(s)}`);
  for (const s of expect.output_includes ?? []) if (!output.includes(s)) reasons.push(`output lacks ${JSON.stringify(s)}`);
  for (const s of expect.output_excludes ?? []) if (output.includes(s)) reasons.push(`output has ${JSON.stringify(s)}`);
  for (const rule of expect.lines ?? []) {
    const picked = output.split('\n').filter(l => l.startsWith(rule.prefix));
    if (picked.length === 0) { reasons.push(`no line starts with ${JSON.stringify(rule.prefix)}`); continue; }
    for (const s of rule.includes ?? []) if (!picked.some(l => l.includes(s))) reasons.push(`no ${JSON.stringify(rule.prefix)} line has ${JSON.stringify(s)}`);
    for (const s of rule.excludes ?? []) if (picked.some(l => l.includes(s))) reasons.push(`a ${JSON.stringify(rule.prefix)} line has ${JSON.stringify(s)}`);
  }
  if (expect.json && expect.json.length > 0) {
    const parsed = parseJsonOutput(r.stdout);
    if (!parsed.ok) reasons.push('stdout is not JSON');
    else for (const a of expect.json) { const why = checkJsonAssertion(parsed.value, a); if (why) reasons.push(why); }
  }
  if (expect.datastore_absent !== undefined) {
    if (!ctx.datastoreExists) reasons.push('datastore check needs a brain context');
    else if (ctx.datastoreExists(expect.datastore_absent)) reasons.push(`brain ${expect.datastore_absent} datastore exists again after the call`);
  }
  return reasons;
}

/** The verdict for a check that ran. */
export function classify(reasons: string[], knownFailure: Cat9Check['known_failure']): Cat9CheckStatus {
  if (reasons.length === 0) return knownFailure ? 'unexpected_pass' : 'pass';
  return knownFailure ? 'expected_fail' : 'fail';
}

/** substitute() over every string inside a JSON-shaped value. */
export function substituteDeep<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === 'string') return substitute(value, vars) as T;
  if (Array.isArray(value)) return value.map(v => substituteDeep(v, vars)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteDeep(v, vars)])) as T;
  return value;
}

/** Replace `{name}` placeholders; an unknown name is an error, never left in place. */
export function substitute(text: string, vars: Record<string, string>): string {
  // A name starts with a letter or underscore, so regex quantifiers such as \d{4} pass through.
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_:]*)\}/g, (_, name: string) => {
    if (!(name in vars)) throw new Error(`unknown placeholder {${name}}`);
    return vars[name];
  });
}

function isRun(s: Cat9SetupStep): s is Cat9RunStep { return Array.isArray((s as Cat9RunStep).run); }

/** Problems with a scenario's setup and checks. Empty when the shape is valid. */
export function validateChecks(s: Cat9CheckedScenario): string[] {
  const out: string[] = [];
  const known = new Set<string>(CAT9_REQUIREMENTS);
  const reqs = (where: string, r: unknown) => {
    if (r === undefined) return;
    if (!Array.isArray(r) || r.some(x => !known.has(String(x)))) out.push(`${s.id} ${where}: requires must list only ${CAT9_REQUIREMENTS.join(', ')}`);
  };
  reqs('scenario', s.requires);
  if (s.engines !== undefined) {
    if (!Array.isArray(s.engines) || s.engines.length === 0 || s.engines.some(e => !(EVAL_ENGINES as readonly string[]).includes(String(e)))) out.push(`${s.id}: engines must list only ${EVAL_ENGINES.join(', ')}`);
    if (typeof s.engines_note !== 'string' || s.engines_note === '') out.push(`${s.id}: engines needs an engines_note that says why`);
  } else if (s.engines_note !== undefined) out.push(`${s.id}: engines_note without engines`);
  const memberOk = (where: string, m: unknown) => {
    // gbrain's member id rule (src/core/access/principals.ts ACCESS_ID_RE).
    if (m !== undefined && (typeof m !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(m))) out.push(`${s.id} ${where}: member must be a member id such as bob-example`);
  };
  (s.setup ?? []).forEach((step, i) => {
    const kinds = SETUP_KINDS.filter(k => k in (step as object));
    if (kinds.length !== 1) out.push(`${s.id} setup[${i}]: needs exactly one of ${SETUP_KINDS.join(', ')}`);
    if ('read_json' in step && (!step.capture || Object.keys(step.capture).length === 0)) out.push(`${s.id} setup[${i}]: read_json needs a capture`);
    if (isRun(step)) {
      if (step.run.length === 0 || step.run.some(a => typeof a !== 'string')) out.push(`${s.id} setup[${i}]: run must be a non-empty string array`);
      if (step.run[0] === 'gbrain') out.push(`${s.id} setup[${i}]: run omits the leading gbrain`);
      reqs(`setup[${i}]`, step.requires);
      memberOk(`setup[${i}]`, step.member);
    }
    if ('manual' in step) {
      if (!Array.isArray(step.requires) || step.requires.length === 0) out.push(`${s.id} setup[${i}]: a manual step must say what it requires`);
      else reqs(`setup[${i}]`, step.requires);
    }
  });
  const ids = new Set<string>();
  for (const c of s.checks ?? []) {
    if (!c.id || ids.has(c.id)) out.push(`${s.id}: check id ${JSON.stringify(c.id)} missing or repeated`);
    ids.add(c.id);
    if (!c.description) out.push(`${s.id}/${c.id}: description missing`);
    if (c.run === undefined) {
      if (!c.not_mechanized) out.push(`${s.id}/${c.id}: a check without run must say why in not_mechanized`);
      if (!c.requires || c.requires.length === 0) out.push(`${s.id}/${c.id}: a check without run must list what it requires`);
      if (c.expect !== undefined) out.push(`${s.id}/${c.id}: a check without run has no expect`);
    } else {
      if (!Array.isArray(c.run) || c.run.length === 0 || c.run.some(a => typeof a !== 'string')) out.push(`${s.id}/${c.id}: run must be a non-empty string array`);
      else if (c.run[0] === 'gbrain') out.push(`${s.id}/${c.id}: run omits the leading gbrain`);
      out.push(...validateExpect(c.expect, `${s.id}/${c.id}`));
    }
    if (c.known_failure && (!c.known_failure.finding || !c.known_failure.note)) out.push(`${s.id}/${c.id}: known_failure needs finding and note`);
    if (c.depends_on !== undefined) {
      if (!Array.isArray(c.depends_on)) out.push(`${s.id}/${c.id}: depends_on must be a list of earlier check ids`);
      else for (const d of c.depends_on) if (!ids.has(d) || d === c.id) out.push(`${s.id}/${c.id}: depends_on names ${JSON.stringify(d)}, which is not an earlier check`);
    }
    if ('allow_fail' in c) out.push(`${s.id}/${c.id}: allow_fail is for setup steps only`);
    reqs(c.id, c.requires);
    memberOk(c.id, c.member);
  }
  return out;
}

// ─── Running ──────────────────────────────────────────────────────────

/** A copy of the environment with every provider key removed and GBRAIN_HOME set. */
export function hermeticChildEnv(home: string, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const listed = new Set<string>(HERMETIC_STRIPPED_KEYS);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || listed.has(k) || HERMETIC_KEY_PATTERN.test(k) || k.startsWith('GBRAIN_')) continue;
    out[k] = v;
  }
  out.GBRAIN_HOME = home;
  return out;
}

/**
 * Run `bun <gbrainRoot>/src/cli.ts <argv>` in a hermetic child process. `extraEnv` adds variables after the hermetic
 * strip (the Rust addon path, which the strip of GBRAIN_* would otherwise remove).
 */
export function cliExec(gbrainRoot: string, timeoutMs = 120_000, extraEnv: Record<string, string> = {}): GbrainExec {
  const cli = join(gbrainRoot, 'src/cli.ts');
  return (argv, { home, cwd, stdin, env }) => {
    const p = Bun.spawnSync([process.execPath, cli, ...argv], {
      cwd, env: { ...hermeticChildEnv(home), ...extraEnv, ...(env ?? {}) }, stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs,
    });
    return { exit: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };
}

/** The engine a checks run creates its brains on; omitted means PGLite. */
export interface Cat9Engine {
  kind: EvalEngineKind;
  /** Postgres admin URL; each brain gets its own scratch database, dropped after the scenario. */
  pgAdminUrl?: string;
}

/** The gbrain CLI's typed refusal of something the engine cannot do (engine_capability_missing). */
export const ENGINE_REFUSAL_RE = ENGINE_REFUSAL_TEXT_RE;

/** The extra child environment a run on `kind` needs: the Rust addon path, which the hermetic strip removes. */
export function cat9EngineEnv(kind: EvalEngineKind | undefined): Record<string, string> {
  return kind === 'rust' ? { ...rustAddonEnv() } as Record<string, string> : {};
}

/** Requirements an engine meets by itself: a Postgres run meets `postgres`. */
export function engineRequirements(kind: EvalEngineKind | undefined): Cat9Requirement[] {
  return kind === 'postgres' ? ['postgres'] : [];
}

export interface ScenarioCheckOptions {
  /** The engine every brain is created on (default PGLite through `gbrain init --pglite`). */
  engine?: Cat9Engine;
  exec: GbrainExec;
  /** The committed corpus directory; copied per scenario. */
  corpusDir: string;
  /** Requirements this run can meet. The free run meets none. */
  available?: ReadonlySet<Cat9Requirement>;
  /** Parent for temp dirs; default the OS temp dir. */
  tmpRoot?: string;
  /** Keep the temp dirs (debugging). */
  keep?: boolean;
  now?: () => Date;
}

function head(text: string, root: string, pgAdminUrl?: string): string {
  return redactConnection(redactUrlPasswords(text.split(root).join('<tmp>')), pgAdminUrl).slice(0, 600);
}

/** Run one scenario's setup and checks on fresh brains. Scenarios without checks give no rows. */
export function runScenarioChecks(s: Cat9CheckedScenario, o: ScenarioCheckOptions): Cat9CheckRow[] {
  const checks = s.checks ?? [];
  if (checks.length === 0) return [];
  const kind: EvalEngineKind = o.engine?.kind ?? 'pglite';
  const available = new Set<Cat9Requirement>([...(o.available ?? []), ...engineRequirements(o.engine?.kind)]);
  const missing = (r?: Cat9Requirement[]) => (r ?? []).filter(x => !available.has(x));
  let root = '';
  // Every recorded string is masked: reasons quote observed values, which can hold temp paths.
  const mask = (t: string) => redactConnection(root ? redactUrlPasswords(t.split(root).join('<tmp>')) : redactUrlPasswords(t), o.engine?.pgAdminUrl);
  const row = (c: Cat9Check, status: Cat9CheckStatus, reasons: string[], extra: Partial<Cat9CheckRow> = {}): Cat9CheckRow => ({
    scenario_id: s.id, check_id: c.id, status, finding: c.known_failure?.finding ?? null, reasons: reasons.map(mask), exit_code: null, argv: null, ...extra,
  });

  // A scenario scoped to other engines: nothing runs, and the reason is the scenario's own note.
  if (s.engines && !s.engines.includes(kind)) {
    return checks.map(c => row(c, ENGINE_NOT_SUPPORTED_BY_RUNNER, [`${ENGINE_NOT_SUPPORTED_BY_RUNNER} (${kind}): this scenario applies to ${s.engines!.join(' and ')} only. ${s.engines_note ?? ''}`.trim()]));
  }

  // A scenario-level or setup-level requirement the run lacks: nothing runs.
  const setupMissing = [...missing(s.requires), ...(s.setup ?? []).flatMap(st => ('requires' in st ? missing(st.requires) : []))];
  if (setupMissing.length > 0) {
    const why = [...new Set(setupMissing)].map(r => `setup not run: ${REQUIREMENT_REASONS[r]}`);
    return checks.map(c => row(c, 'not_run', why));
  }

  root = mkdtempSync(join(o.tmpRoot ?? tmpdir(), `cat9-${s.id.replace(/[^A-Za-z0-9_-]/g, '_')}-`));
  const corpus = join(root, 'corpus');
  cpSync(o.corpusDir, corpus, { recursive: true });
  const vars: Record<string, string> = { corpus };
  const brains = new Map<string, string>();
  const scratchDbs: string[] = [];
  const homeOf = (name: string) => join(root, `home-${name}`);
  // The on-disk store of a brain: PGLite's data directory or the Rust store; a Postgres brain has none.
  const datastoreOf = (name: string): string | null => kind === 'postgres' ? null : join(homeOf(name), '.gbrain', kind === 'rust' ? 'brain.rust' : 'brain.pglite');
  const unsupported = (what: string) => new EvalEngineUnavailable(kind, ENGINE_NOT_SUPPORTED_BY_RUNNER, `${what} needs an on-disk datastore, and a ${kind} brain keeps its data in a database server`);
  const initArgv = (name: string, home: string): string[] => {
    if (kind === 'pglite') return ['init', '--pglite'];
    if (kind === 'postgres') {
      if (!o.engine?.pgAdminUrl) throw new EvalEngineUnavailable('postgres', 'postgres_url_missing', 'Cat 9 checks on postgres need an admin URL (--pg-url or LIFECYCLE_PG_URL).');
      const db = `cat9_${process.pid}_${randomUUID().slice(0, 8)}`;
      createScratchDb(o.engine.pgAdminUrl, db);
      scratchDbs.push(db);
      const url = new URL(o.engine.pgAdminUrl);
      url.pathname = `/${db}`;
      return ['init', '--url', url.toString(), '--non-interactive'];
    }
    // Rust: gbrain init has no Rust flag, so write the rust config first, as eval-engine.ts initRustBrain does.
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const config = { ...cliEngineConfig('rust', { databasePath: datastoreOf(name)! }), embedding_disabled: true, schema_pack: 'gbrain-base-v2' };
    writeFileSync(join(home, '.gbrain', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    return ['init', '--migrate-only', '--non-interactive'];
  };
  const brain = (name = 'A'): string => {
    let home = brains.get(name);
    if (home) return home;
    home = homeOf(name);
    mkdirSync(home, { recursive: true });
    const argv = initArgv(name, home);
    const r = o.exec(argv, { home, cwd: root });
    if (r.exit !== 0) {
      const out = head(r.stderr || r.stdout, root, o.engine?.pgAdminUrl);
      if (ENGINE_REFUSAL_RE.test(`${r.stderr}\n${r.stdout}`)) throw new EvalEngineUnavailable(kind, ENGINE_NOT_SUPPORTED_BY_RUNNER, `gbrain ${argv[0]} for brain ${name} stopped on the engine's typed refusal: ${out}`);
      throw new Error(`gbrain ${argv.slice(0, 2).join(' ')} for brain ${name} exited ${r.exit}: ${out}`);
    }
    brains.set(name, home);
    vars[`home:${name}`] = home;
    return home;
  };
  const call = (step: Pick<Cat9RunStep, 'run' | 'stdin' | 'brain' | 'member'>) => {
    const home = brain(step.brain);
    const argv = step.run.map(a => substitute(a, vars));
    const stdin = step.stdin === undefined ? undefined : readFileSync(join(corpus, substitute(step.stdin, vars)), 'utf8');
    const r = o.exec(argv, { home, cwd: root, stdin, ...(step.member ? { env: { GBRAIN_ENFORCED_MEMBER: step.member } } : {}) });
    return { argv, r };
  };
  const capture = (step: Pick<Cat9RunStep, 'capture'>, stdout: string): string[] => {
    const errs: string[] = [];
    if (!step.capture) return errs;
    const parsed = parseJsonOutput(stdout);
    for (const [name, path] of Object.entries(step.capture)) {
      const v = parsed.ok ? jsonPath(parsed.value, path) : undefined;
      if (v === undefined || v === null || typeof v === 'object') errs.push(`capture ${name} from ${path} found no scalar value`);
      else vars[name] = String(v);
    }
    return errs;
  };

  const cleanup = () => {
    if (!o.keep) rmSync(root, { recursive: true, force: true });
    if (o.engine?.pgAdminUrl) for (const db of scratchDbs.splice(0)) dropScratchDb(o.engine.pgAdminUrl, db);
  };
  const rows: Cat9CheckRow[] = [];
  try {
    for (const [i, step] of (s.setup ?? []).entries()) {
      if ('capture_time' in step) { vars[step.capture_time] = (o.now ?? (() => new Date()))().toISOString(); continue; }
      if ('remove_datastore' in step) {
        brain(step.remove_datastore);
        const ds = datastoreOf(step.remove_datastore);
        if (ds === null) throw unsupported(`setup[${i}] remove_datastore`);
        if (!existsSync(ds)) throw new Error(`setup[${i}]: brain ${step.remove_datastore} has no datastore to remove`);
        renameSync(ds, join(root, `moved-${step.remove_datastore}.pglite`));
        continue;
      }
      if ('read_json' in step) {
        const file = substitute(step.read_json, vars);
        const errs = capture(step, existsSync(file) ? readFileSync(file, 'utf8') : '');
        if (errs.length > 0) throw new Error(`setup[${i}] read_json: ${errs.join('; ')}`);
        continue;
      }
      if (!isRun(step)) continue; // a manual step whose requirements are met is done by whoever provides them
      const { argv, r } = call(step);
      if (r.exit !== 0 && !step.allow_fail && ENGINE_REFUSAL_RE.test(`${r.stderr}\n${r.stdout}`)) {
        throw new EvalEngineUnavailable(kind, ENGINE_NOT_SUPPORTED_BY_RUNNER, `setup[${i}] \`gbrain ${argv.join(' ').split(root).join('<tmp>')}\` stopped on the engine's typed refusal: ${head(r.stderr || r.stdout, root, o.engine?.pgAdminUrl)}`);
      }
      if (r.exit !== 0 && !step.allow_fail) throw new Error(`setup[${i}] \`gbrain ${argv.join(' ').split(root).join('<tmp>')}\` exited ${r.exit}: ${head(r.stderr || r.stdout, root, o.engine?.pgAdminUrl)}`);
      const errs = capture(step, r.stdout);
      if (errs.length > 0) throw new Error(`setup[${i}]: ${errs.join('; ')}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cleanup();
    if (err instanceof EvalEngineUnavailable && err.reason !== ENGINE_NOT_SUPPORTED_BY_RUNNER) throw err;
    if (err instanceof EvalEngineUnavailable) return checks.map(c => row(c, ENGINE_NOT_SUPPORTED_BY_RUNNER, [`${ENGINE_NOT_SUPPORTED_BY_RUNNER} (${kind}): ${msg.split(root).join('<tmp>')}`]));
    return checks.map(c => row(c, 'error', [`harness: ${msg.split(root).join('<tmp>')}`]));
  }

  const refusedOn = new Map<string, string>();
  const statusOf = new Map<string, Cat9CheckStatus>();
  for (const c of checks) {
    const before = rows.length;
    runOne(c);
    if (rows.length > before) statusOf.set(c.id, rows[rows.length - 1].status);
  }
  cleanup();
  return rows;

  function runOne(c: Cat9Check): void {
    const lack = missing(c.requires);
    if (lack.length > 0) { rows.push(row(c, 'not_run', lack.map(r => REQUIREMENT_REASONS[r]))); return; }
    if (!c.run || !c.expect) { rows.push(row(c, 'not_run', [`not mechanized: ${c.not_mechanized ?? 'no run'}`])); return; }
    const blockedBy = (c.depends_on ?? []).find(d => statusOf.get(d) === ENGINE_NOT_SUPPORTED_BY_RUNNER);
    if (blockedBy) {
      rows.push(row(c, ENGINE_NOT_SUPPORTED_BY_RUNNER, [`${ENGINE_NOT_SUPPORTED_BY_RUNNER} (${kind}): this check depends on ${blockedBy}, which the engine refused or could not run, so it would observe nothing`]));
      return;
    }
    if (c.expect.datastore_absent !== undefined && datastoreOf(c.expect.datastore_absent) === null) {
      rows.push(row(c, ENGINE_NOT_SUPPORTED_BY_RUNNER, [`${ENGINE_NOT_SUPPORTED_BY_RUNNER} (${kind}): ${unsupported('the datastore_absent expectation').message}`]));
      return;
    }
    try {
      const { argv, r } = call({ run: c.run, stdin: c.stdin, brain: c.brain, member: c.member });
      const reasons = evaluateExpect(substituteDeep(c.expect, vars), r, { datastoreExists: name => existsSync(datastoreOf(name)!) });
      const errs = capture(c, r.stdout);
      let status = classify([...reasons, ...errs], c.known_failure);
      // A CLI call that exited on the engine's typed refusal did not test the behavior, whatever the expectation said
      // (a check that expects a refusal must not be credited with an engine limitation). A later failing check on the
      // same brain did not test it either: that brain lacks the refused write. Checks on other brains keep their result.
      const brainName = c.brain ?? 'A';
      const refusal = r.exit !== 0 && ENGINE_REFUSAL_RE.test(`${r.stderr}\n${r.stdout}`);
      const failed = status !== 'pass' && status !== 'unexpected_pass';
      const earlier = c.depends_on === undefined ? refusedOn.get(brainName) : undefined;
      const why = refusal ? `${ENGINE_NOT_SUPPORTED_BY_RUNNER} (${kind}): the CLI call stopped on the engine's typed refusal`
        : failed && earlier ? `${ENGINE_NOT_SUPPORTED_BY_RUNNER} (${kind}): an earlier check on brain ${brainName} (${earlier}) stopped on the engine's typed refusal, so that brain lacks its write`
        : null;
      if (refusal && !earlier) refusedOn.set(brainName, c.id);
      if (why) status = ENGINE_NOT_SUPPORTED_BY_RUNNER;
      rows.push(row(c, status, why ? [why, ...reasons, ...errs] : [...reasons, ...errs], {
        exit_code: r.exit, argv: argv.map(a => a.split(root).join('<tmp>')), stdout_head: head(r.stdout, root, o.engine?.pgAdminUrl), stderr_head: head(r.stderr, root, o.engine?.pgAdminUrl),
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof EvalEngineUnavailable && err.reason !== ENGINE_NOT_SUPPORTED_BY_RUNNER) { cleanup(); throw err; }
      if (err instanceof EvalEngineUnavailable) rows.push(row(c, ENGINE_NOT_SUPPORTED_BY_RUNNER, [`${ENGINE_NOT_SUPPORTED_BY_RUNNER} (${kind}): ${msg.split(root).join('<tmp>')}`]));
      else rows.push(row(c, 'error', [`harness: ${msg.split(root).join('<tmp>')}`]));
    }
  }
}

export interface Cat9ChecksSummary {
  checks: number;
  by_status: Record<Cat9CheckStatus, number>;
  scenarios_with_checks: number;
}

export function summarizeChecks(rows: Cat9CheckRow[]): Cat9ChecksSummary {
  const by_status: Record<Cat9CheckStatus, number> = { pass: 0, fail: 0, expected_fail: 0, unexpected_pass: 0, not_run: 0, error: 0, [ENGINE_NOT_SUPPORTED_BY_RUNNER]: 0 };
  for (const r of rows) by_status[r.status]++;
  return { checks: rows.length, by_status, scenarios_with_checks: new Set(rows.map(r => r.scenario_id)).size };
}

/** The scenario-level verdict: the worst check status, in this order. */
export function scenarioStatus(rows: Cat9CheckRow[]): Cat9CheckStatus | 'no_checks' {
  if (rows.length === 0) return 'no_checks';
  const order: Cat9CheckStatus[] = ['error', 'fail', 'unexpected_pass', 'expected_fail', ENGINE_NOT_SUPPORTED_BY_RUNNER, 'pass', 'not_run'];
  for (const s of order) if (rows.some(r => r.status === s)) return s;
  return 'not_run';
}

/** Resolve a path relative to a catalog file. */
export function catalogRelative(catalogPath: string, p: string): string {
  return resolve(dirname(catalogPath), p);
}

/**
 * Create and drop a Cat 9 scratch Postgres database in a child Bun process, so runScenarioChecks stays synchronous.
 * The admin URL reaches the child through its environment, never its argv.
 */
function scratchDbSql(adminUrl: string, sql: string): void {
  const p = Bun.spawnSync([process.execPath, '-e', 'const { SQL } = await import("bun"); const s = new SQL(process.env.CAT9_PG_ADMIN_URL); try { await s.unsafe(process.env.CAT9_PG_SQL); } finally { await s.close(); }'], {
    env: { PATH: process.env.PATH ?? '', CAT9_PG_ADMIN_URL: adminUrl, CAT9_PG_SQL: sql }, stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
  });
  if (p.exitCode !== 0) throw new EvalEngineUnavailable('postgres', 'postgres_unreachable', `Cat 9 scratch database (${sql.split(' ').slice(0, 2).join(' ')}) failed: ${redactUrlPasswords(p.stderr.toString()).trim().split('\n').at(-1)?.slice(0, 300) ?? ''}`);
}

function createScratchDb(adminUrl: string, db: string): void {
  scratchDbSql(adminUrl, `CREATE DATABASE ${db}`);
}

function dropScratchDb(adminUrl: string, db: string): void {
  try { scratchDbSql(adminUrl, `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); } catch { /* best effort; the name is unique per run */ }
}
