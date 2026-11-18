import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPANY_FAMILIES, companyPageKey, companySeed, companyWrittenPages, deriveCompanyGold, generateCompanyLedger, parseCompanyPage, renderCompanyPage,
} from '../../eval/generators/company-dedupe-gen.ts';
import {
  FAMILIES, PERSON_DEDUPE_DEFAULT_PER_FAMILY, PERSON_DEDUPE_DEFAULT_SEED, deriveGold, generateLedger, ledgerFingerprint, pageKey, parseWrittenPage, renderPage, writtenPages,
  type DesignedPair, type WrittenPage,
} from '../../eval/generators/person-dedupe-gen.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import {
  ARMS, REFERENCE_MATCHERS, SELECTIONS, checkFinderCoverage, domainKey, emailKey, emulateFinder, groupId, isRoleEmail, pageKeys, parseFinderOutput, runPersonDedupe, scoreGroups, strictFold, toFinderOutput, variantFold, verdictOf, writeWorld,
  type Group, type Score,
} from '../../eval/runner/person-dedupe.ts';

const page = (source: string, slug: string, title: string, emails: string[] = []): WrittenPage => ({ key: `${source}:${slug}`, source, slug, type: 'person', title, emails, domains: [], linkedin: null, github: null, company: null, city: null });
const company = (source: string, slug: string, title: string, domains: string[] = [], linkedin: string | null = null): WrittenPage => ({ key: `${source}:companies/${slug}`, source, slug: `companies/${slug}`, type: 'company', title, emails: [], domains, linkedin, github: null, company: null, city: null });

describe('person-dedupe generator', () => {
  test('same seed gives the same ledger; another seed gives another', () => {
    expect(ledgerFingerprint(generateLedger())).toBe(ledgerFingerprint(generateLedger(PERSON_DEDUPE_DEFAULT_SEED)));
    expect(ledgerFingerprint(generateLedger(PERSON_DEDUPE_DEFAULT_SEED + 1))).not.toBe(ledgerFingerprint(generateLedger()));
  });

  test('gold agrees with every family on many seeds, and every family plants pairs', () => {
    for (let seed = 1; seed <= 40; seed++) expect(() => deriveGold(generateLedger(seed, 6))).not.toThrow();
    const ledger = generateLedger();
    for (const f of FAMILIES) expect(ledger.pairs.some(p => p.family === f.id)).toBe(true);
    expect(ledger.pairs.some(p => p.label === 'same') && ledger.pairs.some(p => p.label === 'different')).toBe(true);
  });

  test('a rendered page reads back with the same fields and never carries the person id', () => {
    for (const p of generateLedger(3, 2).pages) {
      const md = renderPage(p);
      expect(md).not.toContain(p.person);
      const w = parseWrittenPage(p.source, p.slug, md);
      expect([w.key, w.title, w.emails, w.company, w.city]).toEqual([pageKey(p), p.title, p.emails, p.company, p.city]);
    }
  });

  test('the team address sits on exactly five pages in the alias-on-5 family and six in alias-on-6', () => {
    const ledger = generateLedger(PERSON_DEDUPE_DEFAULT_SEED, 2);
    for (const [fam, n] of [['diff-namesake-alias-on-5', 5], ['diff-namesake-alias-on-6', 6]] as const) {
      const pages = ledger.pages.filter(p => p.family === fam && p.instance === 0);
      const team = pages[0].emails.find(e => e.startsWith('team-'))!;
      expect(ledger.pages.filter(p => p.emails.includes(team)).length).toBe(n);
    }
  });
});

