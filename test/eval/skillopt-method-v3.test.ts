/**
 * skillopt-method-v3 (GBEV-30, plan sections 2, 3 and 10): the world, the three
 * task generators, the frozen data, the contracts, the v3 scorer, the audit and
 * redaction scope, and the dataset cache. Keyless; no model call.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreTrajectory } from 'gbrain/core/skillopt';
import { datasetProblems } from '../../eval/generators/skillopt-method/gen.ts';
import { degenerateAnswers, MAX_TASKS_PER_GROUP_V3, SPLIT_SIZES_V3, splitLeaksV3, statusSkewV3, type MethodTaskV3 } from '../../eval/generators/skillopt-method/common-v3.ts';
import { QUERY_V3_HELD_OUT, QUERY_V3_QUOTAS } from '../../eval/generators/skillopt-method/query-v3.ts';
import { BRIEFING_V3_HELD_OUT, BRIEFING_V3_QUOTAS } from '../../eval/generators/skillopt-method/briefing-v3.ts';
import { FACT_CHECK_V3_HELD_OUT, FACT_CHECK_V3_QUOTAS } from '../../eval/generators/skillopt-method/fact-check-v3.ts';
import { PAGE_WORDS, wordCount } from '../../eval/generators/skillopt-method/world-v3.ts';
import { auditSkill } from '../../eval/runner/skillopt-method/audit.ts';
import { ARMS, armPrompt, CONTRACTS, readContract } from '../../eval/runner/skillopt-method/contract.ts';
import { datasetContext, redactionScope } from '../../eval/runner/skillopt-method/dataset-context.ts';
import { datasetDir, readCriteria, readSealedTasks, readSeed, readTasks, SEED_PINS, sha256 } from '../../eval/runner/skillopt-method/dataset.ts';
import { markersIn, proposerInput, WITHHELD, type TrainTrajectory } from '../../eval/runner/skillopt-method/one-shot.ts';
import { compileJudgeV3, CRITERIA_V3, SPLITS_V3, type FactCheckSpec, type GoldV3, type MeetingSpec, type PartKey, type V3Check } from '../../eval/runner/skillopt-method/score-v3.ts';
import { citedSlugs, evaluateLayers, SKILLS, type GoldValue, type Judge, type SkillName, type StatusClass } from '../../eval/runner/skillopt-method/score.ts';
import { checkSkilloptMethod } from '../../eval/runner/validate-data.ts';

const QUOTAS: Record<SkillName, Record<string, readonly number[]>> = { query: QUERY_V3_QUOTAS, briefing: BRIEFING_V3_QUOTAS, 'fact-check': FACT_CHECK_V3_QUOTAS };
const HELD_OUT: Record<SkillName, readonly string[]> = { query: QUERY_V3_HELD_OUT, briefing: BRIEFING_V3_HELD_OUT, 'fact-check': FACT_CHECK_V3_HELD_OUT };
const trainSel = (skill: SkillName) => [...readTasks(skill, 'train', 'v3'), ...readTasks(skill, 'sel', 'v3')];
const allTasks = (skill: SkillName) => [...trainSel(skill), ...readSealedTasks(skill, 'gate', 'v3'), ...readSealedTasks(skill, 'test', 'v3')];
const checksOf = (j: Judge) => (j.kind === 'rule' ? j.checks as V3Check[] : []);
const layers = (t: { judge: Judge }, text: string) => evaluateLayers(text, t.judge);
const formPasses = (t: { judge: Judge }, text: string) => !layers(t, text).failed.some(c => (c as V3Check).layer === 'form');

/** A gold value as an answer writes it. */
const shown = (v: GoldValue): string => {
  if (v.kind !== 'number') return v.value;
  if (v.unit === 'money') return '$' + v.value.toLocaleString('en-US');
  if (v.unit === 'percent') return v.value + '%';
  if (v.unit === 'days') return v.value + ' days';
  return String(v.value);
};
const LABEL: Record<StatusClass, string> = { supported: '✅ VERIFIED', contradicted: '❌ FALSE', 'not-supported': '🤷 UNVERIFIED' };
const OPPOSITE: Record<StatusClass, string> = { supported: '❌ FALSE', contradicted: '✅ VERIFIED', 'not-supported': '✅ VERIFIED' };
const PART_WORD: Record<PartKey, string> = { seats: 'subscribed seat count', price: 'list price per seat per year', discount: 'percentage discount', notice: 'notice period', payment: 'payment terms', tier: 'support tier' };
const claimOf = (t: MethodTaskV3) => t.task.split('CLAIM: ')[1]!.trim();

// ─── Answers built from a task's gold, in each layout ────────────────────────

type Layout = 'answer-line' | 'seed' | 'heading' | 'table' | 'bold' | 'prose';

function queryAnswer(t: MethodTaskV3, layout: Layout, value?: GoldValue): string | null {
  const s = t.gold.spec;
  if (s.kind === 'value') {
    const v = shown(value ?? s.answer);
    const slugs = s.cite.map(g => g[0]!);
    const brackets = slugs.map(x => '[Source: ' + x + ']').join(' ');
    const after = s.distractors.length ? '\n\nAnother value, ' + shown(s.distractors[0]!) + ', does not apply on that date.' : '';
    if (layout === 'answer-line') return 'Answer: ' + v + '\n\nThe deciding pages: ' + brackets + '.' + after;
    if (layout === 'seed') return 'According to ' + slugs.map(x => '[Source: ' + x + ', compiled truth]').join(' and ') + ', the answer is ' + v + '.' + after;
    if (layout === 'table') return '| Value | Pages |\n|---|---|\n| ' + v + ' | ' + slugs.join(', ') + ' |';
    if (layout === 'bold') return '**Value:** ' + v + '\n**Pages:** ' + slugs.join(', ');
    if (layout === 'prose') return 'I looked through the records for this one. It comes to ' + v + ', per ' + slugs.join(' and ') + '.';
    return null;
  }
  if (s.kind === 'absent') {
    if (layout === 'answer-line') return 'not in the brain: ' + s.name;
    if (layout === 'seed') return "The brain doesn't have information on " + s.name + '.';
    if (layout === 'prose') return 'I could not find ' + s.name + ' anywhere in the brain.';
    return null;
  }
  if (s.kind !== 'ambiguous') return null;
  const names = s.candidates.map(shown);
  if (layout === 'answer-line' || layout === 'seed') return 'ambiguous: ' + s.name + ' could refer to more than one person: one at ' + names.join(', one at ') + '.';
  return null;
}

function briefingAnswer(t: MethodTaskV3, layout: Layout, values?: ReadonlyMap<MeetingSpec, GoldValue>): string | null {
  const s = t.gold.spec;
  if (s.kind !== 'briefing') return null;
  const fact = (m: MeetingSpec, cite: boolean) => (m.absent ? 'No brain page for ' + m.subject + '.' : m.subject + ': ' + shown(values?.get(m) ?? m.answer!) + (cite ? ' [Source: ' + m.cite![0] + ', updated 2026-10-30].' : '.'));
  if (layout === 'seed') return 'MEETINGS TODAY\n' + s.meetings.map(m => '- ' + m.time + ' ' + m.title + '\n  ' + fact(m, true)).join('\n');
  if (layout === 'heading') return s.meetings.map(m => '## ' + m.time + ' ' + m.title + '\n' + fact(m, true)).join('\n\n');
  if (layout === 'table') return '| Time | Meeting | Brief | Page |\n|---|---|---|---|\n' + s.meetings.map(m => '| ' + m.time + ' | ' + m.title + ' | ' + fact(m, false) + ' | ' + (m.cite?.[0] ?? '') + ' |').join('\n');
  if (layout === 'bold') return s.meetings.map(m => '**' + m.time + ' ' + m.title + '**\n' + fact(m, false) + (m.cite ? ' (' + m.cite[0] + ')' : '')).join('\n\n');
  if (layout === 'prose') return s.meetings.map(m => (m.absent ? m.subject + ': I could not find anything in the brain.' : m.subject + ' comes up today: ' + shown(m.answer!) + ', per ' + m.cite![0] + '.')).join('\n\n');
  return null;
}

