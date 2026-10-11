import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGoldEdges, loadCorpus } from '../../eval/runner/world-v1-gold.ts';
import { custodyInput, edgeKeys, renderWorldPage, type StoredEdge } from '../../eval/runner/p5-brain.ts';
import { edgesByOrigin } from '../../eval/runner/line-grammar-typing.ts';
import {
  DECOY_KINDS, TEMPLATES_A, dropStatementsLinking, generateRelationLineWorld, linksTo, normalizeRelationType, validateTemplates,
} from '../../eval/generators/relation-line-variants-gen.ts';
import { scoreWorld, typeRows } from '../../eval/runner/relation-line-variants.ts';
import { nonEntityShare, planSeed, wantedNames } from '../../eval/runner/forward-reference-heal.ts';
import { generateLedger } from '../../eval/generators/n4-entity-gen.ts';
import { generateNoReferentNames, referentProblem, validatePools, POOLS_A } from '../../eval/generators/no-referent-names-gen.ts';
import { createSlug, isLexical, probesFor, summarizeH5 } from '../../eval/runner/n4-similar-pages.ts';

const corpus = loadCorpus('eval/data/world-v1');
const edge = (from: string, to: string, type: string): StoredEdge => ({ from, to, type, origin: from });

describe('P5 shared plumbing', () => {
  test('world pages render in serializeMarkdown form', () => {
    const md = renderWorldPage({ type: 'person', title: 'A "B"', compiled_truth: 'Body.', timeline: '- **2024-01-01** | x' });
    expect(md).toBe('---\ntype: person\ntitle: "A \\"B\\""\n---\n\nBody.\n\n<!-- timeline -->\n\n- **2024-01-01** | x\n');
    expect(renderWorldPage({ type: 'person', title: 'T', compiled_truth: 'Body.', timeline: '' })).not.toContain('timeline');
  });
  test('edges group by the page whose text produced them', () => {
    const by = edgesByOrigin([edge('a', 'b', 'works_at'), { ...edge('c', 'm', 'attended'), origin: 'm' }, edge('a', 'b', 'works_at')]);
    expect(by.get('a')).toBe(JSON.stringify(['a', 'b', 'works_at']));
    expect(by.get('m')).toBe(JSON.stringify(['c', 'm', 'attended']));
    expect(edgeKeys([edge('a', 'b', 't'), edge('a', 'b', 't')]).size).toBe(1);
  });
  test('dev mode refuses held-out seeds; custodian mode logs the access and returns only a hash', () => {
    expect(custodyInput([], [1, 2], [1, 2, 3])).toBeNull();
    expect(() => custodyInput([], [7], [1, 2, 3])).toThrow('held-out seeds belong to the custodian');
    const dir = mkdtempSync(join(tmpdir(), 'p5-custody-'));
    const file = join(dir, 'templates.json');
    writeFileSync(file, JSON.stringify({ id: 'set-x', templates: { a: 1 } }));
    expect(() => custodyInput(['--phrasing-file', file, '--seeds', '7'], [7], [1, 2, 3])).toThrow('--decision-id and --purpose');
    expect(existsSync(join(dir, 'access-log.jsonl'))).toBe(false);
    expect(() => custodyInput(['--phrasing-file', file, '--decision-id', 'p5-x', '--purpose', 'confirm'], [7], [1, 2, 3])).toThrow('explicit --output');
    expect(existsSync(join(dir, 'access-log.jsonl'))).toBe(false);
    const got = custodyInput(['--phrasing-file', file, '--decision-id', 'p5-x', '--purpose', 'confirm', '--output', join(dir, 'out')], [7], [1, 2, 3])!;
    expect(got.parsed.id).toBe('set-x');
    expect(got.sha256).toMatch(/^[0-9a-f]{64}$/);
    const log = JSON.parse(readFileSync(join(dir, 'access-log.jsonl'), 'utf8').trim());
    expect(log).toMatchObject({ action: 'open', decision_id: 'p5-x', purpose: 'confirm', labels_sha256: got.sha256 });
  });
});

