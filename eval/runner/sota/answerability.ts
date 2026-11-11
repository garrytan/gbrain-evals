/**
 * The answerability rule (SOTA loop W1-e, plan decision D5a), frozen here and applied to every dev-split item the loop
 * scores: BEAM's checked public items, the nightly BEAM items and lme-s-hard's items. Each item gets one class.
 *
 *   supported    the support check ran and at most one validator rejects the item;
 *   partial      both validators reject it (or it cites no turn), and the oracle (a frontier reader given only the gold
 *                evidence, frontier-judged) passes it: BEAM's rubric gives partial credit, so an answer can be right
 *                where the cited turns don't spell it out;
 *   unsupported  both validators reject it (or it cites no turn), and the oracle fails it;
 *   unresolved   both validators reject it (or it cites no turn), and no oracle verdict exists yet (no oracle row, or
 *                the oracle answer was empty at its output limit);
 *   unchecked    the support check left it out (BEAM's abstention items cite no turn, and BEAM's absence scan was not run).
 *
 * "Rejects" means a support:<validator> gate, or for an abstention item absence:<validator> (that validator found an
 * answer in the conversation). The oracle passes at a judge score of at least 0.5, the nightly pass bar. Headline rows
 * use supported plus partial; supported-only is the sensitivity view.
 *
 *   bun eval/runner/sota/answerability.ts [--check]
 *   bun eval/runner/sota/answerability.ts --import-a4 <sota-a4-rejudge/1 file>
 *
 * Writes eval/data/answerability/<benchmark>.json from committed inputs only (ids, gates and verdicts; no question,
 * answer or turn text). --check rebuilds in memory and exits 1 when a committed file differs. The inputs:
 *   - BEAM validator gates: GST-2339's public check (docs/benchmarks/2026-11-10-beam-item-support/public-items.json) and
 *     the nightly check of 1m-25 (eval/data/nightly/beam-1m-hard-support.json);
 *   - BEAM-1M oracle: A4's gpt-6.1-sol answers given every gold session (docs/benchmarks/2026-10-08-beam-1m-failure-
 *     analysis, arm a4-oracle-gpt61sol), re-judged by claude-opus-5-5 with the BEAM judge
 *     (eval/data/answerability/oracle/beam-1m.json, imported with --import-a4 <re-judge file>); the October judge's
 *     scores stay as the bridge, never as the verdict;
 *   - lme-s-hard validator verdicts: eval/data/nightly/lme-s-hard-support.json; its oracle,
 *     eval/data/answerability/oracle/lme-s.json once it exists.
 * A sealed id refuses the write (eval/runner/sota/sealed-guard.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertNoSealedIds } from './sealed-guard.ts';

const ROOT = resolve(import.meta.dir, '../../..');
export const ANSWERABILITY_DIR = 'eval/data/answerability';
export const ANSWERABILITY_SCHEMA = 'answerability/1';
export const ORACLE_SCHEMA = 'answerability-oracle/1';
export const ORACLE_PASS = 0.5;
export const VALIDATORS = ['gemini:gemini-3.8-flash', 'anthropic:claude-haiku-5-5'] as const;
export const CLASSES = ['supported', 'partial', 'unsupported', 'unresolved', 'unchecked'] as const;
export type AnswerClass = typeof CLASSES[number];
/** The classes a headline row scores: answerable questions. */
export const ANSWERABLE: readonly AnswerClass[] = ['supported', 'partial'];

export const SOURCES = {
  gst2339: 'docs/benchmarks/2026-11-10-beam-item-support/public-items.json',
  nightlyBeam: 'eval/data/nightly/beam-1m-hard-support.json',
  nightlyLme: 'eval/data/nightly/lme-s-hard-support.json',
  a4: 'docs/benchmarks/2026-10-08-beam-1m-failure-analysis/arms/a4-oracle-gpt61sol',
  oracle: (benchmark: string) => `${ANSWERABILITY_DIR}/oracle/${benchmark}.json`,
} as const;