describe('shared exclusive ids in the generated world', () => {
  const world = (seed: number) => {
    const people = generateLedger(seed);
    const companies = generateCompanyLedger(seed, PERSON_DEDUPE_DEFAULT_PER_FAMILY);
    const pages = [...writtenPages({ ...people, pages: [...people.pages, ...(companies.founders ?? [])] }), ...companyWrittenPages(companies)];
    return { people, companies, pages };
  };

  test('two seeds have disjoint LinkedIn paths and GitHub logins across people and companies', () => {
    const ids = (seed: number) => {
      const { pages } = world(seed);
      expect(pages.some(p => p.type === 'company' && p.linkedin)).toBe(true);
      expect(pages.some(p => p.type === 'person' && p.linkedin)).toBe(true);
      expect(pages.some(p => p.type === 'person' && p.github)).toBe(true);
      return new Set(pages.flatMap(pageKeys).filter(k => /^(linkedin|github):/.test(k)));
    };
    const a = ids(401), b = ids(402);
    expect([...a].filter(k => b.has(k))).toEqual([]);
  });

  test('a declared id is an exclusive key unless it is a placeholder, all zeros or over 320 characters', () => {
    const declared = (external_id: string) => pageKeys({ ...page('work', 'x', 'X Y'), external_id }).filter(k => k.startsWith('declared_id:'));
    expect(declared(' CRM-12 ')).toEqual(['declared_id:crm-12']);
    expect(declared('x'.repeat(320))).toEqual([`declared_id:${'x'.repeat(320)}`]);
    for (const bad of ['', 'n/a', 'Unknown', '000', 'x'.repeat(321)]) expect(declared(bad)).toEqual([]);
  });

  test('the rendered collisions and controls share the named id, with no out-of-instance holder', () => {
    const { people, companies, pages } = world(PERSON_DEDUPE_DEFAULT_SEED);
    const keys = new Map(pages.map(p => [p.key, pageKeys(p)]));
    const byPage = new Map(pages.map(p => [p.key, p]));
    const holders = new Map<string, string[]>();
    for (const [page, ids] of keys) for (const id of ids) holders.set(id, [...(holders.get(id) ?? []), page]);
    for (const [family, kind, different, same, size] of [
      ['diff-recycled-github', 'github', 16, 4, 2],
      ['diff-wrong-linkedin', 'linkedin', 16, 4, 2],
      ['diff-declared-id-typo', 'declared_id', 16, 4, 2],
      ['diff-shared-github-account', 'github', 40, 20, 3],
      ['co-diff-founder-linkedin', 'linkedin', 16, 4, 2],
    ] as const) {
      const pairs = [...people.pairs, ...companies.pairs].filter(p => p.family === family);
      expect(new Set(pairs.map(p => p.instance)).size).toBe(20);
      expect(pairs.filter(p => p.label === 'different').length).toBe(different);
      expect(pairs.filter(p => p.label === 'same').length).toBe(same);
      for (const { a, b, instance, label } of pairs) {
        const shared = keys.get(a)!.filter(id => id.startsWith(`${kind}:`) && keys.get(b)!.includes(id));
        expect(shared).toHaveLength(1);
        const instancePages = new Set(pairs.filter(p => p.instance === instance).flatMap(p => [p.a, p.b]));
        expect(new Set(holders.get(shared[0]))).toEqual(instancePages);
        expect(instancePages.size).toBe(size);
        if (family === 'co-diff-founder-linkedin') expect(byPage.get(a)!.type === byPage.get(b)!.type).toBe(label === 'same');
        if (size === 2) expect(byPage.get(a)!.source).not.toBe(byPage.get(b)!.source);
      }
    }
  });

  test('both gold checks reject flipped labels in the mixed families', () => {
    const { people, companies } = world(PERSON_DEDUPE_DEFAULT_SEED);
    for (const family of ['diff-recycled-github', 'diff-wrong-linkedin', 'diff-declared-id-typo', 'diff-shared-github-account']) {
      const p = people.pairs.find(p => p.family === family && p.label === 'different')!;
      expect(() => deriveGold({ ...people, pairs: [{ ...p, label: 'same' }] })).toThrow(/people say different/);
    }
    const p = companies.pairs.find(p => p.family === 'co-diff-founder-linkedin' && p.label === 'different')!;
    expect(() => deriveCompanyGold({ ...companies, pairs: [{ ...p, label: 'same' }] })).toThrow(/companies say different/);
  });
});

