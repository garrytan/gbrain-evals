import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParamDef } from 'gbrain/operations';
import { generateN6World, ledgerFingerprint, N6_CLASSES, N6_DEFAULT_SEED } from '../../eval/generators/n6-visibility-gen.ts';
import {
  controlSeen, countOccurrences, deliveredUnits, echoCredit, hasSourceRow, isTargeted, namedSlugs, normalizeForOracle,
  namingWindow, oracleView, parseToolResult, runN6, scanLeaks, synthesizeParams, targetTitle, variantsFor, type CallOutcome,
} from '../../eval/runner/n6-visibility-fuzz.ts';
import { gbrainSpecFrom, parseGbrainSpec } from '../../eval/runner/gbrain-under-test.ts';

const ok = (data: unknown): CallOutcome => ({ exposed: true, ok: true, raw: JSON.stringify(data), data });
const ledger = generateN6World();
/** The v1 generator's private_page markers at the default seed, recorded before the v2 classes were added. */
const V1_PRIVATE_PAGE_MARKERS = ['zxkapewezeteq', 'zxluzijamohiq', 'zxsomidukixiq'];
const forbiddenMarkers = ledger.classes.flatMap(c => c.protected_markers);
const forbiddenSlugs = ledger.classes.flatMap(c => c.protected_slugs);

describe('N6 generator ledger', () => {
  test('same seed gives the same ledger; another seed gives another', () => {
    expect(ledgerFingerprint(generateN6World(N6_DEFAULT_SEED))).toBe(ledgerFingerprint(ledger));
    const other = generateN6World(N6_DEFAULT_SEED + 1);
    expect(ledgerFingerprint(other)).not.toBe(ledgerFingerprint(ledger));
    expect(other.classes[0].protected_markers).not.toEqual(ledger.classes[0].protected_markers);
  });

  test('every class has protected markers, a public twin and a ghost that was never written', () => {
    expect(ledger.classes.map(c => c.class)).toEqual([...N6_CLASSES]);
    const written = [...ledger.pages.map(p => p.content), JSON.stringify(ledger.side_writes)].join('\n');
    const pageKeys = new Set(ledger.pages.map(p => `${p.source_id}/${p.slug}`));
    for (const c of ledger.classes) {
      expect(c.protected_markers.length).toBeGreaterThan(0);
      for (const m of [...c.protected_markers, ...c.twin_markers]) expect(written).toContain(m);
      expect(written).not.toContain(c.ghost.query);
      if (c.ghost.slug !== c.protected.slug) expect(pageKeys.has(`${c.ghost.source_id ?? 'alpha'}/${c.ghost.slug}`)).toBe(false);
    }
  });

  test('markers are unique, and no protected marker is written on a page that is public as a whole', () => {
    const all = ledger.classes.flatMap(c => [...c.protected_markers, ...c.twin_markers]);
    expect(new Set(all).size).toBe(all.length);
    const privatePage = ledger.classes.find(c => c.class === 'private_page')!;
    const atom = ledger.classes.find(c => c.class === 'derived_atom')!;
    const orphan = ledger.classes.find(c => c.class === 'private_orphan')!;
    const fenceHosts = new Set([ledger.classes.find(c => c.class === 'private_take')!.protected.slug]);
    for (const p of ledger.pages) {
      const protectedPage = p.source_id === 'beta' || p.slug === privatePage.protected.slug || p.slug === atom.protected.slug || p.slug === orphan.protected.slug || fenceHosts.has(p.slug);
      if (protectedPage) continue;
      for (const m of forbiddenMarkers) expect([p.slug, p.content.includes(m)]).toEqual([p.slug, false]);
    }
  });

  test('v2 side writes: the private ontology value and private raw data are protected, their twins are world', () => {
    const ont = ledger.classes.find(c => c.class === 'private_ontology')!;
    const raw = ledger.classes.find(c => c.class === 'private_raw_data')!;
    const privatePage = ledger.classes.find(c => c.class === 'private_page')!;
    expect(ledger.side_writes.ontology.filter(o => o.value.includes(ont.protected_markers[0])).map(o => o.visibility)).toEqual(['private']);
    expect(ledger.side_writes.ontology.filter(o => o.value.includes(ont.twin_markers[0])).map(o => o.visibility)).toEqual(['world']);
    expect(ledger.side_writes.raw_data.find(d => JSON.stringify(d.data).includes(raw.protected_markers[0]))?.slug).toBe(privatePage.protected.slug);
    expect(ledger.side_writes.raw_data.find(d => JSON.stringify(d.data).includes(raw.twin_markers[0]))?.slug).toBe(privatePage.twin.slug);
  });

  test('v2 keeps every v1 class and marker unchanged', () => {
    expect(ledger.classes.slice(0, 5).map(c => c.class)).toEqual(['private_page', 'private_take', 'private_fact', 'derived_atom', 'foreign_source']);
    expect(ledger.classes[0].protected_markers).toEqual(V1_PRIVATE_PAGE_MARKERS);
  });
});

