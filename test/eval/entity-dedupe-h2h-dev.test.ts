import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lookupEmbeddingPrice } from '../../node_modules/gbrain/src/core/embedding-pricing.ts';
import { generateCompanyLedger } from '../../eval/generators/company-dedupe-gen.ts';
import { deriveGold, generateLedger, ledgerFingerprint, writtenPages } from '../../eval/generators/person-dedupe-gen.ts';
import { CHAT_PRICE_OVERRIDES } from '../../eval/runner/budget-ledger.ts';
import { SELECTIONS, checkFinderCoverage, parseFinderOutput, runPersonDedupe, scoreGroups, type Rate } from '../../eval/runner/person-dedupe.ts';
import { blockPairs, pairId } from '../../eval/runner/entity-h2h/blocker.ts';
import { matcherPrompt } from '../../eval/runner/entity-h2h/matcher.ts';
import { buildWorld } from '../../eval/runner/entity-h2h/world.ts';

const ROOT = resolve(import.meta.dir, '../..');
const DEV = join(ROOT, 'docs/benchmarks/2026-11-18-entity-dedupe-h2h/dev');
const PREREG = readFileSync(join(ROOT, 'docs/benchmarks/2026-11-18-entity-dedupe-h2h-preregistration.md'), 'utf8');
const read = (path: string) => JSON.parse(readFileSync(join(DEV, path), 'utf8'));
const DEV_SEED = 20261117;
const DEV_GENERATOR_VERSION = 1;

const people = generateLedger(DEV_SEED, 20, DEV_GENERATOR_VERSION);
const gold = deriveGold(people);
const known = new Set(writtenPages(people).map(p => p.key));
const pairLabel = new Map(people.pairs.map(p => [[p.a, p.b].sort().join('|'), p.label]));
const pct = (r: Rate, places: number) => `${((r.k / r.n) * 100).toFixed(places)}%`;
const score = (groups: string[][]) => {
  for (const m of groups.flat()) expect(known.has(m)).toBe(true);
  return scoreGroups(groups.map(members => ({ members, kind: 'cluster', class: 'cluster', rules: [] })), people.pairs, gold);
};
const finderRaw = (sha: string) => read(`finder-dev/${sha}/finder.json`);
const finderAuto = (sha: string) => scoreGroups(parseFinderOutput(finderRaw(sha), known).filter(SELECTIONS['auto-link']), people.pairs, gold);
const quoted = (pattern: RegExp, from = '') => {
  const m = PREREG.slice(PREREG.indexOf(from)).match(pattern);
  expect(m).not.toBeNull();
  return m![1];
};
const significant = (s: string) => s.replace('.', '').replace(/^0+/, '').length;
const roundsTo = (value: number, text: string) => expect(value.toPrecision(significant(text))).toBe(Number(text).toPrecision(significant(text)));

