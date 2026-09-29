/**
 * Lifecycle experiment scorer and build-identity guards.
 *
 * The scorer must pass a snapshot that matches the ledger exactly, and each
 * deliberately broken snapshot must fail on the metric it breaks. The build
 * guard must refuse a symlinked overlay or a copy whose files do not hash to
 * the requested tree.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBuildVerified, countSymlinks, type BuildInfo } from '../../eval/runner/lifecycle/builds.ts';
import { hashEmbedding } from '../../eval/runner/lifecycle/fake-embedder.ts';
import type { PageObs, Snapshot } from '../../eval/runner/lifecycle/observe.ts';
import {
  HAZARD_IDS, FACTS, FORGET_KEY, IDENTITIES, expectedAt, identityById, naiveSlug, renderFile, versionAt, type PhaseName,
} from '../../eval/runner/lifecycle/scenario.ts';
import { scoreBijection, scoreCheckpoint, scoreEdges, scoreFacts, scoreOldSlugs, scoreTimeline, type FactEvent } from '../../eval/runner/lifecycle/score.ts';
import { compareRuns, summarizeCell } from '../../eval/runner/lifecycle-report.ts';

function slugOf(id: string, phase: PhaseName): string {
  return naiveSlug(versionAt(identityById(id), phase)!.path);
}

/** A snapshot an ideal system would return after `phase`. */
function perfect(phase: PhaseName, observer: 'local' | 'remote' = 'local'): Snapshot {
  const exp = expectedAt(phase, observer);
  const pages: PageObs[] = [];
  for (const [id, v] of exp.files) {
    pages.push({
      slug: slugOf(id, phase) + (id === 'foobarspace' ? '-2' : ''),
      source_id: identityById(id).source ?? 'vault',
      source_path: v.path,
      text: renderFile(v),
      canaries: [v.canary],
      links: v.links.filter(to => exp.files.has(to)).map(to => slugOf(to, phase)),
      timeline: v.timeline.map(t => ({ date: t.date, summary: t.summary })),
    });
  }
  return { observer, interface: observer === 'local' ? 'cli' : 'mcp-stdio', pages, facts: {}, errors: [], calls: 0, call_ms: 0 };
}

describe('ledger', () => {
  test('canaries are unique per identity and version', () => {
    const seen = new Map<string, string>();
    for (const identity of IDENTITIES) {
      for (const v of Object.values(identity.versions)) {
        if (!v) continue;
        const owner = seen.get(v.canary);
        expect(owner === undefined || owner === identity.id).toBe(true);
        seen.set(v.canary, identity.id);
      }
    }
  });

  test('the correction phase moves, renames, deletes and corrects', () => {
    const exp = expectedAt('correct', 'local');
    expect(exp.files.get('standup')!.path).toBe('meetings/standup.md');
    expect(exp.files.get('erin')!.path).toBe('people/erin-example-2.md');
    expect(exp.files.has('obsolete')).toBe(false);
    expect(exp.edges.has('notea->bob')).toBe(false);
    expect(exp.edges.has('noteb->erin')).toBe(true);
    expect([...exp.timeline].some(t => t.startsWith('carol|2024-03-01'))).toBe(false);
    expect([...exp.timeline].some(t => t.startsWith('carol|2024-04-01'))).toBe(true);
  });

  test('a remote observer expects neither the private page nor the hazard vaults', () => {
    const exp = expectedAt('ingest', 'remote');
    expect(exp.files.has('dave')).toBe(false);
    for (const id of HAZARD_IDS) expect(exp.files.has(id)).toBe(false);
    expect(exp.edges.has('team->dave')).toBe(false);
    expect(exp.edges.has('team->dan')).toBe(true);
  });
});