describe('H2 relation-line variant generator', () => {
  const world = generateRelationLineWorld({ seed: 1, corpus });
  test('is deterministic per seed and converts half of the person pages', () => {
    expect(generateRelationLineWorld({ seed: 1, corpus }).fingerprint).toBe(world.fingerprint);
    expect(generateRelationLineWorld({ seed: 2, corpus }).fingerprint).not.toBe(world.fingerprint);
    expect(world.converted.length).toBe(corpus.filter(p => p._facts.type === 'person').length / 2);
  });
  test('each rendered line is the only link from its page to the company', () => {
    const gold = buildGoldEdges(corpus);
    expect(world.lines.length).toBeGreaterThan(40);
    for (const l of world.lines) {
      expect(gold.some(g => g.from === l.from && g.to === l.to && g.type === l.type)).toBe(true);
      const page = world.pages.find(p => p.slug === l.from)!;
      expect(page.compiled_truth).toContain(l.text);
      expect(linksTo(`${page.compiled_truth.replace(l.text, '')}\n${page.timeline}`, l.to)).toBe(false);
    }
  });
  test('every decoy kind appears, points at unrelated companies and records its stated type', () => {
    const gold = buildGoldEdges(corpus);
    expect(new Set(world.decoys.map(d => d.kind))).toEqual(new Set(DECOY_KINDS));
    for (const d of world.decoys) {
      for (const t of d.targets) expect(gold.some(g => g.from === d.from && g.to === t)).toBe(false);
      expect(world.pages.find(p => p.slug === d.from)!.compiled_truth).toContain(d.text);
    }
    expect(world.decoys.find(d => d.kind === 'multi_word')!.stated_type).toMatch(/^[a-z]+_[a-z]+$/);
    expect(world.decoys.find(d => d.kind === 'machine_section')!.text).toMatch(/^## Related/);
  });
  test('keep-prose leaves the prose and only adds lines', () => {
    const kept = generateRelationLineWorld({ seed: 1, corpus, keepProse: true });
    const original = corpus.find(p => p.slug === kept.converted[0])!;
    expect(kept.pages.find(p => p.slug === original.slug)!.compiled_truth.startsWith(original.compiled_truth.trim())).toBe(true);
  });
  test('dev mode refuses held-out template names; sealed templates are validated', () => {
    expect(() => generateRelationLineWorld({ seed: 1, corpus, templates: 'B' })).toThrow('held out');
    expect(() => validateTemplates({ ...TEMPLATES_A, relation: '- {type} {slug}' })).toThrow('[[{slug}]]');
    expect(() => validateTemplates({ ...TEMPLATES_A, relation_heading: '## See also' })).toThrow('machine-written');
    expect(() => validateTemplates({ ...TEMPLATES_A, decoy_machine_section: '## Notes\n\n- {type} [[{slug}]]' })).toThrow('machine-written');
    const sealed = generateRelationLineWorld({ seed: 9, corpus, sealedTemplates: { id: 'x', templates: { ...TEMPLATES_A, relation: '* {type} [[{slug}]]' } } });
    expect(sealed.templates).toBe('sealed:x');
    expect(sealed.lines[0].text.startsWith('* ')).toBe(true);
  });
  test('sentence removal drops only the sentences that link the target', () => {
    const out = dropStatementsLinking({ compiled_truth: 'She runs [A](companies/a). She likes tea.\n\nAt [A](companies/a) since 2020.', timeline: '- x [A](companies/a)\n- y' }, 'companies/a');
    expect(out).toEqual({ compiled_truth: 'She likes tea.', timeline: '- y' });
    expect(normalizeRelationType('Board member')).toBe('board_member');
    expect(normalizeRelationType('worksAt')).toBe('works_at');
  });
  test('scoring separates grammar-added decoys from inference', () => {
    const w = { ...world, lines: [world.lines[0]], decoys: [world.decoys[0]] };
    const l = w.lines[0], d = w.decoys[0];
    const on = [edge(l.from, l.to, l.type), edge(d.from, d.targets[0], d.stated_type)];
    const { rows, summary } = scoreWorld(w, on, [edge(l.from, l.to, 'mentions')]);
    expect(rows.find(r => r.kind === 'relation')).toMatchObject({ typed_recall: 1, typed_recall_grammar_off: 0 });
    expect(rows.find(r => r.kind === 'decoy')).toMatchObject({ decoy_type_reached: 1, decoy_type_reached_grammar_off: 0, decoy_added_by_grammar: 1 });
    expect(summary.decoy_types_added_by_grammar).toBe(1);
    expect(scoreWorld(w, on, on).rows.find(r => r.kind === 'decoy')!.decoy_added_by_grammar).toBe(0);
    expect(scoreWorld(w, on, on, true).rows.find(r => r.kind === 'decoy')).not.toHaveProperty('stated_type');
    expect(scoreWorld(w, [], []).rows.find(r => r.kind === 'relation')).toMatchObject({ typed_recall: 0, found: 0 });
  });
});

describe('H4 forward references', () => {
  const slugs = corpus.map(p => p.slug);
  test('the write order and the withheld set are seeded', () => {
    const a = planSeed(slugs, 1, 0.2);
    expect(planSeed(slugs, 1, 0.2)).toEqual(a);
    expect(planSeed(slugs, 2, 0.2).order).not.toEqual(a.order);
    expect([...a.order].sort()).toEqual([...slugs].sort());
    expect(a.withheld.length).toBe(Math.round(slugs.filter(s => /^(people|companies)\//.test(s)).length * 0.2));
    expect(a.withheld.every(s => /^(people|companies)\//.test(s))).toBe(true);
  });
  test('a wanted target names a slug directly or by a bare-name reference', () => {
    expect(wantedNames([{ target: 'people/ana-x' }], 'people/ana-x')).toBe(true);
    expect(wantedNames([{ target: 'ana-x', ref_kind: 'name' }], 'people/ana-x')).toBe(true);
    expect(wantedNames([{ target: 'ana-x', ref_kind: 'slug' }], 'people/ana-x')).toBe(false);
  });
  test('the non-entity share pools seeds and is null when nothing is wanted', () => {
    expect(nonEntityShare([{ withheld: { wanted_targets: 10, non_entity_targets: 1 } }, { withheld: { wanted_targets: 30, non_entity_targets: 3 } }])).toBe(0.1);
    expect(nonEntityShare([{ withheld: { wanted_targets: 0, non_entity_targets: 0 } }])).toBeNull();
  });
});

describe('H5a no-referent names', () => {
  const ledger = generateLedger(1);
  const set = generateNoReferentNames({ seed: 1, ledger });
  test('at least 50 seeded names, none resolvable in the ledger', () => {
    expect(set.names.length).toBeGreaterThanOrEqual(50);
    expect(generateNoReferentNames({ seed: 1, ledger }).fingerprint).toBe(set.fingerprint);
    expect(new Set(set.names.map(n => n.text.toLowerCase())).size).toBe(set.names.length);
    for (const n of set.names) expect(referentProblem(n.text, ledger)).toBeNull();
    expect(new Set(set.names.map(n => n.family))).toEqual(new Set(['fresh-person', 'relative', 'fresh-company']));
  });
  test('the oracle check rejects names that point at a page', () => {
    const person = ledger.pages.find(p => p.type === 'person')!;
    expect(referentProblem(person.title, ledger)).toContain('oracle');
    expect(referentProblem(person.slug, ledger)).toContain('oracle');
  });
  test('dev mode refuses held-out pool names; sealed pools need 50 names', () => {
    expect(() => generateNoReferentNames({ seed: 1, ledger, pools: 'B' })).toThrow('held out');
    expect(() => validatePools({ ...POOLS_A, counts: { 'fresh-person': 10, relative: 10, 'fresh-company': 10 } })).toThrow('at least 50');
  });
  test('probes, create slugs and summaries', () => {
    const probes = probesFor(ledger, set);
    expect(probes.filter(p => p.gold === null).length).toBe(set.names.length + ledger.mentions.filter(m => m.design === 'no-referent').length);
    expect(probes.filter(p => p.gold).every(p => p.gold!.length > 0)).toBe(true);
    expect(createSlug('Alice Harbor-Example', 'person', new Set(['people/alice-harbor-example']))).toBe('people/alice-harbor-example-2');
    expect(createSlug('people/bwren-example', 'person', new Set())).toBe('people/bwren-example');
    expect(createSlug('Orbitline Example', 'company', new Set())).toBe('companies/orbitline-example');
    expect(isLexical({ family: 'nickname', documented: true })).toBe(true);
    expect(isLexical({ family: 'nickname', documented: false })).toBe(false);
    const s = summarizeH5([
      { id: 'a', cluster: 'typo', seed: 1, family: 'typo', lexical: true, recall_at_3: 1 },
      { id: 'b', cluster: 'handle', seed: 1, family: 'handle', lexical: false, recall_at_3: 0 },
      { id: 'c', cluster: 'no-referent', seed: 1, family: 'no-referent', origin: 'no-referent-gen', hinted: 1 },
      { id: 'd', cluster: 'no-referent', seed: 1, family: 'no-referent', origin: 'no-referent-gen', hinted: 0 },
    ]);
    expect(s.lexical).toEqual({ n: 1, recall_at_3: 1 });
    expect((s.no_referent as { hint_rate: number }).hint_rate).toBe(0.5);
  });
});

describe('P5 delta H9: per-seed gold-edge type rows', () => {
  test('every gold edge gets a seed-prefixed row; stored gold types match; redaction drops stored types', () => {
    const gold = buildGoldEdges([...corpus]);
    const stored = gold.map(g => edge(g.from, g.to, g.type));
    const t = typeRows(4, corpus, stored);
    expect(t.rows.length).toBe(gold.length);
    expect(t.rows.every(r => String(r.id).startsWith('s4:') && String(r.cluster).startsWith('s4:') && r.kind === 'edge' && r.anyTypeMatch === 1 && r.found === 1)).toBe(true);
    const missing = typeRows(4, corpus, stored.slice(1), true);
    expect(missing.rows.filter(r => r.anyTypeMatch === 0).length).toBe(1);
    expect(missing.rows.some(r => 'inferred_types' in r)).toBe(false);
  });
});