describe('entity-dedupe h2h development evidence: classic tools', () => {
  const scores = read('er-h2h-classic/er-h2h-scores.json');
  const version = (system: string) => scores.inputs.find((i: { system: string }) => i.system === system).version;
  const recount = (file: string, tier: string) => score(read(`er-h2h-classic/${file}.json`).tiers[tier]);

  test('the scores file names the development world, and every input hash matches the committed output', () => {
    expect([scores.seed, scores.per_family, scores.ledger_sha256, scores.pages]).toEqual([DEV_SEED, 20, ledgerFingerprint(people), people.pages.length]);
    expect(scores.inputs).toHaveLength(6);
    for (const input of scores.inputs) {
      const name = input.file.split('/').pop();
      expect(createHash('sha256').update(readFileSync(join(DEV, 'er-h2h-classic', name))).digest('hex')).toBe(input.sha256);
      const output = read(`er-h2h-classic/${name}`);
      expect([output.system, output.version, output.config]).toEqual([input.system, input.version, input.config]);
      expect(Object.keys(output.tiers).sort()).toEqual([...input.tiers].sort());
    }
  });

  test('every tool ran on the development world, with labels and thresholds from the held-out seed only', () => {
    const HELD_OUT_SEED = 20261118;
    for (const input of scores.inputs) {
      const run = read(`er-h2h-classic/${input.system}-${input.config}.run.json`);
      expect([run.system, run.version, run.config]).toEqual([input.system, input.version, input.config]);
      expect(run.world).toBe(`<er-h2h>/worlds/s${DEV_SEED}`);
      expect(run.held_out).toBe(input.system === 'splink' && input.config === 'default' ? null : `<er-h2h>/worlds/s${HELD_OUT_SEED}`);
    }
    expect(PREREG).toContain(`Classic tools, keyless, people only, seed ${DEV_SEED}, labels and thresholds from held-out seed ${HELD_OUT_SEED} only`);
  });

  test('every row of the scores file is recounted from the tool output', () => {
    expect(scores.rows).toHaveLength(7);
    for (const row of scores.rows) {
      const s = recount(`${row.system}-${row.config}`, row.tier);
      expect([row.false_merge.k, row.false_merge.n, row.designed_recall.k, row.designed_recall.n]).toEqual([s.false_merge.k, s.false_merge.n, s.designed_recall.k, s.designed_recall.n]);
    }
  });

  test('the preregistration table matches the recount, row by row', () => {
    const splinkDefault = recount('splink-default', 'auto');
    const splinkAuto = recount('splink-tuned', 'auto');
    const splinkBand = recount('splink-tuned', 'proposed');
    const dedupeDefault = recount('dedupe-default', 'auto');
    const dedupeTuned = recount('dedupe-tuned', 'auto');
    const zinggDefault = recount('zingg-default', 'auto');
    const zinggTuned = recount('zingg-tuned', 'auto');
    const gbrain = finderAuto('ad179784');
    const rows = [
      `| Splink ${version('splink')}, default (Getting Started persons model) | ${splinkDefault.false_merge.k}/${splinkDefault.false_merge.n} (${pct(splinkDefault.false_merge, 1)}) | ${splinkDefault.designed_recall.k}/${splinkDefault.designed_recall.n} |`,
      `| Splink tuned, automatic | ${splinkAuto.false_merge.k}/${splinkAuto.false_merge.n} (${pct(splinkAuto.false_merge, 2)}) | ${splinkAuto.designed_recall.k}/${splinkAuto.designed_recall.n} |`,
      `| Splink tuned, review band (chosen on held-out) | ${splinkBand.false_merge.k}/${splinkBand.false_merge.n} | ${splinkBand.designed_recall.k}/${splinkBand.designed_recall.n} |`,
      `| dedupe ${version('dedupe')}, default | ${dedupeDefault.false_merge.k}/${dedupeDefault.false_merge.n} | ${dedupeDefault.designed_recall.k}/${dedupeDefault.designed_recall.n} |`,
      `| dedupe tuned | ${dedupeTuned.false_merge.k}/${dedupeTuned.false_merge.n} (${pct(dedupeTuned.false_merge, 1)}) | ${dedupeTuned.designed_recall.k}/${dedupeTuned.designed_recall.n} |`,
      `| Zingg ${version('zingg')}, default | ${zinggDefault.false_merge.k}/${zinggDefault.false_merge.n} (${pct(zinggDefault.false_merge, 2)}) | ${zinggDefault.designed_recall.k}/${zinggDefault.designed_recall.n} |`,
      `| Zingg tuned | ${zinggTuned.false_merge.k}/${zinggTuned.false_merge.n} | ${zinggTuned.designed_recall.k}/${zinggTuned.designed_recall.n} (${pct(zinggTuned.designed_recall, 1)}) |`,
      `| gbrain (ad179784), chosen rule, automatic | ${gbrain.false_merge.k}/${gbrain.false_merge.n} | ${gbrain.designed_recall.k}/${gbrain.designed_recall.n} (${pct(gbrain.designed_recall, 1)}) |`,
    ];
    for (const row of rows) expect(PREREG).toContain(row);
    expect(dedupeDefault.false_merge.k).toBe(0);
    expect(zinggTuned.false_merge.k).toBe(0);
    expect(gbrain.false_merge.k).toBe(0);
  });
});