describe('finder contract emulator', () => {
  const world = [
    page('source-a', 'alice-example', 'Alice Example', ['alice@example.com']),
    page('source-b', 'alice-example', 'Alice Example', ['Alice@Example.com']),
    page('source-a', 'bob-sample', 'Bob Sample'),
    page('source-b', 'bob-sample', 'Bob Sample'),
    page('source-a', 'carol-example', 'Carol Example', ['family@example.com']),
    page('source-b', 'dan-example', 'Dan Example', ['family@example.com']),
  ];

  test('reproduces the contract\'s example output: kinds, classes and group ids', () => {
    const out = emulateFinder(world);
    const got = out.groups.map(g => [g.id, g.kind, g.class, g.members.map(m => `${m.source_id}/${m.slug}`)]).sort();
    expect(got).toEqual([
      ['dedupe/4614d2e6ef83ae17', 'cross_source', 'clean', ['source-a/people/alice-example', 'source-b/people/alice-example']],
      ['dedupe/bb5b6b953902169e', 'conflict', 'conflict', ['source-a/people/carol-example', 'source-b/people/dan-example']],
      ['dedupe/e45a80f4192f417d', 'cross_source', 'weak', ['source-a/people/bob-sample', 'source-b/people/bob-sample']],
    ].sort());
    expect(out.counts.by_class).toEqual({ clean: 1, likely: 0, weak: 1, thin: 0, conflict: 1 });
    expect(JSON.stringify(out)).not.toContain('@');
  });

  test('folds and keys follow the contract', () => {
    expect(strictFold('José Example')).toBe(strictFold('Jose Example'));
    expect(strictFold('Sam Example Jr')).not.toBe(strictFold('Sam Example'));
    expect(variantFold('Dr. Sam Example')).toBe(strictFold('Sam Example'));
    for (const v of ['0', '000', 'unknown', 'N/A', '', 'no-at-sign']) expect(emailKey(v)).toBeNull();
    expect(emailKey(' A@B.example ')).toBe('a@b.example');
  });

  test('a key on more than five pages is crowded and forms no group', () => {
    const six = Array.from({ length: 6 }, (_, i) => page(i % 2 ? 'b' : 'a', `p${i}`, `Person ${i} Example`, ['office@example.com']));
    const out = emulateFinder(six);
    expect(out.groups.length).toBe(0);
    expect(out.counts.crowded_key_values).toBe(1);
    expect(emulateFinder(six.slice(0, 5)).groups.map(g => g.class)).toEqual(['conflict']);
  });
});

describe('clean-rule arms', () => {
  test('a person and a company sharing an exclusive id never form a clean group, under any arm', () => {
    const li = 'https://www.linkedin.com/in/ada-founder';
    const pages = [{ ...page('work', 'ada-lark', 'Ada Lark'), linkedin: li }, company('home', 'ada-lark', 'Ada Lark', [], li)];
    for (const [, a] of Object.entries(ARMS)) expect(emulateFinder(pages, a.rule).groups.filter(g => g.class === 'clean')).toEqual([]);
  });
  const pair = (title: string, emails: string[], li?: [string, string]) => [
    { ...page('a', 'x', title, emails), linkedin: li ? `https://www.linkedin.com/in/${li[0]}` : null },
    { ...page('b', 'x', title, emails), linkedin: li ? `https://www.linkedin.com/in/${li[1]}` : null },
  ];
  const cls = (pages: WrittenPage[], arm: string) => emulateFinder(pages, ARMS[arm].rule).groups.map(g => g.class);

  test('a team address alone makes clean under the approved rule and not without role keys', () => {
    const team = pair('Sam Example', ['team-ops@example.com']);
    expect(isRoleEmail('team-ops@example.com') && isRoleEmail('lee.family7@mail.example') && !isRoleEmail('sam.example@example.com')).toBe(true);
    expect(cls(team, '1')).toEqual(['clean']);
    expect(cls(team, '2')).toEqual(['likely']);
    expect(cls(pair('Sam Example', ['sam@example.com']), '3')).toEqual(['likely']);
    expect(cls(pair('Sam Example', ['sam@example.com'], ['sam', 'sam']), '3')).toEqual(['clean']);
  });

  test('arm 6 keeps a role address on a domain that belongs to one person', () => {
    const studio = pair('Sam Example', ['hello@samexamplestudio.example']);
    expect(cls(studio, '5')).toEqual(['likely']);
    expect(cls(studio, '6')).toEqual(['clean']);
    expect(cls([...pair('Sam Example', ['team-ops@acme.example']), page('a', 'y', 'Lee Other', ['lee@acme.example'])], '6')).toEqual(['likely']);
  });

  test('the key-type split links on a shared LinkedIn alone, and on an email only with the same employer', () => {
    expect(cls(pair('Sam Example', [], ['sam', 'sam']), '2b')).toEqual(['clean']);
    expect(cls(pair('Sam Example', ['sam@example.com']), '2b')).toEqual(['likely']);
    const sameJob = pair('Sam Example', ['sam@example.com']).map(p => ({ ...p, company: 'Acme' }));
    expect(cls(sameJob, '2b')).toEqual(['clean']);
    expect(cls(sameJob, '7')).toEqual(['likely']);
    expect(cls(pair('Sam Example', [], ['sam', 'sam']), '7')).toEqual(['clean']);
  });

  test('a bridge page joins two namesakes through two clean groups, and the union check stops it', () => {
    const a = { ...page('work', 'sam', 'Sam Example'), github: 'samex' };
    const b = { ...page('work', 'sam-2', 'Sam Example'), linkedin: 'https://www.linkedin.com/in/samex-2' };
    const bridge = { ...page('home', 'sam', 'Sam Example'), github: 'samex', linkedin: 'https://www.linkedin.com/in/samex-2' };
    expect(cls([a, b, bridge], '4')).toEqual(['clean', 'clean', 'weak']);
    expect(cls([a, b, bridge], '4+union')).toEqual(['likely', 'likely', 'weak']);
  });

  test('a disagreeing LinkedIn sends the group to conflict, and two different emails do not', () => {
    expect(cls(pair('Sam Example', ['team-ops@example.com'], ['sam-1', 'sam-2']), '4')).toEqual(['conflict']);
    const twoEmails = [page('a', 'x', 'Sam Example', ['sam@work.example']), page('b', 'x', 'Sam Example', ['sam@home.example'])];
    expect(cls(twoEmails, '4')).toEqual(['weak']);
  });
});

