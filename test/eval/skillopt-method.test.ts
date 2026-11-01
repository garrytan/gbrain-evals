/**
 * SkillOpt method benchmark, Phase 1 (GST-799): scorer, task sets, seeds,
 * criteria, mutation suite and audit. Keyless; no model call.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFiles, checkManifest, regenerationDiffs } from '../../eval/generators/skillopt-method/gen.ts';
import { splitLeaks, type MethodTask } from '../../eval/generators/skillopt-method/common.ts';
import { QUERY_QUOTAS } from '../../eval/generators/skillopt-method/query.ts';
import { BRIEFING_QUOTAS } from '../../eval/generators/skillopt-method/briefing.ts';
import { FACT_CHECK_QUOTAS } from '../../eval/generators/skillopt-method/fact-check.ts';
import { assertScorerRejectsFakeSystems, type AnswerSpace } from '../../eval/runner/mutation-kit.ts';
import { auditSkill } from '../../eval/runner/skillopt-method/audit.ts';
import { readCriteria, readSealedTestTasks, readSeed, readTasks, SEED_GBRAIN_COMMIT, SEED_GBRAIN_VERSION, SEED_SHA256 } from '../../eval/runner/skillopt-method/dataset.ts';
import {
  citationNdcg, citedSlugs, compileJudge, countedScoreFn, CRITERIA, evaluateJudge, renderFailedCheck, SKILLS, SPLITS, type Gold, type SkillName,
} from '../../eval/runner/skillopt-method/score.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const pass = (skill: SkillName, gold: Gold, answer: string) => evaluateJudge(answer, compileJudge(skill, gold)).correct;
const QUOTAS: Record<SkillName, Record<string, readonly number[]>> = { query: QUERY_QUOTAS, briefing: BRIEFING_QUOTAS, 'fact-check': FACT_CHECK_QUOTAS };
const trainSel = (skill: SkillName): MethodTask[] => [...readTasks(skill, 'train'), ...readTasks(skill, 'sel')];
const allTasks = (skill: SkillName): MethodTask[] => [...trainSel(skill), ...readSealedTestTasks(skill)];

describe('counted scorer: tolerant value patterns', () => {
  const q = (values: Gold['values'], answer: string) => pass('query', { values, slugs: ['contracts/2025-03-28-qfl-msa'] }, `${answer} [Source: contracts/2025-03-28-qfl-msa]`);
  test('money and plain numbers with or without separators', () => {
    for (const a of ['$1,850', '1850', '1 850.00', 'USD 1,850.00']) expect([a, q([{ kind: 'number', value: 1850, unit: 'money' }], a)]).toEqual([a, true]);
    for (const a of ['21850', '18500', '1,850.5', '185']) expect([a, q([{ kind: 'number', value: 1850, unit: 'money' }], a)]).toEqual([a, false]);
    for (const a of ['104k', '$104K', '104,000', '104 thousand']) expect([a, q([{ kind: 'number', value: 104000 }], a)]).toEqual([a, true]);
  });
  test('percent and days need their unit', () => {
    for (const [a, ok] of [['12%', true], ['12 percent', true], ['12', false], ['112%', false]] as const) expect([a, q([{ kind: 'number', value: 12, unit: 'percent' }], a)]).toEqual([a, ok]);
    for (const [a, ok] of [['forty-five (45) calendar days', true], ['Net 45', true], ['45-day', true], ['45 days', true], ['45', false]] as const) expect([a, q([{ kind: 'number', value: 45, unit: 'days' }], a)]).toEqual([a, ok]);
  });
  test('dates in common formats, always with the year', () => {
    for (const [a, ok] of [['2026-03-31', true], ['March 31, 2026', true], ['Mar. 31st 2026', true], ['31 March 2026', true], ['3/31/2026', true], ['03/31/26', true], ['March 31', false], ['2026-03-311', false]] as const) {
      expect([a, q([{ kind: 'date', value: '2026-03-31' }], a)]).toEqual([a, ok]);
    }
  });
  test('names in any case, whole words only', () => {
    for (const [a, ok] of [['brackenwater freight co', true], ['BRACKENWATER  FREIGHT CO.', true], ['Brackenwater Freighter', false]] as const) expect([a, q([{ kind: 'name', value: 'Brackenwater Freight Co.' }], a)]).toEqual([a, ok]);
  });
});

describe('counted scorer: citations, statuses and abstentions', () => {
  const slug = 'people/adam-lee-19';
  test("briefing requires its own [Source: slug, updated DATE] form", () => {
    const gold: Gold = { values: [{ kind: 'name', value: 'Forge' }], slugs: [slug] };
    expect(pass('briefing', gold, `Adam Lee founded Forge. [Source: ${slug}, updated 2026-11-01]`)).toBe(true);
    expect(pass('briefing', gold, `Adam Lee founded Forge. [source: ${slug}, compiled truth, updated Nov 1]`)).toBe(true);
    expect(pass('briefing', gold, `Adam Lee founded Forge. [Source: ${slug}]`)).toBe(false);
    expect(pass('briefing', gold, `Adam Lee founded Forge. [Source: ${slug}0, updated x]`)).toBe(false);
  });
  test('query and fact-check accept the slug in any form, but not a longer slug', () => {
    const gold: Gold = { values: [{ kind: 'number', value: 140 }], slugs: ['contracts/2025-03-28-qfl-msa'] };
    expect(pass('query', gold, '140 seats, per contracts/2025-03-28-qfl-msa.')).toBe(true);
    expect(pass('query', gold, '140 seats [Source: contracts/2025-03-28-qfl-msa, compiled truth]')).toBe(true);
    expect(pass('query', gold, '140 seats (contracts/2025-03-28-qfl-msa-2)')).toBe(false);
  });
  test("fact-check statuses follow the skill's scale", () => {
    const supported: Gold = { values: [], slugs: [slug], status: 'supported' };
    expect(pass('fact-check', supported, `STATUS: ✅ VERIFIED\nSOURCE: ${slug}`)).toBe(true);
    expect(pass('fact-check', supported, `Status: Level 2 — likely accurate (${slug})`)).toBe(true);
    expect(pass('fact-check', supported, `**STATUS:** 🤷 UNVERIFIED (${slug})`)).toBe(false);
    expect(pass('fact-check', supported, `STATUS: VERIFIED\nSTATUS: FALSE (${slug})`)).toBe(false);
    const contradicted: Gold = { values: [{ kind: 'number', value: 140 }], slugs: [slug], status: 'contradicted' };
    expect(pass('fact-check', contradicted, `STATUS: ❌ FALSE — the page says 140 seats (${slug})`)).toBe(true);
    expect(pass('fact-check', contradicted, `STATUS: FALSE (${slug})`)).toBe(false);
    const unsupported: Gold = { values: [], slugs: [], status: 'not-supported' };
    expect(pass('fact-check', unsupported, 'STATUS: UNVERIFIED — no page names this person')).toBe(true);
    expect(pass('fact-check', unsupported, 'STATUS: LIKELY INACCURATE')).toBe(true);
    expect(pass('fact-check', unsupported, 'STATUS: VERIFIED')).toBe(false);
  });
  test('a negative control needs an abstention that names what was asked about', () => {
    const gold: Gold = { values: [], slugs: [], subject: 'Corvin Vantwerp' };
    expect(pass('query', gold, "The brain doesn't have information on Corvin Vantwerp.")).toBe(true);
    expect(pass('briefing', gold, '## 10:30 Corvin Vantwerp\n- No brain page for Corvin Vantwerp.')).toBe(true);
    expect(pass('query', gold, 'I could not find any page about corvin vantwerp.')).toBe(true);
    expect(pass('query', gold, "I don't know.")).toBe(false);
    expect(pass('query', gold, 'Corvin Vantwerp works with Acme.')).toBe(false);
  });
  test('countedScoreFn is binary; nDCG is a diagnostic over cited slugs', async () => {
    const judge = compileJudge('query', { values: [{ kind: 'number', value: 140 }], slugs: ['contracts/2025-03-28-qfl-msa'] });
    const traj = (final_text: string) => ({ task_id: 't', task: 'q', final_text, tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, turns: 1, stop_reason: 'end', duration_ms: 0 }) as Parameters<typeof countedScoreFn>[0];
    expect((await countedScoreFn(traj('140 seats (contracts/2025-03-28-qfl-msa)'), judge)).score).toBe(1);
    expect((await countedScoreFn(traj('140 seats'), judge)).score).toBe(0);
    expect(citedSlugs('see contracts/2025-03-28-qfl-msa and People/Adam-Lee-19.')).toEqual(['contracts/2025-03-28-qfl-msa', 'people/adam-lee-19']);
    expect(citationNdcg('contracts/a then contracts/2025-03-28-qfl-msa', ['contracts/2025-03-28-qfl-msa'])).toBeCloseTo(1 / Math.log2(3), 6);
    expect(citationNdcg('anything', [])).toBeNull();
  });
});

describe('frozen task sets', () => {
  test('generation is deterministic and matches the committed files and MANIFEST.json', () => {
    expect(regenerationDiffs()).toEqual([]);
    expect(checkManifest()).toEqual([]);
    expect([...buildFiles()].map(([p, c]) => [p, createHash('sha256').update(c).digest('hex')])).toEqual([...buildFiles()].map(([p, c]) => [p, createHash('sha256').update(c).digest('hex')]));
  });

  for (const skill of SKILLS) {
    test(`${skill}: 24/24/36 tasks, family quotas, and no anchor, fact or gold page in two splits`, () => {
      const tasks = allTasks(skill);
      expect(SPLITS.map(s => tasks.filter(t => t.split === s).length)).toEqual([24, 24, 36]);
      for (const [family, q] of Object.entries(QUOTAS[skill])) expect([family, SPLITS.map(s => tasks.filter(t => t.split === s && t.family === family).length)]).toEqual([family, [...q]]);
      expect(splitLeaks(tasks)).toEqual([]);
      expect(tasks.every(t => t.anchor.id && t.skill === skill)).toBe(true);
      expect(tasks.every(t => t.answerable === (t.gold.slugs.length > 0))).toBe(true);
      expect(tasks.filter(t => !t.answerable).length).toBeGreaterThanOrEqual(14);
    });

    test(`${skill}: every solvability control passes and the generation report counts its drops`, () => {
      for (const t of allTasks(skill)) expect([t.task_id, evaluateJudge(t.oracle_answer, t.judge).correct]).toEqual([t.task_id, true]);
      const report = JSON.parse(readFileSync(join(REPO_ROOT, 'eval/data/skillopt-method-v1', skill, 'generation-report.json'), 'utf8'));
      expect(report.dropped_by_oracle).toBe(report.dropped.filter((d: { reason: string }) => !d.reason.startsWith('solvability')).length);
      expect(report.dropped_by_solvability).toBe(0);
    });
  }

  test('briefing tasks list the day\'s meetings', () => {
    for (const t of trainSel('briefing')) expect(/Today's calendar:\n(- \d{2}:\d{2} .+\n){3,4}/.test(t.task)).toBe(true);
  });

  test('the test split has its own reader', () => {
    expect(() => readTasks('query', 'test' as 'sel')).toThrow(/sealed/);
  });
});

describe('seeds', () => {
  for (const skill of SKILLS) {
    test(`${skill} seed is verbatim from gbrain ${SEED_GBRAIN_COMMIT.slice(0, 9)}`, () => {
      expect(createHash('sha256').update(readSeed(skill)).digest('hex')).toBe(SEED_SHA256[skill]);
      const installed = join(REPO_ROOT, 'node_modules/gbrain/skills', skill, 'SKILL.md');
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/gbrain/package.json'), 'utf8')) as { version: string };
      const pinned = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).dependencies.gbrain as string).endsWith(SEED_GBRAIN_COMMIT);
      if (pinned && pkg.version === SEED_GBRAIN_VERSION && existsSync(installed)) expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(SEED_SHA256[skill]);
    });
  }
});

describe('criteria text and failed-check rendering', () => {
  test('one task-independent criteria text per skill, frozen with the data, naming no gold value, slug or entity', () => {
    for (const skill of SKILLS) {
      expect(readCriteria(skill)).toBe(CRITERIA[skill] + '\n');
      expect(citedSlugs(CRITERIA[skill])).toEqual([]);
      expect(/\d/.test(CRITERIA[skill])).toBe(false);
      for (const t of allTasks(skill)) for (const v of t.gold.values) if (v.kind === 'name') expect([t.task_id, CRITERIA[skill].toLowerCase().includes(v.value.toLowerCase())]).toEqual([t.task_id, false]);
    }
  });
  test('a failed check renders without its argument', () => {
    for (const skill of SKILLS) for (const t of trainSel(skill)) for (const c of t.judge.kind === 'rule' ? t.judge.checks : []) {
      const text = renderFailedCheck(c);
      expect(/\d|\//.test(text)).toBe(false);
      for (const v of t.gold.values) expect(text.toLowerCase().includes(String(v.value).toLowerCase())).toBe(false);
    }
  });
});

describe('mutation suite', () => {
  for (const skill of SKILLS) {
    const probes = trainSel(skill);
    test(`${skill}: the scorer passes the honest system and fails every fake system`, () => {
      const space: AnswerSpace<MethodTask, string> = {
        truth: t => t.oracle_answer,
        empty: () => '',
        everything: t => t.answerable
          ? `${t.oracle_answer}\nOther candidates: ${t.distractors.values.map(v => String(v.value)).join(', ')} ${t.distractors.slugs.join(' ')}\nSTATUS: VERIFIED\nSTATUS: FALSE\nSTATUS: UNVERIFIED`
          : `${t.gold.subject ?? 'The subject'} works with Acme and founded it in 2021. [Source: companies/acme-0, updated 2026-11-01]\nSTATUS: ✅ VERIFIED`,
        refusal: () => "The brain doesn't have information on this.",
        stale: t => {
          const v = t.distractors.values[0];
          if (!v || t.gold.values.length === 0) return undefined;
          const s = t.distractors.slugs[0] ?? t.gold.slugs[0]!;
          return skill === 'briefing' ? `${v.value} [Source: ${s}, updated 2026-11-01]` : `${v.value} (${s})${skill === 'fact-check' ? '\nSTATUS: FALSE' : ''}`;
        },
        wrongSource: t => {
          const other = t.distractors.slugs.find(s => !t.gold.slugs.includes(s));
          if (!other || !t.gold.slugs.length) return undefined;
          return t.gold.slugs.reduce((a, s) => a.split(s).join(other), t.oracle_answer);
        },
      };
      const results = assertScorerRejectsFakeSystems({
        category: `skillopt-method ${skill}`,
        probes,
        space,
        score: answers => {
          const correct = answers.filter((a, i) => evaluateJudge(a, probes[i]!.judge).correct).length;
          return { pass: correct === probes.length, detail: `${correct}/${probes.length} correct` };
        },
      });
      expect(results.find(r => r.system === 'honest')!.pass).toBe(true);
    });

    test(`${skill}: retrieving the gold page but citing another fails`, () => {
      const decoy = skill === 'briefing' ? 'companies/acme-0' : 'contracts/2024-11-12-bwf-of-2024';
      for (const t of probes.filter(p => p.answerable)) {
        if (t.gold.slugs.includes(decoy)) continue;
        const swapped = t.gold.slugs.reduce((a, s) => a.split(s).join(decoy), t.oracle_answer);
        expect([t.task_id, evaluateJudge(swapped, t.judge).correct]).toEqual([t.task_id, false]);
      }
    });

    test(`${skill}: an empty answer and "I don't know" fail every answerable task; the right abstention passes every negative control`, () => {
      for (const t of probes) {
        if (t.answerable) for (const a of ['', "I don't know."]) expect([t.task_id, a, evaluateJudge(a, t.judge).correct]).toEqual([t.task_id, a, false]);
        else {
          const abstain = skill === 'fact-check' ? 'STATUS: 🤷 UNVERIFIED — nothing in the brain supports this claim.' : `I couldn't find anything about ${t.gold.subject} in the brain.`;
          expect([t.task_id, evaluateJudge(abstain, t.judge).correct]).toEqual([t.task_id, true]);
        }
      }
    });
  }

  test('paraphrased and reformatted correct answers pass', () => {
    const formats: Record<string, (v: number | string) => string[]> = {
      number: v => [Number(v).toLocaleString('en-US'), String(v), `${v}.00`],
      date: v => { const [y, m, d] = String(v).split('-').map(Number); const month = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }); return [String(v), `${month} ${d}, ${y}`, `${d} ${month} ${y}`, `${m}/${d}/${y}`]; },
      name: v => [String(v).toLowerCase(), String(v).toUpperCase()],
    };
    const unit = (v: MethodTask['gold']['values'][number]) => (v.kind === 'number' && v.unit === 'percent' ? '%' : v.kind === 'number' && v.unit === 'days' ? ' days' : '');
    let checked = 0;
    for (const skill of SKILLS) for (const t of trainSel(skill).filter(x => x.answerable)) {
      const v = t.gold.values[0];
      const variants = v ? formats[v.kind]!(v.value).map(f => (v.kind === 'number' && v.unit === 'money' ? `$${f}` : f) + (v ? unit(v) : '')) : [''];
      for (const value of variants) {
        const cite = skill === 'briefing' ? `[Source: ${t.gold.slugs[0]}, updated 2026-10-30]` : `(source: ${t.gold.slugs[0]})`;
        const status = skill !== 'fact-check' ? '' : t.gold.status === 'supported' ? 'Status: LIKELY ACCURATE\n' : t.gold.status === 'contradicted' ? 'STATUS: LIKELY INACCURATE\n' : 'STATUS: FALSE\n';
        const answer = `${status}In short, the answer is ${value}. ${cite}`;
        expect([t.task_id, answer, evaluateJudge(answer, t.judge).correct]).toEqual([t.task_id, answer, true]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  test('a gold-pasting skill does not raise the test score above the noise floor', () => {
    const NOISE_FLOOR = 1 / 36;
    for (const skill of SKILLS) {
      const train = readTasks(skill, 'train');
      const test = readSealedTestTasks(skill);
      const pasted = new Map(train.map(t => [t.task, t.oracle_answer]));
      const lookup = (t: MethodTask) => pasted.get(t.task) ?? "I don't know.";
      const dump = train.map(t => t.oracle_answer).join('\n\n');
      const rate = (ts: MethodTask[], answer: (t: MethodTask) => string) => ts.filter(t => evaluateJudge(answer(t), t.judge).correct).length / ts.length;
      expect([skill, rate(train, lookup)]).toEqual([skill, 1]);
      expect([skill, 'lookup', rate(test, lookup) <= NOISE_FLOOR]).toEqual([skill, 'lookup', true]);
      expect([skill, 'dump', rate(test, () => dump) <= NOISE_FLOOR]).toEqual([skill, 'dump', true]);
    }
  });
});

describe('audit', () => {
  test('the seed audits clean, generic advice stays clean, and pasted train gold is disqualified', () => {
    for (const skill of SKILLS) {
      const seed = readSeed(skill);
      expect(auditSkill(skill, seed)).toEqual({ skill, added_lines: 0, removed_lines: 0, flags: [], disqualified: false });
      const generic = `${seed}\n\nCite the slug of every page you used. Check a record's effective date before stating its value as of a date. Within 30 days counts as recent.`;
      expect(auditSkill(skill, generic).disqualified).toBe(false);
      const train = readTasks(skill, 'train');
      const pasted = `${seed}\n\n## Known answers\n${train.slice(0, 3).map(t => `- ${t.oracle_answer.replace(/\n+/g, ' ')}`).join('\n')}`;
      const r = auditSkill(skill, pasted);
      expect(r.disqualified).toBe(true);
      expect(r.flags.some(f => f.kind === 'slug')).toBe(true);
    }
  });
});
