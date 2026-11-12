/**
 * Attribution of the nightly QA misses (SOTA plan item 6, decision D5a). Each failed row of a QA suite whose benchmark
 * has an answerability file gets one bucket, the first that applies:
 *
 *   harness         the row failed for our harness: a provider or harness error, or an answer cut off at its output
 *                   limit (failure cause harness_error). It is left out of every answerable denominator;
 *   unsupported     the item's answerability class is unsupported (both validators reject it, or it cites no turn, and
 *                   the oracle fails it); the class decides, and the label's item_unsupported counts only for an item
 *                   with no class;
 *   reader_limited  the oracle (this reader given only the gold evidence) fails it too: the reader, not gbrain, is short;
 *   retrieval_lost  the oracle passes it and the gold did not reach the reader whole: missed, partly retrieved, ranked out
 *                   of what the reader was given, or never opened (retrieval_miss, partial_evidence, wrong_ranking,
 *                   reader_budget, gold_unopened, memory_not_consulted, ingest_gap, privacy_hidden);
 *   context_use     the oracle passes it and the gold reached the reader, yet the answer failed;
 *   unknown         a step it needs is missing: an unresolved or unchecked item, no oracle row (or an oracle answer cut
 *                   off with no verdict), or a row that never measured whether the gold was delivered (ranking
 *                   unmeasured) and no model labeller read its context. Unknown rows are counted, never guessed, and
 *                   never earn recoverable points.
 *
 * Each failed row also gets leader_solved: whether the benchmark's leader (sota/leader.ts) answered the item correctly
 * with the same reader, or null with no leader row. Recoverable points per bucket are an upper bound: the pass-rate
 * points a suite and reader would gain if every row in the bucket passed, over its answerable rows (the answerable pool
 * items times the nights the suite ran, less not-run and harness rows). A night counts when it left a label for the
 * suite, so a night on which the suite failed nothing is missed, which only raises the bound. Rows of other suites (Cat 40
 * and the write suites, which have no oracle in v1) are counted as outside.
 *
 * The outcome cache is read, never bought: a row measured on other inputs makes the whole attribution stale
 * (SOTA_CACHE_STALE), with the changed inputs, the re-buy command and the paid-window request.
 */
import { ATTRIBUTION_BUCKETS, TAXONOMY_VERSION } from './taxonomy.ts';
import type { CauseLabel } from './types.ts';
import { loadDevSet, type DevSet } from '../nightly/devset.ts';
import { ANSWERABLE, loadClasses, type AnswerClass } from '../sota/answerability.ts';
import { OutcomeCache, freshness, staleMessage, writeRebuyItems, type Freshness, type Spec } from '../sota/cache.ts';
import { assertNoSealedIds } from '../sota/sealed-guard.ts';

export const ATTRIBUTION_SCHEMA = 'sota-attribution/1';
export type Bucket = typeof ATTRIBUTION_BUCKETS[number]['id'];
export const BUCKETS: readonly Bucket[] = ATTRIBUTION_BUCKETS.map(b => b.id);
/** The buckets a fix can recover: the answerable misses with a known cause. */
export const RECOVERABLE: readonly Bucket[] = ['reader_limited', 'retrieval_lost', 'context_use'];
export const LOST_CAUSES: ReadonlySet<string> = new Set(['retrieval_miss', 'partial_evidence', 'wrong_ranking', 'reader_budget', 'gold_unopened', 'memory_not_consulted', 'ingest_gap', 'privacy_hidden']);

export interface AttributedRow {
  run_id: string; case_id: string; suite: string; item: string; reader: string;
  cause: string | null; rule_id: string; bucket: Bucket; reason: string | null;
  oracle: 'pass' | 'fail' | null; leader_solved: boolean | null; visibility: string; evidence: string[];
}

export interface Cell {
  suite: string; reader: string; nights: number; pool_answerable: number; not_run: number; harness: number; answerable_rows: number;
  rows: Record<Bucket, number>; points: Record<Bucket, number | null>; leader_solved: Record<Bucket, number>;
}

export interface Attribution {
  schema: typeof ATTRIBUTION_SCHEMA; taxonomy_version: string; status: 'ok' | 'stale';
  devset: string; stale: Array<{ spec: Spec; rows: number; message: string }>;
  outside: number; cells: Cell[]; rows: AttributedRow[];
}

/** The current inputs of a benchmark's oracle and leader rows for one reader (sota/oracle.ts oracleSpec, sota/leader.ts leaderSpec). */
export interface Specs { oracle(benchmark: string, reader: string): Spec | null; leader(benchmark: string, reader: string): Spec | null }

