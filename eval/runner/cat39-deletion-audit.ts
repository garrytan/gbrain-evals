/**
 * BrainBench Cat 39: deletion audit (gbrain #5575 Part C).
 *
 * The question: after `gbrain forget <id> --purge` (operation purge_fact,
 * owner-only on the local CLI) and `gbrain delete <slug> --purge`
 * (delete_page with purge: true), is the claim gone from every live store,
 * does adversarial probing recover nothing, does the receipt honestly list
 * what remains, and does the claim stay gone after re-import, re-put and
 * re-extraction?
 *
 * World: eval/generators/cat39-deletion-audit-gen.ts, about forty fictional
 * pages and twenty purge targets, each a claim with a distinctive value token
 * whose every copy the generator recorded (the oracle). The runner writes the
 * world through gbrain (owner imports in two versions, fence extraction,
 * takes_add, add_timeline_entry, an agent's remember, a quarantined pasted
 * page), proves every copy is present and every neighbor is readable, purges,
 * then measures:
 *
 *   exact scan     its own scan of every text, varchar, json, jsonb and text[]
 *                  column of every table (information_schema), never gbrain's
 *                  inventory; each hit is attributed to a page slug and mapped
 *                  to the store status the purge receipt gave;
 *   probes         a 3+ word quote of the claim and a reworded question
 *                  through search, query, recall and get_page as the remote
 *                  agent and the local CLI, plus a SQL quote scan; recovered
 *                  when a result carries the value token from a page that
 *                  should no longer hold it;
 *   embedding      skipped in the hermetic arm (keyword-only brain, no
 *                  embedding model); the paid path embeds the claim and every
 *                  live chunk and fact with OpenAI text-embedding-3-large;
 *   resurrection   the stale pre-purge page (as gbrain would write it to disk)
 *                  imported by the owner and put by the agent, the same body
 *                  put again, fact extraction rerun, and remember of the claim;
 *                  the claim must not be active again;
 *   receipt        completeness (every swept store in gbrain's deletion
 *                  inventory appears in the receipt) and honesty (every live
 *                  residual sits in a store the receipt reports as not
 *                  deleted).
 *
 * A model arm asks an agent with read tools and the proactive hook the
 * reworded question; recovered when the answer carries the value token. Dry
 * mode uses a scripted stub (zero cost); paid mode is guarded by the budget
 * ledger and a preregistration attestation.
 *
 * Accounting: each target and each neighbor is one scored unit. A gbrain
 * exception where an answer is expected is a scored miss. A failed presence
 * assertion is a harness error (run_status 'error'). A build without a purge
 * feature reports the feature as a gap and skips the targets that need it.
 *
 * Usage: bun eval/runner/cat39-deletion-audit.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]] [--json]
 *          [--model-arm dry|paid] [--models a,b] [--repeats N] [--limit N] [--paid --budget-run-id <id>] [--preregistration <path>]
 */
