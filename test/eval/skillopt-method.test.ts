/**
 * SkillOpt method benchmark, Phase 1 (GST-799): scorer, task sets (v1, and
 * v2, the hardening after probe 1 saturated v1), seeds, criteria, mutation
 * suite and audit. Keyless; no model call.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFiles, datasetProblems } from '../../eval/generators/skillopt-method/gen.ts';
import { groupSizes, MAX_TASKS_PER_COMPONENT, splitLeaks, type MethodTask } from '../../eval/generators/skillopt-method/common.ts';
import { QUERY_QUOTAS } from '../../eval/generators/skillopt-method/query.ts';
import { QUERY_V2_QUOTAS } from '../../eval/generators/skillopt-method/query-v2.ts';
import { BRIEFING_QUOTAS } from '../../eval/generators/skillopt-method/briefing.ts';
import { BRIEFING_V2_QUOTAS } from '../../eval/generators/skillopt-method/briefing-v2.ts';
import { FACT_CHECK_QUOTAS } from '../../eval/generators/skillopt-method/fact-check.ts';
import { FACT_CHECK_V2_QUOTAS } from '../../eval/generators/skillopt-method/fact-check-v2.ts';
import { assertScorerRejectsFakeSystems, type AnswerSpace } from '../../eval/runner/mutation-kit.ts';
import { auditSkill } from '../../eval/runner/skillopt-method/audit.ts';
import {
  DATASET_VERSIONS, datasetDir, datasetName, DEFAULT_DATASET, readCriteria, readSealedTestTasks, readSeed, readTasks, SEED_GBRAIN_COMMIT, SEED_GBRAIN_VERSION, SEED_SHA256,
  type DatasetVersion,
} from '../../eval/runner/skillopt-method/dataset.ts';
import {
  citationNdcg, citedSlugs, compileJudge, countedScoreFn, CRITERIA, CRITERIA_V2, evaluateJudge, renderFailedCheck, SKILLS, SPLITS, type Gold, type SkillName,
} from '../../eval/runner/skillopt-method/score.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const pass = (skill: SkillName, gold: Gold, answer: string) => evaluateJudge(answer, compileJudge(skill, gold)).correct;
const QUOTAS: Record<DatasetVersion, Record<SkillName, Record<string, readonly number[]>>> = {
  v1: { query: QUERY_QUOTAS, briefing: BRIEFING_QUOTAS, 'fact-check': FACT_CHECK_QUOTAS },
  v2: { query: QUERY_V2_QUOTAS, briefing: BRIEFING_V2_QUOTAS, 'fact-check': FACT_CHECK_V2_QUOTAS },
};
const CRITERIA_TEXTS: Record<DatasetVersion, Readonly<Record<SkillName, string>>> = { v1: CRITERIA, v2: CRITERIA_V2 };
const trainSel = (skill: SkillName, version: DatasetVersion = DEFAULT_DATASET): MethodTask[] => [...readTasks(skill, 'train', version), ...readTasks(skill, 'sel', version)];
const allTasks = (skill: SkillName, version: DatasetVersion = DEFAULT_DATASET): MethodTask[] => [...trainSel(skill, version), ...readSealedTestTasks(skill, version)];
const checkKinds = (t: MethodTask) => (t.judge.kind === 'rule' ? t.judge.checks.map(c => (c as { kind?: string }).kind) : []);

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
  test('v2 gold: one citation check per group, and an abstention for a subject beside answered parts', () => {
    const pair: Gold = { values: [{ kind: 'number', value: 140 }, { kind: 'number', value: 1850, unit: 'money' }], slugs: ['contracts/a', 'contracts/b'], cite: [['contracts/a'], ['contracts/b']] };
    expect(pass('query', pair, '140 seats (contracts/a) at $1,850 (contracts/b)')).toBe(true);
    expect(pass('query', pair, '140 seats at $1,850 (contracts/a)')).toBe(false);
    expect(pass('query', pair, '140 seats (contracts/a) (contracts/b)')).toBe(false);
    const day: Gold = { values: [{ kind: 'name', value: 'Acme' }], slugs: ['people/mia-brown-0'], cite: [['people/mia-brown-0']], subject: 'Corvin Vantwerp' };
    const answered = 'Mia Brown runs Acme. [Source: people/mia-brown-0, updated 2026-10-30]';
    expect(pass('briefing', day, `${answered}\n## 14:30 Corvin Vantwerp\n- No brain page for Corvin Vantwerp.`)).toBe(true);
    expect(pass('briefing', day, answered)).toBe(false);
    expect(pass('briefing', day, '## 14:30 Corvin Vantwerp\n- No brain page for Corvin Vantwerp.')).toBe(false);
    expect(compileJudge('query', { values: [], slugs: [], subject: 'X' })).toEqual(compileJudge('query', { values: [], slugs: [], subject: 'X', cite: [] }));
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

for (const version of DATASET_VERSIONS) describe(`frozen task sets: ${datasetName(version)}`, () => {
  test('generation is deterministic and matches the committed files and MANIFEST.json', () => {
    expect(datasetProblems(version)).toEqual([]);
    expect([...buildFiles(version)].map(([p, c]) => [p, createHash('sha256').update(c).digest('hex')])).toEqual([...buildFiles(version)].map(([p, c]) => [p, createHash('sha256').update(c).digest('hex')]));
  });

  for (const skill of SKILLS) {
    test(`${skill}: 24/24/36 tasks, family quotas, at most three tasks per group, and no anchor, fact or gold page in two splits`, () => {
      const tasks = allTasks(skill, version);
      expect(SPLITS.map(s => tasks.filter(t => t.split === s).length)).toEqual([24, 24, 36]);
      for (const [family, q] of Object.entries(QUOTAS[version][skill])) expect([family, SPLITS.map(s => tasks.filter(t => t.split === s && t.family === family).length)]).toEqual([family, [...q]]);
      expect([...new Set(tasks.map(t => t.family))].sort()).toEqual(Object.keys(QUOTAS[version][skill]).sort());
      expect(splitLeaks(tasks)).toEqual([]);
      expect(groupSizes(tasks)[0]).toBeLessThanOrEqual(MAX_TASKS_PER_COMPONENT);
      expect(tasks.every(t => t.anchor.id && t.skill === skill)).toBe(true);
      expect(tasks.every(t => t.answerable === (t.gold.slugs.length > 0))).toBe(true);
      expect(tasks.filter(t => !t.answerable).length).toBeGreaterThanOrEqual(14);
      if (version !== 'v1') expect(new Set(tasks.map(t => t.anchor.id)).size).toBe(tasks.length);
    });

    test(`${skill}: every solvability control passes and the generation report counts its drops`, () => {
      for (const t of allTasks(skill, version)) expect([t.task_id, evaluateJudge(t.oracle_answer, t.judge).correct]).toEqual([t.task_id, true]);
      const report = JSON.parse(readFileSync(join(datasetDir(version), skill, 'generation-report.json'), 'utf8'));
      expect(report.dropped_by_oracle).toBe(report.dropped.filter((d: { reason: string }) => !d.reason.startsWith('solvability')).length);
      expect(report.dropped_by_solvability).toBe(0);
    });
  }

  test('the test split has its own reader', () => {
    expect(() => readTasks('query', 'test' as 'sel', version)).toThrow(/sealed/);
  });
});

describe('briefing calendars', () => {
  test("v1 tasks list the day's meetings", () => {
    for (const t of trainSel('briefing', 'v1')) expect(/Today's calendar:\n(- \d{2}:\d{2} .+\n){3,4}/.test(t.task)).toBe(true);
  });

  test('v2 tasks list the day and ask about every external meeting, each answered one with its own citation check', () => {
    const meetings: Record<string, number> = { 'multi-meeting': 2, 'multi-meeting-absent': 3, negative: 1 };
    for (const t of allTasks('briefing', 'v2')) {
      expect([t.task_id, /Today's calendar:\n(- \d{2}:\d{2} .+\n){3,5}/.test(t.task)]).toEqual([t.task_id, true]);
      const asks = t.task.split('For each external meeting, include:\n')[1]!.split('\n').filter(l => l.startsWith('- '));
      expect([t.task_id, asks.length]).toEqual([t.task_id, meetings[t.family]]);
      const kinds = checkKinds(t);
      expect([t.task_id, kinds.filter(k => k === 'citation').length, kinds.filter(k => k === 'value').length, kinds.filter(k => k === 'abstain').length])
        .toEqual([t.task_id, t.family === 'negative' ? 0 : 2, t.family === 'negative' ? 0 : 2, t.family === 'multi-meeting' ? 0 : 1]);
    }
  });
});

describe('v2 hardening', () => {
  test('a superseded record\'s value and page are distractors, and answering with them fails', () => {
    for (const [skill, family] of [['query', 'gov-superseded'], ['fact-check', 'superseded']] as const) {
      const tasks = allTasks(skill, 'v2').filter(t => t.family === family);
      expect(tasks.length).toBeGreaterThan(0);
      for (const t of tasks) {
        const stale = t.distractors.values[0]!;
        expect([t.task_id, t.gold.slugs.length, t.distractors.slugs.includes(t.gold.slugs[0]!), String(stale.value) === String(t.gold.values[0]!.value)]).toEqual([t.task_id, 1, false, false]);
        const answer = `${skill === 'fact-check' ? 'STATUS: FALSE\n' : ''}${stale.value} (${t.distractors.slugs[0]})`;
        expect([t.task_id, evaluateJudge(answer, t.judge).correct]).toEqual([t.task_id, false]);
      }
    }
  });

  test('two-value tasks check both values and cite each governing page', () => {
    for (const [skill, families] of [['query', ['gov-pair']], ['fact-check', ['compound-supported', 'compound-contradicted']]] as const) {
      for (const t of allTasks(skill, 'v2').filter(x => (families as readonly string[]).includes(x.family))) {
        const kinds = checkKinds(t);
        expect([t.task_id, kinds.filter(k => k === 'citation').length]).toEqual([t.task_id, t.gold.cite!.length]);
        expect([t.task_id, kinds.filter(k => k === 'value').length]).toEqual([t.task_id, t.family === 'compound-supported' ? 0 : 2]);
        if (t.gold.cite!.length > 1) expect([t.task_id, evaluateJudge(t.oracle_answer.split(t.gold.cite![1]![0]!).join('contracts/none'), t.judge).correct]).toEqual([t.task_id, false]);
      }
    }
    expect(allTasks('fact-check', 'v2').some(t => (t.gold.cite?.length ?? 0) > 1)).toBe(true);
  });

  test('multi-hop answers cite the founder\'s own page; the company page alone fails', () => {
    for (const t of allTasks('query', 'v2').filter(x => x.family === 'multi-hop')) {
      expect([t.task_id, t.gold.slugs.length, t.gold.slugs[0]!.startsWith('people/')]).toEqual([t.task_id, 1, true]);
      const answer = `${t.gold.values[0]!.value} founded it. [Source: ${t.distractors.slugs[0]}]`;
      expect([t.task_id, evaluateJudge(answer, t.judge).correct]).toEqual([t.task_id, false]);
    }
  });
});

describe('seeds', () => {
  for (const version of DATASET_VERSIONS) for (const skill of SKILLS) {
    test(`${datasetName(version)} ${skill} seed is verbatim from gbrain ${SEED_GBRAIN_COMMIT.slice(0, 9)}`, () => {
      expect(createHash('sha256').update(readSeed(skill, version)).digest('hex')).toBe(SEED_SHA256[skill]);
      const installed = join(REPO_ROOT, 'node_modules/gbrain/skills', skill, 'SKILL.md');
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'node_modules/gbrain/package.json'), 'utf8')) as { version: string };
      const pinned = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).dependencies.gbrain as string).endsWith(SEED_GBRAIN_COMMIT);
      if (pinned && pkg.version === SEED_GBRAIN_VERSION && existsSync(installed)) expect(createHash('sha256').update(readFileSync(installed)).digest('hex')).toBe(SEED_SHA256[skill]);
    });
  }
});

describe('criteria text and failed-check rendering', () => {
  test('one task-independent criteria text per skill, frozen with the data, naming no gold value, slug or entity', () => {
    for (const version of DATASET_VERSIONS) for (const skill of SKILLS) {
      const text = CRITERIA_TEXTS[version][skill];
      expect(readCriteria(skill, version)).toBe(text + '\n');
      expect(citedSlugs(text)).toEqual([]);
      expect(/\d/.test(text)).toBe(false);
      for (const t of allTasks(skill, version)) for (const v of t.gold.values) if (v.kind === 'name') expect([t.task_id, text.toLowerCase().includes(v.value.toLowerCase())]).toEqual([t.task_id, false]);
    }
  });
  test('a failed check renders without its argument', () => {
    for (const version of DATASET_VERSIONS) for (const skill of SKILLS) for (const t of trainSel(skill, version)) for (const c of t.judge.kind === 'rule' ? t.judge.checks : []) {
      const text = renderFailedCheck(c);
      expect(/\d|\//.test(text)).toBe(false);
      for (const v of t.gold.values) expect(text.toLowerCase().includes(String(v.value).toLowerCase())).toBe(false);
    }
  });
});

for (const version of DATASET_VERSIONS) describe(`mutation suite: ${datasetName(version)}`, () => {
  for (const skill of SKILLS) {
    const probes = trainSel(skill, version);
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
        category: `${datasetName(version)} ${skill}`,
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
    for (const skill of SKILLS) for (const t of trainSel(skill, version).filter(x => x.answerable)) {
      const first = t.gold.values[0];
      const n = first ? formats[first.kind]!(first.value).length : 1;
      for (let i = 0; i < n; i++) {
        const value = t.gold.values.map(v => {
          const forms = formats[v.kind]!(v.value);
          const f = forms[i % forms.length]!;
          return (v.kind === 'number' && v.unit === 'money' ? `${f}` : f) + unit(v);
        }).join(' and ');
        const cite = (t.gold.cite ?? [t.gold.slugs]).map(g => (skill === 'briefing' ? `[Source: ${g[0]}, updated 2026-10-30]` : `(source: ${g[0]})`)).join(' ');
        const status = skill !== 'fact-check' ? '' : t.gold.status === 'supported' ? 'Status: LIKELY ACCURATE\n' : t.gold.status === 'contradicted' ? 'STATUS: LIKELY INACCURATE\n' : 'STATUS: FALSE\n';
        const abstain = t.gold.subject ? `\nNo brain page for ${t.gold.subject}.` : '';
        const answer = `${status}In short, the answer is ${value}. ${cite}${abstain}`;
        expect([t.task_id, answer, evaluateJudge(answer, t.judge).correct]).toEqual([t.task_id, answer, true]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  test('a gold-pasting skill does not raise the test score above the noise floor', () => {
    const NOISE_FLOOR = 1 / 36;
    for (const skill of SKILLS) {
      const train = readTasks(skill, 'train', version);
      const test = readSealedTestTasks(skill, version);
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