function factCheckAnswer(t: MethodTaskV3, layout: Layout, perPart: boolean, opts: { correct?: (p: FactCheckSpec['parts'][number]) => GoldValue | undefined } = {}): string | null {
  const s = t.gold.spec;
  if (s.kind !== 'fact-check') return null;
  const slugs = s.cite.map(g => g[0]!).join(', ') || 'no page';
  const correct = (p: FactCheckSpec['parts'][number]) => (opts.correct ? opts.correct(p) : p.correct);
  const compound = s.parts.length > 1;
  const parts = compound && perPart ? s.parts : [{ key: null, status: s.status, correct: undefined } as FactCheckSpec['parts'][number]];
  const notes = (p: FactCheckSpec['parts'][number]) => {
    const vs = (p.key === null ? s.parts : [p]).map(correct).filter((v): v is GoldValue => !!v);
    return vs.length ? 'Correct value: ' + vs.map(shown).join('; ') : s.status === 'not-supported' ? 'The brain has no page for what the claim names.' : 'The page in force confirms it.';
  };
  const claimText = (p: FactCheckSpec['parts'][number]) => (p.key ? 'The claim\'s ' + PART_WORD[p.key] + '.' : claimOf(t));
  if (layout === 'seed') return '# Fact-Check Report: data-derived claim\n\n## Full Claim-by-Claim Report\n' + parts.map((p, i) => '[' + (i + 1) + '] CLAIM: ' + claimText(p) + '\nLANE: data-derived\nSTATUS: ' + LABEL[p.status] + '\nSOURCE: ' + slugs + '\n' + notes(p)).join('\n\n');
  if (layout === 'heading') return parts.map((p, i) => '### Claim ' + (i + 1) + ': ' + claimText(p) + '\nSTATUS: ' + LABEL[p.status] + '\nSOURCE: ' + slugs + '\n' + notes(p)).join('\n\n');
  const lines = (compound ? s.parts : [{ key: null, status: s.status, correct: undefined } as FactCheckSpec['parts'][number]]).map(p => ({ word: p.key ? PART_WORD[p.key] : 'claim', status: LABEL[p.status].replace(/^\S+ /, ''), value: (p.key === null ? s.parts : [p]).map(correct).filter((v): v is GoldValue => !!v).map(shown).join('; ') }));
  if (layout === 'table') return '| Part | Status | Brain holds | Pages |\n|---|---|---|---|\n' + lines.map(l => '| ' + l.word + ' | ' + l.status + ' | ' + (l.value || '—') + ' | ' + slugs + ' |').join('\n');
  if (layout === 'bold') return lines.map(l => '**' + l.word + ':** ' + l.status + (l.value ? ', the brain holds ' + l.value : '') + ' (' + slugs + ').').join('\n');
  if (layout === 'prose') return lines.map(l => 'On the ' + l.word + ', the claim is ' + l.status.toLowerCase() + (l.value ? '; the brain holds ' + l.value : '') + ' (' + slugs + ').').join('\n');
  return null;
}

// ─── Seed templates, read from the seed skills themselves ────────────────────