const failedLabel = (l: CauseLabel) => !l.rule_id.startsWith('not_run.') && l.rule_id !== 'passed';

/** suite, item, reader and trial from a nightly case id (<suite>|<item>|<reader>|t<trial>). */
export function parseCase(caseId: string): { suite: string; item: string; reader: string; trial: number } | null {
  const m = /^([^|]+)\|(.+)\|([^|]+)\|t(\d+)$/.exec(caseId);
  return m ? { suite: m[1]!, item: m[2]!, reader: m[3]!, trial: Number(m[4]) } : null;
}

export interface AttributeOptions { cacheDir: string; specs: Specs; devset?: DevSet; classes?: (benchmark: string) => ReadonlyMap<string, AnswerClass> | null }

/** Attributes every failed QA row in the labels. Reads the cache only; stale specs make status 'stale' and leave the buckets empty. */
export function attribute(labels: readonly CauseLabel[], o: AttributeOptions): Attribution {
  const devset = o.devset ?? loadDevSet();
  const classesOf = o.classes ?? ((b: string) => loadClasses(b));
  const specs = o.specs;
  const cache = new OutcomeCache(o.cacheDir);
  const suites = new Map(devset.suites.filter(s => s.kind === 'qa' && typeof s.config?.benchmark === 'string').map(s => [s.id, { suite: s, benchmark: String(s.config!.benchmark) }]));

  const parsed = labels.map(l => ({ l, c: parseCase(l.case_id) }));
  const inScope = parsed.filter((x): x is { l: CauseLabel; c: NonNullable<typeof x.c> } => !!x.c && suites.has(x.c.suite) && !!classesOf(suites.get(x.c.suite)!.benchmark));
  const scoped = new Set<CauseLabel>(inScope.map(x => x.l));
  const outside = labels.filter(l => failedLabel(l) && !scoped.has(l)).length;

  const byCell = new Map<string, Array<{ l: CauseLabel; c: NonNullable<ReturnType<typeof parseCase>> }>>();
  for (const x of inScope) {
    const k = `${x.c.suite}\u0000${x.l.model}`;
    byCell.set(k, [...(byCell.get(k) ?? []), x]);
  }
  const wanted = new Map<string, { spec: Spec; items: Set<string> }>();
  for (const [k, xs] of byCell) {
    const [suite, reader] = k.split('\u0000') as [string, string];
    const benchmark = suites.get(suite)!.benchmark;
    for (const spec of [specs.oracle(benchmark, reader), specs.leader(benchmark, reader)]) {
      if (!spec) continue;
      const w = wanted.get(JSON.stringify(spec)) ?? { spec, items: new Set<string>() };
      for (const x of xs) if (failedLabel(x.l)) w.items.add(x.c.item);
      wanted.set(JSON.stringify(spec), w);
    }
  }
  const lookups = new Map<string, Freshness>([...wanted].map(([k, w]) => [k, freshness(cache, w.spec, [...w.items].sort())]));
  const look = (spec: Spec | null) => (spec ? lookups.get(JSON.stringify(spec)) ?? null : null);
  const stale = [...lookups.values()].filter(f => f.stale.length).map(f => ({ spec: f.spec, rows: f.stale.length,
    message: staleMessage(f, writeRebuyItems(o.cacheDir, f.spec, f.stale.map(s => s.item)), o.cacheDir) }));
  if (stale.length) return { schema: ATTRIBUTION_SCHEMA, taxonomy_version: TAXONOMY_VERSION, status: 'stale', devset: devset.digest, stale, outside, cells: [], rows: [] };

  const rows: AttributedRow[] = [];
  const cells: Cell[] = [];
  for (const [k, xs] of [...byCell].sort(([a], [b]) => a.localeCompare(b))) {
    const [suite, reader] = k.split('\u0000') as [string, string];
    const { suite: s, benchmark } = suites.get(suite)!;
    const classes = classesOf(benchmark)!;
    const oracle = look(specs.oracle(benchmark, reader)), lead = look(specs.leader(benchmark, reader));
    const nights = new Set(labels.filter(l => parseCase(l.case_id)?.suite === suite).map(l => l.run_id)).size;
    const pool = s.items.filter(i => ANSWERABLE.includes(classes.get(i.id) as AnswerClass)).length;
    const cellRows: AttributedRow[] = [];
    for (const { l, c } of xs) {
      if (!failedLabel(l)) continue;
      const cls = classes.get(c.item) ?? null;
      const o = oracle?.hits.get(c.item) ?? null, lr = lead?.hits.get(c.item) ?? null;
      const verdict = o?.pass === true ? 'pass' : o?.pass === false ? 'fail' : null;
      const put = (bucket: Bucket, reason: string | null = null) => cellRows.push({ run_id: l.run_id, case_id: l.case_id, suite, item: c.item, reader, cause: l.cause, rule_id: l.rule_id,
        bucket, reason, oracle: verdict, leader_solved: lr ? lr.pass === true : null, visibility: l.visibility, evidence: l.evidence });
      if (l.cause === 'harness_error') put('harness');
      else if (cls === 'unsupported' || (cls === null && l.cause === 'item_unsupported')) put('unsupported');
      else if (!ANSWERABLE.includes(cls as AnswerClass)) put('unknown', `answerability ${cls ?? 'missing'}`);
      else if (!o) put('unknown', 'no oracle row');
      else if (o.pass === null) put('unknown', 'oracle answer has no verdict');
      else if (!o.pass) put('reader_limited');
      else if (l.cause && LOST_CAUSES.has(l.cause)) put('retrieval_lost');
      else if (l.basis !== 'model' && l.unmeasured.includes('ranking')) put('unknown', 'gold delivery not measured');
      else put('context_use');
    }
    const count = (b: Bucket, f: (r: AttributedRow) => boolean = () => true) => cellRows.filter(r => r.bucket === b && f(r)).length;
    const notRun = xs.filter(x => x.l.rule_id.startsWith('not_run.') && ANSWERABLE.includes(classes.get(x.c.item) as AnswerClass)).length;
    const harness = count('harness', r => ANSWERABLE.includes(classes.get(r.item) as AnswerClass));
    const answerable = pool * nights - notRun - harness;
    cells.push({
      suite, reader, nights, pool_answerable: pool, not_run: notRun, harness, answerable_rows: answerable,
      rows: Object.fromEntries(BUCKETS.map(b => [b, count(b)])) as Cell['rows'],
      points: Object.fromEntries(BUCKETS.map(b => [b, RECOVERABLE.includes(b) && answerable > 0 ? Math.round(10000 * count(b) / answerable) / 100 : null])) as Cell['points'],
      leader_solved: Object.fromEntries(BUCKETS.map(b => [b, count(b, r => r.leader_solved === true)])) as Cell['leader_solved'],
    });
    rows.push(...cellRows);
  }
  return { schema: ATTRIBUTION_SCHEMA, taxonomy_version: TAXONOMY_VERSION, status: 'ok', devset: devset.digest, stale: [], outside, cells, rows };
}

