/**
 * messy-company-v1: dataset integrity, agent-task oracle checks, scorers and
 * the loader smoke.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { longClause } from '../../eval/generators/messy-company/generate.ts';
import { adjudications, compareAll } from '../../eval/generators/messy-company/labels.ts';
import { checkManifest } from '../../eval/generators/messy-company/manifest.ts';
import { governing, ownersOn } from '../../eval/generators/messy-company/oracle.ts';
import { TASKS } from '../../eval/generators/messy-company/tasks.ts';
import { EVENTS, type Attr } from '../../eval/generators/messy-company/world.ts';
import { DATASET, loadGold, type Split } from '../../eval/runner/messy-company/common.ts';
import { loadSplit, readSplit } from '../../eval/runner/messy-company/load.ts';
import { scoreAgentTasks } from '../../eval/runner/messy-company/score-agent-tasks.ts';
import { scoreAliases } from '../../eval/runner/messy-company/score-aliases.ts';
import { scoreChanges } from '../../eval/runner/messy-company/score-changes.ts';
import { scoreStatus } from '../../eval/runner/messy-company/score-document-status.ts';
import { scoreEntityMentions } from '../../eval/runner/messy-company/score-entity-mentions.ts';
import { scoreGoverning } from '../../eval/runner/messy-company/score-governing-records.ts';
import { scoreOwnerPhrases } from '../../eval/runner/messy-company/score-owner-phrases.ts';
import { probes, scoreOwnership } from '../../eval/runner/messy-company/score-ownership.ts';
import { scoreTimeline } from '../../eval/runner/messy-company/score-timeline.ts';
import type { Report } from '../../eval/runner/messy-company/common.ts';

const SPLITS: Split[] = ['dev', 'heldout'];
const rate = (r: Report, name: string) => r.metrics.find(m => m.name === name)!.rate;

describe('messy-company-v1 dataset', () => {
  test('data files match the frozen manifest', () => {
    expect(checkManifest()).toEqual([]);
  });

  test('corpus splits are disjoint and match the label slugs', () => {
    const pages = readSplit('all');
    expect(pages.length).toBe(226);
    const slugs = new Map(pages.map(p => [p.slug, p.split]));
    for (const split of SPLITS) {
      for (const lane of ['owner-phrases', 'entity-mentions', 'document-status']) {
        for (const r of loadGold(lane, split)) expect(slugs.get(r.slug)).toBe(split);
      }
      for (const t of loadGold('agent-tasks', split)) for (const s of t.evidence_slugs) expect(slugs.get(s)).toBe(split);
    }
  });

  test('every verifier disagreement has a recorded adjudication', () => {
    const adj = adjudications();
    const open = compareAll().filter(i => !i.agree && !adj.has(i.key));
    expect(open.map(i => i.key)).toEqual([]);
    for (const a of adj.values()) expect(a.note.length).toBeGreaterThan(20);
  });

  test('owner-phrase lane keeps enough candidates on both sides', () => {
    const rows = SPLITS.flatMap(s => loadGold('owner-phrases', s));
    expect(rows.length).toBeGreaterThanOrEqual(120);
    expect(rows.filter(r => r.should_link).length).toBeGreaterThanOrEqual(70);
    expect(rows.filter(r => !r.should_link).length).toBeGreaterThanOrEqual(40);
    for (const r of rows) expect(r.lines.length).toBeGreaterThan(0);
  });

  test('long contracts bury exactly one deciding notice clause', () => {
    for (const [path, days] of [['corpus/dev/contracts/2025-03-28-qfl-msa.md', 120], ['corpus/heldout/contracts/2025-06-30-vtg-msa.md', 90]] as const) {
      const t = readFileSync(join(DATASET, path), 'utf8');
      expect(t.length).toBeGreaterThan(20_000);
      const c = longClause(t.replace(/^---\n[\s\S]*?\n---\n/, ''), days);
      expect(c?.index ?? -1).toBeGreaterThanOrEqual(0);
      expect(c!.para).toMatch(/elect/i);
    }
  });
});

describe('messy-company-v1 agent tasks', () => {
  test('every oracle_check reproduces the stored answer', () => {
    const checked = TASKS.filter(t => t.oracle_check);
    expect(checked.length).toBeGreaterThan(20);
    for (const t of checked) {
      const c = t.oracle_check!;
      if (c.kind === 'owner_on' || c.kind === 'acting_on') {
        const pick = (view: 'full' | 'public') => ownersOn(c.account!, c.date!, view).filter(s => (c.kind === 'acting_on' ? s.role === 'acting' : s.role === 'primary' || s.role === 'team')).map(s => s.owner);
        expect({ id: t.id, got: pick('full') }).toEqual({ id: t.id, got: [t.answer as string] });
        if (t.answer_public_only === 'unknown') expect({ id: t.id, leaked: pick('public').includes(t.answer as string) }).toEqual({ id: t.id, leaked: false });
      } else if (c.kind === 'governing') {
        expect({ id: t.id, got: governing(c.account!, c.attr as Attr, c.date!)?.value }).toEqual({ id: t.id, got: t.answer as string | number });
      } else {
        expect({ id: t.id, got: EVENTS.find(e => e.id === c.event)?.date }).toEqual({ id: t.id, got: t.answer as string });
      }
    }
  });

  test('task ids are unique and split by account cluster', () => {
    expect(new Set(TASKS.map(t => t.id)).size).toBe(TASKS.length);
    for (const t of TASKS) expect(t.id.startsWith(t.split === 'dev' ? 'dev-' : 'ho-')).toBe(true);
  });
});

describe('messy-company-v1 scorers', () => {
  for (const split of SPLITS) {
    test(`a gold-perfect system scores 100% and an empty one 0% (${split})`, () => {
      const op = loadGold('owner-phrases', split);
      const perfectOp = scoreOwnerPhrases(split, { links: op.filter(g => g.should_link).map(g => ({ slug: g.slug, surface: g.surface, accounts: g.intended_accounts })) });
      expect(rate(perfectOp, 'link recall (should_link, right accounts)')).toBe(1);
      expect(rate(perfectOp, 'link precision (emitted links that are right)')).toBe(1);
      expect(rate(perfectOp, 'false links on should_link=false')).toBe(0);
      const publicOp = scoreOwnerPhrases(split, { links: op.filter(g => g.should_link_public).map(g => ({ slug: g.slug, surface: g.surface, accounts: g.intended_accounts })) }, 'public');
      expect(rate(publicOp, 'link recall (should_link, right accounts)')).toBe(1);
      const greedy = scoreOwnerPhrases(split, { links: op.map(g => ({ slug: g.slug, surface: g.surface.toUpperCase(), accounts: g.intended_accounts.length ? g.intended_accounts : ['quarrendon'] })) });
      expect(rate(greedy, 'false links on should_link=false')).toBe(1);
      expect(rate(scoreOwnerPhrases(split, {}), 'link recall (should_link, right accounts)')).toBe(0);

      const ow = loadGold('ownership', split);
      const windows = ow.filter(g => g.role && g.role !== 'overlap').map(g => ({ account: g.account, owner: g.owner, role: g.role, start: g.start, end: g.end }));
      const perfectOw = scoreOwnership(split, { windows });
      expect(rate(perfectOw, 'owner-on-date probes correct')).toBe(1);
      expect(rate(perfectOw, 'acting-cover probes correct')).toBe(1);
      expect(rate(perfectOw, 'exact window recall (known start)')).toBe(1);
      expect(rate(perfectOw, 'exact window precision')).toBe(1);
      const vacant = probes(ow, 'full').filter(p => p.kind === 'owner');
      expect(rate(scoreOwnership(split, {}), 'owner-on-date probes correct')).toBe(vacant.filter(p => p.owners.length === 0).length / vacant.length);

      const al = loadGold('aliases', split);
      const perfectAl = scoreAliases(split, { aliases: al.filter(g => g.valid).map(g => ({ surface: g.surface, entity: g.entity })) });
      expect(rate(perfectAl, 'valid alias recall')).toBe(1);
      expect(rate(perfectAl, 'false aliases asserted')).toBe(0);
      expect(rate(scoreAliases(split, { aliases: al.map(g => ({ surface: g.surface, entity: g.entity })) }), 'false aliases asserted')).toBe(1);

      const em = loadGold('entity-mentions', split);
      expect(rate(scoreEntityMentions(split, { mentions: em.map(g => ({ slug: g.slug, line: g.line, surface: g.surface, occurrence: g.occurrence, entity: g.entity })) }), 'accuracy (all mentions)')).toBe(1);
      expect(rate(scoreEntityMentions(split, {}), 'accuracy (all mentions)')).toBe(0);

      const gr = loadGold('governing-records', split);
      const perfectGr = scoreGoverning(split, { answers: gr.map(g => ({ id: g.id, value: g.value, record_slug: g.governing_slug, passage: { slug: g.deciding_passage.slug, line: g.deciding_passage.line } })) });
      expect(rate(perfectGr, 'value correct')).toBe(1);
      expect(rate(perfectGr, 'governing record correct')).toBe(1);
      expect(rate(perfectGr, 'deciding passage hit (slug, +-3 lines)')).toBe(1);

      const ds = loadGold('document-status', split);
      expect(rate(scoreStatus(split, { status: ds.map(g => ({ slug: g.slug, status: g.status })) }), 'status correct')).toBe(1);
      expect(rate(scoreStatus(split, { status: ds.map(g => ({ slug: g.slug, status: 'signed' })) }), 'status correct')).toBeLessThan(1);

      const tl = loadGold('timeline', split);
      const perfectTl = scoreTimeline(split, { events: tl.filter(g => !g.negative).map(g => ({ date: g.date, accounts: g.accounts })) });
      expect(rate(perfectTl, 'event recall (date + account)')).toBe(1);
      expect(rate(perfectTl, 'event precision')).toBe(1);
      expect(rate(perfectTl, 'events on corrected announcement dates')).toBe(0);
      expect(rate(scoreTimeline(split, { events: tl.filter(g => g.negative).map(g => ({ date: g.negative_date, accounts: g.accounts })) }), 'events on corrected announcement dates')).toBe(1);

      const ch = loadGold('changes', split);
      const perfectCh = scoreChanges(split, { pairs: ch.filter(g => g.kind === 'pair').map(g => ({ id: g.id, relation: g.relation })), retractions: ch.filter(g => g.kind === 'retraction').map(g => ({ id: g.id, value: g.final_value })) });
      expect(rate(perfectCh, 'pair relation correct')).toBe(1);
      if (ch.some(g => g.kind === 'retraction')) {
        expect(rate(perfectCh, 'retraction final value correct')).toBe(1);
        expect(rate(scoreChanges(split, { retractions: ch.filter(g => g.kind === 'retraction').map(g => ({ id: g.id, value: g.retracted_value })) }), 'retraction final value correct')).toBe(0);
      }

      const at = loadGold('agent-tasks', split);
      expect(rate(scoreAgentTasks(split, { answers: at.map(t => ({ id: t.id, answer: t.answer })) }), 'answer correct')).toBe(1);
      expect(rate(scoreAgentTasks(split, { answers: at.map(t => ({ id: t.id, answer: t.answer_public_only ?? t.answer })) }, 'public'), 'answer correct')).toBe(1);
      expect(rate(scoreAgentTasks(split, { answers: at.map(t => ({ id: t.id, answer: 'zzz' })) }), 'answer correct')).toBe(0);
    });
  }
});

describe('messy-company-v1 loader', () => {
  test('imports every dev page into PGLite and reads it back', async () => {
    const { engine, report } = await loadSplit('dev');
    await engine.disconnect();
    expect(report.errors).toEqual([]);
    expect(report.imported).toBe(report.pages);
    expect(report.read_back_ok).toBe(report.pages);
  }, 300_000);

  test('marks visibility: private pages so --public-only can skip them', () => {
    for (const split of SPLITS) {
      const pages = readSplit(split);
      const priv = pages.filter(p => p.private);
      expect(priv.length).toBeGreaterThan(0);
      for (const p of priv) expect(p.content).toMatch(/^---\n[\s\S]*?^visibility: private$/m);
    }
  });
});