/** What the support check found for one item. */
export interface Check { checked: boolean; gates: string[]; cited: number | null; abstention: boolean }
export interface OracleRow { score: number | null; pass: boolean | null }
export interface ItemClass { class: AnswerClass; gates: string[]; oracle: 'pass' | 'fail' | null }

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

/**
 * Whether both validators reject an item, or it cites no turn. An abstention item cites no turn by design, so only its
 * absence scan counts: both validators found an answer the question says isn't there.
 */
export function rejectedByBoth(c: Check): boolean {
  if (c.abstention) return VALIDATORS.every(v => c.gates.includes(`absence:${v}`));
  if (c.gates.includes('uncited') || c.cited === 0) return true;
  return VALIDATORS.every(v => c.gates.includes(`support:${v}`));
}

/** The D5a class of one item. */
export function classify(check: Check | null, oracle: OracleRow | null): ItemClass {
  const verdict = oracle?.pass === true ? 'pass' : oracle?.pass === false ? 'fail' : null;
  if (!check?.checked) return { class: 'unchecked', gates: check?.gates ?? [], oracle: verdict };
  const gates = [...check.gates].sort();
  if (!rejectedByBoth(check)) return { class: 'supported', gates, oracle: verdict };
  return { class: verdict === 'pass' ? 'partial' : verdict === 'fail' ? 'unsupported' : 'unresolved', gates, oracle: verdict };
}

// ─── inputs ──────────────────────────────────────────────────────────

/** BEAM support checks by item id: GST-2339's public check, then the nightly check's items it did not list. */
export function beamChecks(): Map<string, Check & { scale: string }> {
  const out = new Map<string, Check & { scale: string }>();
  for (const i of readJson(SOURCES.gst2339).items as Array<{ id: string; scale: string; ability: string; checked: boolean; gates: string[]; cited: number }>) {
    out.set(i.id, { scale: i.scale, checked: i.checked, gates: i.gates, cited: i.cited, abstention: i.ability === 'abstention' });
  }
  for (const [id, x] of Object.entries(readJson(SOURCES.nightlyBeam).items as Record<string, { checked: boolean; gates?: string[]; cited?: number }>)) {
    if (!out.has(id)) out.set(id, { scale: 'beam-1m', checked: x.checked, gates: x.gates ?? [], cited: x.cited ?? null, abstention: id.split(':')[1] === 'abstention' });
  }
  return out;
}

/** lme-s-hard's support checks (W1-c), or an empty map before they are committed. */
export function lmeChecks(): Map<string, Check> {
  if (!existsSync(join(ROOT, SOURCES.nightlyLme))) return new Map();
  const items = readJson(SOURCES.nightlyLme).items as Record<string, { checked: boolean; gates?: string[]; cited?: number }>;
  return new Map(Object.entries(items).map(([id, x]) => [id, { checked: x.checked, gates: x.gates ?? [], cited: x.cited ?? null, abstention: id.endsWith('_abs') }]));
}

/** A frontier-judged oracle file's rows, or an empty map when it is not committed yet. */
export function oracleRows(benchmark: string): Map<string, OracleRow> {
  const rel = SOURCES.oracle(benchmark);
  if (!existsSync(join(ROOT, rel))) return new Map();
  const f = readJson(rel) as { schema: string; rows: Record<string, OracleRow> };
  if (f.schema !== ORACLE_SCHEMA) throw new Error(`${rel} is not an ${ORACLE_SCHEMA} file`);
  return new Map(Object.entries(f.rows));
}

const jsonl = (path: string) => gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

/**
 * A4's oracle as the October judge scored it (the bridge): pass at a score of at least 0.5, and no verdict for an empty
 * answer that stopped at the output limit. Only the self-check against GBEV-73's correction 8 reads it.
 */
