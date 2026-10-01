#!/usr/bin/env bun
/**
 * BrainBench N5: forgetting and withdrawal residue, through the lifecycle
 * harness (eval-category wave amendments 2 and 5).
 *
 * The contract under test is the documented one (src/core/facts/forget.ts
 * header; docs/guides/memory-boundaries.md): `forget` withdraws a claim from
 * active recall, the withdrawal survives reimport and restart, it is scoped
 * to the subject and source, and a corrected claim is the way back (the
 * exact claim is refused). Original prose, page history, files and backups
 * may keep the text by design; withdrawal matches claims lexically, so a
 * paraphrase stays active. Those are reported as documented non-guarantees,
 * never as failures.
 *
 * Per cell (engine x transport, lifecycle/slice.ts):
 *   witness         every canary is read in every active tier before any
 *                   forget (a pair not witnessed carries no signal);
 *   immediate       right after the forgets, the corrected claims and the
 *                   refused repeat;
 *   settled         after the vault is committed and an incremental sync;
 *   stale_reimport  after the pre-forget files are restored and fully
 *                   re-synced, and an agent writes back a stale page body;
 *   restart         after the server (or CLI session) restarts;
 *   concurrent      after new claims and two late forgets run concurrently.
 * Active tiers: recall facts, recall query arm, search, query, context_pack,
 * the unstruck fence row in get_page, and the entity card. On mcp-http cells
 * a read-only and a foreign-source OAuth client also try to forget.
 *
 * Hermetic: keys stripped, fresh GBRAIN_HOME per cell, no embedding model,
 * System One off. Dream-derived tiers (synthesis, consolidation into takes)
 * need a chat model and are reported as unmeasured. Gating metrics
 * (data.metrics) aggregate the PGLite cells; Postgres cells are report-only
 * (data.metrics_postgres).
 *
 * Usage: bun eval/runner/n5-forget-residue.ts [--seed N] [--output <dir>] [--gbrain <checkout>[@ref]]
 *          [--engines pglite,postgres] [--interfaces cli,mcp-stdio,mcp-http] [--pg-url <url>] [--concurrency N] [--json]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gbrainSpecFrom, overlaySummary, productIdentityFor, resolveGbrainUnderTest, type GbrainUnderTest } from './gbrain-under-test.ts';
import { gbrainPin } from './gbrain-version.ts';
import { DECIDE_OFF, withHermeticEnv } from './hermetic-env.ts';
import type { Driver } from './lifecycle/drivers.ts';
import {
  fenceRowTokens, pairKey, scoreN5, sumN5,
  type AuthorityAttempt, type CheckpointObs, type N5Metrics, type N5Score, type RememberOutcome,
} from './lifecycle/n5-score.ts';
import { ENGINES, IFACES, SliceCell, asRows, postgresReachable, runMatrix, type Engine, type Iface } from './lifecycle/slice.ts';
import { registryEntry } from '../registry.ts';
import { evaluatePromotion } from './promotion.ts';
import { BENCHMARK_VERSION, RECEIPT_SCHEMA_VERSION, latencySummary, noModelSpend, receiptPath, sourceTreeIdentity, writeReceipt, type Receipt } from './receipt.ts';
import {
  ACTIVE_TIERS, CHECKPOINTS, N5_DEFAULT_SEED, N5_GENERATOR_VERSION, generateN5World, isForgottenAt, privateTokens, renderInitialPage, writtenBy,
  type ActiveTier, type Canary, type N5Checkpoint, type N5Ledger, type N5World,
} from '../generators/n5-forget-residue-gen.ts';

export const CATEGORY = 'n5-forget-residue';

export const NON_GUARANTEES: ReadonlyArray<{ item: string; source: string }> = [
  { item: 'semantic paraphrase retraction', source: 'withdrawal fingerprints fold case, whitespace and listed punctuation only (src/core/facts/withdrawal-schema.ts); a paraphrase has a different fingerprint' },
  { item: 'physical erasure of page history (get_versions), vault Git history, files and backups', source: 'src/core/facts/forget.ts header: "These are retractions: original prose, files and backups may retain text"; docs/guides/memory-boundaries.md' },
  { item: 'prose outside the Facts fence', source: 'src/core/facts/forget.ts header; the chunker drops forgotten fence rows only (src/core/remote-body.ts)' },
  { item: 'struck fence rows', source: 'forget strikes the row with a "forgotten:" marker and keeps it as the audit trail (src/core/facts/withdrawal-overlay.ts)' },
];

export const UNMEASURED: ReadonlyArray<{ tier: string; reason: string }> = [
  { tier: 'dream synthesis and consolidation (takes, synthesized pages)', reason: 'these phases call a chat model; the hermetic arm strips every key and no fake chat endpoint was wired for this slice, so they were not run. The capability matrix lists them as tiers forget does not touch (a gap, not scored).' },
  { tier: 'think', reason: 'keyless think returns the gather only, with no synthesized answer; not probed.' },
  { tier: 'ontology and timeline rows', reason: 'forget does not write to them (capability matrix, N5); the canaries here are not written there.' },
];

// ─── Observation ─────────────────────────────────────────────────────────

export interface N5Observation { obs: CheckpointObs; struck: Array<{ canary: string; entity: string }>; entityCounts: Record<string, number | null> }

const errorOf = (e: string | undefined) => ({ error: e ?? 'no data' });

/** Observe every (canary, tier) pair for `canaries` through `d`. */
export async function observeN5(d: Driver, ledger: N5Ledger, canaries: readonly Canary[], cp: N5Checkpoint): Promise<N5Observation> {
  const obs: CheckpointObs = new Map();
  const struck: N5Observation['struck'] = [];
  const entityCounts: Record<string, number | null> = {};
  const live = canaries.filter(c => writtenBy(c, cp));
  const entities = [...new Set(live.map(c => c.entity))];
  const set = (c: Canary, t: ActiveTier, v: { present: boolean } | { error: string }) => obs.set(pairKey(c.id, t), v);
  // context_pack first: its hot facts come from a short-lived server cache, so a later read could hide a stale entry.
  const pack = await d.call('context_pack', { entities: ledger.entities.map(e => e.slug).join(','), include_private: true });
  const packText = pack.ok ? String((pack.data as Record<string, unknown>)?.text ?? '') : '';
  const packFacts = asRows(pack.data, ['facts']);
  for (const c of live) {
    const inText = packText.split('\n').some(l => l.includes(c.token) && l.includes(`[${c.entity}]`));
    const inFacts = packFacts.some(f => String(f.fact ?? '').includes(c.token) && f.entity_slug === c.entity);
    set(c, 'context_pack', pack.ok ? { present: inText || inFacts } : errorOf(pack.error));
  }
  for (const entity of entities) {
    const mine = live.filter(c => c.entity === entity);
    const r = await d.call('recall', { entity, limit: 100 });
    const facts = asRows(r.data, ['facts']).filter(f => f.expired_at == null).map(f => String(f.fact ?? ''));
    for (const c of mine) set(c, 'recall_facts', r.ok ? { present: facts.some(f => f.includes(c.token)) } : errorOf(r.error));
    const g = await d.call('get_page', { slug: entity });
    const body = g.ok && g.data && typeof g.data === 'object' ? String((g.data as Record<string, unknown>).compiled_truth ?? '') : '';
    const rows = fenceRowTokens(body);
    for (const c of mine) {
      set(c, 'fence_active', g.ok ? { present: rows.unstruck.has(c.token) } : errorOf(g.error));
      if (rows.struck.has(c.token)) struck.push({ canary: c.id, entity });
    }
    const e = await d.call('entity', { name: entity });
    const card = e.ok ? JSON.stringify(e.data) : '';
    entityCounts[entity] = e.ok ? Number(((e.data as Record<string, unknown>)?.card as Record<string, unknown> | undefined)?.active_fact_count ?? NaN) : null;
    for (const c of mine) set(c, 'entity_card', e.ok ? { present: card.includes(c.token) } : errorOf(e.error));
  }
  const tokens = [...new Set(live.map(c => c.token))];
  for (const token of tokens) {
    const owners = live.filter(c => c.token === token);
    const asks: Array<[ActiveTier, string, Record<string, unknown>, string[]]> = [
      ['search', 'search', { query: token, limit: 20 }, []],
      ['query', 'query', { query: token, limit: 20 }, ['results']],
      ['recall_query', 'recall', { query: token, limit: 20 }, ['results']],
    ];
    for (const [tier, op, args, keys] of asks) {
      const r = await d.call(op, args);
      const hits = asRows(r.data, keys).filter(x => JSON.stringify(x).includes(token)).map(x => String(x.slug ?? x.page_slug ?? ''));
      for (const c of owners) set(c, tier, r.ok ? { present: hits.includes(c.entity) } : errorOf(r.error));
    }
  }
  return { obs, struck, entityCounts };
}