import { join } from 'node:path';
import { budgetOptionsFrom, receiptCost, startPaidRun, type RunSummary } from './budget-ledger.ts';
import { GoldStore } from './evaluator/gold-store.ts';
import { gbrainSpecFrom, importGbrain, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import { paidRequested, requirePaidArm } from './paid-arm.ts';
import { attestPreregistration } from './prereg.ts';
import { ProbeAccounting } from './probe-accounting.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import { answerText, brainArm, runSession, scriptedModel } from './memory-trust/agent.ts';
import { estimateUsd, modelsFrom, providerOf, MEMORY_TRUST_CAP_USD, STUB_MODEL } from './memory-trust/models.ts';
import { missingCapabilities, openTrustSut, type TrustCapabilities, type TrustSut } from './memory-trust/sut.ts';
import {
  CAT39_DEFAULT_SEED, CAT39_GENERATOR_VERSION, VALUE_TOKEN_RE, generateCat39World,
  type Cat39Gold, type Cat39Ledger, type Cat39Neighbor, type Cat39Target, type GeneratedCat39,
} from '../generators/cat39-deletion-audit-gen.ts';

export const CATEGORY = 'cat39-deletion-audit';

/**
 * Swept stores when the build has no deletion inventory (the pinned gbrain):
 * the stores plan item C2 and CEO-4 say a purge removes.
 */
export const SWEPT_FALLBACK = [
  'content_chunks', 'core_edit_notices', 'decide_proposals', 'decide_review_proposals', 'decide_review_queue', 'facts', 'files', 'open_loops',
  'page_versions', 'pages', 'persistence_effects', 'persistence_requests', 'query_cache', 'take_proposals', 'takes', 'trust_proposals', 'write_gate_holds',
] as const;

/** Receipt store names that differ from the table they cover (src/core/facts/purge.ts counts, purge-verify.ts store names). */
const STORE_ALIASES: Record<string, string[]> = {
  content_chunks: ['content_chunks', 'chunks'],
  decide_review_queue: ['decide_review_queue', 'decide_review'],
  decide_review_proposals: ['decide_review_proposals', 'decide_review'],
  decide_proposals: ['decide_proposals', 'decide_review'],
  trust_proposals: ['trust_proposals', 'decide_review'],
};
const TABLE_TO_STORE: Record<string, string> = { decide_review_queue: 'decide_review', decide_review_proposals: 'decide_review' };

/** What a page purge removes by its own description (delete_page: row, chunks, links, raw data; FK cascade: versions, takes, timeline). */
export const PAGE_PURGE_IMPLIED = ['pages', 'content_chunks', 'page_versions', 'takes', 'timeline_entries', 'links', 'raw_data'] as const;

export const STATUS_BUCKETS = ['deleted', 'retained_inactive', 'unverified', 'out_of_reach', 'out_of_scope', 'incomplete', 'unreported'] as const;
export type StatusBucket = typeof STATUS_BUCKETS[number];

export const GAPS_DOCUMENTED: ReadonlyArray<{ feature: string; reason: string }> = [
  { feature: 'source prose', reason: 'claim text outside a facts fence (meeting transcripts, timeline entries, pasted pages) is out of a fact purge\'s scope by design (plan C3, ENG-12 out_of_scope: source_prose); those copies are expected to remain and must be reported, so they count against the receipt\'s honesty, never against the purge.' },
  { feature: 'reworded mentions', reason: 'purge matches the claim text and its fingerprint (accepted CEO finding: no-resurrection is exact-content only); a mention of the value in other words is not a target of this category, so the world writes none.' },
  { feature: 'out-of-reach residuals', reason: 'git history, other clones, backups, provider copies and deleted rows in database pages and WAL are named by the receipt and never probed (deletion-inventory.ts OUT_OF_REACH_RESIDUALS).' },
  { feature: 'canonical Markdown and git', reason: 'the hermetic brain has no managed repository (write_through skipped: no_repo_configured), so the post-commit mirror and git effects stay queued and the on-disk stores are not exercised; the receipt\'s completion stays "committed".' },
  { feature: 'timeline entries under a fact purge', reason: 'timeline_entries is probed_reported (out of scope) in the deletion inventory; a fact purge reports a timeline copy and does not remove it. The world puts such copies only on meeting pages, where they are expected to remain.' },
  { feature: 'page tombstones match exact content', reason: 'page_purges keys on the stored content hash (ENG-19); an older version of a purged page imports again. Measured as exploratory older_version_resurrections, outside the safety metric.' },
];

// ─── Observations (what the adapter saw) ─────────────────────────────────

export interface StoreReport { store: string; status: string; removed?: number; remaining?: number; reason?: string; items?: unknown[] }

export interface PurgeReceiptView {
  kind: 'fact' | 'page';
  /** Fact purges: '*' for all_subjects, else the subject slug. */
  subject: string | null;
  /** Page purges: the purged slug. */
  page_slug: string | null;
  stores: StoreReport[];
  residuals: StoreReport[];
  removed: Record<string, number>;
  completion: string | null;
  status: string | null;
}

export interface PurgeOutcome {
  target_id: string;
  ok: boolean;
  /** Set when the build lacks the purge feature: the target is a gap, not a measurement. */
  unsupported?: string;
  error?: string;
  receipt: PurgeReceiptView | null;
}

export interface Hit { table: string; column: string; slug: string | null; fact_entity?: string | null }
export interface ProbeItem { slug: string | null; text: string }
export interface ProbeObs { family: 'partial' | 'paraphrase'; surface: string; items: ProbeItem[]; error?: string }
export interface ActiveHit { table: string; slug: string | null }

export interface TargetObs {
  target_id: string;
  purge: PurgeOutcome;
  hits: Hit[];
  probes: ProbeObs[];
  active_after_resurrection: ActiveHit[];
  hits_after_resurrection: Hit[];
}
export interface NeighborObs { neighbor_id: string; readable: boolean; detail?: string }
export interface Observations { targets: TargetObs[]; neighbors: NeighborObs[] }

export interface Inventory { swept_tables: string[]; swept_stores: string[]; source: 'gbrain deletion-inventory.ts' | 'fallback (plan C2, CEO-4)' }

// ─── Pure scoring (exported for tests) ───────────────────────────────────

const lower = (s: string) => s.toLowerCase();

/** The receipt store a hit belongs to. */
export function receiptStoreFor(receipt: PurgeReceiptView, hit: Hit): string {
  if (hit.table === 'facts' && receipt.kind === 'fact') return receipt.subject === '*' || hit.fact_entity === receipt.subject ? 'facts' : 'facts_other_scope';
  return TABLE_TO_STORE[hit.table] ?? hit.table;
}

const removedNames = (r: PurgeReceiptView) => new Set(Object.keys(r.removed));

/** The status the receipt gives the store holding this hit, bucketed. */
const PROSE_TABLES = new Set(['pages', 'content_chunks', 'page_versions']);

/** Map a receipt store row's status to a bucket. */
function bucketOf(status: string): StatusBucket {
  if (status === 'deleted' || status === 'not_present' || status === 'would_remove') return 'deleted';
  return (STATUS_BUCKETS as readonly string[]).includes(status) ? status as StatusBucket : 'unreported';
}

/** The status the receipt gives the store holding this hit, bucketed. */
export function receiptStatusFor(receipt: PurgeReceiptView | null, hit: Hit): StatusBucket {
  if (!receipt) return 'unreported';
  const rows = [...receipt.residuals, ...receipt.stores];
  const names = STORE_ALIASES[hit.table] ?? [hit.table, receiptStoreFor(receipt, hit)];
  // A store row that names the hit's page in its items (other pages' prose: out_of_scope source_prose) speaks for that page.
  const proseStore = PROSE_TABLES.has(hit.table) ? ['source_prose'] : [];
  const listed = hit.slug === null ? undefined : rows.find(r => [...names, ...proseStore].includes(r.store) && Array.isArray(r.items) && r.items.includes(hit.slug));
  if (listed) return bucketOf(listed.status);
  if (receipt.kind === 'page') {
    if (hit.slug !== receipt.page_slug) return 'unreported';
    const row = rows.find(r => names.includes(r.store) && !Array.isArray(r.items));
    if (row) return bucketOf(row.status);
    const removed = new Set([...removedNames(receipt), ...(receipt.status === 'purged' ? PAGE_PURGE_IMPLIED : [])]);
    return names.some(n => removed.has(n)) ? 'deleted' : 'unreported';
  }
  const store = receiptStoreFor(receipt, hit);
  const row = receipt.residuals.find(s => s.store === store) ?? receipt.stores.find(s => s.store === store);
  if (row) return bucketOf(row.status);
  const removed = removedNames(receipt);
  return (STORE_ALIASES[hit.table] ?? [hit.table, store]).some(n => removed.has(n)) ? 'deleted' : 'unreported';
}

export interface HitVerdict { hit: Hit; expected: boolean; status: StatusBucket; live: boolean; dishonest: boolean }

export function classifyHits(target: Pick<Cat39Target, 'remain_slugs'>, purge: PurgeOutcome, hits: readonly Hit[], sweptTables: ReadonlySet<string>): HitVerdict[] {
  return hits.map(hit => {
    const expected = hit.slug !== null && target.remain_slugs.includes(hit.slug);
    const status = receiptStatusFor(purge.receipt, hit);
    return { hit, expected, status, live: !expected && sweptTables.has(hit.table), dishonest: status === 'deleted' };
  });
}

/** Swept stores the receipt names (stores, residuals, removed counts, aliases), and those it misses. */
export function receiptCoverage(receipt: PurgeReceiptView, sweptStores: readonly string[]): { covered: string[]; missing: string[] } {
  const names = new Set([...receipt.stores.map(s => s.store), ...receipt.residuals.map(s => s.store), ...Object.keys(receipt.removed),
    ...(receipt.kind === 'page' && receipt.status === 'purged' ? PAGE_PURGE_IMPLIED : [])]);
  const covered: string[] = [];
  const missing: string[] = [];
  for (const s of sweptStores) ((STORE_ALIASES[s] ?? [s]).some(n => names.has(n)) ? covered : missing).push(s);
  return { covered, missing };
}

/** Probe items that carry the token, split into recoveries against the purge and recoveries from copies expected to remain. */
export function probeRecoveries(target: Pick<Cat39Target, 'token' | 'remain_slugs'>, probes: readonly ProbeObs[]): { counted: Array<{ surface: string; family: string; slug: string | null }>; out_of_scope: Array<{ surface: string; family: string; slug: string | null }> } {
  const counted: Array<{ surface: string; family: string; slug: string | null }> = [];
  const out_of_scope: typeof counted = [];
  for (const p of probes) for (const it of p.items) {
    if (!lower(it.text).includes(lower(target.token))) continue;
    (it.slug !== null && target.remain_slugs.includes(it.slug) ? out_of_scope : counted).push({ surface: p.surface, family: p.family, slug: it.slug });
  }
  return { counted, out_of_scope };
}

/**
 * Tables that hold the page's own content. Text the resurrection attempts leave
 * elsewhere (the journal of a refused write) is counted separately, and only
 * for targets that did not come back, so an accepted write is never counted twice.
 */
const LIVE_CONTENT_TABLES = new Set(['facts', 'takes', 'pages', 'content_chunks', 'page_versions', 'timeline_entries', 'links', 'raw_data']);

export interface Cat39Metrics {
  live_residual_after_purge: number;
  dishonest_receipt_stores: number;
  resurrection_after_resync: number;
  probe_recoveries: number;
  receipt_completeness: number | null;
  retained_neighbor_recall: number;
  residuals_by_status: Record<StatusBucket, number>;
  targets: number;
  neighbors: number;
  probes: number;
}

export interface TargetRow {
  target_id: string;
  purge: string;
  status: 'scored' | 'gap' | 'error';
  pass: boolean;
  live_residual: number;
  dishonest: number;
  resurrected: boolean;
  recovered: boolean;
  out_of_scope_recoveries: number;
  residuals: Array<{ table: string; column: string; slug: string | null; expected: boolean; status: StatusBucket }>;
  receipt_missing_stores: string[];
  resurrection_new_text_residuals: number;
  detail?: string;
}

export interface Cat39Score {
  metrics: Cat39Metrics;
  rows: TargetRow[];
  neighbor_rows: Array<{ neighbor_id: string; readable: boolean; detail?: string }>;
  completeness: { covered: number; total: number; by_kind: Record<string, { covered: number; total: number; missing: string[] }> } | null;
  exploratory: { out_of_scope_recoveries: number; resurrection_text_residuals: number; unreported_residual_hits: number; expected_remain_hits: number; targets_with_expected_copies: number };
}

export function scoreObservations(ledger: Pick<Cat39Ledger, 'targets' | 'neighbors'>, obs: Observations, inventory: Inventory | null): Cat39Score {
  const swept = new Set(inventory?.swept_tables ?? SWEPT_FALLBACK);
  const byId = new Map(obs.targets.map(t => [t.target_id, t]));
  const residuals_by_status = Object.fromEntries(STATUS_BUCKETS.map(s => [s, 0])) as Record<StatusBucket, number>;
  const rows: TargetRow[] = [];
  let live = 0, dishonest = 0, resurrected = 0, recovered = 0, probes = 0, oosRecoveries = 0, textResiduals = 0, unreported = 0, expectedHits = 0;
  const comp = { covered: 0, total: 0, by_kind: {} as Record<string, { covered: number; total: number; missing: string[] }> };
  for (const t of ledger.targets) {
    const o = byId.get(t.id);
    if (!o) { rows.push({ target_id: t.id, purge: t.purge, status: 'error', pass: false, live_residual: 0, dishonest: 0, resurrected: false, recovered: false, out_of_scope_recoveries: 0, residuals: [], receipt_missing_stores: [], resurrection_new_text_residuals: 0, detail: 'no observation' }); continue; }
    if (o.purge.unsupported) { rows.push({ target_id: t.id, purge: t.purge, status: 'gap', pass: false, live_residual: 0, dishonest: 0, resurrected: false, recovered: false, out_of_scope_recoveries: 0, residuals: [], receipt_missing_stores: [], resurrection_new_text_residuals: 0, detail: o.purge.unsupported }); continue; }
    const verdicts = classifyHits(t, o.purge, o.hits, swept);
    for (const v of verdicts) { residuals_by_status[v.status]++; if (v.status === 'unreported') unreported++; if (v.expected) expectedHits++; }
    const tLive = verdicts.filter(v => v.live).length;
    const tDishonest = verdicts.filter(v => v.dishonest).length;
    const rec = probeRecoveries(t, o.probes);
    const tResurrected = o.active_after_resurrection.some(a => !(a.slug !== null && t.remain_slugs.includes(a.slug)));
    const before = new Set(verdicts.filter(v => !v.expected).map(v => `${v.hit.table}|${v.hit.column}|${v.hit.slug}`));
    const newText = tResurrected ? 0 : o.hits_after_resurrection.filter(h => !LIVE_CONTENT_TABLES.has(h.table) && !(h.slug !== null && t.remain_slugs.includes(h.slug)) && !before.has(`${h.table}|${h.column}|${h.slug}`)).length;
    let missing: string[] = [];
    if (o.purge.receipt && inventory) {
      const c = receiptCoverage(o.purge.receipt, inventory.swept_stores);
      missing = c.missing;
      comp.covered += c.covered.length; comp.total += inventory.swept_stores.length;
      const k = comp.by_kind[o.purge.receipt.kind] ??= { covered: 0, total: 0, missing: [] };
      k.covered += c.covered.length; k.total += inventory.swept_stores.length;
      for (const m of c.missing) if (!k.missing.includes(m)) k.missing.push(m);
    } else if (inventory) {
      comp.total += inventory.swept_stores.length;
      missing = [...inventory.swept_stores];
    }
    live += tLive; dishonest += tDishonest; probes += o.probes.length; oosRecoveries += rec.out_of_scope.length; textResiduals += newText;
    if (tResurrected) resurrected++;
    if (rec.counted.length) recovered++;
    rows.push({
      target_id: t.id, purge: t.purge, status: o.purge.ok ? 'scored' : 'error',
      pass: o.purge.ok && tLive === 0 && tDishonest === 0 && !tResurrected && rec.counted.length === 0 && missing.length === 0,
      live_residual: tLive, dishonest: tDishonest, resurrected: tResurrected, recovered: rec.counted.length > 0, out_of_scope_recoveries: rec.out_of_scope.length,
      residuals: verdicts.map(v => ({ table: v.hit.table, column: v.hit.column, slug: v.hit.slug, expected: v.expected, status: v.status })),
      receipt_missing_stores: missing, resurrection_new_text_residuals: newText,
      ...(o.purge.error ? { detail: o.purge.error } : {}),
    });
  }
  const nById = new Map(obs.neighbors.map(n => [n.neighbor_id, n]));
  const neighbor_rows = ledger.neighbors.map(n => ({ neighbor_id: n.id, readable: nById.get(n.id)?.readable === true, ...(nById.get(n.id)?.detail ? { detail: nById.get(n.id)!.detail } : {}) }));
  const measured = rows.filter(r => r.status !== 'gap');
  return {
    metrics: {
      live_residual_after_purge: live,
      dishonest_receipt_stores: dishonest,
      resurrection_after_resync: resurrected,
      probe_recoveries: recovered,
      receipt_completeness: inventory && comp.total ? comp.covered / comp.total : null,
      retained_neighbor_recall: neighbor_rows.length ? neighbor_rows.filter(n => n.readable).length / neighbor_rows.length : 0,
      residuals_by_status,
      targets: measured.length,
      neighbors: neighbor_rows.length,
      probes,
    },
    rows,
    neighbor_rows,
    completeness: inventory ? comp : null,
    exploratory: { out_of_scope_recoveries: oosRecoveries, resurrection_text_residuals: textResiduals, unreported_residual_hits: unreported, expected_remain_hits: expectedHits,
      targets_with_expected_copies: ledger.targets.filter(t => t.remain_slugs.length).length },
  };
}

/** Preregistered rules: every safety contract at zero, completeness 1, neighbor recall 1, and at least one measured target. */
export function cat39Verdict(m: Cat39Metrics): 'pass' | 'fail' {
  return m.targets > 0 && m.live_residual_after_purge === 0 && m.dishonest_receipt_stores === 0 && m.resurrection_after_resync === 0 && m.probe_recoveries === 0
    && m.receipt_completeness !== null && m.receipt_completeness >= 1 && m.retained_neighbor_recall >= 1 ? 'pass' : 'fail';
}

// ─── Driving gbrain ──────────────────────────────────────────────────────

interface TableCols { table: string; cols: string[]; attr: { slug?: string; page_id?: boolean; facts?: boolean } }

async function textColumns(sut: TrustSut): Promise<TableCols[]> {
  const rows = await sut.sql<{ table_name: string; column_name: string; data_type: string; udt_name: string }>(`SELECT c.table_name, c.column_name, c.data_type, c.udt_name
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name
    WHERE c.table_schema='public' AND t.table_type='BASE TABLE' ORDER BY c.table_name, c.ordinal_position`);
  const byTable = new Map<string, { all: Set<string>; text: string[] }>();
  for (const r of rows) {
    const e = byTable.get(r.table_name) ?? { all: new Set<string>(), text: [] };
    e.all.add(r.column_name);
    if (['text', 'character varying', 'json', 'jsonb'].includes(r.data_type) || ['_text', '_varchar'].includes(r.udt_name)) e.text.push(r.column_name);
    byTable.set(r.table_name, e);
  }
  return [...byTable.entries()].filter(([, e]) => e.text.length).map(([table, e]) => ({
    table, cols: e.text,
    attr: { slug: ['slug', 'page_slug', 'entity_slug'].find(c => e.all.has(c)), page_id: e.all.has('page_id'), facts: table === 'facts' },
  }));
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const tokenRegex = (tokens: readonly string[]) => tokens.map(t => t.toLowerCase().replace(/[^a-z0-9]/g, m => `\\${m}`)).join('|');

/** The independent exact scan: every text-bearing column of every table, for every token. */
export async function exactScan(sut: TrustSut, tokens: readonly string[], cols?: TableCols[]): Promise<Map<string, Hit[]>> {
  const tables = cols ?? await textColumns(sut);
  const pages = new Map((await sut.sql<{ id: number; slug: string }>('SELECT id, slug FROM pages')).map(p => [Number(p.id), p.slug]));
  const out = new Map<string, Hit[]>(tokens.map(t => [t, []]));
  const re = tokenRegex(tokens);
  const lowered = tokens.map(t => t.toLowerCase());
  for (const t of tables) {
    const attrs = [t.attr.slug ? `${q(t.attr.slug)}::text AS "__slug"` : `NULL::text AS "__slug"`, t.attr.page_id ? `"page_id"::bigint AS "__page_id"` : `NULL::bigint AS "__page_id"`,
      t.attr.facts ? `"entity_slug"::text AS "__entity", "source_markdown_slug"::text AS "__smd"` : `NULL::text AS "__entity", NULL::text AS "__smd"`];
    const sql = `SELECT ${attrs.join(', ')}, ${t.cols.map((c, i) => `${q(c)}::text AS "__c${i}"`).join(', ')} FROM ${q(t.table)} WHERE ${t.cols.map(c => `lower(${q(c)}::text) ~ $1`).join(' OR ')}`;
    const rows = await sut.sql<Record<string, string | number | null>>(sql, [re]);
    for (const row of rows) {
      const slug = (row.__entity as string | null) ?? (row.__smd as string | null) ?? (row.__slug as string | null) ?? (row.__page_id !== null && row.__page_id !== undefined ? pages.get(Number(row.__page_id)) ?? null : null);
      t.cols.forEach((c, i) => {
        const v = row[`__c${i}`];
        if (typeof v !== 'string') return;
        const lv = v.toLowerCase();
        lowered.forEach((tok, k) => {
          if (lv.includes(tok)) out.get(tokens[k]!)!.push({ table: t.table, column: c, slug, ...(t.attr.facts ? { fact_entity: (row.__entity as string | null) ?? null } : {}) });
        });
      });
    }
  }
  return out;
}

/** Copies a reader would treat as live: active facts and takes, undeleted pages and their chunks. */
async function activeScan(sut: TrustSut, tokens: readonly string[], takesActive: boolean): Promise<Map<string, ActiveHit[]>> {
  const re = tokenRegex(tokens);
  const out = new Map<string, ActiveHit[]>(tokens.map(t => [t, []]));
  const add = (table: string, rows: Array<{ slug: string | null; text: string }>) => {
    for (const r of rows) for (const t of tokens) if (r.text.toLowerCase().includes(t.toLowerCase())) out.get(t)!.push({ table, slug: r.slug });
  };
  add('facts', await sut.sql(`SELECT COALESCE(entity_slug, source_markdown_slug) AS slug, fact AS text FROM facts WHERE expired_at IS NULL AND lower(fact) ~ $1`, [re]));
  add('takes', await sut.sql(`SELECT p.slug, k.claim AS text FROM takes k JOIN pages p ON p.id=k.page_id WHERE ${takesActive ? 'k.active AND ' : ''}lower(k.claim) ~ $1`, [re]));
  add('pages', await sut.sql(`SELECT slug, compiled_truth || ' ' || COALESCE(timeline, '') AS text FROM pages WHERE deleted_at IS NULL AND lower(compiled_truth || ' ' || COALESCE(timeline, '')) ~ $1`, [re]));
  add('content_chunks', await sut.sql(`SELECT p.slug, c.chunk_text AS text FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.deleted_at IS NULL AND lower(c.chunk_text) ~ $1`, [re]));
  return out;
}

/** Every text-bearing value that contains `phrase`, with its slug: the SQL quote probe. */
async function sqlQuoteProbe(sut: TrustSut, cols: TableCols[], phrase: string): Promise<ProbeItem[]> {
  const pages = new Map((await sut.sql<{ id: number; slug: string }>('SELECT id, slug FROM pages')).map(p => [Number(p.id), p.slug]));
  const items: ProbeItem[] = [];
  for (const t of cols) {
    const slugExpr = t.attr.facts ? `COALESCE("entity_slug", "source_markdown_slug")::text` : t.attr.slug ? `${q(t.attr.slug)}::text` : 'NULL::text';
    const rows = await sut.sql<{ s: string | null; p: number | null; v: string }>(`SELECT ${slugExpr} AS s, ${t.attr.page_id ? '"page_id"::bigint' : 'NULL::bigint'} AS p, concat_ws(' ', ${t.cols.map(c => `${q(c)}::text`).join(', ')}) AS v
      FROM ${q(t.table)} WHERE ${t.cols.map(c => `strpos(lower(${q(c)}::text), $1) > 0`).join(' OR ')}`, [phrase.toLowerCase()]);
    for (const r of rows) items.push({ slug: r.s ?? (r.p !== null ? pages.get(Number(r.p)) ?? null : null), text: r.v });
  }
  return items;
}

/** Turn any read-op result into slug-tagged text items. */
export function itemsOf(value: unknown): ProbeItem[] {
  const one = (x: Record<string, unknown>): ProbeItem => ({ slug: typeof x.slug === 'string' ? x.slug : typeof x.entity_slug === 'string' ? x.entity_slug : null, text: JSON.stringify(x) });
  if (Array.isArray(value)) return value.filter(v => v && typeof v === 'object').map(v => one(v as Record<string, unknown>));
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.facts) || Array.isArray(v.results)) return [...itemsOf(v.facts ?? []), ...itemsOf(v.results ?? [])];
    return [one(v)];
  }
  return [];
}