describe('scorer', () => {
  test('an exact snapshot scores zero violations and perfect precision and recall', () => {
    for (const phase of ['ingest', 'outage', 'correct'] as PhaseName[]) {
      const snap = perfect(phase);
      const exp = expectedAt(phase, 'local');
      expect(scoreBijection(snap, exp).violations).toBe(0);
      const e = scoreEdges(snap, exp);
      expect([e.precision, e.recall]).toEqual([1, 1]);
      const t = scoreTimeline(snap, exp);
      expect([t.precision, t.recall]).toEqual([1, 1]);
    }
  });

  test('a moved page that was deleted counts as lost, and an acknowledged write lost', () => {
    const snap = perfect('correct');
    snap.pages = snap.pages.filter(p => !p.canaries.includes('cnrystandup1v1'));
    const exp = expectedAt('correct', 'local');
    const acknowledged = new Map([...exp.files].map(([id, v]) => [id, v.canary]));
    const s = scoreCheckpoint({ snap, exp, hiddenIds: [], acknowledgedCanaries: acknowledged, forgetKey: FORGET_KEY });
    expect(s.bijection.lost).toEqual(['standup']);
    expect(s.acknowledged_writes_lost).toEqual(['file:standup']);
    expect(s.edges.recall).toBeLessThan(1);
  });

  test('a page left at the old path next to the moved page is a duplicate', () => {
    const snap = perfect('correct');
    const moved = snap.pages.find(p => p.canaries.includes('cnrystandup1v1'))!;
    snap.pages.push({ ...moved, slug: 'inbox/standup', source_path: 'inbox/standup.md' });
    expect(scoreBijection(snap, expectedAt('correct', 'local')).duplicate).toHaveLength(1);
  });

  test('an edit that never landed is stale, and a deleted file left live is an orphan', () => {
    const snap = perfect('correct');
    const tmplb = snap.pages.find(p => p.canaries.includes('cnrytmplb1v2'))!;
    tmplb.canaries = ['cnrytmplb1v1'];
    snap.pages.push({ slug: 'notes/obsolete', source_id: 'vault', source_path: 'notes/obsolete.md', text: '', canaries: ['cnryobsolete1v1'], links: [], timeline: [] });
    const b = scoreBijection(snap, expectedAt('correct', 'local'));
    expect(b.stale).toEqual(['templateb']);
    expect(b.orphan).toHaveLength(1);
    expect(b.violations).toBe(2);
  });

  test('a colliding pair collapsed into one page loses one file', () => {
    const snap = perfect('ingest');
    snap.pages = snap.pages.filter(p => !p.canaries.includes('cnryfoobarsp1v1'));
    expect(scoreBijection(snap, expectedAt('ingest', 'local')).lost).toEqual(['foobarspace']);
  });

  test('a removed link that persists lowers edge precision', () => {
    const snap = perfect('correct');
    snap.pages.find(p => p.slug === 'notes/a')!.links.push('people/bob-example');
    const e = scoreEdges(snap, expectedAt('correct', 'local'));
    expect(e.precision).toBeLessThan(1);
    expect(e.extra).toEqual(['notea->bob']);
  });

  test('a corrected timeline bullet that persists lowers timeline precision', () => {
    const snap = perfect('correct');
    snap.pages.find(p => p.slug === 'people/carol-example')!.timeline.push({ date: '2024-03-01', summary: 'Joined Acme Example as CTO' });
    const t = scoreTimeline(snap, expectedAt('correct', 'local'));
    expect(t.extra).toEqual(['carol|2024-03-01|joined acme example as cto']);
  });

  test('a near-name wikilink resolved to the wrong entity is a wrong-entity attribution', () => {
    const snap = perfect('ingest');
    snap.pages.find(p => p.slug === 'notes/near-names')!.links.push('people/exa-cheng');
    expect(scoreEdges(snap, expectedAt('ingest', 'local')).wrong_entity).toEqual(['nearnames->exacheng']);
  });

  test('a private page seen by a remote observer is reported, not expected', () => {
    const snap = perfect('ingest', 'remote');
    const dave = versionAt(identityById('dave'), 'ingest')!;
    snap.pages.push({ slug: 'people/dave-example', source_id: 'vault', source_path: dave.path, text: renderFile(dave), canaries: [dave.canary], links: [], timeline: [] });
    const b = scoreBijection(snap, expectedAt('ingest', 'remote'), ['dave'], HAZARD_IDS);
    expect(b.hidden_visible).toHaveLength(1);
    expect(b.violations).toBe(0);
  });
});

describe('renames and moves', () => {
  test('an old slug counts only when it reaches the moved page', () => {
    const snap = perfect('correct');
    snap.old_slugs = {
      'inbox/standup': { resolved_to: 'meetings/standup', canaries: ['cnrystandup1v1'] },
      'people/erin-example': { resolved_to: null, canaries: [], error: 'page_not_found' },
    };
    expect(scoreOldSlugs(snap, expectedAt('correct', 'local'))).toEqual({ checked: 2, resolved: ['inbox/standup'], unresolved: ['people/erin-example'] });
  });
});