/** The attribution file's text, refused when it would carry a sealed id. */
export function attributionText(a: Attribution, where: string): string {
  const text = JSON.stringify(a, null, 1) + '\n';
  assertNoSealedIds(text, where);
  return text;
}

/** The report section: buckets beside the cause counts, or the stale notice. */
export function renderAttribution(a: Attribution): string[] {
  if (a.status === 'stale') return ['## Attribution (stale)', '', 'Attribution is stale: the outcome cache holds rows measured on other inputs, so no bucket is shown. Cause counts above stand.', '',
    ...a.stale.map(s => '    ' + s.message.split('\n').join('\n    ')), ''];
  const head = ['Suite', 'Reader', 'Answerable rows', ...BUCKETS.map(b => b.replace('_', ' ')), 'Leader solved (recoverable)'];
  const pts = (c: Cell, b: Bucket) => (c.points[b] === null ? String(c.rows[b]) : `${c.rows[b]} (${c.points[b]!.toFixed(1)} pts)`);
  return [
    '## Attribution', '',
    'Each failed QA row in one bucket, first that applies: harness, unsupported, reader limited (the oracle fails too), retrieval lost (the oracle passes; the gold never reached the reader whole), context use (the oracle passes; the gold reached the reader), unknown (a step is unmeasured or uncached). Points are an upper bound on the pass-rate points each recoverable bucket could return, over the answerable rows; harness rows are out of every denominator.', '',
    `| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`,
    ...a.cells.map(c => `| ${c.suite} | ${c.reader} | ${c.answerable_rows} | ${BUCKETS.map(b => pts(c, b)).join(' | ')} | ${RECOVERABLE.reduce((n, b) => n + c.leader_solved[b], 0)} |`),
    '', ...(a.outside ? [`${a.outside} failed rows of suites with no oracle in v1 (Cat 40, the write suites) are outside attribution.`, ''] : []),
  ];
}