/** Merge two observations (primary for world canaries, trusted for private ones on remote cells). */
function merge(a: N5Observation, b: N5Observation | null): N5Observation {
  if (!b) return a;
  return { obs: new Map([...a.obs, ...b.obs]), struck: [...a.struck, ...b.struck], entityCounts: { ...b.entityCounts, ...a.entityCounts } };
}

// ─── One cell ────────────────────────────────────────────────────────────

export interface N5CellOutcome {
  id: string;
  engine: Engine;
  interface: Iface;
  duration_ms: number;
  fatal?: string;
  void_reason?: string;
  server_version: string;
  decide: SliceCell['decideOff'];
  writes: Array<{ step: string; canary?: string; target?: string; ok: boolean; status?: string; error?: string }>;
  fact_ids: Record<string, string>;
  forgets: Array<{ canary: string; caller: string; ok: boolean; error?: string; checkpoint: string }>;
  checkpoints: Partial<Record<N5Checkpoint, Record<string, boolean | string>>>;
  struck_by_design: number;
  paraphrase: Array<{ canary: string; relates_to: string; active_after_forget: boolean | null }>;
  concurrent_writes: RememberOutcome[];
  concurrent_visible: number;
  retained_by_design: { page_history_tokens: number; vault_git_tokens: number; prose_chunk_hits: number };
  entity_counts: Partial<Record<N5Checkpoint, Record<string, number | null>>>;
  authority: AuthorityAttempt[];
  /** Remote responses whose MCP `_meta.brain_hot_memory` carried a canary after its forget returned. */
  meta_residue: { responses: number; canaries: string[]; witnessed_before_forget: string[]; evidence: Array<{ op: string; canary: string; after_forget_calls: number }> };
  score: N5Score | null;
  private_canary_leaks: number;
  leak_evidence: Array<{ op: string; caller: string; token: string; excerpt: string }>;
  calls: { primary: number; trusted: number; extra: number; primary_ms: number[] };
  operator: SliceCell['operatorLog'];
}