describe('finder output parser', () => {
  const known = new Set(['work:a', 'home:a']);
  const ok = toFinderOutput([{ members: ['home:a', 'work:a'], kind: 'cross_source', class: 'clean', rules: ['shared_key:email'] }]);
  test('reads the documented shape', () => {
    expect(parseFinderOutput(ok, known)).toEqual([{ members: ['home:a', 'work:a'], kind: 'cross_source', class: 'clean', rules: ['shared_key/shared_key/email'] }]);
  });
  test('refuses another schema version, an extra key, an unknown class and a page the world does not have', () => {
    expect(() => parseFinderOutput({ ...ok, schema_version: 2 }, known)).toThrow(/schema_version/);
    expect(() => parseFinderOutput({ ...ok, extra: 1 }, known)).toThrow(/keys/);
    expect(() => parseFinderOutput({ ...ok, groups: [{ ...ok.groups[0], class: 'sure' }] }, known)).toThrow(/class/);
    expect(() => parseFinderOutput({ ...ok, groups: [{ ...ok.groups[0], members: [{ source_id: 'work', slug: 'people/zed' }] }] }, known)).toThrow(/does not have/);
  });
  test('group ids follow the contract rule', () => {
    expect(groupId('cross_source', ['source-a:alice-example', 'source-b:alice-example'])).toBe('dedupe/4614d2e6ef83ae17');
  });
  test('the confirm list holds cross-source likely groups marked contact_key_only, and nothing else', () => {
    const groups = parseFinderOutput(toFinderOutput([
      { members: ['home:a', 'work:a'], kind: 'cross_source', class: 'likely', rules: ['shared_key:email', 'contact_key_only'] },
      { members: ['home:a', 'work:a'], kind: 'cross_source', class: 'likely', rules: ['shared_key:email'] },
      { members: ['home:a', 'work:a'], kind: 'cross_source', class: 'likely', rules: ['shared_key:linkedin'] },
      { members: ['home:a', 'work:a'], kind: 'cross_source', class: 'conflict', rules: ['shared_key:email', 'contact_key_only'] },
      { members: ['home:a', 'work:a'], kind: 'cross_source', class: 'clean', rules: ['shared_key:email'] },
    ]), known);
    expect(groups.filter(SELECTIONS['confirm-list']).map(g => g.rules)).toEqual([['shared_key/shared_key/email', 'key_check/contact_key_only']]);
    expect(groups.filter(SELECTIONS['auto-link+confirm-list']).map(g => g.class)).toEqual(['likely', 'clean']);
  });
  test('the confirm list reads the contact_key_only mark under any matcher name', () => {
    const out = toFinderOutput([{ members: ['home:a', 'work:a'], kind: 'cross_source', class: 'likely', rules: ['shared_key:email'] }]);
    out.groups[0].evidence.push({ matcher: 'shared_key', rule: 'contact_key_only' });
    expect(parseFinderOutput(out, known).filter(SELECTIONS['confirm-list']).length).toBe(1);
  });
});