describe('N6 tool-result parsing with gbrain notice blocks', () => {
  const body = JSON.stringify({ found: false, latency_ms: 11, suggestions: [] });
  const notice = '[gbrain notice mention_index kind=degraded]\nwhy: 17 page(s) have not been scanned';

  test('the body is content[0]; notice blocks stay in raw for the leak scan and do not break JSON parsing', () => {
    const o = parseToolResult({ content: [{ text: body }, { text: notice }] });
    expect(o.data).toEqual({ found: false, latency_ms: 11, suggestions: [] });
    expect(o.notices).toEqual([notice]);
    expect(o.raw).toContain('mention_index');
  });

  test('two responses that differ only in a volatile key compare equal; a differing notice does not', () => {
    const a = parseToolResult({ content: [{ text: body }, { text: notice }] });
    const b = parseToolResult({ content: [{ text: body.replace('11', '23') }, { text: notice }] });
    const c = parseToolResult({ content: [{ text: body }, { text: notice.replace('17', '18') }] });
    expect(normalizeForOracle(oracleView(a), [])).toBe(normalizeForOracle(oracleView(b), []));
    expect(normalizeForOracle(oracleView(a), [])).not.toBe(normalizeForOracle(oracleView(c), []));
  });

  test('an error body keeps its code', () => {
    expect(parseToolResult({ content: [{ text: JSON.stringify({ error: 'page_not_found' }) }, { text: notice }], isError: true }).error_code).toBe('page_not_found');
  });
});

describe('N6 naming window (preregistered 2026-10-06)', () => {
  const page = ledger.classes.find(c => c.class === 'private_page')!;
  const foreign = ledger.classes.find(c => c.class === 'foreign_source')!;
  const params: Record<string, ParamDef> = { window: { type: 'string' }, prior_context: { type: 'string' } };

  test('the window names the page title with every word capitalized', () => {
    expect(namingWindow('Note zxkapewezeteq')).toBe('user: I was just reading Note Zxkapewezeteq again.');
  });

  test('titles come from the ledger page in the target source; the ghost title swaps in the ghost query', () => {
    expect(targetTitle(ledger, page.protected)).toBe(`Note ${page.protected.query}`);
    expect(targetTitle(ledger, page.twin)).toBe(`Note ${page.twin.query}`);
    expect(targetTitle(ledger, page.ghost, page.protected)).toBe(`Note ${page.ghost.query}`);
    expect(targetTitle(ledger, foreign.protected)).toBe(`Project ${foreign.protected.query}`);
    expect(targetTitle(ledger, page.ghost)).toBeUndefined();
  });

  test('only a window parameter changes; without a title the old query rule stands', () => {
    const named = synthesizeParams(params, page.protected, { title: targetTitle(ledger, page.protected) }).params!;
    expect(named.window).toBe(namingWindow(`Note ${page.protected.query}`));
    expect(named.prior_context).toBe(page.protected.query);
    expect(synthesizeParams(params, page.protected).params!.window).toBe(page.protected.query);
  });
});