function seedTemplate(skill: SkillName, t: MethodTaskV3, wrong: boolean): string | null {
  const seed = readSeed(skill, 'v3');
  const s = t.gold.spec;
  if (skill === 'query') {
    const cite = /Citations: "(According to \[Source: people\/jane-doe, compiled truth\])\.\.\."/.exec(seed)![1]!;
    const gap = /Gap flags: "(The brain doesn't have information on) X"/.exec(seed)![1]!;
    if (s.kind === 'absent') return wrong ? null : gap + ' ' + s.name + '.';
    if (s.kind !== 'value') return null;
    if (wrong && !s.distractors.length) return null;
    const v = wrong ? s.distractors[0]! : s.answer;
    return s.cite.map((g, i) => (i === 0 ? cite.replace('people/jane-doe', g[0]!) : '[Source: ' + g[0] + ', compiled truth]')).join(' and ') + ', the answer is ' + shown(v) + '.';
  }
  if (skill === 'briefing' && s.kind === 'briefing') {
    const block = /\x60\x60\x60\n(DAILY BRIEFING[\s\S]*?)\n\x60\x60\x60/.exec(seed)![1]!;
    const item = /^- \[time\] \[meeting name\]\n {2}Participants: \[name\] \(slug: people\/name, \[key context\]\)$/m.exec(block)![0]!;
    const example = /"(Jane is CTO of Acme) \[Source: people\/jane-doe, updated (\d{4}-\d{2}-\d{2})\]"/.exec(seed)!;
    const gap = /\("(No brain page for) alice-example( -- consider enrichment)"\)/.exec(seed)!;
    if (wrong && !s.meetings.some(m => m.distractors.length && !m.absent)) return null;
    const entries = s.meetings.map(m => {
      const context = m.absent ? gap[1] + ' ' + m.subject + gap[2] : shown(wrong && m.distractors.length ? m.distractors[0]! : m.answer!) + ' [Source: ' + m.cite![0] + ', updated ' + example[2] + ']';
      return item.replace('[time]', m.time).replace('[meeting name]', m.title).replace('[name]', m.subject).replace('people/name', m.cite?.[0] ?? 'none').replace('[key context]', context);
    });
    return block.replace('[date]', 'October 30, 2026').replace(item, entries.join('\n'));
  }
  if (skill === 'fact-check' && s.kind === 'fact-check') {
    const block = /\x60\x60\x60\n(# Fact-Check Report:[\s\S]*?)\n\x60\x60\x60/.exec(seed)![1]!;
    const fix = s.parts.filter(p => p.correct);
    if (wrong && !fix.some(p => t.distractors.values.some(d => shown(d) !== shown(p.correct!)))) return null;
    const correct = (p: FactCheckSpec['parts'][number]) => (wrong ? t.distractors.values.find(d => shown(d) !== shown(p.correct!)) ?? p.correct! : p.correct!);
    const slugs = s.cite.map(g => g[0]!).join(', ') || 'no page';
    const compound = s.parts.length > 1;
    const blocks = (compound ? s.parts : [s.parts[0]!]).map((p, i) => [
      '[' + (i + 1) + '] CLAIM: ' + (compound ? 'The claim\'s ' + PART_WORD[p.key!] + '.' : claimOf(t)),
      'LANE: data-derived',
      'STATUS: ' + LABEL[compound ? p.status : s.status],
      'SOURCE: ' + slugs,
      'NOTES: ' + (p.correct ? 'was as claimed, now ' + shown(correct(p)) : s.status === 'not-supported' ? 'the brain has no page for what the claim names' : 'confirmed by the page in force'),
    ].join('\n'));
    const corrections = fix.length ? fix.map((p, i) => (i + 1) + '. ' + (p.key ? PART_WORD[p.key] : 'The claim') + ' — was: as claimed, now: ' + shown(correct(p)) + ', source: ' + slugs).join('\n') : '(none)';
    return block
      .replace('[Document Title]', 'data-derived claim')
      .replace(/^1\. \[Claim\] — was: X, now: Y, source: \[URL or independent query\]$/m, corrections)
      .replace(/^\[N\] CLAIM: \.\.\.\nLANE: web-derived \| data-derived\nSTATUS: \.\.\.\nSOURCE: \[URL, or the independent re-derivation query \+ result\]\nNOTES: \.\.\.$/m, blocks.join('\n\n'))
      .replace(/\bN\b/g, '1').replace(/X%/g, '100%');
  }
  return null;
}

// ─── Frozen data ─────────────────────────────────────────────────────────────

describe('skillopt-method-v3: frozen data', () => {
  test('regenerates byte for byte and matches MANIFEST.json; validate-data agrees', () => {
    expect(datasetProblems('v3')).toEqual([]);
    expect(checkSkilloptMethod('v3').failures).toEqual([]);
  }, 120_000);

  test('seeds are the skills gbrain ships at 311a83bbe, byte-identical to v2\'s', () => {
    expect(SEED_PINS.v3.commit.startsWith('311a83bb')).toBe(true);
    for (const skill of SKILLS) {
      expect(sha256(readSeed(skill, 'v3'))).toBe(SEED_PINS.v3.sha256[skill]);
      expect(readSeed(skill, 'v3')).toBe(readSeed(skill, 'v2'));
    }
  });

  test('the world: about a thousand pages of 150 to 700 words, every link resolving, no name with a period', () => {
    const ctx = datasetContext('v3');
    expect(ctx.pages.size).toBeGreaterThanOrEqual(950);
    expect(ctx.pages.size).toBeLessThanOrEqual(1050);
    for (const [slug, page] of ctx.pages) {
      const n = wordCount(page);
      expect([slug, n >= PAGE_WORDS.min && n <= PAGE_WORDS.max]).toEqual([slug, true]);
      for (const m of page.matchAll(/\]\(([a-z]+\/[a-z0-9-]+)\)/g)) expect([slug, m[1], ctx.pages.has(m[1]!)]).toEqual([slug, m[1], true]);
    }
    expect(ctx.names.length).toBeGreaterThan(400);
    for (const name of ctx.names) expect([name, name.includes('.')]).toEqual([name, false]);
    for (const skill of SKILLS) for (const t of allTasks(skill)) {
      const named = [t.gold.subject, 'name' in t.gold.spec ? t.gold.spec.name : undefined].filter(Boolean) as string[];
      for (const n of named) expect([t.task_id, n.includes('.')]).toEqual([t.task_id, false]);
    }
  });

  for (const skill of SKILLS) describe(skill, () => {
    const tasks = allTasks(skill);
    const report = JSON.parse(readFileSync(join(datasetDir('v3'), skill, 'generation-report.json'), 'utf8'));

    test('24/24/36/96 tasks in the planned family mix; held-out families only in gate and test', () => {
      expect(SPLITS_V3.map(sp => tasks.filter(t => t.split === sp).length)).toEqual(SPLITS_V3.map(sp => SPLIT_SIZES_V3[sp]));
      for (const [family, q] of Object.entries(QUOTAS[skill])) expect([family, SPLITS_V3.map(sp => tasks.filter(t => t.split === sp && t.family === family).length)]).toEqual([family, [...q]]);
      for (const t of tasks) expect([t.task_id, t.held_out, t.held_out ? ['gate', 'test'].includes(t.split) : true]).toEqual([t.task_id, HELD_OUT[skill].includes(t.family), true]);
      expect(HELD_OUT[skill].length).toBe(3);
    });

    test('train is round-robin: every batch of 8 covers every trained family', () => {
      const train = readTasks(skill, 'train', 'v3');
      const trained = Object.keys(QUOTAS[skill]).filter(f => !HELD_OUT[skill].includes(f));
      for (let i = 0; i < train.length; i += 8) expect([i, [...new Set(train.slice(i, i + 8).map(t => t.family))].sort()]).toEqual([i, [...trained].sort()]);
    });

    test('one anchor per task, no fact or gold page in two splits, at most three tasks per group, groups inside one split', () => {
      expect(splitLeaksV3(tasks)).toEqual([]);
      expect(new Set(tasks.map(t => t.anchor.id)).size).toBe(tasks.length);
      const groups = new Map<string, MethodTaskV3[]>();
      for (const t of tasks) groups.set(t.group_id, [...(groups.get(t.group_id) ?? []), t]);
      for (const [id, g] of groups) {
        expect([id, g.length <= MAX_TASKS_PER_GROUP_V3]).toEqual([id, true]);
        expect([id, new Set(g.map(t => t.split)).size]).toEqual([id, 1]);
      }
    });

    test('no two tasks share prompt text, in any family or split', () => {
      const seen = new Map<string, string>();
      const dups: string[][] = [];
      for (const t of tasks) {
        const first = seen.get(t.task);
        if (first) dups.push([first, t.task_id]);
        else seen.set(t.task, t.task_id);
      }
      expect(dups).toEqual([]);
    });

    test('the capacity report meets every family and split, with no solvability or degenerate drop', () => {
      for (const row of report.capacity) {
        expect([row.family, row.short]).toEqual([row.family, 0]);
        expect([row.family, row.placed]).toEqual([row.family, row.quota]);
        expect(row.confirmed).toBeGreaterThanOrEqual(Object.values(row.quota as Record<string, number>).reduce((a, b) => a + b, 0));
      }
      expect(report.capacity.map((r: { family: string }) => r.family).sort()).toEqual(Object.keys(QUOTAS[skill]).sort());
      expect([report.dropped_by_solvability, report.dropped_by_degenerate]).toEqual([0, 0]);
    });

    test('every task\'s judge compiles from its gold, every check is one tagged regex, and every task has substance and form checks', () => {
      for (const t of tasks) {
        expect([t.task_id, t.judge]).toEqual([t.task_id, compileJudgeV3(skill, t.gold as GoldV3)]);
        const checks = checksOf(t.judge);
        expect(checks.every(c => c.op === 'regex' && typeof c.arg === 'string' && (c.layer === 'form' || c.layer === 'substance'))).toBe(true);
        expect([t.task_id, checks.some(c => c.layer === 'substance'), checks.some(c => c.layer === 'form')]).toEqual([t.task_id, true, true]);
      }
    });

    test('on every split, the solvability control passes in full and every degenerate answer fails substance', () => {
      for (const t of tasks) {
        expect([t.task_id, layers(t, t.oracle_answer).full]).toEqual([t.task_id, true]);
        for (const d of degenerateAnswers(skill, t)) expect([t.task_id, d.kind, layers(t, d.text).substance]).toEqual([t.task_id, d.kind, false]);
      }
    });

    test('every abstention task records near-miss pages the world holds', () => {
      const pages = datasetContext('v3').pages;
      const abstains = tasks.filter(t => t.gold.spec.kind === 'absent' || t.gold.spec.kind === 'ambiguous' || (t.gold.spec.kind === 'fact-check' && t.gold.spec.status === 'not-supported') || (t.gold.spec.kind === 'briefing' && t.gold.spec.meetings.some(m => m.absent)));
      expect(abstains.length).toBeGreaterThan(0);
      for (const t of abstains) {
        expect([t.task_id, (t.near_miss ?? []).length > 0]).toEqual([t.task_id, true]);
        for (const s of t.near_miss!) expect([t.task_id, s, pages.has(s)]).toEqual([t.task_id, s, true]);
      }
    });

    test('criteria.md and contract.md are frozen, task-independent and name no slug or digit', () => {
      expect(readCriteria(skill, 'v3')).toBe(CRITERIA_V3[skill] + '\n');
      expect(readContract(skill)).toBe(CONTRACTS[skill]);
      for (const text of [CRITERIA_V3[skill], CONTRACTS[skill]]) {
        expect(citedSlugs(text)).toEqual([]);
        expect(/\d/.test(text)).toBe(false);
      }
    });
  });

  test('sealed splits have their own reader', () => {
    expect(() => readTasks('query', 'gate' as 'sel', 'v3')).toThrow(/sealed/);
    expect(() => readTasks('query', 'test' as 'sel', 'v3')).toThrow(/sealed/);
    expect(() => readSealedTasks('query', 'gate', 'v2')).toThrow(/no sealed gate/);
    expect(readSealedTasks('query', 'gate', 'v3').length).toBe(36);
  });
});