async function rememberCanary(d: Driver, c: Canary): Promise<RememberOutcome> {
  const r = await d.call('remember', { fact: c.claim, entity: c.entity, provenance: 'n5-ledger', visibility: c.visibility });
  const data = (r.data && typeof r.data === 'object' ? r.data : {}) as Record<string, unknown>;
  return { canary: c.id, ok: r.ok, status: String(data.status ?? (r.ok ? 'unknown' : 'error')), ...(r.ok ? {} : { error: r.error?.slice(0, 300) }) };
}

async function writePage(d: Driver, slug: string, content: string) {
  const current = await d.call('get_page', { slug, include_content: true });
  const revision = current.ok && current.data && typeof current.data === 'object' ? (current.data as Record<string, unknown>).revision : undefined;
  return d.call('put_page', typeof revision === 'string' ? { slug, content, expected_revision: revision } : { slug, content });
}

async function runCell(world: N5World, gut: GbrainUnderTest, engine: Engine, iface: Iface, opts: { work: string; pgAdminUrl: string; port: number; log: (s: string) => void }): Promise<N5CellOutcome> {
  const t0 = Date.now();
  const { ledger } = world;
  const cell = new SliceCell({
    buildDir: gut.root, engine, iface, work: opts.work, label: 'n5', pgAdminUrl: opts.pgAdminUrl, port: opts.port, extraSources: ['other'],
    extraClients: [{ name: 'reader', scopes: 'read', source: 'vault' }, { name: 'foreign', scopes: 'read write', source: 'other' }],
  });
  const out: N5CellOutcome = {
    id: cell.id, engine, interface: iface, duration_ms: 0, server_version: '', decide: cell.decideOff, writes: [], fact_ids: {}, forgets: [], checkpoints: {},
    struck_by_design: 0, paraphrase: [], concurrent_writes: [], concurrent_visible: 0, retained_by_design: { page_history_tokens: 0, vault_git_tokens: 0, prose_chunk_hits: 0 },
    entity_counts: {}, authority: [], meta_residue: { responses: 0, canaries: [], witnessed_before_forget: [], evidence: [] }, score: null, private_canary_leaks: 0, leak_evidence: [], calls: { primary: 0, trusted: 0, extra: 0, primary_ms: [] }, operator: cell.operatorLog,
  };
  const world_ = (c: Canary) => c.visibility === 'world';
  const priv = (c: Canary) => c.visibility === 'private';
  const checkpoints: Partial<Record<N5Checkpoint, CheckpointObs>> = {};
  const corrected: RememberOutcome[] = [];
  const repeats: RememberOutcome[] = [];
  const secret = privateTokens(ledger);
  const observe = async (cp: N5Checkpoint) => {
    const primarySet = ledger.canaries.filter(c => !cell.remote || world_(c));
    const a = await observeN5(cell.primary, ledger, primarySet, cp);
    const b = cell.remote ? await cell.trusted(d => observeN5(d, ledger, ledger.canaries.filter(priv), cp)) : null;
    const m = merge(a, b);
    checkpoints[cp] = m.obs;
    out.entity_counts[cp] = m.entityCounts;
    out.checkpoints[cp] = Object.fromEntries([...m.obs].map(([k, v]) => [k, 'present' in v ? v.present : `error: ${v.error}`]));
    if (cp !== 'witness') out.struck_by_design += m.struck.filter(s => isForgottenAt(ledger.canaries.find(c => c.id === s.canary)!, cp)).length;
    opts.log(`[n5] ${cell.id} ${cp}: ${[...m.obs.values()].filter(v => 'present' in v && v.present).length} present of ${m.obs.size} pairs`);
    return m;
  };
  const forgottenAt = new Map<string, number>();
  let forgetStartIndex = Number.MAX_SAFE_INTEGER;
  const forget = async (c: Canary, cp: string, d?: Driver) => {
    const id = out.fact_ids[c.id];
    if (!id) { out.forgets.push({ canary: c.id, caller: 'none', ok: false, error: 'no fact id was witnessed', checkpoint: cp }); return; }
    const run = async (drv: Driver, caller: string) => {
      const r = await drv.call('forget', { id, reason: 'n5 withdrawal' });
      out.forgets.push({ canary: c.id, caller, ok: r.ok, ...(r.ok ? {} : { error: r.error?.slice(0, 300) }), checkpoint: cp });
      if (r.ok && !forgottenAt.has(c.id)) forgottenAt.set(c.id, cell.calls.length);
    };
    // A private fact is withdrawn by the trusted local caller, who is the one able to see it.
    if (priv(c)) await cell.trusted(drv => run(drv, 'trusted'));
    else await run(d ?? cell.primary, 'primary');
  };

  try {
    await cell.setup();
    out.server_version = cell.serverVersion;
    if (!cell.decideOff.ok) { out.void_reason = `System One is not provably off in this cell: ${cell.decideOff.error ?? JSON.stringify(cell.decideOff.slots.filter(s => s.effective !== 'off'))}`; return out; }

    for (const e of ledger.entities) {
      const r = await writePage(cell.primary, e.slug, renderInitialPage(ledger, e));
      out.writes.push({ step: 'initial-page', target: e.slug, ok: r.ok, ...(r.ok ? {} : { error: r.error?.slice(0, 300) }) });
    }
    for (const c of ledger.canaries.filter(x => x.via === 'remember' && ['forgotten', 'retained', 'late-forgotten', 'paraphrase'].includes(x.role))) {
      const r = priv(c) && cell.remote ? await cell.trusted(d => rememberCanary(d, c)) : await rememberCanary(cell.primary, c);
      out.writes.push({ step: 'remember', canary: c.id, ok: r.ok, status: r.status, ...(r.error ? { error: r.error } : {}) });
    }

    // Witness, and learn each canary's fact id from the trusted caller.
    const witness = await observe('witness');
    const ids = await cell.trusted(async d => {
      const found: Record<string, string> = {};
      for (const e of ledger.entities) {
        const r = await d.call('recall', { entity: e.slug, limit: 100 });
        for (const f of asRows(r.data, ['facts'])) {
          for (const c of ledger.canaries.filter(x => x.entity === e.slug && String(f.fact ?? '').includes(x.token) && f.expired_at == null)) found[c.id] = String(f.fact_id ?? f.id);
        }
      }
      return found;
    });
    Object.assign(out.fact_ids, ids);
    const core = ledger.canaries.filter(c => ['forgotten', 'retained', 'late-forgotten'].includes(c.role));
    const unseen = core.filter(c => !(witness.obs.get(pairKey(c.id, 'recall_facts')) as { present?: boolean } | undefined)?.present);
    if (unseen.length) { out.void_reason = `Presence check failed: ${unseen.length} of ${core.length} canaries were not in recall before the forget, so a residue of 0 would mean nothing. First: ${unseen[0].id} on ${unseen[0].entity}`; return out; }
    cell.commitVaults('n5 witnessed state');
    const preForget = Object.fromEntries(ledger.entities.map(e => {
      const f = join(cell.vaults.vault, `${e.slug}.md`);
      return [e.slug, existsSync(f) ? readFileSync(f, 'utf8') : null];
    }));

    // Forget, then the documented way back (a corrected claim) and the documented refusal (the exact claim).
    // A context_pack right before the forgets warms the server's hot-memory cache, as an agent's session start would.
    await cell.primary.call('context_pack', { entities: ledger.entities.map(e => e.slug).join(','), include_private: true });
    forgetStartIndex = cell.calls.length;
    for (const c of ledger.canaries.filter(x => x.role === 'forgotten')) await forget(c, 'immediate');
    for (const c of ledger.canaries.filter(x => x.role === 'corrected')) corrected.push(await rememberCanary(cell.primary, c));
    for (const id of ledger.repeats) repeats.push(await rememberCanary(cell.primary, ledger.canaries.find(c => c.id === id)!));
    const immediate = await observe('immediate');
    for (const p of ledger.canaries.filter(c => c.role === 'paraphrase')) {
      const o = immediate.obs.get(pairKey(p.id, 'recall_facts'));
      out.paraphrase.push({ canary: p.id, relates_to: p.relates_to!, active_after_forget: o && 'present' in o ? o.present : null });
    }

    cell.commitVaults('n5 after forget');
    await cell.maintenance('settle-sync', ['sync', '--source', 'vault', '--no-pull']);
    await observe('settled');

    // Stale reimport: restore the pre-forget files and fully re-sync; an agent also writes back a stale body.
    for (const [slug, text] of Object.entries(preForget)) if (text !== null) writeFileSync(join(cell.vaults.vault, `${slug}.md`), text);
    cell.commitVaults('n5 restore pre-forget files');
    await cell.maintenance('stale-reimport-sync', ['sync', '--source', 'vault', '--full', '--no-pull']);
    const staleTarget = ledger.entities[0].slug;
    if (preForget[staleTarget]) {
      const r = await writePage(cell.primary, staleTarget, preForget[staleTarget]!);
      out.writes.push({ step: 'stale-put-page', target: staleTarget, ok: r.ok, ...(r.ok ? {} : { error: r.error?.slice(0, 300) }) });
    }
    await observe('stale_reimport');

    await cell.restart();
    // Authority: a read-only client and a foreign-source client try to forget retained canaries (HTTP only).
    for (const [client, target] of [['reader', ledger.authority_targets[0]], ['foreign', ledger.authority_targets[1]]] as const) {
      const d = await cell.extraClient(client);
      if (!d) continue;
      const id = out.fact_ids[target];
      const r = await d.call('forget', { id, reason: 'n5 unauthorized attempt' });
      out.authority.push({ client, target, call_ok: r.ok, still_active: null, ...(r.ok ? {} : { error: r.error?.slice(0, 300) }) });
    }
    const restart = await observe('restart');
    for (const a of out.authority) {
      const o = restart.obs.get(pairKey(a.target, 'recall_facts'));
      a.still_active = o && 'present' in o ? o.present : null;
    }

    // Concurrent: new claims (including the forgotten claim's exact text on another entity) while two late forgets run.
    const newbies = ledger.canaries.filter(c => c.role === 'concurrent' || c.role === 'twin-concurrent');
    const late = ledger.canaries.filter(c => c.role === 'late-forgotten');
    const results = await Promise.all([...newbies.map(c => rememberCanary(cell.primary, c)), ...late.map(c => forget(c, 'concurrent').then(() => null))]);
    out.concurrent_writes = results.filter((x): x is RememberOutcome => x !== null);
    // A refused write is retried once by the client; durability is owed only to acknowledged writes.
    for (const [k, r] of out.concurrent_writes.entries()) {
      if (r.ok) continue;
      const again = await rememberCanary(cell.primary, newbies[k]);
      if (again.ok) out.concurrent_writes[k] = { ...again, status: `${again.status} (after retry)` };
    }
    for (const c of late) if (!out.forgets.some(f => f.canary === c.id && f.ok)) await forget(c, 'concurrent-retry');
    const conc = await observe('concurrent');
    out.concurrent_visible = newbies.filter(c => { const o = conc.obs.get(pairKey(c.id, 'recall_facts')); return o && 'present' in o && o.present; }).length;

    // Retained by design: page history and vault Git history still carry forgotten claims.
    const forgottenTokens = ledger.canaries.filter(c => c.role === 'forgotten').map(c => c.token);
    const history = await cell.trusted(async d => {
      let n = 0;
      for (const e of ledger.entities) { const r = await d.call('get_versions', { slug: e.slug }); n += forgottenTokens.filter(t => r.raw.includes(t)).length; }
      return n;
    });
    const gitLog = execFileSync('git', ['-C', cell.vaults.vault, 'log', '-p', '--all'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const prose = ledger.canaries.find(c => c.in_prose)!;
    out.retained_by_design = {
      page_history_tokens: history,
      vault_git_tokens: forgottenTokens.filter(t => gitLog.includes(t)).length,
      prose_chunk_hits: ['search', 'query', 'recall_query'].filter(t => { const o = conc.obs.get(pairKey(prose.id, t as ActiveTier)); return o && 'present' in o && o.present; }).length,
    };
  } catch (e) {
    out.fatal = `${(e as Error).stack ?? String(e)}${cell.remote ? `\n[server stderr tail]\n${cell.stderrTail().join('\n')}` : ''}`;
  } finally {
    await cell.close();
    const remoteCalls = cell.remote ? cell.calls.filter(c => c.caller !== 'trusted') : [];
    if (cell.remote) {
      const seen = new Set<string>();
      const before = new Set<string>();
      cell.calls.forEach((call, i) => {
        if (call.caller === 'trusted' || !call.meta) return;
        const facts = (() => { try { return (JSON.parse(call.meta) as { brain_hot_memory?: { facts?: Array<{ fact?: string; entity_slug?: string }> } }).brain_hot_memory?.facts ?? []; } catch { return []; } })();
        let carried = false;
        for (const c of ledger.canaries) {
          if (!facts.some(f => String(f.fact ?? '').includes(c.token) && f.entity_slug === c.entity)) continue;
          const at = forgottenAt.get(c.id);
          if (at === undefined) { if (i < forgetStartIndex && (c.role === 'forgotten' || c.role === 'late-forgotten')) before.add(c.id); continue; }
          if (i < at) continue;
          carried = true;
          seen.add(c.id);
          if (out.meta_residue.evidence.length < 12) out.meta_residue.evidence.push({ op: call.op, canary: c.id, after_forget_calls: i - at });
        }
        if (carried) out.meta_residue.responses++;
      });
      out.meta_residue.canaries = [...seen].sort();
      out.meta_residue.witnessed_before_forget = [...before].sort();
    }
    for (const c of remoteCalls) {
      const text = c.raw + (c.meta ?? '');
      const tok = secret.find(t => text.includes(t));
      if (!tok) continue;
      out.private_canary_leaks++;
      if (out.leak_evidence.length < 10) { const i = text.indexOf(tok); out.leak_evidence.push({ op: c.op, caller: c.caller, token: tok, excerpt: text.slice(Math.max(0, i - 160), i + 60) }); }
    }
    const primary = cell.calls.filter(c => c.caller === 'primary');
    out.calls = { primary: primary.length, trusted: cell.calls.filter(c => c.caller === 'trusted').length, extra: cell.calls.filter(c => c.caller === 'extra').length, primary_ms: primary.map(c => c.ms) };
    if (!out.fatal && !out.void_reason) {
      out.score = scoreN5({ ledger, observable: () => true, checkpoints, corrected, repeats, concurrent: out.concurrent_writes, authority: out.authority, private_canary_leaks: out.private_canary_leaks });
    }
    out.duration_ms = Date.now() - t0;
  }
  return out;
}

// ─── Receipt ─────────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at >= 0) return argv[at + 1];
  return argv.find(a => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

export function aggregateN5(cells: readonly N5CellOutcome[]): N5Metrics & { cells: number; void_cells: number } {
  return { ...sumN5(cells.filter(c => c.score).map(c => c.score!.metrics)), cells: cells.length, void_cells: cells.filter(c => c.fatal || c.void_reason).length };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = json ? () => {} : (s: string) => console.log(s);
  const seed = Number(argValue(argv, '--seed') ?? N5_DEFAULT_SEED);
  if (!Number.isInteger(seed)) throw new Error('--seed needs an integer');
  const engines = (argValue(argv, '--engines') ?? 'pglite,postgres').split(',') as Engine[];
  const ifaces = (argValue(argv, '--interfaces') ?? IFACES.join(',')).split(',') as Iface[];
  for (const e of engines) if (!ENGINES.includes(e)) throw new Error(`--engines takes ${ENGINES.join(',')}, not ${e}`);
  for (const i of ifaces) if (!IFACES.includes(i)) throw new Error(`--interfaces takes ${IFACES.join(',')}, not ${i}`);
  const pgAdminUrl = argValue(argv, '--pg-url') ?? process.env.LIFECYCLE_PG_URL ?? 'postgres://postgres@127.0.0.1:55432/postgres';
  const concurrency = Number(argValue(argv, '--concurrency') ?? '3');
  const output = argValue(argv, '--output');
  const outPath = output ? join(output, 'receipt.json') : receiptPath(CATEGORY);
  const work = resolve(argValue(argv, '--work') ?? join('eval/reports', CATEGORY, 'cells'));
  mkdirSync(work, { recursive: true });
  const startedAt = new Date().toISOString();
  const gut = resolveGbrainUnderTest(gbrainSpecFrom(argv));
  log(`# BrainBench N5: forgetting and withdrawal residue (gbrain ${gut.version}${gut.overlay ? `, overlay ${gut.overlay.build.commit.slice(0, 7)}` : ', pinned'})`);

  const world = generateN5World({ seed });
  const result = await withHermeticEnv('n5', async () => {
    const pgDown = engines.includes('postgres') ? await postgresReachable(pgAdminUrl) : null;
    const runEngines = engines.filter(e => e !== 'postgres' || !pgDown);
    const cells = await runMatrix(runEngines, ifaces, concurrency, 47400, (engine, iface, port) => {
      log(`[n5] start ${engine}/${iface}`);
      return runCell(world, gut, engine, iface, { work, pgAdminUrl, port, log }).then(c => { log(`[n5] done ${c.id} in ${Math.round(c.duration_ms / 1000)}s${c.fatal ? ` FATAL ${c.fatal.split('\n')[0]}` : c.void_reason ? ` VOID ${c.void_reason}` : ''}`); return c; });
    });
    return { cells, pgDown };
  });

  const pglite = result.cells.filter(c => c.engine === 'pglite');
  const postgres = result.cells.filter(c => c.engine === 'postgres');
  const metrics = aggregateN5(pglite);
  const metricsPg = postgres.length ? aggregateN5(postgres) : null;
  const entry = registryEntry('N5')!;
  const pgliteVoid = pglite.length === 0 || pglite.some(c => c.fatal || c.void_reason);
  const runStatus = pgliteVoid ? 'error' : 'completed';
  const safety = {
    prohibited_active_outputs: metrics.prohibited_active_outputs === 0,
    reactivations: metrics.reactivations === 0,
    collateral_expirations: metrics.collateral_expirations === 0,
    unauthorized_forgets_applied: metrics.unauthorized_forgets_applied === 0,
    private_canary_leaks: metrics.private_canary_leaks === 0,
  };
  const quality = {
    retained_recall: { value: metrics.retained_recall, threshold: 1, pass: metrics.retained_recall === 1 },
    reinstatement_rate: { value: metrics.reinstatement_rate, threshold: 1, pass: metrics.reinstatement_rate === 1 },
  };
  const verdict = Object.values(safety).every(Boolean) ? 'pass' : 'fail';
  const harnessErrors = result.cells.filter(c => c.fatal || c.void_reason).map(c => ({ probe_id: c.id, origin: 'harness' as const, message: (c.void_reason ?? c.fatal ?? '').slice(0, 500) }));
  const nPairs = pglite.reduce((n, c) => n + Object.values(c.checkpoints).reduce((m, cp) => m + Object.keys(cp ?? {}).length, 0), 0);
  const sumBy = (cells: readonly N5CellOutcome[], key: 'by_tier' | 'by_checkpoint') => {
    const outAgg: Record<string, Record<string, number>> = {};
    for (const c of cells) for (const [k, v] of Object.entries(c.score?.[key] ?? {})) {
      outAgg[k] ??= {};
      for (const [f, n] of Object.entries(v)) outAgg[k][f] = (outAgg[k][f] ?? 0) + (n as number);
    }
    return outAgg;
  };
  const paraphrase = pglite.flatMap(c => c.paraphrase);
  const receipt: Receipt = {
    ...noModelSpend('hermetic: provider keys stripped, no embedding model, System One off; no model and no paid request'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    benchmark_version: BENCHMARK_VERSION,
    category: CATEGORY,
    run_status: runStatus,
    ...(runStatus === 'completed' ? { verdict } : {}),
    n_total: nPairs,
    n_scored: nPairs,
    completion_rate: nPairs ? 1 : 0,
    errors: harnessErrors,
    publishable: !pgliteVoid,
    gbrain_version: gut.version,
    gbrain_pin: gbrainPin(),
    execution: { source_tree: sourceTreeIdentity(), product: productIdentityFor(gut) },
    latency_ms: latencySummary(pglite.flatMap(c => c.calls.primary_ms), 'primary-transport call latency over the PGLite cells'),
    resolved_config: {
      decide: DECIDE_OFF,
      decide_status_per_cell: Object.fromEntries(result.cells.map(c => [c.id, c.decide.ok ? 'all slots off' : c.decide])),
      engines: { requested: engines, run: [...new Set(result.cells.map(c => c.engine))], postgres_unreachable: result.pgDown },
      interfaces: ifaces,
      harness: 'eval/runner/lifecycle/slice.ts (lifecycle drivers: trusted local CLI `gbrain call`, stdio `gbrain serve`, HTTP `gbrain serve --http` with OAuth client_credentials clients: main read+write on vault, reader read-only on vault, foreign read+write on another source)',
      init: '`gbrain init --no-embedding --non-interactive` (managed persistence, keyword search only), git vaults as sources',
      seed, generator_version: N5_GENERATOR_VERSION, ledger_sha256: world.fingerprint,
      checkpoints: CHECKPOINTS, active_tiers: ACTIVE_TIERS,
      contract: 'src/core/facts/forget.ts header and docs/guides/memory-boundaries.md at the tested commit',
      gating_scope: 'data.metrics aggregates the PGLite cells; data.metrics_postgres is report-only outside CI',
      gbrain_overlay: overlaySummary(gut),
    },
    hashes: { ledger_sha256: world.fingerprint },
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    data: {
      metrics,
      metrics_postgres: metricsPg,
      safety,
      quality,
      promotion_rules: entry.promotion,
      by_tier: sumBy(pglite, 'by_tier'),
      by_checkpoint: sumBy(pglite, 'by_checkpoint'),
      by_tier_postgres: sumBy(postgres, 'by_tier'),
      by_cell: result.cells.map(c => ({
        id: c.id, duration_ms: c.duration_ms, fatal: c.fatal?.split('\n')[0], void_reason: c.void_reason, server_version: c.server_version, metrics: c.score?.metrics ?? null,
        calls: { primary: c.calls.primary, trusted: c.calls.trusted, extra: c.calls.extra }, authority: c.authority, forgets_failed: c.forgets.filter(f => !f.ok),
        concurrent_writes: c.concurrent_writes, concurrent_visible: c.concurrent_visible, entity_counts: c.entity_counts,
      })),
      gaps: {
        paraphrase_residue: { active_after_forget: paraphrase.filter(p => p.active_after_forget).length, of: paraphrase.length, note: 'documented: withdrawal matches normalized claims lexically' },
        non_guarantees: NON_GUARANTEES,
      },
      retained_by_design: {
        struck_fence_rows_seen: pglite.reduce((n, c) => n + c.struck_by_design, 0),
        page_history_tokens: pglite.reduce((n, c) => n + c.retained_by_design.page_history_tokens, 0),
        vault_git_tokens: pglite.reduce((n, c) => n + c.retained_by_design.vault_git_tokens, 0),
        prose_chunk_hits: pglite.reduce((n, c) => n + c.retained_by_design.prose_chunk_hits, 0),
      },
      meta_hot_memory_residue: {
        scope: 'reported, not gated (a tier found during development, after the rules were frozen): remote responses whose MCP _meta.brain_hot_memory still carried a canary after its forget returned',
        pglite: { responses: pglite.reduce((n, c) => n + c.meta_residue.responses, 0), canaries: pglite.reduce((n, c) => n + c.meta_residue.canaries.length, 0), cells_with_residue: pglite.filter(c => c.meta_residue.responses > 0).map(c => c.id) },
        postgres: { responses: postgres.reduce((n, c) => n + c.meta_residue.responses, 0), canaries: postgres.reduce((n, c) => n + c.meta_residue.canaries.length, 0), cells_with_residue: postgres.filter(c => c.meta_residue.responses > 0).map(c => c.id) },
        witnessed_before_forget: result.cells.reduce((n, c) => n + c.meta_residue.witnessed_before_forget.length, 0),
        evidence: result.cells.flatMap(c => c.meta_residue.evidence.map(e => ({ cell: c.id, ...e }))).slice(0, 20),
      },
      unmeasured_tiers: UNMEASURED,
      findings: result.cells.flatMap(c => (c.score?.findings ?? []).map(f => ({ cell: c.id, ...f }))).slice(0, 300),
      leak_evidence: result.cells.flatMap(c => c.leak_evidence.map(e => ({ cell: c.id, ...e }))).slice(0, 20),
      cells: result.cells.map(c => ({ ...c, calls: { primary: c.calls.primary, trusted: c.calls.trusted, extra: c.calls.extra } })),
    },
  };
  writeReceipt(outPath, receipt);
  const outcome = evaluatePromotion(entry.promotion!, receipt);

  log(`\nverdict: ${runStatus === 'error' ? `error (${harnessErrors.map(e => e.message).join('; ').slice(0, 400)})` : verdict}`);
  log(`safety contracts (PGLite cells, ${pglite.length} cells):`);
  log(`  prohibited active outputs after forget: ${metrics.prohibited_active_outputs} (forgotten pairs with a witness: ${metrics.forgotten_pairs_with_signal}, without: ${metrics.forgotten_pairs_without_witness})`);
  log(`  reactivations: ${metrics.reactivations}`);
  log(`  collateral expirations: ${metrics.collateral_expirations}`);
  log(`  unauthorized forgets applied: ${metrics.unauthorized_forgets_applied}`);
  log(`  private canaries in remote responses: ${metrics.private_canary_leaks}`);
  log(`quality metrics:`);
  log(`  retained-neighbor recall: ${pct(metrics.retained_recall)} (${metrics.retained_present} of ${metrics.retained_pairs} witnessed retained pairs over post-forget checkpoints)`);
  log(`  reinstatement: ${pct(metrics.reinstatement_rate)} (${metrics.reinstated} of ${metrics.reinstatement_attempts} corrected claims)`);
  log(`  retained recall with the capped context_pack tier included (erratum, not gated): ${pct(metrics.retained_recall_including_capped)}`);
  log(`  remote responses whose _meta hot memory carried a forgotten canary (not gated): ${pglite.reduce((n, c) => n + c.meta_residue.responses, 0)}`);
  log(`  paraphrase still active after forget (documented gap): ${paraphrase.filter(p => p.active_after_forget).length} of ${paraphrase.length}`);
  if (metricsPg) log(`  postgres (report-only): prohibited ${metricsPg.prohibited_active_outputs}, reactivations ${metricsPg.reactivations}, collateral ${metricsPg.collateral_expirations}, unauthorized ${metricsPg.unauthorized_forgets_applied}, leaks ${metricsPg.private_canary_leaks}, retained ${pct(metricsPg.retained_recall)}, reinstatement ${pct(metricsPg.reinstatement_rate)}`);
  log(`promotion rules: ${outcome.pass ? 'pass' : 'fail'} (${outcome.failures.map(f => f.id).join(', ') || 'none failed'})`);
  log(`gbrain findings: see docs/benchmarks/2026-10-01-wave-bugs.md (N5-*)`);
  log(`receipt: ${outPath}`);
  if (json) process.stdout.write(JSON.stringify({ run_status: runStatus, verdict, metrics, metrics_postgres: metricsPg }, null, 2) + '\n');
  process.exit(runStatus === 'error' ? 3 : verdict === 'pass' ? 0 : 1);
}

if (import.meta.main) {
  main().catch(e => { console.error(e); process.exit(3); });
}