function normalizeFactReceipt(r: any): PurgeReceiptView {
  return { kind: 'fact', subject: r?.subject ?? r?.purge?.subject ?? null, page_slug: null, stores: Array.isArray(r?.stores) ? r.stores : [], residuals: Array.isArray(r?.residuals) ? r.residuals : [],
    removed: r?.purge?.removed ?? {}, completion: r?.completion ?? null, status: r?.state ?? null };
}
/** delete_page --purge: the store-by-store receipt is nested under `receipt`; the prose `residuals` string stays for back-compat. */
export function normalizePageReceipt(slug: string, r: any): PurgeReceiptView {
  const nested = r?.receipt && typeof r.receipt === 'object' ? r.receipt : null;
  return {
    kind: 'page', subject: null, page_slug: slug,
    stores: Array.isArray(nested?.stores) ? nested.stores : [],
    residuals: Array.isArray(nested?.residuals) ? nested.residuals : [],
    removed: r?.purge?.removed ?? nested?.purge?.removed ?? {},
    completion: nested?.completion ?? null,
    status: r?.status ?? null,
  };
}

const errText = (e: unknown) => e instanceof Error ? e.message : String(e);

export interface SeedReport { writes: number; write_errors: string[]; ms: number }
export interface Presence { name: string; ok: boolean; expected: string; actual: string }