describe('N6 parameter synthesis', () => {
  const params: Record<string, ParamDef> = {
    slug: { type: 'string', required: true },
    limit: { type: 'number' },
    include_private: { type: 'boolean' },
    source_id: { type: 'string' },
    unit: { type: 'string', enum: ['a', 'b'] },
  };
  const target = ledger.classes[0].protected;

  test('fills targets, widening flags and scope overrides', () => {
    expect(synthesizeParams(params, target).params).toEqual({ slug: target.slug, limit: 50, include_private: true });
    expect(synthesizeParams(params, target, { scope: 'foreign' }).params?.source_id).toBe('beta');
    expect(synthesizeParams(params, target, { scope: 'all' }).params?.source_id).toBe('__all__');
    expect(synthesizeParams(params, target, { enumOverride: ['unit', 'b'] }).params?.unit).toBe('b');
  });

  test('a required param without a rule is unsupported, not guessed', () => {
    expect(synthesizeParams({ revision: { type: 'string', required: true } }, target).unsupported).toContain('revision');
    expect(synthesizeParams({ slug: { type: 'string', required: true } }, null).unsupported).toContain('slug');
  });

  test('variants cover every enum value and both source overrides; targeted ops are recognized', () => {
    expect(variantsFor(params).map(v => v.id)).toEqual(['base', 'unit=a', 'unit=b', 'source_id=beta', 'source_id=__all__']);
    expect(isTargeted(params)).toBe(true);
    expect(isTargeted({ limit: { type: 'number' } })).toBe(false);
  });

  test('a hits array names the target with its source', () => {
    const foreign = ledger.classes.find(c => c.class === 'foreign_source')!.protected;
    expect(synthesizeParams({ hits: { type: 'array', required: true } }, foreign).params).toEqual({ hits: [{ source_id: 'beta', slug: foreign.slug, chunk_id: 0 }] });
  });
});

describe('N6 leak scoring', () => {
  const marker = forbiddenMarkers[0];
  const slug = forbiddenSlugs[0];

  test('a protected marker anywhere in a response is a content leak', () => {
    expect(scanLeaks(ok({ results: [{ chunk_text: `x ${marker} y` }] }), forbiddenMarkers, forbiddenSlugs, []).content).toContain(marker);
    expect(scanLeaks(ok({ results: [] }), forbiddenMarkers, forbiddenSlugs, []).content).toBeNull();
  });

  test('an echo of the probe\'s own argument is credited by the ghost call, and only that often', () => {
    const credit = echoCredit({ query: marker }, { query: 'zxghostq' }, JSON.stringify({ query: 'zxghostq', results: [] }), forbiddenMarkers);
    expect(credit.get(marker)).toBe(1);
    expect(scanLeaks(ok({ query: marker, results: [] }), forbiddenMarkers, forbiddenSlugs, [], credit).content).toBeNull();
    expect(scanLeaks(ok({ query: marker, results: [{ text: marker }] }), forbiddenMarkers, forbiddenSlugs, [], credit).content).not.toBeNull();
  });

  test('a protected slug in a result field is an existence leak unless the probe asked for it; beta rows always are', () => {
    expect(scanLeaks(ok({ edges: [{ slug }] }), forbiddenMarkers, forbiddenSlugs, []).existence).toContain(slug);
    expect(scanLeaks(ok({ slug, links: [] }), forbiddenMarkers, forbiddenSlugs, [slug]).existence).toBeNull();
    expect(scanLeaks(ok([{ slug: 'projects/x', source_id: 'beta' }]), forbiddenMarkers, forbiddenSlugs, []).existence).toContain('beta');
    expect(namedSlugs(['a/b', { to_slug: 'c/d' }])).toEqual(new Set(['a/b', 'c/d']));
    expect(hasSourceRow({ rows: [{ source_id: 'alpha' }] }, 'beta')).toBe(false);
  });

  test('refusing everything finds no leak but earns no signal, so it cannot buy coverage', () => {
    const denied: CallOutcome = { exposed: true, ok: false, error_code: 'permission_denied', raw: '{"error":"permission_denied"}', data: { error: 'permission_denied' } };
    expect(scanLeaks(denied, forbiddenMarkers, forbiddenSlugs, [])).toEqual({ content: null, existence: null });
    for (const c of ledger.classes) expect(controlSeen(denied, c.twin_markers, [c.twin.slug])).toBe(false);
  });

  test('returning everything leaks every class', () => {
    const everything = ok({ pages: ledger.pages.map(p => ({ slug: p.slug, source_id: p.source_id, body: p.content })), side_writes: ledger.side_writes });
    for (const c of ledger.classes) expect(scanLeaks(everything, c.protected_markers, c.protected_slugs, []).content).not.toBeNull();
  });

  test('expansion is recognized only from delivered blocks', () => {
    expect(deliveredUnits({ results: [{ chunk_text: 'x', delivered: { unit: 'page', chunk_ids: [1] } }, { delivered: { unit: 'chunk' } }] })).toEqual(['page', 'chunk']);
    expect(deliveredUnits({ results: [{ chunk_text: 'x' }], delivery: { applied_unit: 'page' } })).toEqual([]);
  });

  test('the oracle compares masked shapes and ignores volatile fields', () => {
    const a = normalizeForOracle({ error: 'page_not_found', message: 'Page not found: notes/aaa', took_ms: 3 }, ['notes/aaa', 'notes/bbb']);
    const b = normalizeForOracle({ error: 'page_not_found', message: 'Page not found: notes/bbb', took_ms: 9 }, ['notes/aaa', 'notes/bbb']);
    expect(a).toBe(b);
    expect(normalizeForOracle({ entries: [] }, [])).not.toBe(normalizeForOracle({ error: 'page_not_found' }, []));
    expect(countOccurrences('ABC abc', 'abc')).toBe(2);
  });

  test('the reference clock open_loops echoes (as_of) is volatile', () => {
    const protectedRun = { data: { as_of: '2026-10-07T20:13:29.085Z', count: 0, groups: [], redacted: true }, notices: [] };
    const ghostRun = { data: { as_of: '2026-10-07T20:13:29.086Z', count: 0, groups: [], redacted: true }, notices: [] };
    expect(normalizeForOracle(protectedRun, [])).toBe(normalizeForOracle(ghostRun, []));
    expect(normalizeForOracle(protectedRun, [])).not.toBe(normalizeForOracle({ ...ghostRun, data: { ...ghostRun.data, count: 1 } }, []));
  });
});

