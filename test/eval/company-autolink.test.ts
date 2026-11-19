import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCompanyLedger } from '../../eval/generators/company-dedupe-gen.ts';
import { COMPANY_V_DEV_SEED, COMPANY_V_FAMILIES, generateCompanyVWorld } from '../../eval/generators/company-dedupe-v-gen.ts';
import {
  COMPANY_AUTOLINK_ARMS, companyAutoLink, companyInitials, companyProposed, dottedVariantFold, formatCompanyAutoLink, hasUrlPath, initialsMatch,
  ownSiteDomains, registrableDomain, rejectionMemory, runCompanyAutoLink,
} from '../../eval/runner/company-autolink.ts';
import { ARMS, SELECTIONS, emulateFinder, parseFinderOutput, variantFold } from '../../eval/runner/person-dedupe.ts';
import { DEV_SEED, HELD_OUT_SEED, buildWorld } from '../../eval/runner/entity-h2h/world.ts';

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x, (_k, v) => v instanceof Map ? [...v] : v)).digest('hex');

describe('the default worlds are unchanged by the opt-in company families', () => {
  // Computed on main at 20f30c00, before the V families and company auto-link arms existed.
  test('the entity-dedupe head-to-head world hashes as it did, at the dev and held-out seeds', () => {
    for (const [seed, want] of [[DEV_SEED, '8314c91f7928ab236280d3cc45157e2dffb4a9426c196737b0b395e186164e4f'], [HELD_OUT_SEED, 'd19722c4f0ce59df6f7afe10bec22d0327461138b20bec2a4bee0c80a082ec70']] as const) {
      const w = buildWorld(seed, 20);
      expect(hash({ pages: w.pages, pairs: w.pairs, gold: w.gold, fp: w.fingerprints })).toBe(want);
    }
  });
  test('the company ledger at both generator versions and the contract emulator hash as they did', () => {
    expect(hash(generateCompanyLedger(DEV_SEED, 20, 1))).toBe('1d25f9b7b45aa381bd23e0b7c3da69bee4be486eef3519f237b4672f6286dcc6');
    expect(hash(generateCompanyLedger(DEV_SEED, 20, 2))).toBe('0b1b384cbda2d047131d3a697ec85e78d4f0983afeea78920596e6d1941943cd');
    const pages = buildWorld(DEV_SEED, 20).pages.map(p => p.written);
    expect(hash(emulateFinder(pages, ARMS['1'].rule))).toBe('aba4824f056429796fe2a88adfbfee04554c81d3b18979eead6b8c21bd47535e');
    expect(hash(emulateFinder(pages, ARMS['7'].rule))).toBe('17f605f33e1ba903e3375e0b6eb07f7a7389e5f17bddb2ecc7d78a0e169d333f');
  });
});

describe('company V families', () => {
  const w = generateCompanyVWorld();
  test('dev seed only, and the same seed gives the same world', () => {
    expect(() => generateCompanyVWorld(COMPANY_V_DEV_SEED + 1)).toThrow(/development families/);
    expect(hash(generateCompanyVWorld())).toBe(hash(w));
  });
  test('every family and variant plants pairs with the family label, and gold agrees', () => {
    for (const f of COMPANY_V_FAMILIES) {
      const ps = w.pairs.filter(p => p.family === f.id);
      expect(ps.length).toBe(f.id === 'v-renamed-namesake' ? 10 : 20);
      expect(new Set(ps.map(p => p.variant))).toEqual(new Set(f.variants));
      for (const p of ps) expect(w.gold.get(p.a) === w.gold.get(p.b)).toBe(f.label === 'same');
    }
    expect(new Set(w.pages.map(p => p.key)).size).toBe(w.pages.length);
    expect(new Set(w.pages.map(p => p.page_id)).size).toBe(w.pages.length);
  });
  test('a moved or renamed page keeps its page id, and each rejection records both ids and both keys at rejection', () => {
    expect(w.changes.length).toBe(20);
    for (const { before, after } of w.changes) {
      expect(after.page_id).toBe(before.page_id);
      expect(after.key).not.toBe(before.key);
      expect(w.pages.some(p => p.key === before.key)).toBe(false);
      const r = w.rejections.find(x => x.b_id === before.page_id)!;
      expect(r.b_key).toBe(before.key);
      expect(w.pages.find(p => p.page_id === r.a_id)!.key).toBe(r.a_key);
    }
  });
  test('the limit families have the designed shapes', () => {
    const page = (k: string) => w.pages.find(p => p.key === k)!;
    for (const p of w.pairs.filter(x => x.family === 'v-shared-linkedin')) {
      const [a, b] = [page(p.a), page(p.b)];
      expect(a.linkedin).toBe(b.linkedin);
      expect(variantFold(a.title, 'company') === variantFold(b.title, 'company')).toBe(p.variant!.startsWith('same name'));
    }
    for (const p of w.pairs.filter(x => x.family === 'v-subsidiary-root-domain')) {
      const [a, b] = [page(p.a), page(p.b)];
      expect(ownSiteDomains(b)).toEqual(ownSiteDomains(a));
      expect(b.domains.some(hasUrlPath)).toBe(false);
      expect(variantFold(a.title, 'company') === variantFold(b.title, 'company')).toBe(p.variant!.includes('fold drops'));
    }
  });
});