describe('person-dedupe scorer', () => {
  const person = new Map([['w:a', 'P'], ['h:a', 'P'], ['w:b', 'Q'], ['h:b', 'R'], ['w:c', 'S']]);
  const pairs: DesignedPair[] = [
    { a: 'w:a', b: 'h:a', family: 'same-exact', instance: 0, label: 'same' },
    { a: 'w:b', b: 'h:b', family: 'diff-namesake', instance: 0, label: 'different' },
    { a: 'w:a', b: 'w:c', family: 'diff-transitive-chain', instance: 0, label: 'different' },
  ];
  const g = (members: string[]): Group => ({ members, kind: 'cross_source', class: 'clean', rules: ['t'] });

  test('the true grouping passes; a namesake merge and a chain through closure fail', () => {
    expect(verdictOf(scoreGroups([g(['h:a', 'w:a'])], pairs, person)).pass).toBe(true);
    const namesake = scoreGroups([g(['h:a', 'w:a']), g(['h:b', 'w:b'])], pairs, person);
    expect(namesake.false_merge.k).toBe(1);
    expect(verdictOf(namesake).pass).toBe(false);
    const chain = scoreGroups([g(['h:a', 'w:a']), g(['h:a', 'w:c'])], pairs, person);
    expect(chain.false_merge_cases).toEqual([{ a: 'w:a', b: 'w:c', family: 'diff-transitive-chain', via: ['closure'] }]);
  });

  test('refusing everything fails the utility floor', () => {
    expect(verdictOf(scoreGroups([], pairs, person)).shortfalls.join()).toMatch(/plain duplicates/);
  });

  test('a broken finder that links every same-name pair fails on the generated world', () => {
    const ledger = generateLedger(PERSON_DEDUPE_DEFAULT_SEED, 3);
    const byName = new Map<string, string[]>();
    for (const p of ledger.pages) byName.set(strictFold(p.title), [...(byName.get(strictFold(p.title)) ?? []), pageKey(p)]);
    const groups = [...byName.values()].filter(m => m.length > 1).map(m => ({ members: m.sort(), kind: 'cross_source', class: 'clean', rules: ['shared_key:email'] }));
    const arms = runPersonDedupe(ledger, { finderJson: toFinderOutput(groups), finderBuild: 'broken-fixture' });
    const auto = arms.find(a => a.id === 'finder:auto-link')!;
    expect(auto.verdict.pass).toBe(false);
    expect(auto.score.false_merge.k).toBeGreaterThan(0);
  });

  test('the scorer passes the honest system and fails the fake ones', () => {
    const ledger = generateLedger(PERSON_DEDUPE_DEFAULT_SEED, 3);
    const gold = deriveGold(ledger);
    const title = new Map(ledger.pages.map(p => [pageKey(p), p.title]));
    const score = (answers: readonly boolean[]) => {
      const v = verdictOf(scoreGroups(ledger.pairs.filter((_, i) => answers[i]).map(p => g([p.a, p.b])), ledger.pairs, gold));
      return { pass: v.pass, detail: v.shortfalls.join('; ') || 'ok' };
    };
    assertScorerRejectsFakeSystems<DesignedPair, boolean>({
      category: 'person-dedupe',
      probes: ledger.pairs,
      space: {
        truth: p => p.label === 'same',
        empty: () => false,
        everything: () => true,
        refusal: () => false,
        wrongSource: p => p.label === 'different' && strictFold(title.get(p.a)!) === strictFold(title.get(p.b)!) ? true : undefined,
      },
      score,
      notApplicable: { stale: 'person-dedupe has no time axis: a page belongs to one person for the whole world' },
    });
  });
});