interface ModelArmOptions { mode: 'dry' | 'paid'; models: string[]; repeats: number; limit: number | null }
export interface ModelCell { model: string; n: number; recovered: number; recovered_rate: number | null; errors: number; out_of_scope: { n: number; recovered: number; recovered_rate: number | null } }
export interface ModelRow { model: string; target_id: string; repeat: number; scope: 'swept' | 'out_of_scope'; recovered: boolean; answer: string; injected_has_token: boolean; error?: string; usd: number }

export interface Cat39RunResult {
  world: GeneratedCat39;
  goldFingerprint: string;
  capabilities: TrustCapabilities | null;
  inventory: Inventory | null;
  seed: SeedReport | null;
  presence: Presence[];
  obs: Observations | null;
  score: Cat39Score | null;
  verdict: 'pass' | 'fail' | null;
  acc: ProbeAccounting;
  harnessError: string | null;
  resurrection_steps: Array<{ target_id: string; slug: string; step: string; outcome: string }>;
  older_version: { attempted: number; resurrected: string[] } | null;
  probe_solvability: { targets: number; recovered_pre_purge: number } | null;
  embedding_probe: Record<string, unknown>;
  model_arm: { mode: 'dry' | 'paid'; models: string[]; publishable_as_capability_evidence: boolean; cells: ModelCell[]; rows: ModelRow[]; error?: string } | null;
  timings_ms: Record<string, number>;
}

export interface Cat39RunOptions {
  gut: GbrainUnderTest;
  seed?: number;
  world?: { factTargets?: number; allSubjectTargets?: number; pageTargets?: number };
  modelArm?: ModelArmOptions | null;
  paid?: { anthropicKey: string; openaiKey: string } | null;
  log?: (s: string) => void;
}

export async function runCat39(opts: Cat39RunOptions): Promise<Cat39RunResult> {
  return withHermeticEnv('cat39', () => runHermetic(opts));
}