// ─── Contract ────────────────────────────────────────────────────────────────

describe('skillopt-method-v3: contract', () => {
  test('the contract reaches every arm but the bare no-skill arm', () => {
    for (const skill of SKILLS) for (const t of trainSel(skill).slice(0, 3)) for (const arm of ARMS) {
      const prompt = armPrompt(t.task, skill, arm);
      expect([skill, arm, prompt.startsWith(t.task), prompt.includes(CONTRACTS[skill])]).toEqual([skill, arm, true, arm !== 'bare-no-skill']);
      if (arm === 'bare-no-skill') expect(prompt).toBe(t.task);
    }
    expect(ARMS).toContain('no-skill');
  });
});

// ─── Scorer ──────────────────────────────────────────────────────────────────

describe('skillopt-method-v3: seed templates', () => {
  for (const skill of SKILLS) test(skill + ': the seed\'s documented output, filled with the gold, passes every check; filled with a wrong value it passes form and fails substance', () => {
    let filled = 0, wrongs = 0;
    for (const t of trainSel(skill)) {
      const good = seedTemplate(skill, t, false);
      if (good !== null) {
        filled++;
        expect([t.task_id, layers(t, good).failed.map(c => (c as V3Check).kind)]).toEqual([t.task_id, []]);
      }
      const bad = seedTemplate(skill, t, true);
      if (bad !== null) {
        wrongs++;
        expect([t.task_id, formPasses(t, bad), layers(t, bad).substance]).toEqual([t.task_id, true, false]);
      }
    }
    expect(filled).toBeGreaterThanOrEqual(skill === 'query' ? 30 : 40);
    expect(wrongs).toBeGreaterThan(10);
  });
});