describe('report summary', () => {
  test('hazard vaults report imported files out of three from the bijection score', () => {
    const snap = perfect('correct');
    snap.pages = snap.pages.filter(p => !p.canaries.includes('cnrybystand1v1') && !p.canaries.includes('cnryfoobarsp1v1'));
    const exp = expectedAt('correct', 'local');
    const score = scoreCheckpoint({ snap, exp, hiddenIds: [], acknowledgedCanaries: new Map(), forgetKey: FORGET_KEY });
    const cell = {
      build: 'x', engine: 'pglite', interface: 'cli', sync_exits: { ingest: { vault: 0, collide: 1, sharedid: 0 } },
      checkpoints: { restart: { score, snapshot: snap } }, forget: { ok: true }, outage: {}, operator: [],
    };
    const s = summarizeCell(cell);
    expect(s.hazards.collide).toBe('1/3 imported; sync exit 1');
    expect(s.hazards.sharedid).toBe('3/3 imported; sync exit 0');
  });
});

describe('facts', () => {
  const spec = (key: string) => FACTS.find(f => f.key === key)!;
  const ev = (key: string, acknowledged = true, entity_slug: string | null = spec(key).entity): FactEvent => ({
    spec: spec(key), acknowledged, status: acknowledged ? 'inserted' : 'error', fact_id: acknowledged ? key : null, entity_slug,
  });
  const snapWith = (facts: Record<string, string[]>): Snapshot => ({
    observer: 'local', interface: 'cli', pages: [], errors: [], calls: 0, call_ms: 0,
    facts: Object.fromEntries(Object.entries(facts).map(([entity, list]) => [entity, { active: list.map((fact, i) => ({ fact_id: String(i), fact, entity_slug: entity })) }])),
  });

  test('a subject-scoped forget passes', () => {
    const events = ['alice_email', 'bob_email', 'alice_maps', 'exachen_lang', 'frank_email'].map(k => ev(k));
    const snap = snapWith({
      'people/alice-example': ['Collects vintage maps cnryfactmaps1'],
      'people/bob-example': ['Prefers email'],
      'people/frank-example': ['Prefers email'],
      'people/exa-cheng': [],
    });
    const s = scoreFacts(snap, events, new Set([FORGET_KEY]), FORGET_KEY);
    expect(s).toMatchObject({ lost: [], residue: [], collateral: [], blocked: [], wrong_entity: [] });
  });

  test('a subjectless forget shows collateral and a blocked re-remember', () => {
    const events = ['alice_email', 'bob_email', 'alice_maps', 'exachen_lang'].map(k => ev(k)).concat([ev('frank_email', false)]);
    const snap = snapWith({ 'people/alice-example': ['Collects vintage maps cnryfactmaps1'], 'people/bob-example': [] });
    const s = scoreFacts(snap, events, new Set([FORGET_KEY]), FORGET_KEY);
    expect(s.collateral).toEqual(['bob_email']);
    expect(s.blocked).toHaveLength(1);
  });

  test('a forgotten fact that stays active is residue, and a near-name fact on the wrong entity is flagged', () => {
    const events = [ev('alice_email'), ev('exachen_lang', true, 'people/exa-cheng')];
    const snap = snapWith({ 'people/alice-example': ['Prefers email'] });
    const s = scoreFacts(snap, events, new Set([FORGET_KEY]), FORGET_KEY);
    expect(s.residue).toEqual(['alice_email']);
    expect(s.wrong_entity).toHaveLength(1);
  });
});

describe('build identity guard', () => {
  const base = (): BuildInfo => ({
    label: 'x', description: '', ref: 'abc', dir: '/tmp/x', commit: 'abc', tree: 't1', version: '1.0.0',
    verified: { copy_tree: 't1', tree_matches: true, symlinks_under_src: 0, dir_is_realpath: true, cli_version: '1.0.0', cli_version_matches: true },
  });

  test('a verified copy passes', () => {
    expect(() => assertBuildVerified(base())).not.toThrow();
  });

  test('a symlinked overlay is refused', () => {
    const b = base();
    b.verified.symlinks_under_src = 3;
    b.verified.dir_is_realpath = false;
    expect(() => assertBuildVerified(b)).toThrow(/symlink/);
  });

  test('a copy whose files do not hash to the requested tree is refused', () => {
    const b = base();
    b.verified.copy_tree = 't2';
    b.verified.tree_matches = false;
    expect(() => assertBuildVerified(b)).toThrow(/expected t1/);
  });

  test('the symlink counter catches a src/ that is itself a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-symlink-'));
    mkdirSync(join(dir, 'pinned'));
    writeFileSync(join(dir, 'pinned', 'a.ts'), 'export {}');
    symlinkSync(join(dir, 'pinned'), join(dir, 'src'));
    expect(countSymlinks(join(dir, 'src'))).toBe(1);
    expect(countSymlinks(join(dir, 'pinned'))).toBe(0);
  });
});