describe('person-dedupe --company-autolink', () => {
  const run = (...args: string[]) => Bun.spawnSync(['bun', 'eval/runner/person-dedupe.ts', '--company-autolink', ...args], { env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', PARTICLE_API_KEY: '' } });
  test('refuses a seed other than the dev seed before any work, and a per-family count the name pool cannot fill', () => {
    const out = mkdtempSync(join(tmpdir(), 'company-autolink-'));
    const seed = run('--seed', '7', '--output', out);
    expect(seed.exitCode).not.toBe(0);
    expect(seed.stderr.toString() + seed.stdout.toString()).toContain('runs only on the dev seed');
    const big = run('--per-family', '40', '--output', out);
    expect(big.exitCode).not.toBe(0);
    expect(big.stderr.toString() + big.stdout.toString()).toContain('name pool exhausted');
    expect(readdirSync(out)).toEqual([]);
  });
});

describe('company auto-link rules', () => {
  test('new folds and keys: dotted abbreviations, own-site domains, registrable domains and initials', () => {
    expect(variantFold('Iselwood, L.L.C.', 'company')).toBe('iselwood l l c');
    expect(dottedVariantFold('Iselwood, L.L.C.')).toBe('iselwood');
    expect(dottedVariantFold('Iselwood LLC')).toBe('iselwood');
    expect(ownSiteDomains({ domains: ['halwick.example', 'https://www.halwick.example/labs'] })).toEqual([]);
    expect(ownSiteDomains({ domains: ['halwick.example', 'https://www.halwick.example'] })).toEqual(['halwick.example']);
    expect(ownSiteDomains({ domains: ['halwick.example', 'halwick.example/labs'] })).toEqual([]);
    expect(registrableDomain('https://www.uk.halwick.example/x')).toBe('halwick');
    expect(registrableDomain('halwick.uk.example')).toBe('halwick.uk');
    expect(companyInitials('Velfield United Minerals')).toBe('vum');
    expect(initialsMatch('VUM', 'Velfield United Minerals')).toBe(true);
    expect(initialsMatch('Velfield', 'Velfield United Minerals')).toBe(false);
  });
  test('two linked groups that share a page link nothing when their union holds two pages of one source; an unknown arm throws', () => {
    const page = (key: string, domains: string[], linkedin: string | null) => ({ key, source: key.slice(0, key.indexOf(':')), slug: key.slice(key.indexOf(':') + 1), type: 'company' as const, title: 'Acme', emails: [], domains, linkedin, github: null, company: null, city: null, page_id: key });
    const pages = [page('work:companies/acme', ['acme.example'], null), page('home:companies/acme', ['acme.example'], 'https://www.linkedin.example/company/acme'), page('work:companies/acme-2', [], 'https://www.linkedin.example/company/acme')];
    expect(companyAutoLink(pages.slice(0, 2), 'd3').length).toBe(1);
    expect(companyAutoLink(pages, 'd3')).toEqual([]);
    expect(() => companyAutoLink(pages, 'nope')).toThrow(/unknown arm/);
  });
  test('the baseline arm is the contract emulator\'s arm 7 auto tier on company pages', () => {
    const { pages } = generateCompanyVWorld();
    const emulator = parseFinderOutput(JSON.parse(JSON.stringify(emulateFinder(pages, ARMS['7'].rule))), new Set(pages.map(p => p.key))).filter(SELECTIONS['auto-link']).map(g => g.members.join('|')).sort();
    expect(companyAutoLink(pages, 'baseline').map(g => g.members.join('|')).sort()).toEqual(emulator);
  });
  test('rejection memory keyed on the stable page id holds every rejected pair; keyed on the page key it holds none after the change', () => {
    const w = generateCompanyVWorld();
    const current = w.rejections.map(r => [w.pages.find(p => p.page_id === r.a_id)!.key, w.pages.find(p => p.page_id === r.b_id)!.key]);
    const together = (hs: string[][], [a, b]: string[]) => hs.some(h => h.includes(a) && h.includes(b));
    expect(current.every(c => together(companyProposed(w.pages, rejectionMemory(w.rejections, 'page-key')), c))).toBe(true);
    expect(current.some(c => together(companyProposed(w.pages, rejectionMemory(w.rejections, 'page-id')), c))).toBe(false);
    for (const arm of Object.keys(COMPANY_AUTOLINK_ARMS)) expect(current.some(c => together(companyAutoLink(w.pages, arm, rejectionMemory(w.rejections, 'page-id')).map(g => g.members), c))).toBe(false);
  });
  test('the scorer reports every arm, family and variant, with the own-site arms at no base false merge', () => {
    const w = generateCompanyVWorld();
    const results = runCompanyAutoLink(w);
    expect(results.map(r => r.arm)).toEqual(Object.keys(COMPANY_AUTOLINK_ARMS));
    for (const r of results) {
      for (const f of COMPANY_V_FAMILIES) for (const v of f.variants) expect(r.variants[`${f.id} / ${v}`]).toBeDefined();
      expect(r.base.false_merge.n + r.base.found.n).toBe(w.pairs.filter(p => w.base_families.includes(p.family)).length);
    }
    const by = Object.fromEntries(results.map(r => [r.arm, r]));
    for (const arm of ['baseline', 'c', 'd1', 'd1-strict', 'd2', 'd3']) expect(by[arm].base.false_merge.k).toBe(0);
    expect(by.d3.base.found.k).toBeGreaterThan(by.d2.base.found.k);
    expect(by.d2.base.found.k).toBeGreaterThan(by.d1.base.found.k);
    expect(by.a.base.false_merge.k).toBeGreaterThan(0);
    expect(by.baseline.older_pass.links_joining_a_rejected_pair).toBe(0);
    expect(by.d3.older_pass.links_joining_a_rejected_pair).toBeGreaterThan(0);
    expect(by.d3.older_pass.links_touching_changed_pages).toBeGreaterThanOrEqual(by.d3.older_pass.links_joining_a_rejected_pair);
    expect(formatCompanyAutoLink(results).join('\n')).toContain('v-subsidiary-root-domain / plainly different name');
  });
});