describe('skillopt-method-v3: layouts and mutations over train and selection', () => {
  test('query: the answer line and the seed shape pass; a table, bold lines or prose pass substance and fail form; a wrong, hedged or uncited answer fails', () => {
    for (const t of trainSel('query')) {
      const s = t.gold.spec;
      for (const layout of ['answer-line', 'seed'] as const) {
        const a = queryAnswer(t, layout);
        if (a !== null) expect([t.task_id, layout, layers(t, a).failed.map(c => (c as V3Check).kind)]).toEqual([t.task_id, layout, []]);
      }
      for (const layout of ['table', 'bold', 'prose'] as const) {
        const a = queryAnswer(t, layout);
        if (a !== null) expect([t.task_id, layout, layers(t, a).substance, layers(t, a).full]).toEqual([t.task_id, layout, true, false]);
      }
      if (s.kind === 'value' && s.distractors.length) {
        for (const d of s.distractors) expect([t.task_id, 'wrong value', layers(t, queryAnswer(t, 'answer-line', d)!).substance]).toEqual([t.task_id, 'wrong value', false]);
        const hedged = 'Answer: ' + shown(s.distractors[0]!) + ', later ' + shown(s.answer) + ' ' + s.cite.map(g => '[Source: ' + g[0] + ']').join(' ');
        expect([t.task_id, 'hedged', layers(t, hedged).substance]).toEqual([t.task_id, 'hedged', false]);
      }
      if (s.kind === 'value') expect([t.task_id, 'uncited', layers(t, 'Answer: ' + shown(s.answer)).substance]).toEqual([t.task_id, 'uncited', false]);
      if (s.kind === 'absent' && s.distractors.length) {
        const leaked = s.name + ': ' + shown(s.distractors[0]!) + ' [Source: ' + t.near_miss![0] + ']. The brain doesn\'t have information on ' + s.name + '.';
        expect([t.task_id, 'near-miss value first', layers(t, leaked).substance]).toEqual([t.task_id, 'near-miss value first', false]);
      }
      if (s.kind === 'ambiguous') expect([t.task_id, 'commits', layers(t, s.name + ' works with ' + shown(s.candidates[0]!) + '.').substance]).toEqual([t.task_id, 'commits', false]);
    }
  });

  test('briefing: the seed list and headings pass; a table, bold lines or prose pass substance and fail form; swapped facts, a wrong value or a missing citation fail', () => {
    let swapped = 0;
    for (const t of trainSel('briefing')) {
      const s = t.gold.spec;
      if (s.kind !== 'briefing') throw new Error(t.task_id);
      for (const layout of ['seed', 'heading'] as const) expect([t.task_id, layout, layers(t, briefingAnswer(t, layout)!).failed.map(c => (c as V3Check).kind)]).toEqual([t.task_id, layout, []]);
      for (const layout of ['table', 'bold', 'prose'] as const) {
        const r = layers(t, briefingAnswer(t, layout)!);
        expect([t.task_id, layout, r.substance, r.full]).toEqual([t.task_id, layout, true, false]);
      }
      const answered = s.meetings.filter(m => !m.absent);
      const pair = answered.flatMap((a, i) => answered.slice(i + 1).map(b => [a, b] as const)).find(([a, b]) => shown(a.answer!) !== shown(b.answer!));
      if (pair) {
        swapped++;
        const values = new Map([[pair[0], pair[1].answer!], [pair[1], pair[0].answer!]]);
        expect([t.task_id, 'swapped', layers(t, briefingAnswer(t, 'seed', values)!).substance]).toEqual([t.task_id, 'swapped', false]);
      }
      for (const m of answered) {
        if (m.distractors.length) expect([t.task_id, m.time, 'wrong value', layers(t, briefingAnswer(t, 'seed', new Map([[m, m.distractors[0]!]]))!).substance]).toEqual([t.task_id, m.time, 'wrong value', false]);
        const uncited = briefingAnswer(t, 'seed')!.replace(' [Source: ' + m.cite![0] + ', updated 2026-10-30].', '.');
        expect([t.task_id, m.time, 'uncited', layers(t, uncited).substance]).toEqual([t.task_id, m.time, 'uncited', false]);
      }
    }
    expect(swapped).toBeGreaterThan(20);
  });

  test('fact-check: one block for the claim and one per part pass; heading blocks, a table, bold lines or prose pass substance and fail form; incompatible statuses, a wrong status or a superseded correction fail', () => {
    for (const t of trainSel('fact-check')) {
      const s = t.gold.spec;
      if (s.kind !== 'fact-check') throw new Error(t.task_id);
      for (const perPart of [false, true]) {
        expect([t.task_id, perPart, layers(t, factCheckAnswer(t, 'seed', perPart)!).failed.map(c => (c as V3Check).kind)]).toEqual([t.task_id, perPart, []]);
        const r = layers(t, factCheckAnswer(t, 'heading', perPart)!);
        expect([t.task_id, perPart, 'heading', r.substance, r.full]).toEqual([t.task_id, perPart, 'heading', true, false]);
      }
      for (const layout of ['table', 'bold', 'prose'] as const) {
        const r = layers(t, factCheckAnswer(t, layout, true)!);
        expect([t.task_id, layout, r.substance, r.full]).toEqual([t.task_id, layout, true, false]);
      }
      const good = factCheckAnswer(t, 'seed', true)!;
      const parts = s.parts.length > 1 ? s.parts : [{ key: null, status: s.status } as FactCheckSpec['parts'][number]];
      const p = parts[0]!;
      const contra = good + '\n\n[' + (parts.length + 1) + '] CLAIM: ' + (p.key ? 'The claim\'s ' + PART_WORD[p.key] + ' again.' : claimOf(t)) + '\nLANE: data-derived\nSTATUS: ' + OPPOSITE[p.status] + '\nSOURCE: ' + (s.cite[0]?.[0] ?? 'none');
      expect([t.task_id, 'two statuses for one part', layers(t, contra).substance]).toEqual([t.task_id, 'two statuses for one part', false]);
      expect([t.task_id, 'wrong status', layers(t, good.split('STATUS: ' + LABEL[p.status]).join('STATUS: ' + OPPOSITE[p.status])).substance]).toEqual([t.task_id, 'wrong status', false]);
      const stale = s.parts.find(x => x.correct && t.distractors.values.some(d => shown(d) !== shown(x.correct!)));
      if (stale) {
        const wrong = factCheckAnswer(t, 'seed', true, { correct: x => (x === stale ? t.distractors.values.find(d => shown(d) !== shown(x.correct!)) : x.correct) })!;
        expect([t.task_id, 'superseded correction', layers(t, wrong).substance]).toEqual([t.task_id, 'superseded correction', false]);
      }
    }
  });

  test('fact-check: status words outside the STATUS: line, a whole-claim block with a status line per part, and part words in notes do not change substance', () => {
    let compound = 0;
    for (const t of trainSel('fact-check')) {
      const s = t.gold.spec;
      if (s.kind !== 'fact-check') throw new Error(t.task_id);
      const noisy = t.oracle_answer.replace(/^NOTES: (.*)$/gm, (_, n) => 'NOTES: ' + n + ' The claimed value was correct before the record in force took effect; the figure is per seat, USD 1/seat/year before discount.\nAmendment status: confirmed in force');
      expect([t.task_id, 'status words in notes', layers(t, noisy).substance]).toEqual([t.task_id, 'status words in notes', true]);
      if (s.parts.length < 2) continue;
      compound++;
      const slugs = s.cite.map(g => g[0]!).join(', ');
      const fixes = s.parts.flatMap(p => (p.correct ? [shown(p.correct)] : []));
      const whole = '[1] CLAIM: ' + claimOf(t) + '\nLANE: data-derived\nSTATUS: ' + LABEL[s.status] + '\nSOURCE: ' + slugs + '\n' + s.parts.map(p => '- ' + PART_WORD[p.key!] + ': ' + (p.status === 'supported' ? 'correct' : 'incorrect' + (p.correct ? ', the brain holds ' + shown(p.correct) : ''))).join('\n') + '\n' + (fixes.length ? 'Correct value: ' + fixes.join('; ') : 'NOTES: The pages in force confirm it.');
      expect([t.task_id, 'whole-claim block with part lines', layers(t, whole).failed.map(c => (c as V3Check).kind)]).toEqual([t.task_id, 'whole-claim block with part lines', []]);
    }
    expect(compound).toBeGreaterThan(5);
  });

  test('fact-check: every split places true claims, and every right-or-wrong family places both true and false claims in each split it fills', () => {
    const tasks = allTasks('fact-check');
    for (const sp of SPLITS_V3) expect([sp, tasks.some(t => t.split === sp && t.gold.status === 'supported')]).toEqual([sp, true]);
    for (const family of ['superseded', 'compound', 'not-founder', 'role-on-date', 'three-hop', 'lookalike-founder']) for (const sp of SPLITS_V3) {
      const placed = tasks.filter(t => t.family === family && t.split === sp);
      if (!placed.length) continue;
      const statuses = [...new Set(placed.map(t => t.gold.status))].sort();
      expect([family, sp, statuses]).toEqual([family, sp, ['contradicted', 'supported']]);
    }
  });

  test('fact-check: oracle reports with every status FALSE, or every status VERIFIED, pass substance on no larger a share of train or of selection than of gate', () => {
    const { shares, problems } = statusSkewV3(allTasks('fact-check'));
    for (const report of ['all-false', 'all-true'] as const) {
      expect([report, shares[report].gate! > 0, shares[report].gate! < 1]).toEqual([report, true, true]);
      for (const sp of ['train', 'sel'] as const) expect([report, sp, shares[report][sp]! <= shares[report].gate!]).toEqual([report, sp, true]);
    }
    expect(problems).toEqual([]);
    const [first] = allTasks('fact-check');
    expect(() => statusSkewV3([{ ...first!, oracle_answer: first!.oracle_answer.replace(/^STATUS: /gm, '**STATUS:** ') }])).toThrow(`${first!.task_id}'s oracle report has no STATUS: line`);
  });
});