describe('gbrain under test', () => {
  test('--gbrain, --gbrain= and GBRAIN_UNDER_TEST select an overlay; nothing selects the pin', () => {
    expect(gbrainSpecFrom(['--gbrain', '../gbrain'], {})).toBe('../gbrain');
    expect(gbrainSpecFrom(['--gbrain=../gbrain@abc'], {})).toBe('../gbrain@abc');
    expect(gbrainSpecFrom([], { GBRAIN_UNDER_TEST: '/x' })).toBe('/x');
    expect(gbrainSpecFrom([], {})).toBeNull();
    expect(() => gbrainSpecFrom(['--gbrain'], {})).toThrow();
  });

  test('a ref splits off only when the left side is a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gut-'));
    try {
      expect(parseGbrainSpec(`${dir}@origin/capy/branch`)).toEqual({ checkout: dir, ref: 'origin/capy/branch' });
      expect(parseGbrainSpec(dir)).toEqual({ checkout: dir, ref: 'HEAD' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('N6 end to end on the pinned gbrain (small op subset)', () => {
  test('presence holds, detector controls fire, and get_page / list_pages are covered without leaks', async () => {
    const out = mkdtempSync(join(tmpdir(), 'n6-e2e-'));
    try {
      const { receipt } = await runN6({ only: ['get_page', 'list_pages', 'get_timeline'], outputDir: out, quiet: true });
      expect(receipt.run_status).toBe('completed');
      const data = receipt.data as Record<string, any>;
      expect(data.presence.checks.every((c: { pass: boolean }) => c.pass)).toBe(true);
      expect(data.metrics.local_replay_detections).toBeGreaterThan(0);
      expect(data.metrics.local_oracle_differences).toBeGreaterThan(0);
      const byOp = Object.fromEntries(data.ops.map((o: { op: string }) => [o.op, o]));
      for (const op of ['get_page', 'list_pages']) {
        expect(byOp[op].signal).toBeGreaterThan(0);
        expect(byOp[op].leaks).toBe(0);
      }
      expect(receipt.hashes?.ledger_sha256).toBe(ledgerFingerprint(ledger));
    } finally { rmSync(out, { recursive: true, force: true }); }
  }, 60_000);
});