export function octoberOracle(): Map<string, OracleRow> {
  const dir = join(ROOT, SOURCES.a4);
  const shards = readdirSync(dir).filter(s => s.startsWith('shard-')).sort();
  const answers = new Map(shards.flatMap(s => jsonl(join(dir, s, 'answers.ndjson.gz'))).map((a: { id: string; answer: string; finish_reason: string }) => [a.id, a]));
  return new Map(shards.flatMap(s => jsonl(join(dir, s, 'rows.ndjson.gz'))).map((r: { id: string; qa_score: number | null }) => {
    const a = answers.get(r.id);
    const cut = !!a && !a.answer.trim() && a.finish_reason === 'length';
    return [r.id, { score: r.qa_score, pass: cut || r.qa_score === null ? null : r.qa_score >= ORACLE_PASS }];
  }));
}

/**
 * The BEAM-1M oracle file from the A4 re-judge (schema sota-a4-rejudge/1): scores and verdicts only. Refuses a file
 * whose judge is not claude-opus-5-5 (A4's reader is gpt-6.1-sol, so the judge must be Claude), whose row count is not
 * A4's 220, or whose verdict disagrees with its score.
 */
export function oracleFromRejudge(text: string) {
  const a = JSON.parse(text) as { schema: string; judge: string; answers: string; judge_prompt: unknown; pass_threshold: number;
    rows: Record<string, { score: number | null; pass: boolean | null; empty_at_limit: boolean }> };
  if (a.schema !== 'sota-a4-rejudge/1') throw new Error('not a sota-a4-rejudge/1 file');
  if (a.judge !== 'anthropic:claude-opus-5-5') throw new Error(`the A4 oracle must be judged by anthropic:claude-opus-5-5, not ${a.judge}`);
  if (a.pass_threshold !== ORACLE_PASS) throw new Error(`pass threshold ${a.pass_threshold}, not ${ORACLE_PASS}`);
  const ids = Object.keys(a.rows).sort();
  if (ids.length !== 220) throw new Error(`${ids.length} rows, not A4's 220`);
  const rows: Record<string, OracleRow> = {};
  for (const id of ids) {
    const r = a.rows[id]!;
    const expected = r.empty_at_limit || r.score === null ? null : r.score >= ORACLE_PASS;
    if (r.pass !== expected) throw new Error(`${id}: pass ${r.pass} disagrees with score ${r.score}`);
    rows[id] = { score: r.score, pass: r.pass };
  }
  const file = {
    schema: ORACLE_SCHEMA, benchmark: 'beam-1m',
    about: "A4's gpt-6.1-sol answers given every gold session (arm a4-oracle-gpt61sol), re-judged by claude-opus-5-5 with BEAM's judge prompts, one yes-or-no call per rubric item. pass is a score of at least 0.5; an empty answer that stopped at the output limit has no verdict (pass null). Ids and scores only.",
    reader: 'openai:gpt-6.1-sol', judge: a.judge, answers: a.answers, judge_prompt: a.judge_prompt, pass_threshold: ORACLE_PASS,
    source_sha256: sha256(text), rows,
  };
  const out = JSON.stringify(file, null, 1) + '\n';
  assertNoSealedIds(out, SOURCES.oracle('beam-1m'));
  return out;
}

// ─── files ───────────────────────────────────────────────────────────

export interface AnswerabilityFile {
  schema: typeof ANSWERABILITY_SCHEMA; benchmark: string; rule: string;
  sources: Record<string, { file: string; sha256: string } | null>;
  counts: Record<AnswerClass, number>;
  items: Record<string, ItemClass>;
}

const RULE = 'D5a: supported when at most one validator rejects; partial when both reject (or it cites no turn) and the oracle passes (score >= 0.5); unsupported when both reject and the oracle fails; unresolved when both reject and no oracle verdict exists; unchecked when the support check left it out.';

const source = (rel: string) => (existsSync(join(ROOT, rel)) ? { file: rel, sha256: sha256(readFileSync(join(ROOT, rel))) } : null);