describe('skillopt-method-v3: scorer cases', () => {
  const run = (skill: SkillName, gold: GoldV3, text: string) => { const r = evaluateLayers(text, compileJudgeV3(skill, gold)); return [r.full, r.substance]; };
  const qv: GoldV3 = { values: [{ kind: 'number', value: 240 }], slugs: ['contracts/wyncrest-produce-renewal-2025'], spec: { kind: 'value', answer: { kind: 'number', value: 240 }, distractors: [{ kind: 'number', value: 335 }, { kind: 'number', value: 290 }], cite: [['contracts/wyncrest-produce-renewal-2025']] } };
  test('query: the seed shape, an Answer line and the seed\'s citation with notes pass; a hedge, a stale value or a preamble does not', () => {
    expect(run('query', qv, 'As of June 12, 2026, Wyncrest Produce has 240 subscribed seats [Source: contracts/wyncrest-produce-renewal-2025]. The 2024 renewal had set 335 seats, superseded.')).toEqual([true, true]);
    expect(run('query', qv, 'Answer: 240 seats\n\nAccording to [Source: contracts/wyncrest-produce-renewal-2025, compiled truth], the renewal set 240. Earlier: 335 (Renewal 2024).')).toEqual([true, true]);
    expect(run('query', qv, 'Wyncrest Produce went from 335 to 240 seats [Source: contracts/wyncrest-produce-renewal-2025].')).toEqual([false, false]);
    expect(run('query', qv, 'Answer: 335 seats [Source: contracts/wyncrest-produce-renewal-2025]')).toEqual([false, false]);
    expect(run('query', qv, 'Let me check the records.\n\nThe seat count is 240 (contracts/wyncrest-produce-renewal-2025).')).toEqual([false, true]);
    expect(run('query', qv, 'Per the Dec. 2025 renewal, i.e. contracts/wyncrest-produce-renewal-2025, the count is 240. Before that 335.')).toEqual([false, true]);
  });
  test('query: a negated or refused gold value fails; a correction or a note after the value passes', () => {
    expect(run('query', qv, 'Answer: Not 240 seats [Source: contracts/wyncrest-produce-renewal-2025]')).toEqual([false, false]);
    expect(run('query', qv, 'I cannot confirm 240 seats [Source: contracts/wyncrest-produce-renewal-2025].')).toEqual([false, false]);
    expect(run('query', qv, 'Answer: Wyncrest Produce no longer has 240 seats [Source: contracts/wyncrest-produce-renewal-2025]')).toEqual([false, false]);
    for (const refusal of ["I can't confirm 240 seats", 'I can’t confirm 240 seats', "It won't be 240 seats", 'It won’t be 240 seats', "The brain doesn't show 240 seats", 'I could not find 240 seats', 'There is no record of 240 seats', 'I am not able to confirm 240 seats', "I can't see 240 seats in the brain", 'I could not see the 240 seats']) {
      expect(run('query', qv, `${refusal} [Source: contracts/wyncrest-produce-renewal-2025].`)).toEqual([false, false]);
    }
    expect(run('query', qv, 'Answer: 240 seats, not the 200 the MSA set [Source: contracts/wyncrest-produce-renewal-2025]')).toEqual([true, true]);
    expect(run('query', qv, 'Answer: 240 seats (no change since the renewal) [Source: contracts/wyncrest-produce-renewal-2025]')).toEqual([true, true]);
    expect(run('query', qv, 'Answer: the seat count has not changed from 240 [Source: contracts/wyncrest-produce-renewal-2025]')).toEqual([true, true]);
    expect(run('query', qv, "Wyncrest Produce has 240 seats, and I don't see the 240 seats changing [Source: contracts/wyncrest-produce-renewal-2025].")).toEqual([true, true]);
    expect(run('query', qv, "I don't see the 240 seats changing after the renewal [Source: contracts/wyncrest-produce-renewal-2025].")).toEqual([true, true]);
  });
  test('query: every refusal built on see stays negated and the as-of trap scores wrong; change, changed or changing in the two words after the value keeps it', () => {
    const refusals = ['I do not see 240 seats in the brain', "I don't see 240 seats in the brain", 'I don’t see 240 seats in the brain', "I didn't see 240 seats", "I wasn't able to see 240 seats in the brain", 'I can not see 240 seats in the brain', 'I never see 240 seats in the brain', 'I cannot see 240 seats', "I can't see 240 seats", "I couldn't see 240 seats", 'I could not see 240 seats', 'I am unable to see 240 seats', 'I am not able to see 240 seats'];
    for (const refusal of refusals) expect([refusal, run('query', qv, `${refusal} [Source: contracts/wyncrest-produce-renewal-2025].`)]).toEqual([refusal, [false, false]]);
    const asOf: GoldV3 = { values: [{ kind: 'number', value: 570 }], slugs: ['contracts/wyncrest-produce-renewal-2025'], spec: { kind: 'value', answer: { kind: 'number', value: 570 }, distractors: [{ kind: 'number', value: 695 }], cite: [['contracts/wyncrest-produce-renewal-2025']] } };
    expect(run('query', asOf, "I don't see 570 seats in force on that date. The record in force then shows 695 seats. [Source: contracts/wyncrest-produce-renewal-2025]")).toEqual([false, false]);
    expect(run('query', asOf, 'Answer: 570 seats were in force on that date [Source: contracts/wyncrest-produce-renewal-2025]. The 695 came later.')).toEqual([true, true]);
    expect(run('query', qv, "I can't see the 240 changing [Source: contracts/wyncrest-produce-renewal-2025].")).toEqual([true, true]);
    expect(run('query', qv, "I don't see 240 seats changed by the amendment [Source: contracts/wyncrest-produce-renewal-2025].")).toEqual([true, true]);
    expect(run('query', qv, "I don't see 240 seats in the brain changing [Source: contracts/wyncrest-produce-renewal-2025].")).toEqual([false, false]);
    expect(run('query', qv, "I don't see 240 seats. Nothing has changed [Source: contracts/wyncrest-produce-renewal-2025].")).toEqual([false, false]);
  });
  test('query: abstentions and look-alikes', () => {
    const qa: GoldV3 = { values: [], slugs: [], subject: 'Wyncrest Freight', spec: { kind: 'absent', name: 'Wyncrest Freight', distractors: [{ kind: 'number', value: 240 }] } };
    expect(run('query', qa, "The brain doesn't have information on Wyncrest Freight. It does hold Wyncrest Produce, which has 240 seats.")).toEqual([true, true]);
    expect(run('query', qa, "Wyncrest Freight has 240 seats. Actually the brain doesn't have information on Wyncrest Freight.")).toEqual([false, false]);
    expect(run('query', qa, 'I could not find Wyncrest Freight anywhere in the brain.')).toEqual([false, true]);
    const qm: GoldV3 = { values: [], slugs: [], spec: { kind: 'ambiguous', name: 'Maren Holt', candidates: [{ kind: 'name', value: 'Corvane Robotics' }, { kind: 'name', value: 'Halbridge Freight' }] } };
    expect(run('query', qm, 'ambiguous: two people named Maren Holt: one at Corvane Robotics, one at Halbridge Freight.')).toEqual([true, true]);
    expect(run('query', qm, 'Maren Holt works with Corvane Robotics. There is also a Maren Holt at Halbridge Freight, which is ambiguous.')).toEqual([false, false]);
  });
  test('briefing: facts bind to their own meeting', () => {
    const br: GoldV3 = { values: [], slugs: [], spec: { kind: 'briefing', times: ['09:00', '10:30', '13:00', '14:30', '16:00'], meetings: [
      { time: '10:30', title: 'Renewal planning call with Wyncrest Produce', subject: 'Wyncrest Produce', answer: { kind: 'number', value: 240 }, distractors: [{ kind: 'number', value: 335 }], cite: ['contracts/wyncrest-produce-renewal-2025'] },
      { time: '13:00', title: 'Coffee with Maren Holte', subject: 'Maren Holte', answer: { kind: 'name', value: 'Halbridge Freight' }, distractors: [{ kind: 'name', value: 'Corvane Robotics' }], cite: ['people/maren-holte-123'] },
      { time: '16:00', title: 'Intro call with Talisa Vantwerp', subject: 'Talisa Vantwerp', absent: true, distractors: [] },
    ] } };
    const good = 'MEETINGS TODAY\n- 10:30 Renewal planning call with Wyncrest Produce\n  Seats in force: 240 [Source: contracts/wyncrest-produce-renewal-2025, updated 2026-06-12]. A renewal at 335 is signed.\n- 13:00 Coffee with Maren Holte\n  Maren Holte is with Halbridge Freight [Source: people/maren-holte-123, updated 2026-05-01]. Not the Maren Holt of Corvane Robotics.\n- 16:00 Intro call with Talisa Vantwerp\n  No brain page for Talisa Vantwerp.';
    expect(run('briefing', br, good)).toEqual([true, true]);
    expect(run('briefing', br, good.replace('Halbridge Freight [Source', 'Halbridge Freight (not Corvane Robotics) [Source'))).toEqual([false, false]);
    expect(run('briefing', br, good.replace('Seats in force: 240', 'Company: Halbridge Freight').replace('Maren Holte is with Halbridge Freight', 'Seats 240'))).toEqual([false, false]);
    expect(run('briefing', br, good.replace(' [Source: people/maren-holte-123, updated 2026-05-01]', ''))).toEqual([false, false]);
    expect(run('briefing', br, good.replace('Maren Holte is with Halbridge Freight', 'Maren Holte is with Corvane Robotics'))).toEqual([false, false]);
  });
  test('fact-check: statuses bind to parts', () => {
    const fc: GoldV3 = { values: [], slugs: [], status: 'contradicted', spec: { kind: 'fact-check', status: 'contradicted', cite: [['contracts/a-msa'], ['contracts/a-amendment-1']], parts: [{ key: 'seats', status: 'contradicted', correct: { kind: 'number', value: 240 } }, { key: 'discount', status: 'supported' }] } };
    const perPart = '[1] CLAIM: Acme had 300 seats.\nSTATUS: ❌ FALSE\nSOURCE: contracts/a-amendment-1\nCorrect value: 240 seats\n\n[2] CLAIM: Acme had a 15% discount.\nSTATUS: ✅ VERIFIED\nSOURCE: contracts/a-msa';
    expect(run('fact-check', fc, perPart)).toEqual([true, true]);
    expect(run('fact-check', fc, perPart + '\n\n[3] CLAIM: The seat count of 300.\nSTATUS: ✅ VERIFIED\nSOURCE: contracts/a-msa')).toEqual([false, false]);
    expect(run('fact-check', fc, perPart.replace('STATUS: ✅ VERIFIED', 'STATUS: ❌ FALSE'))).toEqual([false, false]);
    expect(run('fact-check', fc, '| Part | Claimed | Brain | Status |\n|---|---|---|---|\n| Seats | 300 | 240 (contracts/a-amendment-1) | FALSE |\n| Discount | 15% | 15% (contracts/a-msa) | VERIFIED |')).toEqual([false, true]);
  });
  test('fact-check: a block\'s status is read from its STATUS: lines and its parts from its CLAIM: line', () => {
    const f01: GoldV3 = { values: [], slugs: [], status: 'contradicted', spec: { kind: 'fact-check', status: 'contradicted', cite: [['contracts/yewlow-fasteners-amendment-1']], parts: [{ key: null, status: 'contradicted', correct: { kind: 'name', value: 'Tier 1' } }] } };
    const oracle01 = '# Fact-Check Report: data-derived claim\n\n## Corrections Applied\n1. As of November 9, 2024, Yewlow Fasteners\' support tier was Tier 3. — was: as claimed, now: Tier 1, source: contracts/yewlow-fasteners-amendment-1\n\n## Full Claim-by-Claim Report\n[1] CLAIM: As of November 9, 2024, Yewlow Fasteners\' support tier was Tier 3.\nLANE: data-derived\nSTATUS: ❌ FALSE\nSOURCE: contracts/yewlow-fasteners-amendment-1\nNOTES: Correct value: Tier 1.';
    expect(run('fact-check', f01, oracle01)).toEqual([true, true]);
    expect(run('fact-check', f01, oracle01 + ' Tier 3 was correct before the amendment took effect.')).toEqual([true, true]);
    expect(run('fact-check', f01, oracle01 + '\nAmendment status: confirmed in force')).toEqual([true, true]);
    expect(run('fact-check', f01, oracle01 + '\n\n[2] CLAIM: As of November 9, 2024, Yewlow Fasteners\' support tier was Tier 3.\nLANE: data-derived\nSTATUS: ⚖️ DISPUTED\nSOURCE: contracts/yewlow-fasteners-amendment-1')).toEqual([false, false]);

    const f02: GoldV3 = { values: [], slugs: [], status: 'contradicted', spec: { kind: 'fact-check', status: 'contradicted', cite: [['contracts/wynlow-fulfillment-renewal-2025'], ['contracts/wynlow-fulfillment-amendment-1']], parts: [{ key: 'seats', status: 'contradicted', correct: { kind: 'number', value: 625 } }, { key: 'price', status: 'contradicted', correct: { kind: 'number', value: 1250, unit: 'money' } }, { key: 'tier', status: 'supported' }] } };
    const whole02 = '[1] CLAIM: As of December 9, 2025, Wynlow Fulfillment\'s subscribed seat count was 515, its list price per seat per year was USD 1,450 and its support tier was Tier 2.\nLANE: data-derived\nSTATUS: ❌ FALSE\nSOURCE: contracts/wynlow-fulfillment-renewal-2025, contracts/wynlow-fulfillment-amendment-1\n- Seat count: incorrect, the brain holds 625\n- List price: incorrect, the brain holds USD 1,250\n- Support tier: correct (Tier 2)\nCorrect value: 625 seats; USD 1,250';
    expect(run('fact-check', f02, whole02)).toEqual([true, true]);
    expect(run('fact-check', f02, whole02 + '\n\n[2] CLAIM: As of December 9, 2025, Wynlow Fulfillment\'s subscribed seat count was 515.\nLANE: data-derived\nSTATUS: ⚖️ DISPUTED\nSOURCE: contracts/wynlow-fulfillment-renewal-2025')).toEqual([false, false]);

    const f18: GoldV3 = { values: [], slugs: [], status: 'contradicted', spec: { kind: 'fact-check', status: 'contradicted', cite: [['contracts/prahaven-hardware-renewal-2024'], ['contracts/prahaven-hardware-renewal-2024', 'contracts/prahaven-hardware-rescission-1']], parts: [{ key: 'seats', status: 'contradicted', correct: { kind: 'number', value: 560 } }, { key: 'price', status: 'supported' }, { key: 'discount', status: 'contradicted', correct: { kind: 'number', value: 5, unit: 'percent' } }] } };
    const block18 = (n: number, claim: string, status: string, source: string, notes: string) => '[' + n + '] CLAIM: As of February 12, 2025, Prahaven Hardware\'s ' + claim + '\nLANE: data-derived\nSTATUS: ' + status + '\nSOURCE: ' + source + '\n' + notes;
    const report18 = (price: string, priceNotes: string) => [
      block18(1, 'subscribed seat count was 465.', '❌ FALSE', 'contracts/prahaven-hardware-renewal-2024', 'Correct value: 560.'),
      block18(2, price, '✅ VERIFIED', 'contracts/prahaven-hardware-renewal-2024', priceNotes),
      block18(3, 'percentage discount was 10%.', '❌ FALSE', 'contracts/prahaven-hardware-renewal-2024, contracts/prahaven-hardware-rescission-1', 'Correct value: 5%.'),
    ].join('\n\n');
    expect(run('fact-check', f18, report18('list price per seat per year was USD 1,175.', 'The page in force confirms it.'))).toEqual([true, true]);
    expect(run('fact-check', f18, report18('list price per seat per year was USD 1,175.', 'The renewal lists USD 1,175/seat/year, before discount, for every seat.'))).toEqual([true, true]);
    expect(run('fact-check', f18, report18('list price was USD 1,175/seat/year.', 'The page in force confirms it.'))).toEqual([true, true]);
    expect(run('fact-check', f18, report18('per-seat list price was USD 1,175 before discount.', 'The page in force confirms it.'))).toEqual([true, true]);
  });
  test('fact-check: every part marked FALSE is a degenerate answer that fails a task with a supported part', () => {
    const fc: GoldV3 = { values: [], slugs: [], status: 'contradicted', spec: { kind: 'fact-check', status: 'contradicted', cite: [['contracts/a-msa'], ['contracts/a-amendment-1']], parts: [{ key: 'seats', status: 'contradicted', correct: { kind: 'number', value: 240 } }, { key: 'discount', status: 'supported' }] } };
    const fs: GoldV3 = { values: [], slugs: ['companies/acme', 'people/jo-ray'], status: 'supported', spec: { kind: 'fact-check', status: 'supported', cite: [['companies/acme', 'people/jo-ray']], parts: [{ key: null, status: 'supported' }] } };
    for (const gold of [fc, fs]) {
      const negative = degenerateAnswers('fact-check', { gold, distractors: { slugs: [], values: [] }, answerable: true }).find(d => d.kind === 'always-negative');
      expect(negative).toBeTruthy();
      expect(run('fact-check', gold, negative!.text)).toEqual([false, false]);
    }
    const contradicted: GoldV3 = { values: [], slugs: [], status: 'contradicted', spec: { kind: 'fact-check', status: 'contradicted', cite: [['contracts/a-msa']], parts: [{ key: null, status: 'contradicted', correct: { kind: 'number', value: 240 } }] } };
    expect(degenerateAnswers('fact-check', { gold: contradicted, distractors: { slugs: [], values: [] }, answerable: true }).map(d => d.kind)).not.toContain('always-negative');
  });
});

