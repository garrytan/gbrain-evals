import { describe, expect, test } from 'bun:test';
import {
  FAMILIES, PERSON_DEDUPE_DEFAULT_SEED, deriveGold, generateLedger, ledgerFingerprint, pageKey, parseWrittenPage, renderPage,
  type DesignedPair, type WrittenPage,
} from '../../eval/generators/person-dedupe-gen.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import {
  ARMS, emailKey, emulateFinder, groupId, isRoleEmail, parseFinderOutput, runPersonDedupe, scoreGroups, strictFold, toFinderOutput, variantFold, verdictOf,
  type Group,
} from '../../eval/runner/person-dedupe.ts';

const page = (source: string, slug: string, title: string, emails: string[] = []): WrittenPage => ({ key: `${source}:${slug}`, source, slug, title, emails, linkedin: null, github: null, company: null, city: null });

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