export function buildFile(benchmark: string, checks: Map<string, Check>, oracle: Map<string, OracleRow>, sources: AnswerabilityFile['sources']): AnswerabilityFile {
  const ids = [...checks.keys()].sort();
  const items = Object.fromEntries(ids.map(id => [id, classify(checks.get(id)!, oracle.get(id) ?? null)]));
  const counts = Object.fromEntries(CLASSES.map(c => [c, Object.values(items).filter(i => i.class === c).length])) as Record<AnswerClass, number>;
  return { schema: ANSWERABILITY_SCHEMA, benchmark, rule: RULE, sources, counts, items };
}

export function buildAll(): AnswerabilityFile[] {
  const beam = beamChecks();
  const files: AnswerabilityFile[] = [];
  for (const scale of ['beam-100k', 'beam-500k', 'beam-1m']) {
    const checks = new Map([...beam].filter(([, c]) => c.scale === scale));
    files.push(buildFile(scale, checks, oracleRows(scale), { validators: source(SOURCES.gst2339), nightly: scale === 'beam-1m' ? source(SOURCES.nightlyBeam) : null, oracle: source(SOURCES.oracle(scale)) }));
  }
  const lme = lmeChecks();
  if (lme.size) files.push(buildFile('lme-s', lme, oracleRows('lme-s'), { validators: source(SOURCES.nightlyLme), oracle: source(SOURCES.oracle('lme-s')) }));
  return files;
}

export const fileText = (f: AnswerabilityFile) => JSON.stringify(f, null, 1) + '\n';

/** The committed class of each item of a benchmark, or null when the benchmark has no answerability file. */
export function loadClasses(benchmark: string, root = ROOT): Map<string, AnswerClass> | null {
  const path = join(root, ANSWERABILITY_DIR, `${benchmark}.json`);
  if (!existsSync(path)) return null;
  const f = JSON.parse(readFileSync(path, 'utf8')) as AnswerabilityFile;
  if (f.schema !== ANSWERABILITY_SCHEMA || f.benchmark !== benchmark) throw new Error(`${path} is not an ${ANSWERABILITY_SCHEMA} file for ${benchmark}`);
  return new Map(Object.entries(f.items).map(([id, x]) => [id, x.class]));
}

/** Class counts overall and per ability, the shape GBEV-73's correction 8 and the W1-d table use. */
export function classTable(items: Record<string, ItemClass>, ids?: readonly string[]) {
  const keep = ids ? ids.filter(id => items[id]) : Object.keys(items);
  const count = (xs: string[]) => Object.fromEntries(CLASSES.map(c => [c, xs.filter(id => items[id]!.class === c).length]));
  const abilities = [...new Set(keep.map(id => id.split(':')[1] ?? 'all'))].sort();
  return { items: keep.length, overall: count(keep), per_ability: Object.fromEntries(abilities.map(a => [a, count(keep.filter(id => id.split(':')[1] === a))])) };
}

if (import.meta.main) {
  const at = process.argv.indexOf('--import-a4');
  if (at > 0) {
    const out = oracleFromRejudge(readFileSync(process.argv[at + 1]!, 'utf8'));
    mkdirSync(join(ROOT, ANSWERABILITY_DIR, 'oracle'), { recursive: true });
    writeFileSync(join(ROOT, SOURCES.oracle('beam-1m')), out);
    console.log(`wrote ${SOURCES.oracle('beam-1m')}`);
    process.exit(0);
  }
  const files = buildAll();
  const check = process.argv.includes('--check');
  let drift = 0;
  for (const f of files) {
    const rel = join(ANSWERABILITY_DIR, `${f.benchmark}.json`), text = fileText(f);
    assertNoSealedIds(text, rel);
    if (check) {
      const committed = existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : null;
      if (committed !== text) { drift++; console.error(`ANSWERABILITY_DRIFT: ${rel} differs from a rebuild; fix: bun eval/runner/sota/answerability.ts && git diff ${ANSWERABILITY_DIR}`); }
    } else {
      mkdirSync(join(ROOT, ANSWERABILITY_DIR), { recursive: true });
      writeFileSync(join(ROOT, rel), text);
    }
    console.log(`${f.benchmark}: ${Object.entries(f.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  process.exit(drift ? 1 : 0);
}