describe('skillopt-method-v3: gbrain rule-score parity', () => {
  test('gbrain\'s rule score equals the fraction of score.ts checks passed, and the substance subset agrees, on every train and selection task, seed template and mutation', async () => {
    let n = 0;
    for (const skill of SKILLS) for (const t of trainSel(skill)) {
      const texts = [t.oracle_answer, seedTemplate(skill, t, false), seedTemplate(skill, t, true), ...degenerateAnswers(skill, t).map(d => d.text),
        ...(skill === 'query' ? (['answer-line', 'table', 'prose'] as const).map(l => queryAnswer(t, l)) : skill === 'briefing' ? (['seed', 'table', 'prose'] as const).map(l => briefingAnswer(t, l)) : (['seed', 'table', 'prose'] as const).map(l => factCheckAnswer(t, l, true)))]
        .filter((x): x is string => x !== null);
      const substance: Judge = { kind: 'rule', checks: checksOf(t.judge).filter(c => c.layer === 'substance') };
      for (const text of texts) {
        const ours = evaluateLayers(text, t.judge);
        const theirs = await scoreTrajectory({ final_text: text } as Parameters<typeof scoreTrajectory>[0], t.judge);
        const theirsSubstance = await scoreTrajectory({ final_text: text } as Parameters<typeof scoreTrajectory>[0], substance);
        expect([t.task_id, theirs.score]).toEqual([t.task_id, ours.fraction]);
        expect([t.task_id, theirsSubstance.score === 1]).toEqual([t.task_id, ours.substance]);
        n++;
      }
    }
    expect(n).toBeGreaterThan(800);
  }, 120_000);
});