describe('entity-dedupe h2h development evidence: gbrain finder', () => {
  test('each finder run saw every page and its receipt matches the recount', () => {
    for (const sha of ['6259ede5', '1e6e7ed3', 'ad179784']) {
      const imports = readFileSync(join(DEV, `finder-dev/${sha}/imports.jsonl`), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      expect(() => checkFinderCoverage(imports, people.pages)).not.toThrow();
      const receipt = read(`finder-dev/${sha}/receipt.json`);
      expect([receipt.resolved_config.seed, receipt.resolved_config.ledger_sha256, receipt.resolved_config.finder_build]).toEqual([DEV_SEED, ledgerFingerprint(people), `gbrain@${sha}`]);
      const s = finderAuto(sha);
      const headline = receipt.data.headline.person ?? receipt.data.headline;
      expect([headline.false_merge.k, headline.false_merge.n, headline.recall.k]).toEqual([s.false_merge.k, s.false_merge.n, s.recall.k]);
    }
  });

  test('under the chosen rule (1e6e7ed3 and ad179784) the automatic tier matches the preregistration', () => {
    const [a, b] = [finderAuto('1e6e7ed3'), finderAuto('ad179784')];
    expect([b.false_merge.k, b.false_merge.n, b.designed_recall.k, b.designed_recall.n]).toEqual([a.false_merge.k, a.false_merge.n, a.designed_recall.k, a.designed_recall.n]);
    const [lo, hi] = a.false_merge.ci95!.map(x => (x * 100).toFixed(1));
    expect(PREREG).toContain(`gbrain under the chosen rule (gbrain 1e6e7ed3 and ad179784, people world at seed ${DEV_SEED}): automatic tier ${a.false_merge.k} of ${a.false_merge.n} must-not-link pairs (95% interval ${lo}% to ${hi}%), recall ${a.designed_recall.k} of ${a.designed_recall.n} (${pct(a.designed_recall, 1)}).`);
  });

  const confirmList = (sha: string) => {
    const raw = finderRaw(sha);
    const entries = raw.groups.filter((g: { kind: string; class: string; evidence: Array<{ matcher: string; rule: string }> }) => g.kind === 'cross_source' && g.class === 'likely' && g.evidence.some(e => e.matcher === 'key_check' && e.rule === 'contact_key_only'));
    expect(entries.length).toBe(parseFinderOutput(raw, known).filter(SELECTIONS['confirm-list']).length);
    const labelled = entries.map((g: { members: Array<{ source_id: string; slug: string }>; evidence: Array<{ rule: string; veto?: boolean }> }) => {
      expect(g.members).toHaveLength(2);
      const keys = g.members.map(m => `${m.source_id}:${m.slug.replace(/^people\//, '')}`).sort();
      return { label: pairLabel.get(keys.join('|')) ?? 'undesigned', veto: g.evidence.some(e => e.rule === 'key_differs' && e.veto === true) };
    });
    const count = (f: (e: { label: string; veto: boolean }) => boolean) => labelled.filter(f).length;
    return { entries: labelled.length, real: count(e => e.label === 'same'), mustNotLink: count(e => e.label === 'different'), undesigned: count(e => e.label === 'undesigned'), vetoed: count(e => e.veto), vetoedMustNotLink: count(e => e.veto && e.label === 'different') };
  };

  test('the confirm-list counts are recounted from the 1e6e7ed3 finder output', () => {
    const c = confirmList('1e6e7ed3');
    expect(c.undesigned).toBe(0);
    expect(c.real + c.mustNotLink).toBe(c.entries);
    expect(PREREG).toContain(`Confirm list: ${c.entries} entries, ${c.real} real duplicates and ${c.mustNotLink} must-not-link pairs, ${c.vetoedMustNotLink} of them vetoed.`);
    expect(PREREG).toContain(`are all must-not-link, as in development (${c.vetoedMustNotLink} of ${c.vetoed})`);
  });

  test('at ad179784 the vetoed entries leave the confirm list, so the confirm-list counts are 1e6e7ed3\'s', () => {
    const [before, after] = [confirmList('1e6e7ed3'), confirmList('ad179784')];
    expect(after.vetoed).toBe(0);
    expect([after.entries, after.real, after.mustNotLink]).toEqual([before.entries - before.vetoed, before.real, before.mustNotLink - before.vetoed]);
    expect(PREREG).toContain(`At ad179784 the ${before.vetoed} vetoed groups move to the conflict class, leaving ${after.entries} entries: ${after.real} real duplicates and ${after.mustNotLink} must-not-link pairs, none vetoed.`);
  });
});

describe('entity-dedupe h2h amendment 1: counted world, blocker and matcher prompt', () => {
  const w = buildWorld(DEV_SEED, 20);
  const n = (x: number) => x.toLocaleString('en-US');
  const split = (label: string, person: boolean) => w.pairs.filter(p => w.people_gold.has(p.a) === person && p.label === label).length;

  test('the counted world counts recount from the generator at the current version', () => {
    const founders = w.people.pages.length - generateLedger(DEV_SEED, 20).pages.length;
    expect(PREREG).toContain(`${n(w.pages.length)} pages, of them ${n(w.people.pages.length)} person pages (${founders} of them founder pages written beside their companies) and ${w.companies.pages.length} company pages; ${n(w.pairs.length)} designed pairs: people ${split('different', true)} must-not-link and ${split('same', true)} must-link, companies ${split('different', false)} must-not-link and ${split('same', false)} must-link.`);
  });

  test('the blocker figures recount at the development seed', () => {
    const b = blockPairs(w.pages.map(p => p.written));
    const cands = new Set(b.pairs.map(([x, y]) => pairId(x, y)));
    const missed = w.pairs.filter(p => !cands.has(pairId(p.a, p.b)));
    const fam = (label: string, family: string) => missed.filter(p => p.label === label && p.family === family).length;
    expect(b.crowded).toHaveLength(1);
    const [crowded] = b.crowded;
    expect(PREREG).toContain(`it gives ${n(b.pairs.length)} candidate pairs, drops one key (the surname "${crowded.key.split(':').at(-1)}", on ${crowded.pages} pages), and leaves ${missed.length} designed pairs unreached: ${missed.filter(p => p.label === 'different').length} must-not-link (${fam('different', 'co-diff-acquired')} acquired-company pairs, the ${fam('different', 'co-diff-founder-linkedin')} founder-versus-firm pairs and ${fam('different', 'diff-initial-lookalike')} initial-lookalike pair) and ${missed.filter(p => p.label === 'same').length} must-link (${fam('same', 'co-same-abbreviation')} abbreviations, ${fam('same', 'co-same-rebrand')} rebrands).`);
  });

  test('the frozen matcher prompt is the file the harness reads', () => {
    const { template, sha256 } = matcherPrompt();
    expect(PREREG).toContain(`(${Buffer.byteLength(template)} bytes, SHA-256 \`${sha256}\`)`);
    for (const line of template.trimEnd().split('\n').filter(Boolean)) expect(PREREG).toContain(`  ${line}`);
  });
});

describe('entity-dedupe h2h development evidence: world size and company stand-in', () => {
  const companies = generateCompanyLedger(DEV_SEED, 20, DEV_GENERATOR_VERSION);
  const count = (pairs: ReadonlyArray<{ label: string }>, label: string) => pairs.filter(p => p.label === label).length;

  test('the world sizes match the preregistration', () => {
    const [pd, ps, cd, cs] = [count(people.pairs, 'different'), count(people.pairs, 'same'), count(companies.pairs, 'different'), count(companies.pairs, 'same')];
    expect(PREREG).toContain(`plus ${new Set(companies.pages.map(p => p.family)).size} company families (${companies.pages.length} pages at 20 instances)`);
    expect(PREREG).toContain(`that is ${(people.pages.length + companies.pages.length).toLocaleString('en-US')} pages: ${pd} person and ${cd} company must-not-link pairs, and ${ps} person and ${cs} company must-link pairs.`);
    expect(PREREG).toContain(`of the ${pd + ps + cd + cs} designed pairs`);
  });

  test('the committed stand-in receipt is the development world, and the chosen rule\'s company counts recount from it', () => {
    const receipt = read('standin/receipt.json');
    expect([receipt.resolved_config.seed, receipt.resolved_config.per_family, receipt.hashes.ledger, receipt.hashes.company_ledger]).toEqual([DEV_SEED, 20, ledgerFingerprint(people), ledgerFingerprint(companies)]);
    const id = 'contract-emulator[arm 7]:auto-link';
    const committed = receipt.data.arms.find((a: { id: string }) => a.id === id).by_type.company.score;
    const fresh = runPersonDedupe(people, { companies }).find(a => a.id === id)!.by_type.company!.score;
    expect([committed.false_merge.k, committed.false_merge.n, committed.designed_recall.k, committed.designed_recall.n]).toEqual([fresh.false_merge.k, fresh.false_merge.n, fresh.designed_recall.k, fresh.designed_recall.n]);
    expect(PREREG).toContain(`Companies, on a stand-in for the same rule rather than the real finder: ${fresh.false_merge.k} of ${fresh.false_merge.n} linked, recall ${fresh.designed_recall.k} of ${fresh.designed_recall.n};`);
  }, 60_000);
});

describe('entity-dedupe h2h development evidence: smoke', () => {
  const KINDS = ['ext-temporal-graph', 'ext-extract-first', 'ext-graph-pipeline', 'ext-memory-bank'] as const;
  const MODELS = { 'gpt-6.2-sol': 'openai:gpt-6.2-sol', 'claude-opus-5-5': 'anthropic:claude-opus-5-5', 'particle-1': 'particle:particle-1' } as const;
  const runRecord = (k: string) => `docs/comparison-systems/${k}/entity-h2h-smoke-run.json`;
  const runs = Object.fromEntries(KINDS.map(k => [k, JSON.parse(readFileSync(join(ROOT, runRecord(k)), 'utf8'))]));
  const aggregate = read('smoke-runs/aggregate.json');
  const matcher = read('smoke-runs/matcher-summary.json');
  const smoke = generateLedger(DEV_SEED, 2, DEV_GENERATOR_VERSION);
  const smokePages = Object.keys(runs['ext-temporal-graph'].ingest);
  const inSmoke = new Set(smokePages);
  const smokeDifferent = smoke.pairs.filter(p => p.label === 'different' && inSmoke.has(p.a) && inSmoke.has(p.b));
  const embedding = (id: string) => { const p = lookupEmbeddingPrice(id); if (p.kind !== 'known') throw new Error(`no price for ${id}`); return { input: p.pricePerMTok, output: 0 }; };
  const PRICES: Record<string, { input: number; output: number; cache_read?: number; cache_write?: number }> = {
    'openai:gpt-6.2-sol': { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
    'openai:text-embedding-3-small': embedding('openai:text-embedding-3-small'),
    'openai:text-embedding-3-large': embedding('openai:text-embedding-3-large'),
    'anthropic:claude-opus-5-5': CHAT_PRICE_OVERRIDES['anthropic:claude-opus-5-5'],
    'particle:particle-1': CHAT_PRICE_OVERRIDES['particle:particle-1'],
  };
  type Tokens = { input: number; cached: number; output: number };
  const priced = (model: string, t: Tokens, cacheWrite = 0) => {
    const p = PRICES[model];
    if (!p || ((t.cached && p.cache_read === undefined) || (cacheWrite && p.cache_write === undefined))) throw new Error(`no price for ${model}`);
    return ((t.input - t.cached - cacheWrite) * p.input + t.cached * (p.cache_read ?? 0) + cacheWrite * (p.cache_write ?? 0) + t.output * p.output) / 1e6;
  };

  test('the committed smoke files hold no spend', () => {
    const allowed = new Set(['usd_per_page_last_third', 'usd_per_pair']);
    const offending: string[] = [];
    const walk = (o: unknown, path: string) => {
      if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
        if (/usd|dollar|cost|spend|charged|billed/i.test(k) && !allowed.has(k)) offending.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    };
    for (const name of readdirSync(join(DEV, 'smoke-runs'))) walk(read(`smoke-runs/${name}`), name);
    for (const k of KINDS) walk(runs[k], runRecord(k));
    expect(offending).toEqual([]);
  });

  test('every committed development file is free of machine paths', () => {
    const files: string[] = [];
    const list = (dir: string) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) list(p); else files.push(p); } };
    list(DEV);
    files.push(...KINDS.map(k => join(ROOT, runRecord(k))));
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toMatch(/\/home\/|\/var\/tmp|\/tmp\/|~\/\.capy|\/workspace\//);
  });

  test('the smoke world is the development seed at two per family, and each cell has the stated pairs', () => {
    for (const k of KINDS) {
      expect(runs[k].ledger_sha256).toBe(ledgerFingerprint(smoke));
      expect(Object.keys(runs[k].ingest)).toEqual(smokePages);
    }
    expect(PREREG).toContain(`A ${smokePages.length}-page smoke on 2026-11-17 (Pacific), a plumbing check only, with ${smokeDifferent.length} designed different-people pairs per cell: each memory system merged`);
  });

  test('each memory system\'s merges are its listed false-merge cases, every one a designed different-people pair', () => {
    const designed = new Set(smokeDifferent.map(p => [p.a, p.b].sort().join('|')));
    const merged = KINDS.map(k => {
      const fm = runs[k].sanity_score.auto.false_merge;
      expect(fm.n).toBe(smokeDifferent.length);
      const cases = new Set<string>(runs[k].sanity_score.auto.false_merge_cases.map((c: { a: string; b: string }) => [c.a, c.b].sort().join('|')));
      for (const c of cases) expect(designed.has(c)).toBe(true);
      expect(cases.size).toBe(fm.k);
      expect(aggregate[k].sanity.auto.false_merge).toBe(`${fm.k}/${fm.n}`);
      return fm.k;
    });
    const order = (Object.keys(MODELS) as Array<keyof typeof MODELS>);
    for (const m of order) expect(matcher[MODELS[m]].sanity_score.auto.false_merge.n).toBe(smokeDifferent.length);
    const yes = Object.fromEntries(order.map(m => [m, matcher[MODELS[m]].sanity_score.auto.false_merge.k]));
    expect(PREREG).toContain(`each memory system merged ${Math.min(...merged)} to ${Math.max(...merged)} of ${smokeDifferent.length}, and the matcher's "yes" verdicts merged ${yes['claude-opus-5-5']} (claude-opus-5-5), ${yes['gpt-6.2-sol']} (gpt-6.2-sol) and ${yes['particle-1']} (particle-1).`);
  });

  test('the ingest cost per page at the last-third rate recounts from the per-page token counts', () => {
    for (const k of KINDS) {
      const usage = runs[k].usage;
      const pages = Object.keys(usage).filter(key => inSmoke.has(key));
      expect(pages).toEqual(smokePages);
      const perPage = pages.map(key => {
        const row = usage[key];
        const chat = Object.keys(row.by_model).filter(m => !m.includes('embedding'));
        expect(chat.length).toBeLessThanOrEqual(1);
        return Object.entries(row.by_model as Record<string, Tokens>).reduce((sum, [m, t]) => sum + priced(m, t, chat[0] === m ? row.cache_write : 0), 0);
      });
      const last = perPage.slice(perPage.length - Math.floor(perPage.length / 3));
      const rate = last.reduce((a, b) => a + b, 0) / last.length;
      const text = quoted(new RegExp(`\`${k}\` \\$(0\\.[0-9]+)`), 'Ingest cost per page');
      roundsTo(rate, text);
      expect(aggregate[k].usd_per_page_last_third).toBe(Number(text));
    }
  });

  test('ext-temporal-graph took about 12.5 seconds a page', () => {
    const t = runs['ext-temporal-graph'].timings_s;
    const mean = smokePages.reduce((s, key) => s + t[key], 0) / smokePages.length;
    expect(PREREG).toContain(`about ${mean.toFixed(1)} seconds a page in the smoke`);
    for (const k of KINDS) expect(aggregate[k].run_record).toBe(runRecord(k));
    expect(runs['ext-temporal-graph'].capabilities.versions.package).toContain(quoted(/`ext-temporal-graph` at ([0-9.]+) sends/));
  });

  test('the matcher cost per pair recounts from its token counts over the pairs sent', () => {
    for (const [name, id] of Object.entries(MODELS)) {
      const m = matcher[id];
      expect(m.calls).toBe(matcher.pairs_sent);
      expect(Object.keys(m.usage.by_model)).toEqual([id]);
      const perPair = priced(id, m.usage.by_model[id]) / matcher.pairs_sent;
      const text = quoted(new RegExp(`${name.replace(/\./g, '\\.')} \\$(0\\.[0-9]+)`), 'Matcher cost per pair:');
      roundsTo(perPair, text);
      expect(m.usd_per_pair).toBe(Number(text));
    }
  });
});