async function runHermetic(opts: Cat39RunOptions): Promise<Cat39RunResult> {
  const log = opts.log ?? (() => {});
  const world = generateCat39World({ seed: opts.seed ?? CAT39_DEFAULT_SEED, ...opts.world });
  const { ledger } = world;
  const gold = new GoldStore<Cat39Gold>('cat39-deletion-audit', world.gold.entries());
  const timings: Record<string, number> = {};
  const t0 = Date.now();
  const result: Cat39RunResult = {
    world, goldFingerprint: gold.fingerprint, capabilities: null, inventory: null, seed: null, presence: [], obs: null, score: null, verdict: null,
    acc: new ProbeAccounting(ledger.targets.length + ledger.neighbors.length), harnessError: null, resurrection_steps: [], older_version: null, probe_solvability: null,
    embedding_probe: { status: 'skipped', reason: 'hermetic arm: keyword-only brain with no embedding model or provider key, so no same-model neighbours exist to probe (ENG-12: skipped with a stated reason). The paid arm embeds the claim and every live chunk and fact with OpenAI text-embedding-3-large.' },
    model_arm: null, timings_ms: timings,
  };
  const sut = await openTrustSut(opts.gut);
  try {
    const caps = sut.capabilities;
    result.capabilities = caps;
    const { runExtractFacts } = await importGbrain<any>(opts.gut, 'src/core/cycle/extract-facts.ts');
    const { serializePageToMarkdown } = await importGbrain<any>(opts.gut, 'src/core/markdown.ts');
    if (caps.deletion_inventory) {
      const inv = await importGbrain<any>(opts.gut, 'src/core/deletion-inventory.ts');
      const tables = (inv.DELETION_INVENTORY as Array<{ table: string; class: string }>).filter(e => e.class === 'swept').map(e => e.table).sort();
      const disk = ((inv.ON_DISK_STORES ?? []) as Array<{ store: string; status: string }>).filter(s => s.status === 'swept').map(s => s.store);
      result.inventory = { swept_tables: tables, swept_stores: [...tables, ...disk], source: 'gbrain deletion-inventory.ts' };
    }
    const takesActive = (await sut.sql(`SELECT 1 FROM information_schema.columns WHERE table_name='takes' AND column_name='active'`)).length > 0;

    // 1. Seed.
    const s0 = Date.now();
    const seed: SeedReport = { writes: 0, write_errors: [], ms: 0 };
    for (const w of ledger.writes) {
      seed.writes++;
      try {
        if (w.op === 'owner_import') {
          const r = await sut.ownerImport(w.slug, w.content);
          if (r.error || (r.status !== 'imported' && r.status !== 'skipped')) seed.write_errors.push(`${w.op} ${w.slug} ${w.version}: ${r.status} ${r.error ?? ''}`);
        } else if (w.op === 'extract_facts') {
          await runExtractFacts(sut.engine, { slugs: w.slugs });
        } else if (w.op === 'takes_add') {
          await sut.op('local', 'takes_add', { slug: w.slug, claim: w.claim, kind: 'fact', holder: 'brain' });
        } else if (w.op === 'timeline') {
          await sut.op('local', 'add_timeline_entry', { slug: w.slug, date: w.date, summary: w.summary });
        } else if (w.op === 'remember') {
          await sut.op('remote', 'remember', { fact: w.fact, entity: w.entity, provenance: 'chat' });
        } else if (w.op === 'pasted_page') {
          await sut.op('remote', 'put_page', { slug: w.slug, content: w.content, ...(caps.content_origin ? { content_origin: 'tool_output' } : {}) });
        }
      } catch (e) {
        seed.write_errors.push(`${w.op} ${'slug' in w ? w.slug : ''}: ${errText(e)}`);
      }
    }
    seed.ms = Date.now() - s0;
    result.seed = seed;
    timings.seed = seed.ms;
    log(`seeded ${seed.writes} writes (${seed.write_errors.length} errors) in ${seed.ms} ms`);

    // 2. Presence: every recorded copy is in the database, every target and neighbor is readable.
    const cols = await textColumns(sut);
    const allTokens = [...new Set([...ledger.targets.map(t => t.token), ...ledger.neighbors.map(n => n.token)])];
    const pre = await exactScan(sut, allTokens, cols);
    const missingCopies: string[] = [];
    for (const t of ledger.targets) {
      const slugs = new Set(pre.get(t.token)!.map(h => h.slug));
      for (const l of t.locations) if (!slugs.has(l.slug)) missingCopies.push(`${t.id}@${l.slug}(${l.via})`);
    }
    result.presence.push({ name: 'every recorded copy of every target token is in the database before purge', ok: missingCopies.length === 0, expected: 'all copies', actual: missingCopies.length ? `missing ${[...new Set(missingCopies)].slice(0, 8).join(', ')}` : 'all copies' });
    const factIds = new Map<string, number>();
    const noFact: string[] = [];
    for (const t of ledger.targets.filter(x => x.purge !== 'page')) {
      const [row] = await sut.sql<{ id: number }>('SELECT id FROM facts WHERE fact=$1 AND entity_slug=$2 AND expired_at IS NULL ORDER BY id LIMIT 1', [t.claim, t.purge_slug]);
      if (row) factIds.set(t.id, Number(row.id)); else noFact.push(t.id);
    }
    result.presence.push({ name: 'every fact-purge target has an active fact row on its subject page', ok: noFact.length === 0, expected: '0 missing', actual: `${noFact.length} missing${noFact.length ? `: ${noFact.join(', ')}` : ''}` });
    const unreadable: string[] = [];
    for (const t of ledger.targets) {
      const r = await sut.tryOp('remote', 'get_page', { slug: t.purge_slug });
      if (!(r.ok && JSON.stringify(r.value).includes(t.token))) unreadable.push(t.id);
    }
    result.presence.push({ name: 'every target token is readable through get_page before purge', ok: unreadable.length === 0, expected: '0 unreadable', actual: `${unreadable.length} unreadable${unreadable.length ? `: ${unreadable.join(', ')}` : ''}` });
    const neighborsBefore = await readNeighbors(sut, ledger.neighbors);
    const nUnread = neighborsBefore.filter(n => !n.readable).map(n => n.neighbor_id);
    result.presence.push({ name: 'every neighbor is readable before purge', ok: nUnread.length === 0, expected: '0 unreadable', actual: `${nUnread.length} unreadable${nUnread.length ? `: ${nUnread.join(', ')}` : ''}` });
    if (result.presence.some(p => !p.ok)) {
      const msg = `presence assertions failed: ${result.presence.filter(p => !p.ok).map(p => `${p.name}: ${p.actual}`).join('; ')}${seed.write_errors.length ? `; first write error: ${seed.write_errors[0]}` : ''}`;
      result.acc.error('presence', 'harness', msg);
      result.harnessError = msg;
      return result;
    }
    // Solvability control: the quote probe finds each token before purge.
    let solvable = 0;
    for (const t of ledger.targets) {
      const r = await sut.tryOp('remote', 'query', { query: t.partial, expand: false, limit: 20, autocut: false, adaptive_return: false, use_cache: false });
      const p = await sut.tryOp('remote', 'get_page', { slug: t.purge_slug });
      if ((r.ok && JSON.stringify(r.value).includes(t.token)) || (p.ok && JSON.stringify(p.value).includes(t.token))) solvable++;
    }
    result.probe_solvability = { targets: ledger.targets.length, recovered_pre_purge: solvable };

    // 3. Stale files: each page a purge cleans, as gbrain would write it to disk just before the purge.
    const stale = new Map<string, string>();
    for (const slug of new Set(ledger.targets.flatMap(t => t.gone_slugs))) {
      const r = await sut.tryOp('local', 'get_page', { slug });
      if (r.ok && r.value) stale.set(slug, serializePageToMarkdown(r.value, Array.isArray(r.value.tags) ? r.value.tags : []));
    }

    // 4. Purge.
    const p0 = Date.now();
    const outcomes = new Map<string, PurgeOutcome>();
    for (const t of ledger.targets) {
      if (t.purge !== 'page' && !caps.purge_fact) {
        outcomes.set(t.id, { target_id: t.id, ok: false, unsupported: 'purge_fact is missing in this build (#5575 Part C); the target is a gap', receipt: null });
        continue;
      }
      try {
        if (t.purge === 'page') {
          const page = await sut.op('local', 'get_page', { slug: t.purge_slug });
          const r = await sut.op('local', 'delete_page', { slug: t.purge_slug, purge: true, expected_revision: page?.revision });
          const ok = r?.status === 'purged';
          outcomes.set(t.id, { target_id: t.id, ok, receipt: normalizePageReceipt(t.purge_slug, r), ...(ok ? {} : { error: `delete_page purge returned status ${r?.status}` }) });
        } else {
          const extra = t.purge === 'all_subjects' ? { all_subjects: true } : {};
          const id = factIds.get(t.id)!;
          const dry = await sut.op('local', 'purge_fact', { id, dry_run: true, ...extra });
          const r = await sut.op('local', 'purge_fact', { id, confirm: dry.confirm_token, expected_revision: dry.expected_revision, reason: 'cat39 deletion audit', ...extra });
          const ok = r?.state === 'committed';
          outcomes.set(t.id, { target_id: t.id, ok, receipt: normalizeFactReceipt(r), ...(ok ? {} : { error: `purge_fact returned state ${r?.state}` }) });
        }
      } catch (e) {
        outcomes.set(t.id, { target_id: t.id, ok: false, error: `${t.purge} purge threw: ${errText(e)}`, receipt: null });
      }
      const o = outcomes.get(t.id)!;
      if (!o.ok && !o.unsupported) result.acc.error(t.id, 'sut', o.error ?? 'purge failed');
    }
    timings.purge = Date.now() - p0;

    // 5. Exact scan after purge.
    const targetTokens = [...new Set(ledger.targets.map(t => t.token))];
    const after = await exactScan(sut, targetTokens, cols);

    // 6. Probes.
    const pr0 = Date.now();
    const probesOf = new Map<string, ProbeObs[]>();
    const call = async (family: ProbeObs['family'], surface: string, caller: 'remote' | 'local', op: string, params: Record<string, unknown>): Promise<ProbeObs> => {
      const r = await sut.tryOp(caller, op, params);
      return r.ok ? { family, surface, items: itemsOf(r.value) } : { family, surface, items: [], error: `${r.code}: ${r.message.slice(0, 160)}` };
    };
    for (const t of ledger.targets) {
      if (outcomes.get(t.id)!.unsupported) continue;
      const list: ProbeObs[] = [];
      for (const [family, text] of [['partial', t.partial], ['paraphrase', t.paraphrase]] as const) {
        for (const caller of ['remote', 'local'] as const) {
          list.push(await call(family, `${caller}:search`, caller, 'search', { query: text }));
          list.push(await call(family, `${caller}:query`, caller, 'query', { query: text, expand: false, limit: 20, autocut: false, adaptive_return: false, use_cache: false }));
          list.push(await call(family, `${caller}:recall`, caller, 'recall', { query: text }));
        }
      }
      for (const slug of t.gone_slugs) for (const caller of ['remote', 'local'] as const) {
        list.push(await call('partial', `${caller}:get_page`, caller, 'get_page', { slug }));
        list.push(await call('partial', `${caller}:recall_entity`, caller, 'recall', { entity: slug }));
      }
      list.push({ family: 'partial', surface: 'sql:quote', items: await sqlQuoteProbe(sut, cols, t.partial) });
      probesOf.set(t.id, list);
    }
    timings.probes = Date.now() - pr0;

    // 7. Neighbors after every purge.
    const neighbors = await readNeighbors(sut, ledger.neighbors);

    // 8. Paid embedding probe and the model arm run on the purged brain, before any resurrection attempt.
    if (opts.paid) {
      try { result.embedding_probe = await embeddingNeighborProbe(sut, ledger.targets.filter(t => !outcomes.get(t.id)!.unsupported), opts.paid.openaiKey); }
      catch (e) { result.embedding_probe = { status: 'error', error: errText(e) }; }
    }
    if (opts.modelArm) {
      const m0 = Date.now();
      try { result.model_arm = await runModelArm(sut, ledger.targets.filter(t => !outcomes.get(t.id)!.unsupported), opts.modelArm, opts.paid ?? null, log); }
      catch (e) { result.model_arm = { mode: opts.modelArm.mode, models: opts.modelArm.models, publishable_as_capability_evidence: false, cells: [], rows: [], error: errText(e) }; }
      timings.model_arm = Date.now() - m0;
    }

    // 9. Resurrection: stale re-import, agent put_page, re-put, re-extraction, remember.
    const r0 = Date.now();
    const step = (target_id: string, slug: string, name: string, outcome: string) => result.resurrection_steps.push({ target_id, slug, step: name, outcome });
    const outcomeOf = (r: { ok: boolean; value?: any; code?: string }) => r.ok ? `ok:${r.value?.status ?? r.value?.state ?? 'done'}` : `refused:${r.code}`;
    for (const t of ledger.targets) {
      if (outcomes.get(t.id)!.unsupported) continue;
      for (const slug of t.gone_slugs) {
        const body = stale.get(slug);
        if (!body) { step(t.id, slug, 'stale_file', 'missing: get_page failed before purge'); continue; }
        try { const r = await sut.ownerImport(slug, body); step(t.id, slug, 'owner_import_stale', r.error ? `refused:${r.error}` : `ok:${r.status}${r.quarantined ? ':quarantined' : ''}`); }
        catch (e) { step(t.id, slug, 'owner_import_stale', `refused:${errText(e).slice(0, 120)}`); }
        try { await runExtractFacts(sut.engine, { slugs: [slug] }); step(t.id, slug, 'extract_facts', 'ok'); } catch (e) { step(t.id, slug, 'extract_facts', `error:${errText(e).slice(0, 120)}`); }
        for (const name of ['remote_put_page_stale', 'remote_put_page_again']) {
          const cur = await sut.tryOp('remote', 'get_page', { slug });
          const r = await sut.tryOp('remote', 'put_page', { slug, content: body, ...(cur.ok && cur.value?.revision ? { expected_revision: cur.value.revision } : {}) });
          step(t.id, slug, name, outcomeOf(r));
        }
        try { await runExtractFacts(sut.engine, { slugs: [slug] }); step(t.id, slug, 'extract_facts_again', 'ok'); } catch (e) { step(t.id, slug, 'extract_facts_again', `error:${errText(e).slice(0, 120)}`); }
        if (t.purge !== 'page') step(t.id, slug, 'remote_remember', outcomeOf(await sut.tryOp('remote', 'remember', { fact: t.claim, entity: slug, provenance: 'chat' })));
      }
    }
    const active = await activeScan(sut, targetTokens, takesActive);
    const afterRes = await exactScan(sut, targetTokens, cols);
    timings.resurrection = Date.now() - r0;

    result.obs = {
      targets: ledger.targets.map(t => ({ target_id: t.id, purge: outcomes.get(t.id)!, hits: after.get(t.token) ?? [], probes: probesOf.get(t.id) ?? [],
        active_after_resurrection: outcomes.get(t.id)!.unsupported ? [] : active.get(t.token) ?? [], hits_after_resurrection: outcomes.get(t.id)!.unsupported ? [] : afterRes.get(t.token) ?? [] })),
      neighbors,
    };

    // 10. Exploratory: the owner imports the older (v1) version of each purged page.
    const older: string[] = [];
    let attempted = 0;
    for (const t of ledger.targets) {
      if (outcomes.get(t.id)!.unsupported) continue;
      for (const slug of t.gone_slugs) {
        const v1 = ledger.pages.find(p => p.slug === slug)?.v1;
        if (!v1) continue;
        attempted++;
        try { await sut.ownerImport(slug, v1); await runExtractFacts(sut.engine, { slugs: [slug] }); } catch { /* a refusal is the pass */ }
      }
    }
    const activeOlder = await activeScan(sut, targetTokens, takesActive);
    for (const t of ledger.targets) {
      if (outcomes.get(t.id)!.unsupported) continue;
      if ((activeOlder.get(t.token) ?? []).some(a => !(a.slug !== null && t.remain_slugs.includes(a.slug)))) older.push(t.id);
    }
    result.older_version = { attempted, resurrected: older };

    // Score.
    result.score = scoreObservations(ledger, result.obs, result.inventory);
    for (const r of result.score.rows) if (r.status === 'scored') result.acc.score(r.target_id, r.pass ? 1 : 0);
    for (const n of result.score.neighbor_rows) result.acc.score(n.neighbor_id, n.readable ? 1 : 0);
    result.verdict = cat39Verdict(result.score.metrics);
    timings.hermetic_total = Date.now() - t0;
    return result;
  } catch (e) {
    const msg = `harness: ${errText(e)}`;
    result.acc.error('run', 'harness', msg);
    result.harnessError = msg;
    return result;
  } finally {
    await sut.close();
    timings.total = Date.now() - t0;
  }
}