// ─── Audit, redaction and the dataset cache ──────────────────────────────────

describe('skillopt-method-v3: dataset context', () => {
  const v3 = datasetContext('v3');
  const v2 = datasetContext('v2');
  const sentinel = v3.names.find(n => n.includes(' ') && !v2.names.includes(n) && ![...v2.pages.values()].some(p => p.includes(n)))!;

  test('a v3-only sentinel entity, slug and gold value are audited under v3 and are not v2 vocabulary', () => {
    expect(sentinel).toBeTruthy();
    const seed = readSeed('query', 'v3');
    const slug = [...v3.pages.keys()].find(s => s.startsWith('announcements/'))!;
    const value = readTasks('query', 'train', 'v3').flatMap(t => t.gold.values).find(v => v.kind === 'number' && v.unit === 'money')!;
    const frozen = seed + '\n- Always ask ' + sentinel + ' first.\n- Read ' + slug + ' before answering.\n- A list price of ' + shown(value) + ' is typical.\n';
    const r3 = auditSkill('query', frozen, seed, 'v3');
    expect(r3.disqualified).toBe(true);
    expect(r3.flags.filter(f => f.token === sentinel || f.token === slug).map(f => f.kind).sort()).toEqual(['entity', 'slug']);
    expect(r3.flags.some(f => f.kind === 'gold-value')).toBe(true);
    const r2 = auditSkill('query', frozen, seed, 'v2');
    expect(r2.flags.filter(f => f.token === sentinel || f.token === slug)).toEqual([]);
    expect(auditSkill('query', seed, seed, 'v3')).toEqual({ skill: 'query', added_lines: 0, removed_lines: 0, flags: [], disqualified: false });
  });

  test('a frozen skill that changes its frontmatter or its tools: list is disqualified', () => {
    for (const skill of SKILLS) {
      const seed = readSeed(skill, 'v3');
      const description = /^description: .*$/m.exec(seed)![0]!;
      const retitled = seed.replace(description, description + ' Also more.');
      const r = auditSkill(skill, retitled, seed, 'v3');
      expect([skill, r.disqualified, r.flags.map(f => f.kind)]).toEqual([skill, true, ['frontmatter']]);
      const tooled = seed.replace(/^tools:\s*\n/m, m => m + '  - put_page\n');
      expect(tooled).not.toBe(seed);
      const t = auditSkill(skill, tooled, seed, 'v3');
      expect([skill, t.disqualified, t.flags.map(f => f.kind)]).toEqual([skill, true, ['tools']]);
    }
  });

  test('the proposer input withholds v3 selection gold under v3\'s redaction scope', () => {
    const train = readTasks('query', 'train', 'v3');
    const sel = readTasks('query', 'sel', 'v3');
    const scope = redactionScope(v3, train, sel);
    const gold = sel.find(t => t.gold.slugs.length && !scope.pages.visible.has(t.gold.slugs[0]!) && t.gold.values.some(v => v.kind === 'number' && v.unit === 'money' && scope.markers.some(m => m.kind === 'value' && new RegExp(m.pattern, 'm').test(shown(v)))))!;
    const slug = gold.gold.slugs[0]!;
    const value = shown(gold.gold.values.find(v => v.kind === 'number' && v.unit === 'money')!);
    const trajectories: TrainTrajectory[] = [{
      task_id: train[0]!.task_id, task: train[0]!.task, answer: 'It is ' + value + ', see ' + slug + ' and ' + sentinel + '.', correct: false, failed: ['answer'],
      tool_calls: [{ name: 'get_page', input: { slug }, failed: false, pages: [{ slug, title: 'Planted' }] }],
    }];
    const { text, withheld } = proposerInput({ seedText: 'seed', criteria: 'criteria', trajectories, ...scope });
    expect(withheld).toBeGreaterThanOrEqual(3);
    expect(text).toContain(WITHHELD);
    expect(text).not.toContain(slug);
    expect(text).not.toContain(value);
    expect(markersIn(text, scope.markers)).toEqual([]);
    expect(v2.pages.has(slug)).toBe(false);
  });

  test('a same-process dataset change invalidates the cached context', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillopt-method-v3-'));
    try {
      mkdirSync(join(root, 'world'));
      const write = (pages: Record<string, string>, manifest: string) => {
        writeFileSync(join(root, 'world', 'pages.jsonl'), Object.entries(pages).map(([slug, content]) => JSON.stringify({ slug, content })).join('\n') + '\n');
        writeFileSync(join(root, 'MANIFEST.json'), manifest);
      };
      const person = (name: string) => '---\ntype: person\ntitle: "' + name + '"\n---\n\n# ' + name + '\n';
      write({ 'people/ada-sentinel-1': person('Ada Sentinel') }, '{"rev":1}');
      const a = datasetContext('v3', root);
      expect([a.pages.size, a.names]).toEqual([1, ['Ada Sentinel']]);
      expect(datasetContext('v3', root)).toBe(a);
      write({ 'people/ada-sentinel-1': person('Ada Sentinel'), 'people/bo-sentinel-2': person('Bo Sentinel') }, '{"rev":2}');
      const b = datasetContext('v3', root);
      expect(b).not.toBe(a);
      expect([b.pages.size, b.names]).toEqual([2, ['Ada Sentinel', 'Bo Sentinel']]);
      expect(b.manifest_sha256).toBe(sha256('{"rev":2}'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