describe('real-finder run guards', () => {
  test('writeWorld refuses a directory that already holds files, and writes into an empty one', () => {
    const ledger = generateLedger(3, 1);
    const dir = mkdtempSync(join(tmpdir(), 'pd-world-'));
    try {
      writeWorld(ledger, join(dir, 'fresh'));
      expect(() => writeWorld(generateLedger(4, 1), join(dir, 'fresh'))).toThrow(/not empty/);
      const used = join(dir, 'used');
      mkdirSync(used);
      writeFileSync(join(used, 'stale.md'), 'old world');
      expect(() => writeWorld(ledger, used)).toThrow(/not empty/);
      mkdirSync(join(dir, 'empty'));
      expect(() => writeWorld(ledger, join(dir, 'empty'))).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('coverage passes only when every source imported every page with no failure', () => {
    const ledger = generateLedger(3, 1);
    const per = new Map<string, number>();
    for (const p of ledger.pages) per.set(p.source, (per.get(p.source) ?? 0) + 1);
    const ok = [...per].map(([source_id, n]) => ({ status: 'success', source_id, imported: n, unchanged: 0, total_files: n, errors: 0, malformed_skipped: 0, failures: [] as unknown[], skipped: 0, chunks: n, duration_s: 0.1 }));
    expect(() => checkFinderCoverage(ok, ledger.pages)).not.toThrow();
    expect(() => checkFinderCoverage(ok.slice(1), ledger.pages)).toThrow(/never saw/);
    expect(() => checkFinderCoverage([{ ...ok[0], imported: ok[0].imported - 1 }, ...ok.slice(1)], ledger.pages)).toThrow(/missing pages/);
    expect(() => checkFinderCoverage([{ ...ok[0], imported: ok[0].imported - 1, unchanged: 1 }, ...ok.slice(1)], ledger.pages)).toThrow(/1 unchanged/);
    expect(() => checkFinderCoverage([{ ...ok[0], errors: 1 }, ...ok.slice(1)], ledger.pages)).toThrow(/errors/);
    expect(() => checkFinderCoverage([{ ...ok[0], malformed_skipped: 1 }, ...ok.slice(1)], ledger.pages)).toThrow(/malformed/);
    expect(() => checkFinderCoverage([{ ...ok[0], failures: [{ path: 'x' }] }, ...ok.slice(1)], ledger.pages)).toThrow(/failures/);
    expect(() => checkFinderCoverage([...ok, ok[0]], ledger.pages)).toThrow(/two import summaries/);
    expect(() => checkFinderCoverage([...ok, { ...ok[0], source_id: 'elsewhere' }], ledger.pages)).toThrow(/does not have/);
  });
});

describe('company pages', () => {
  test('the company world is seeded on its own stream and leaves every person page where v1 put it', () => {
    const v1 = JSON.parse(readFileSync(join(import.meta.dir, '../../docs/benchmarks/2026-11-17-person-dedupe/receipt.json'), 'utf8'));
    const { seed, per_family, generator_version, sha256 } = v1.data.ledger;
    expect(ledgerFingerprint(generateLedger(seed, per_family, generator_version))).toBe(sha256);
    expect(companySeed(PERSON_DEDUPE_DEFAULT_SEED)).not.toBe(PERSON_DEDUPE_DEFAULT_SEED);
    const a = generateCompanyLedger(PERSON_DEDUPE_DEFAULT_SEED, PERSON_DEDUPE_DEFAULT_PER_FAMILY);
    expect(ledgerFingerprint(a)).toBe(ledgerFingerprint(generateCompanyLedger(PERSON_DEDUPE_DEFAULT_SEED, PERSON_DEDUPE_DEFAULT_PER_FAMILY)));
    expect(ledgerFingerprint(generateCompanyLedger(PERSON_DEDUPE_DEFAULT_SEED + 1, PERSON_DEDUPE_DEFAULT_PER_FAMILY))).not.toBe(ledgerFingerprint(a));
  });

  test('gold agrees with every company family on many seeds, and every family plants pairs', () => {
    for (let seed = 1; seed <= 40; seed++) expect(() => deriveCompanyGold(generateCompanyLedger(seed, 6))).not.toThrow();
    const ledger = generateCompanyLedger(PERSON_DEDUPE_DEFAULT_SEED, PERSON_DEDUPE_DEFAULT_PER_FAMILY);
    for (const f of COMPANY_FAMILIES) expect(ledger.pairs.some(p => p.family === f.id)).toBe(true);
    expect(new Set(ledger.pages.map(companyPageKey)).size).toBe(ledger.pages.length);
    expect(ledger.pages.every(p => p.domains.every(d => d.endsWith('.example')) && (!p.website || new URL(p.website).hostname.endsWith('.example')))).toBe(true);
  });

  test('a rendered company page has type company, reads back its domain and website, and never carries the company id', () => {
    for (const p of generateCompanyLedger(3, 3).pages) {
      const md = renderCompanyPage(p);
      expect(md).toContain('type: company');
      expect(md).not.toContain(p.company);
      expect(md).not.toContain(p.company.replace(/-/g, ''));
      expect(md).not.toContain(p.family.replace(/-/g, ''));
      const w = parseCompanyPage(p.source, p.slug, md);
      expect([w.key, w.type, w.title, w.linkedin, w.city]).toEqual([companyPageKey(p), 'company', p.title, p.linkedin, p.city]);
      expect(w.domains).toEqual([...p.domains, ...(p.website ? [p.website] : [])]);
    }
  });

  test('company keys and folds follow the contract: the website host is a domain, and the variant fold drops suffixes only for companies', () => {
    expect(domainKey('https://www.Halwick.example/labs?x=1')).toBe('halwick.example');
    expect(domainKey('uk.halwick.example')).toBe('uk.halwick.example');
    expect(domainKey('not a domain')).toBeNull();
    expect(variantFold('Halwick, Inc.', 'company')).toBe('halwick');
    expect(variantFold('Halwick Labs', 'company')).toBe('halwick');
    expect(variantFold('Sam Example Co', 'person')).toBe('sam example co');
  });

  test('the stand-in classes company groups by the contract', () => {
    const cls = (pages: WrittenPage[], arm = '1') => emulateFinder(pages, ARMS[arm].rule).groups.map(g => `${g.kind}/${g.class}`);
    const franchise = [company('work', 'halwick-bakery', 'Halwick Bakery', ['https://www.halwickbakery.example/leeds']), company('home', 'halwick-bakery', 'Halwick Bakery', ['https://www.halwickbakery.example/york'])];
    expect(cls(franchise)).toEqual(['cross_source/clean']);
    const vetoed = franchise.map((p, i) => ({ ...p, linkedin: `https://www.linkedin.com/company/halwick-${i}` }));
    expect(cls(vetoed, '4')).toEqual(['conflict/conflict']);
    expect(cls(franchise, '2b')).toEqual(['cross_source/likely']);
    expect(cls([company('work', 'halwick', 'Halwick', ['halwick.example']), company('home', 'halwick-labs', 'Halwick Labs', ['https://www.halwick.example/labs'])])).toEqual(['cross_source/likely']);
    expect(cls([company('work', 'halwick-group', 'Halwick Group', ['halwick.example']), company('home', 'halwick-rail', 'Halwick Rail', ['halwick.example'])])).toEqual(['conflict/conflict']);
    expect(cls([company('work', 'sam-example', 'Sam Example'), page('home', 'sam-example', 'Sam Example')])).toEqual([]);
  });

  test('company groups go through the finder\'s JSON shape with companies/ slugs', () => {
    const known = new Set(['work:companies/halwick', 'home:companies/halwick', 'work:halwick']);
    const out = toFinderOutput([{ members: ['home:companies/halwick', 'work:companies/halwick'], kind: 'cross_source', class: 'clean', rules: ['shared_key:domain'] }]);
    expect(out.groups[0].members).toEqual([{ source_id: 'home', slug: 'companies/halwick' }, { source_id: 'work', slug: 'companies/halwick' }]);
    expect(parseFinderOutput(out, known)[0].members).toEqual(['home:companies/halwick', 'work:companies/halwick']);
  });

  test('every reference matcher and stand-in arm says what it does on company pages', () => {
    for (const m of REFERENCE_MATCHERS) expect(m.company.length).toBeGreaterThan(0);
    for (const a of Object.values(ARMS)) expect(a.company.length).toBeGreaterThan(0);
    expect(ARMS['2'].company).toMatch(/no company rule/);
  });
});

describe('type-split scoring', () => {
  const gold = new Map([['w:p1', 'P1'], ['h:p2', 'P2'], ['w:companies/c', 'C'], ['h:companies/c', 'C']]);
  const pairs: DesignedPair[] = [
    { a: 'w:p1', b: 'h:p2', family: 'diff-namesake', instance: 0, label: 'different' },
    { a: 'w:companies/c', b: 'h:companies/c', family: 'co-same-exact', instance: 0, label: 'same' },
  ];
  const g = (members: string[]): Group => ({ members, kind: 'cross_source', class: 'clean', rules: ['t'] });

  test('a chain through a company page still merges two people in the people score', () => {
    const groups = [g(['w:companies/c', 'w:p1']), g(['h:p2', 'w:companies/c'])];
    const people = new Map([...gold].filter(([k]) => !k.includes('companies/')));
    const s = scoreGroups(groups, pairs.slice(0, 1), people, groups);
    expect(s.false_merge.k).toBe(1);
    expect(scoreGroups([], pairs.slice(0, 1), people, groups).false_merge.k).toBe(1);
    expect(scoreGroups([], pairs.slice(0, 1), people).false_merge.k).toBe(0);
  });

  test('the company verdict names companies and its own plain duplicates', () => {
    const s = scoreGroups([g(['h:p2', 'w:p1'])], pairs, gold);
    expect(verdictOf(s, 'all').shortfalls).toEqual(['1 of 1 designed different-entity pairs merged (target 0)', 'found 0 of 1 plain duplicates (same name, same email or domain, two sources; target all)']);
    expect(verdictOf(s, 'company').shortfalls[0]).toMatch(/different-company/);
  });

  test('a people-only world scores no companies; with companies, a finder that links a person to a company counts a cross-type merge', () => {
    const ledger = generateLedger(PERSON_DEDUPE_DEFAULT_SEED, 2);
    expect(runPersonDedupe(ledger)[0].by_type.company).toBeNull();
    const companies = generateCompanyLedger(PERSON_DEDUPE_DEFAULT_SEED, 2, 1);
    const p = pageKey(ledger.pages[0]), c = companyPageKey(companies.pages[0]);
    const arms = runPersonDedupe(ledger, { companies, finderJson: toFinderOutput([{ members: [c, p].sort(), kind: 'cross_source', class: 'clean', rules: ['shared_key:email'] }]), finderBuild: 'cross-type-fixture' });
    const auto = arms.find(a => a.id === 'finder:auto-link')!;
    expect(auto.cross_type_merges).toBe(1);
    expect(auto.score.false_merges_anywhere).toBe(1);
    expect(auto.by_type.person.score.false_merges_anywhere + auto.by_type.company!.score.false_merges_anywhere).toBe(0);
    expect(arms.filter(a => a.system !== 'finder').every(a => a.cross_type_merges === 0)).toBe(true);
  });

  test('adding companies leaves every person number of the published v1 receipt byte-identical', () => {
    const v1 = JSON.parse(readFileSync(join(import.meta.dir, '../../docs/benchmarks/2026-11-17-person-dedupe/receipt.json'), 'utf8'));
    const { seed, per_family, generator_version } = v1.data.ledger;
    const arms = runPersonDedupe(generateLedger(seed, per_family, generator_version), { companies: generateCompanyLedger(seed, per_family, 1) });
    const brief = (s: Score) => ({ ...s, false_merge_cases: `${s.false_merge_cases.length} cases; listed only for auto-link selections` });
    expect(arms.map(a => a.id)).toEqual(v1.data.arms.map((a: { id: string }) => a.id));
    for (const old of v1.data.arms) {
      const now = arms.find(a => a.id === old.id)!;
      const score = now.selection === 'auto-link' ? now.by_type.person.score : brief(now.by_type.person.score);
      expect(JSON.stringify({ score, verdict: now.by_type.person.verdict })).toBe(JSON.stringify({ score: old.score, verdict: old.verdict }));
    }
  }, 60_000);

  test('the designed founder collision is scored together and never in a single-type denominator', () => {
    const ledger = generateLedger(PERSON_DEDUPE_DEFAULT_SEED, 1);
    const companies = generateCompanyLedger(PERSON_DEDUPE_DEFAULT_SEED, 1);
    const family = 'co-diff-founder-linkedin';
    const { a, b } = companies.pairs.find(p => p.family === family)!;
    const finderJson = toFinderOutput([g([a, b])]);
    const auto = runPersonDedupe(ledger, { companies, finderJson }).find(a => a.id === 'finder:auto-link')!;
    expect(auto.score.by_family[family].false_merge).toMatchObject({ k: 1, n: 1 });
    expect(auto.by_type.person.score.by_family[family]).toBeUndefined();
    expect(auto.by_type.company!.score.by_family[family]).toBeUndefined();
    expect(auto.cross_type_merges).toBe(1);
  });
});