describe('hash embedder', () => {
  test('is deterministic and unit length', () => {
    const a = hashEmbedding('alpha beta cnryabc123', 64);
    expect(hashEmbedding('alpha beta cnryabc123', 64)).toEqual(a);
    expect(Math.abs(Math.hypot(...a) - 1)).toBeLessThan(1e-9);
  });
});

describe('published 2026-09-29 receipts recount', () => {
  const load = (attempt: string) => JSON.parse(readFileSync(join(import.meta.dir, `../../docs/benchmarks/2026-09-29-lifecycle/${attempt}/receipt.json`), 'utf8'));
  const primary = load('primary');
  const cells = primary.cells.map(summarizeCell);
  const byBuild = (b: string) => cells.filter((c: ReturnType<typeof summarizeCell>) => c.build === b);

  test('every build copy was verified and the run was hermetic', () => {
    expect(primary.cost_usd).toBe(0);
    expect(primary.builds.map((b: BuildInfo) => [b.label, b.verified.tree_matches, b.verified.symlinks_under_src])).toEqual([
      ['a', true, 0], ['b0', true, 0], ['b', true, 0], ['c', true, 0],
    ]);
    expect(cells).toHaveLength(24);
    expect(cells.filter((c: ReturnType<typeof summarizeCell>) => c.fatal)).toHaveLength(0);
  });

  test('forget collateral and blocked re-remember stop only with #5666', () => {
    for (const b of ['a', 'b0', 'b']) {
      for (const c of byBuild(b)) { expect(c.collateral).toEqual(['bob_email']); expect(c.blocked).toHaveLength(1); expect(c.ack_lost_final).toBe(1); }
    }
    for (const c of byBuild('c')) { expect(c.collateral).toEqual([]); expect(c.blocked).toHaveLength(0); expect(c.ack_lost_final).toBe(0); }
    for (const c of cells) { expect(c.residue_forget).toEqual([]); expect(c.residue_restart).toEqual([]); }
  });

  test('private tags reach remote callers on a and b0 only', () => {
    for (const b of ['a', 'b0']) for (const c of byBuild(b).filter((c: ReturnType<typeof summarizeCell>) => c.iface !== 'cli')) expect(c.leaks_content).toEqual(['get_tags(named page)']);
    for (const b of ['b', 'c']) for (const c of byBuild(b)) expect(c.leaks_content).toEqual([]);
    for (const c of cells) expect(c.leaks_existence).toEqual([]);
  });

  test('hazard vaults, renames and near-name facts', () => {
    for (const c of cells.filter((c: ReturnType<typeof summarizeCell>) => c.iface === 'cli')) {
      expect(c.hazards.collide).toBe('1/3 imported; sync exit 1');
      expect(c.hazards.sharedid).toBe(c.build === 'a' ? '1/3 imported; sync exit 1' : '3/3 imported; sync exit 0');
    }
    for (const c of cells) {
      expect(c.old_slugs).toBe('0/2');
      expect(c.edges_missing).toContain('noteb->erin');
      expect(c.edges_extra).toEqual([]);
      expect(c.timeline_extra).toEqual([]);
      expect(c.wrong_entity.length).toBe(c.build === 'a' ? 1 : 0);
    }
  });

  test('the repeat run differs only in timing-dependent fields', () => {
    const repeat = compareRuns([primary, load('repeat')]);
    expect(repeat).toContain('Cells whose summary matched in every run: 21 of 24.');
    const differing = repeat.split('\n').filter(l => l.startsWith('- '));
    const allowed = [
      /^- a\/(pglite|postgres)\/mcp-(stdio|http) differs in: search_lost_after_forget$/,
      /^- b\/pglite\/mcp-stdio differs in: edges_final, edges_missing$/,
    ];
    expect(differing.every(l => allowed.some(re => re.test(l)))).toBe(true);
  });
});