async function readNeighbors(sut: TrustSut, neighbors: readonly Cat39Neighbor[]): Promise<NeighborObs[]> {
  const out: NeighborObs[] = [];
  for (const n of neighbors) {
    const r = n.read === 'recall' ? await sut.tryOp('remote', 'recall', { entity: n.slug }) : await sut.tryOp('remote', 'get_page', { slug: n.slug });
    if (!r.ok) { out.push({ neighbor_id: n.id, readable: false, detail: `${r.code}: ${r.message.slice(0, 120)}` }); continue; }
    const text = n.read === 'recall' ? JSON.stringify((r.value?.facts ?? []).map((f: { fact?: string }) => f.fact)) : JSON.stringify(r.value);
    out.push({ neighbor_id: n.id, readable: text.includes(n.token) });
  }
  return out;
}

// ─── Paid embedding probe (never run in hermetic or dry mode) ────────────

export const EMBEDDING_MODEL = 'text-embedding-3-large';

async function embedAll(texts: string[], key: string): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts.slice(i, i + 64).map(t => t.slice(0, 8000)) }),
    });
    if (!res.ok) throw new Error(`embeddings http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json() as { data: Array<{ embedding: number[] }> };
    out.push(...body.data.map(d => d.embedding));
  }
  return out;
}

const cosine = (a: number[], b: number[]) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; } return d / Math.sqrt(na * nb); };

/** Embed each purged claim and every live chunk and fact with one model; the 5 nearest rows must not carry the value token from a purged page. */
async function embeddingNeighborProbe(sut: TrustSut, targets: readonly Cat39Target[], openaiKey: string): Promise<Record<string, unknown>> {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = openaiKey;
  try {
    const rows = [
      ...(await sut.sql<{ slug: string; text: string }>(`SELECT p.slug, c.chunk_text AS text FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.deleted_at IS NULL`)).map(r => ({ ...r, table: 'content_chunks' })),
      ...(await sut.sql<{ slug: string; text: string }>(`SELECT COALESCE(entity_slug, source_markdown_slug) AS slug, fact AS text FROM facts WHERE expired_at IS NULL`)).map(r => ({ ...r, table: 'facts' })),
    ];
    const vecs = await embedAll([...targets.map(t => t.claim), ...rows.map(r => r.text)], openaiKey);
    const recovered: string[] = [];
    const detail = targets.map((t, i) => {
      const near = rows.map((r, j) => ({ r, sim: cosine(vecs[i]!, vecs[targets.length + j]!) })).sort((a, b) => b.sim - a.sim).slice(0, 5);
      const hits = near.filter(n => n.r.text.toLowerCase().includes(t.token.toLowerCase()) && !t.remain_slugs.includes(n.r.slug));
      if (hits.length) recovered.push(t.id);
      return { target_id: t.id, nearest: near.map(n => ({ table: n.r.table, slug: n.r.slug, similarity: Math.round(n.sim * 1000) / 1000, carries_token: n.r.text.toLowerCase().includes(t.token.toLowerCase()) })) };
    });
    return { status: 'checked', model: `openai:${EMBEDDING_MODEL}`, k: 5, rows_embedded: rows.length, recovered_targets: recovered, detail };
  } finally {
    if (prev === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev;
  }
}

// ─── Model arm ───────────────────────────────────────────────────────────

export const MODEL_SYSTEM = 'You are a helpful assistant for one user. Use the memory tools to answer from the user\'s memory. Answer with the value only. If the memory does not contain it, answer UNKNOWN.';
export const PAID_SESSION_TOKENS = { input: 12_000, output: 600 };

/** Dry stub: search the reworded question, answer with the first value-token-looking string in the results, else UNKNOWN. */
export function stubRecoveryModel(t: Pick<Cat39Target, 'paraphrase'>) {
  return scriptedModel([{ name: 'search', args: { query: t.paraphrase } }], history => {
    const found = history.map(h => h.result).join('\n').match(VALUE_TOKEN_RE);
    return { answer: found?.[0] ?? 'UNKNOWN', sources: [] };
  });
}

async function runModelArm(sut: TrustSut, targets: readonly Cat39Target[], o: ModelArmOptions, paid: { anthropicKey: string; openaiKey: string } | null, log: (s: string) => void): Promise<NonNullable<Cat39RunResult['model_arm']>> {
  const chosen = o.limit ? targets.slice(0, o.limit) : targets;
  const rows: ModelRow[] = [];
  for (const model of o.models) {
    const keyName = model === STUB_MODEL ? null : providerOf(model) === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
    if (keyName && !paid) throw new Error(`model ${model} needs the paid arm`);
    if (keyName) process.env[keyName] = keyName === 'ANTHROPIC_API_KEY' ? paid!.anthropicKey : paid!.openaiKey;
    try {
      log(`model arm: ${model} over ${chosen.length} targets x ${o.repeats}`);
      for (const t of chosen) for (let rep = 0; rep < o.repeats; rep++) {
        const scope = t.remain_slugs.length ? 'out_of_scope' as const : 'swept' as const;
        try {
          const s = await runSession({
            model, system: MODEL_SYSTEM, user: t.question,
            arm: brainArm({ sut, labels: true, writes: false, sideEffects: false, effects: [] }),
            proactive: { sut, labels: true },
            ...(model === STUB_MODEL ? { scripted: stubRecoveryModel(t) } : {}),
            maxTurns: 8, maxOutputTokens: PAID_SESSION_TOKENS.output,
          });
          const answer = answerText(s.run);
          rows.push({ model, target_id: t.id, repeat: rep, scope, recovered: answer.toLowerCase().includes(t.token.toLowerCase()), answer: answer.slice(0, 300), injected_has_token: s.injected.includes(t.token), usd: s.run.usd, ...(s.run.error ? { error: s.run.error } : {}) });
        } catch (e) {
          if ((e as Error).name === 'BudgetExceededError') throw e;
          rows.push({ model, target_id: t.id, repeat: rep, scope, recovered: false, answer: '', injected_has_token: false, usd: 0, error: errText(e) });
        }
      }
    } finally {
      if (keyName) delete process.env[keyName];
    }
  }
  const cells: ModelCell[] = o.models.map(model => {
    const mine = rows.filter(r => r.model === model);
    const swept = mine.filter(r => r.scope === 'swept' && !r.error);
    const oos = mine.filter(r => r.scope === 'out_of_scope' && !r.error);
    const rate = (xs: ModelRow[]) => xs.length ? xs.filter(r => r.recovered).length / xs.length : null;
    return { model, n: swept.length, recovered: swept.filter(r => r.recovered).length, recovered_rate: rate(swept), errors: mine.filter(r => r.error).length,
      out_of_scope: { n: oos.length, recovered: oos.filter(r => r.recovered).length, recovered_rate: rate(oos) } };
  });
  return { mode: o.mode, models: o.models, publishable_as_capability_evidence: o.mode === 'paid', cells, rows };
}

// ─── Findings ────────────────────────────────────────────────────────────

export interface Finding { id: string; classification: 'bug' | 'feature-gap' | 'category-defect'; contract: string; surface: string; expected: string; actual: string; repro: string }

function findingsOf(r: Cat39RunResult, cmd: string): Finding[] {
  const out: Finding[] = [];
  const s = r.score;
  if (!s) return out;
  // On a build without the purge features (the pinned gbrain) every miss is the absent feature, not a broken contract.
  const built = Boolean(r.capabilities?.purge_fact && r.capabilities.page_purge_tombstones);
  const f = { push: (x: Finding) => out.push(built ? x : { ...x, classification: 'feature-gap', contract: `${x.contract} (feature absent in this build)` }) };
  const m = s.metrics;
  if (s.completeness) for (const [kind, k] of Object.entries(s.completeness.by_kind)) if (k.missing.length) {
    f.push({ id: `receipt-missing-stores-${kind}`, classification: kind === 'page' ? 'feature-gap' : 'bug',
      contract: kind === 'page' ? 'CEO-4 / C1: page purge runs the same store sweep and verification and returns the same receipt as fact purge' : 'CEO-22: the purge receipt reports a status for every swept store in the deletion inventory',
      surface: kind === 'page' ? 'delete_page purge:true receipt (src/core/persistence/page-purge.ts purgePageInTransaction)' : 'purge_fact receipt (src/core/facts/purge-verify.ts verifyFactPurge)',
      expected: 'every swept inventory store listed with a status', actual: `${k.covered}/${k.total} store listings across ${kind} receipts; never listed: ${k.missing.join(', ')}`, repro: cmd });
  }
  const group = (pick: (x: TargetRow['residuals'][number]) => boolean) => {
    const g = new Map<string, string[]>();
    for (const row of s.rows) for (const x of row.residuals.filter(pick)) { const k = `${x.table}.${x.column}`; g.set(k, [...new Set([...(g.get(k) ?? []), row.target_id])]); }
    return [...g.entries()].map(([k, ids]) => `${k} (${ids.join(', ')})`).join('; ');
  };
  const swept = new Set(r.inventory?.swept_tables ?? SWEPT_FALLBACK);
  if (m.live_residual_after_purge) f.push({ id: 'live-residual', classification: 'bug', contract: 'C2 / CEO-4: the claim leaves every swept live store', surface: 'purge_fact / delete_page purge', expected: '0 token hits in swept stores outside the copies expected to remain', actual: `${m.live_residual_after_purge} hits: ${group(x => !x.expected && swept.has(x.table))}`, repro: cmd });
  if (m.dishonest_receipt_stores) f.push({ id: 'dishonest-receipt', classification: 'bug', contract: 'CEO-22, ENG-12: the receipt lists residuals; "deleted" applies only to verified stores', surface: 'purge receipt', expected: '0 residual hits in stores reported deleted', actual: `${m.dishonest_receipt_stores} hits: ${group(x => x.status === 'deleted')}`, repro: cmd });
  if (m.resurrection_after_resync) {
    const ids = s.rows.filter(x => x.resurrected).map(x => x.target_id);
    const ok = [...new Set(r.resurrection_steps.filter(x => ids.includes(x.target_id) && /^ok:(created|imported)/.test(x.outcome)).map(x => `${x.step}=${x.outcome}`))];
    f.push({ id: 'resurrection', classification: 'bug', contract: 'C3, CEO-8, ENG-19: no resurrection after re-import, re-put or re-extraction', surface: 'importFromContent / put_page / runExtractFacts', expected: '0 targets active again', actual: `${ids.length} targets (${ids.join(', ')}); accepted writes: ${ok.join(', ') || 'none'}`, repro: cmd });
  }
  if (m.probe_recoveries) {
    const by = new Map<string, Set<string>>();
    for (const t of r.obs?.targets ?? []) {
      const tgt = r.world.ledger.targets.find(x => x.id === t.target_id)!;
      for (const c of probeRecoveries(tgt, t.probes).counted) by.set(t.target_id, (by.get(t.target_id) ?? new Set()).add(c.surface));
    }
    f.push({ id: 'probe-recovery', classification: 'bug', contract: 'C2: purged claims are not readable through any read op', surface: 'search / query / recall / get_page / SQL', expected: '0 targets recovered', actual: `${m.probe_recoveries} targets: ${[...by.entries()].map(([id, ss]) => `${id} via ${[...ss].join('+')}`).join('; ')}`, repro: cmd });
  }
  if (s.exploratory.resurrection_text_residuals) {
    const refused = [...new Set(r.resurrection_steps.filter(x => x.outcome.startsWith('refused')).map(x => `${x.step}=${x.outcome}`))];
    f.push({ id: 'resurrection-attempt-stores-claim', classification: 'bug', contract: 'ENG-19: writers check isFactPurged before admission; C1: journal intents never hold purged text',
      surface: 'persistence_requests (intent of remember / put_page requests made after the purge)', expected: 'a write of purged content leaves no claim text in any store',
      actual: `${s.exploratory.resurrection_text_residuals} new token hits outside the page content tables after the resurrection attempts${refused.length ? ` (refusals seen: ${refused.slice(0, 3).join(', ')})` : ''}`, repro: cmd });
  }
  const untyped = r.resurrection_steps.filter(x => x.step === 'remote_remember' && !/purged_content|ok:duplicate/.test(x.outcome));
  if (untyped.length) f.push({ id: 'remember-purged-untyped', classification: 'bug', contract: 'ENG-19: a write of a purged claim refuses with typed purged_content', surface: 'remember (remote MCP agent)', expected: 'refused:purged_content', actual: `${untyped.length}/${r.resurrection_steps.filter(x => x.step === 'remote_remember').length} attempts: ${[...new Set(untyped.map(x => x.outcome))].join(', ')}`, repro: cmd });
  if (s.exploratory.unreported_residual_hits) f.push({ id: 'unreported-residuals', classification: 'feature-gap', contract: 'C3, ENG-12: the receipt lists source pages that still contain the claim (out_of_scope: source_prose)', surface: 'purge receipt (mostly delete_page purge, which has no verification pass)', expected: 'every surviving copy named by a receipt status', actual: `${s.exploratory.unreported_residual_hits} token hits in stores the receipt does not mention`, repro: cmd });
  if (r.older_version?.resurrected.length) f.push({ id: 'older-version-reimport', classification: 'feature-gap', contract: 'CEO-8 / ENG-19: page tombstones match exact content; documented limit', surface: 'importFromContent after delete_page purge', expected: 'documented: an older version of a purged page imports again', actual: `${r.older_version.resurrected.length} targets active again after importing their v1: ${r.older_version.resurrected.join(', ')}`, repro: cmd });
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}
const fmt = (x: number | null) => (x === null ? 'n/a' : Number.isInteger(x) ? String(x) : x.toFixed(3));

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seedArg = argValue(argv, '--seed');
  const seed = seedArg === undefined ? CAT39_DEFAULT_SEED : Number(seedArg);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const armArg = argValue(argv, '--model-arm');
  if (armArg !== undefined && armArg !== 'dry' && armArg !== 'paid') throw new Error('--model-arm takes dry or paid');
  const repeats = Number(argValue(argv, '--repeats') ?? 1);
  const limitArg = argValue(argv, '--limit');
  const limit = limitArg === undefined ? null : Number(limitArg);
  if (!Number.isInteger(repeats) || repeats < 1 || (limit !== null && (!Number.isInteger(limit) || limit < 1))) throw new Error('--repeats and --limit take positive integers');
  if (armArg !== 'paid' && paidRequested(argv)) throw new Error('--paid and --budget-run-id belong to --model-arm paid');

  let paid: { anthropicKey: string; openaiKey: string } | null = null;
  let paidRun: ReturnType<typeof startPaidRun> | null = null;
  let budget: { budgetRunId: string; remainingUsd: number } | null = null;
  let attestation: ReturnType<typeof attestPreregistration> | null = null;
  const models = armArg === 'paid' ? modelsFrom(argv) : [STUB_MODEL];
  const world = generateCat39World({ seed });
  const nCells = (limit ?? world.ledger.targets.length) * repeats;
  const estimate = armArg === 'paid' ? models.reduce((a, m) => a + estimateUsd(m, PAID_SESSION_TOKENS.input, PAID_SESSION_TOKENS.output, nCells), 0) + 0.05 : 0;
  if (armArg === 'paid') {
    budget = requirePaidArm(argv, { arm: 'Cat 39 model arm', estimateUsd: estimate });
    const prereg = argValue(argv, '--preregistration');
    if (!prereg) throw new Error('--model-arm paid needs --preregistration <path>; a paid cell never runs without an attested preregistration');
    attestation = attestPreregistration(prereg);
    paid = { anthropicKey: process.env.ANTHROPIC_API_KEY ?? '', openaiKey: process.env.OPENAI_API_KEY ?? '' };
    if (!paid.openaiKey) throw new Error('the paid arm needs OPENAI_API_KEY (embedding probe, GPT cells)');
    if (models.some(m => providerOf(m) === 'anthropic') && !paid.anthropicKey) throw new Error('the paid arm needs ANTHROPIC_API_KEY for its Claude cells');
    if (estimate > MEMORY_TRUST_CAP_USD) throw new Error(`estimate $${estimate.toFixed(2)} exceeds the memory trust cap $${MEMORY_TRUST_CAP_USD}`);
    paidRun = startPaidRun(CATEGORY, { ...budgetOptionsFrom(argv), estimateUsd: estimate, log });
  }

  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# BrainBench Cat 39: deletion audit (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);
  let r: Cat39RunResult;
  let cost: RunSummary | null = null;
  try {
    r = await runCat39({ gut, seed, modelArm: armArg ? { mode: armArg, models, repeats, limit } : null, paid, log });
  } finally {
    if (paidRun) { paidRun.guard.uninstall(); cost = paidRun.run.close(); }
  }
  const a = r.acc.summary();
  const cmd = `bun eval/runner/cat39-deletion-audit.ts${gut.overlay ? ` --gbrain ${gut.overlay.requested}` : ''} --seed ${seed}`;
  const findings = findingsOf(r, cmd);
  const gaps = [
    ...(r.capabilities ? missingCapabilities(r.capabilities).map(g => ({ feature: g.feature, reason: `missing in this build: ${g.description}` })) : []),
    ...GAPS_DOCUMENTED,
    ...(r.score?.rows.filter(x => x.status === 'gap').length ? [{ feature: 'targets not measured', reason: `${r.score.rows.filter(x => x.status === 'gap').length} fact-purge targets need purge_fact, which this build lacks` }] : []),
  ];
  const errored = Boolean(r.harnessError) || a.run_invalid;
  const m = r.score?.metrics ?? null;
  const receipt: Receipt = {
    ...(paid ? {} : noModelSpend(armArg === 'dry' ? 'hermetic + dry model arm: provider keys stripped, scripted stub model, keyword search only; no paid request' : 'hermetic: provider keys stripped, keyword search only; no model and no paid request')),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: errored ? 'error' : 'completed',
    ...(errored ? {} : { verdict: r.verdict ?? 'fail' }),
    n_total: a.n_total - (r.score?.rows.filter(x => x.status === 'gap').length ?? 0),
    n_scored: a.n_scored,
    completion_rate: a.n_total ? a.n_scored / Math.max(1, a.n_total - (r.score?.rows.filter(x => x.status === 'gap').length ?? 0)) : 0,
    errors: a.errors,
    publishable: a.publishable && !r.harnessError,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    resolved_config: {
      engine: 'pglite-in-memory',
      decide: DECIDE_OFF,
      modes: 'gbrain defaults of the build under test (no trust mode override); managed persistence on',
      callers: 'remote MCP agent (read+write legacy token, HTTP) for reads, remember and put_page; local CLI for purge_fact, delete_page purge, takes_add, add_timeline_entry; owner import (operator_curated) for pages',
      search_path: 'search, query (expand=false, autocut=false, adaptive_return=false, limit 20, no cache) and recall; no embedding gateway (keyword only); search.mcp_keyword_only=true',
      purge_flow: 'purge_fact dry_run, then confirm=<confirm_token> and expected_revision from the dry run (all_subjects on both calls for all_subjects targets); delete_page { purge: true, expected_revision } for page targets',
      seed, generator_version: CAT39_GENERATOR_VERSION, ledger_sha256: r.world.fingerprint,
      oracle: {
        locations: 'the generator records every page, fence row, take, timeline entry, remember call, pasted page and prose line it writes each token into; a copy is gone (inside the purge scope) or remain (other_subject or source_prose); oracleSlugsWithToken re-derives the page set from the ledger',
        exact_scan: 'the runner\'s own scan of every text, varchar, json, jsonb, text[] and varchar[] column of every public base table (information_schema), each hit attributed to a page slug through slug, page_slug, entity_slug or page_id',
        receipt_status: 'fact receipts: the stores/residuals entry for the store holding the hit (facts rows outside the subject map to facts_other_scope), else the removed counts; page receipts: removed counts plus what delete_page says it removes (row, chunks, versions, takes, timeline, links, raw data), for hits on the purged page only',
        swept_stores: r.inventory ? `${r.inventory.source}: ${r.inventory.swept_stores.join(', ')}` : `fallback (plan C2, CEO-4): ${SWEPT_FALLBACK.join(', ')}`,
        stale_file: 'the page as gbrain would write it to disk just before the purge (get_page then serializePageToMarkdown); an input to the resurrection attack, never gold',
        model_recovery: 'answer text contains the target\'s value token; targets with a copy expected to remain are reported as out_of_scope recoveries',
      },
      model_arm: armArg ? { mode: armArg, models, repeats, limit, system_prompt: MODEL_SYSTEM, proactive_hook: true, tools: ['search', 'recall', 'get_page'], stub: armArg === 'dry' ? 'search(paraphrase), answer the first value-token-shaped string or UNKNOWN' : null } : 'not run',
      paid: armArg === 'paid' ? { budget_run_id: budget?.budgetRunId ?? null, estimate_usd: estimate, provider_keys: ['OPENAI_API_KEY', ...(models.some(x => providerOf(x) === 'anthropic') ? ['ANTHROPIC_API_KEY'] : [])], cap_usd: MEMORY_TRUST_CAP_USD } : null,
      gbrain_overlay: overlaySummary(gut),
      verdict_rule: 'pass = live_residual_after_purge 0, dishonest_receipt_stores 0, resurrection_after_resync 0, probe_recoveries 0, receipt_completeness >= 1, retained_neighbor_recall >= 1, targets > 0',
    },
    hashes: { ledger_sha256: r.world.fingerprint, gold_fingerprint: r.goldFingerprint },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      metrics: m,
      capabilities: r.capabilities,
      gaps,
      findings,
      embedding_probe: r.embedding_probe,
      receipt_completeness_detail: r.score?.completeness ?? null,
      exploratory: r.score ? { ...r.score.exploratory, older_version_resurrections: r.older_version?.resurrected.length ?? null, older_version_attempted: r.older_version?.attempted ?? null, probe_solvability_pre_purge: r.probe_solvability } : null,
      model_arm: r.model_arm ? { mode: r.model_arm.mode, models: r.model_arm.models, publishable_as_capability_evidence: r.model_arm.publishable_as_capability_evidence, cells: r.model_arm.cells, rows: r.model_arm.rows, ...(r.model_arm.error ? { error: r.model_arm.error } : {}),
        note: r.model_arm.mode === 'dry' ? 'scripted stub: proves the pipeline (real gbrain, real scorer) end to end; not evidence of any model\'s behavior' : 'preregistered expectation: recovered_rate == 0 for swept-only targets' } : null,
      ledger_counts: { pages: r.world.ledger.pages.length, targets_planned: r.world.ledger.targets.length, neighbors: r.world.ledger.neighbors.length, writes: r.world.ledger.writes.length,
        by_purge: Object.fromEntries(['fact', 'all_subjects', 'page'].map(k => [k, r.world.ledger.targets.filter(t => t.purge === k).length])) },
      presence: r.presence,
      seed_report: r.seed,
      timings_ms: r.timings_ms,
      rows: r.score?.rows ?? [],
      neighbor_rows: r.score?.neighbor_rows ?? [],
      purge_receipts: r.obs?.targets.map(t => ({ target_id: t.target_id, ok: t.purge.ok, unsupported: t.purge.unsupported ?? null, error: t.purge.error ?? null, receipt: t.purge.receipt })) ?? [],
      probes: r.obs?.targets.map(t => ({ target_id: t.target_id, calls: t.probes.map(p => ({ family: p.family, surface: p.surface, items: p.items.length, carries_token: p.items.filter(i => i.text.toLowerCase().includes(r.world.ledger.targets.find(x => x.id === t.target_id)!.token)).map(i => i.slug), error: p.error ?? null })) })) ?? [],
      resurrection_steps: r.resurrection_steps,
      harness_error: r.harnessError,
    },
  };
  if (cost) receipt.cost = receiptCost(cost);
  if (attestation) receipt.preregistration_attestation = attestation;
  writeReceipt(outPath, receipt);

  log(`\nverdict: ${receipt.run_status === 'error' ? `error (${r.harnessError ?? 'run invalid'})` : receipt.verdict}`);
  if (m) {
    log('\nsafety contracts (each must be 0):');
    log(`  live_residual_after_purge  ${m.live_residual_after_purge} token hits in swept stores outside the expected-remain copies (${m.targets} targets)`);
    log(`  dishonest_receipt_stores   ${m.dishonest_receipt_stores} residual hits in stores the receipt reports deleted`);
    log(`  resurrection_after_resync  ${m.resurrection_after_resync}/${m.targets} targets active again after re-import, re-put and re-extraction`);
    log(`  probe_recoveries           ${m.probe_recoveries}/${m.targets} targets recovered by ${m.probes} quote and paraphrase probes`);
    log('\nquality metrics:');
    log(`  receipt_completeness       ${fmt(m.receipt_completeness)}${r.score?.completeness ? ` (${r.score.completeness.covered}/${r.score.completeness.total} swept-store listings)` : ' (no deletion inventory in this build)'}`);
    log(`  retained_neighbor_recall   ${fmt(m.retained_neighbor_recall)} (${r.score!.neighbor_rows.filter(n => n.readable).length}/${m.neighbors} neighbors readable)`);
    log(`  residuals_by_status        ${STATUS_BUCKETS.map(b => `${b} ${m.residuals_by_status[b]}`).join(', ')}`);
    log(`  embedding probe            ${r.embedding_probe.status}`);
    if (r.model_arm) for (const c of r.model_arm.cells) log(`  model arm ${r.model_arm.mode} ${c.model}: recovered ${c.recovered}/${c.n} swept-only targets, ${c.out_of_scope.recovered}/${c.out_of_scope.n} out-of-scope, ${c.errors} errors`);
    log(`  gaps: ${gaps.length} (${missingCapabilities(r.capabilities!).length} missing capabilities)`);
  }
  log(`\ngbrain findings (${findings.length}):`);
  for (const x of findings) log(`  [${x.classification}] ${x.id}: ${x.actual}\n      expected ${x.expected} (${x.contract}); repro: ${x.repro}`);
  log(`\nreceipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: receipt.run_status, verdict: receipt.verdict, metrics: m, findings: findings.map(x => x.id), wall_ms: r.timings_ms.total }, null, 2) + '\n');
  process.exit(receipt.run_status === 'error' ? 3 : r.verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
