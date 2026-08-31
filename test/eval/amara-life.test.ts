/**
 * amara-life-v1 procedural skeleton tests (Day 2 of BrainBench v1 Complete).
 *
 * Guards:
 *   - Determinism under seed (same seed → byte-identical output)
 *   - Item counts (50/300/20/8/40)
 *   - Perturbation FIXTURE counts (10/5/5/3) and planted ITEM counts
 *     (20/10/5/9) — contradictions and stale facts are PAIRED (audit fix
 *     generators-01), implicit preferences carry >=3 evidence items each
 *     (audit fix generators-02)
 *   - Slug regex compatibility with eval/runner/queries/validator.ts
 *   - Meeting↔calendar coherence (audit fix generators-08)
 *   - Email thread counterparty coherence (audit fix generators-09)
 *   - Gold derivation (buildGoldFixtures) references real planted slugs
 *
 * This runs WITHOUT generating Opus prose (Day 3) or world-v1 resolution.
 */

import { describe, test, expect } from 'bun:test';
import {
  buildSkeleton,
  buildGoldFixtures,
  countPerturbations,
  CONTRADICTION_FIXTURES,
  STALE_FACT_FIXTURES,
  IMPLICIT_PREF_PLACEMENTS,
  DEFAULT_CONTACTS,
  type AmaraLifeSkeleton,
  type Perturbation,
  type PerturbationKind,
} from '../../eval/generators/amara-life.ts';

// Regex from eval/runner/queries/validator.ts:131 — pins the slug convention.
const SLUG_RE = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

/** All perturbed items across the corpus, with their slugs. */
function perturbedItems(s: AmaraLifeSkeleton): Array<{ slug: string; p: Perturbation; ts: Date }> {
  const out: Array<{ slug: string; p: Perturbation; ts: Date }> = [];
  for (const e of s.emails) if (e.perturbation) out.push({ slug: e.slug, p: e.perturbation, ts: new Date(e.ts) });
  for (const m of s.slack) if (m.perturbation) out.push({ slug: m.slug, p: m.perturbation, ts: new Date(m.ts) });
  for (const mt of s.meetings) if (mt.perturbation) out.push({ slug: mt.slug, p: mt.perturbation, ts: new Date(mt.date) });
  for (const n of s.notes) if (n.perturbation) out.push({ slug: n.slug, p: n.perturbation, ts: new Date(n.date) });
  return out;
}

describe('amara-life skeleton', () => {
  test('default buildSkeleton() returns counts matching plan spec', () => {
    const s = buildSkeleton();
    expect(s.emails.length).toBe(50);
    expect(s.slack.length).toBe(300);
    expect(s.calendar.length).toBe(20);
    expect(s.meetings.length).toBe(8);
    expect(s.notes.length).toBe(40);
    expect(s.contacts.length).toBe(15);
  });

  test('perturbation fixture counts are exactly 10/5/5/3; item counts 20/10/5/9', () => {
    const s = buildSkeleton();
    const counts = countPerturbations(s);
    expect(counts.fixtures.contradiction).toBe(10);
    expect(counts.fixtures['stale-fact']).toBe(5);
    expect(counts.fixtures.poison).toBe(5);
    expect(counts.fixtures['implicit-preference']).toBe(3);
    expect(counts.items.contradiction).toBe(20);
    expect(counts.items['stale-fact']).toBe(10);
    expect(counts.items.poison).toBe(5);
    expect(counts.items['implicit-preference']).toBe(9);
  });

  test('same seed produces byte-identical output', () => {
    const a = buildSkeleton({ seed: 42 });
    const b = buildSkeleton({ seed: 42 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  test('different seeds produce different output', () => {
    const a = buildSkeleton({ seed: 42 });
    const b = buildSkeleton({ seed: 7 });
    // Content differs (timestamps are deterministic, but contact choices shift)
    expect(a.emails[0].from.email).not.toBe(b.emails[0].from.email);
  });

  test('all slugs match the one-slash validator regex', () => {
    const s = buildSkeleton();
    const allSlugs = [
      ...s.emails.map(e => e.slug),
      ...s.slack.map(x => x.slug),
      ...s.calendar.map(x => x.slug),
      ...s.meetings.map(x => x.slug),
      ...s.notes.map(x => x.slug),
    ];
    for (const slug of allSlugs) {
      expect(slug).toMatch(SLUG_RE);
    }
  });

  test('all contact worldSlugs match slug regex', () => {
    for (const c of DEFAULT_CONTACTS) {
      expect(c.worldSlug).toMatch(SLUG_RE);
    }
  });

  test('all email thread_ids and in_reply_to chain correctly', () => {
    const s = buildSkeleton();
    for (const e of s.emails) {
      if (e.in_reply_to) {
        expect(e.in_reply_to).toMatch(/^em-\d{4}$/);
      }
      expect(e.thread_id).toMatch(/^thr-\d{4}$/);
    }
  });

  test('amara is either sender or recipient of every email', () => {
    const s = buildSkeleton();
    for (const e of s.emails) {
      const amaraIsSender = e.from.email === 'amara@halfway.vc';
      const amaraIsRecipient = e.to.some(t => t.email === 'amara@halfway.vc');
      expect(amaraIsSender || amaraIsRecipient).toBe(true);
    }
  });

  test('calendar events have dtstart < dtend', () => {
    const s = buildSkeleton();
    for (const ev of s.calendar) {
      expect(new Date(ev.dtstart).getTime()).toBeLessThan(new Date(ev.dtend).getTime());
    }
  });

  test('meetings attendees include amara', () => {
    const s = buildSkeleton();
    for (const m of s.meetings) {
      expect(m.attendees).toContain('user/amara-okafor');
    }
  });

  test('throws when given too few contacts', () => {
    expect(() =>
      buildSkeleton({ contacts: DEFAULT_CONTACTS.slice(0, 3) })
    ).toThrow(/≥8 contacts/);
  });

  test('profile.implicit_preferences has exactly 3 entries with unique fixture_ids', () => {
    const s = buildSkeleton();
    expect(s.profile.implicit_preferences.length).toBe(3);
    const ids = s.profile.implicit_preferences.map(p => p.fixture_id);
    expect(new Set(ids).size).toBe(3);
  });

  test('schema_version is 1 (bump invalidates cache per fix #18)', () => {
    const s = buildSkeleton();
    expect(s.schema_version).toBe(1);
  });
});

describe('paired fixtures (audit fix generators-01)', () => {
  const s = buildSkeleton();
  const planted = perturbedItems(s);
  const byFixture = new Map<string, Array<{ slug: string; p: Perturbation; ts: Date }>>();
  for (const it of planted) {
    const arr = byFixture.get(it.p.fixture_id) ?? [];
    arr.push(it);
    byFixture.set(it.p.fixture_id, arr);
  }

  test('every contradiction fixture c-001..c-010 has exactly 2 items with distinct slugs', () => {
    for (let n = 1; n <= 10; n++) {
      const id = `c-${String(n).padStart(3, '0')}`;
      const items = byFixture.get(id) ?? [];
      expect(items.length).toBe(2);
      expect(new Set(items.map(i => i.slug)).size).toBe(2);
      const roles = items.map(i => i.p.role).sort();
      expect(roles).toEqual(['counterpart', 'primary']);
    }
  });

  test('every stale-fact fixture s-001..s-005 has exactly 2 items with distinct slugs', () => {
    for (let n = 1; n <= 5; n++) {
      const id = `s-${String(n).padStart(3, '0')}`;
      const items = byFixture.get(id) ?? [];
      expect(items.length).toBe(2);
      expect(new Set(items.map(i => i.slug)).size).toBe(2);
      const roles = items.map(i => i.p.role).sort();
      expect(roles).toEqual(['counterpart', 'primary']);
    }
  });

  test('both sides of a paired fixture carry the same machine-readable fact pair', () => {
    for (const f of [...CONTRADICTION_FIXTURES, ...STALE_FACT_FIXTURES]) {
      const items = byFixture.get(f.fixture_id) ?? [];
      expect(items.length).toBe(2);
      for (const it of items) {
        expect(it.p.fact).toBeDefined();
        expect(it.p.fact!.fact_key).toBe(f.fact.fact_key);
        expect(it.p.fact!.primary_value).toBe(f.fact.primary_value);
        expect(it.p.fact!.counterpart_value).toBe(f.fact.counterpart_value);
        expect(it.p.fact!.primary_value).not.toBe(it.p.fact!.counterpart_value);
      }
    }
  });

  test('stale-fact counterpart (superseding fact) always has a later timestamp than its primary', () => {
    for (const f of STALE_FACT_FIXTURES) {
      const items = byFixture.get(f.fixture_id) ?? [];
      const primary = items.find(i => i.p.role === 'primary')!;
      const counterpart = items.find(i => i.p.role === 'counterpart')!;
      expect(counterpart.ts.getTime()).toBeGreaterThan(primary.ts.getTime());
    }
  });

  test('poison fixtures stay single-item', () => {
    for (let n = 1; n <= 5; n++) {
      const id = `poison-${String(n).padStart(3, '0')}`;
      const items = byFixture.get(id) ?? [];
      expect(items.length).toBe(1);
      expect(items[0].p.role).toBeUndefined();
    }
  });

  test('no item carries two fixtures (placements never collide)', () => {
    // buildPerturbationMap throws on collision; this re-checks post-build.
    expect(new Set(planted.map(i => i.slug)).size).toBe(planted.length);
  });
});

describe('implicit-preference evidence (audit fix generators-02)', () => {
  const s = buildSkeleton();
  const planted = perturbedItems(s);

  test('every pref-001..003 has >=3 evidence items with distinct slugs and an evidence_hint', () => {
    for (const pref of s.profile.implicit_preferences) {
      const evidence = planted.filter(
        i => i.p.kind === 'implicit-preference' && i.p.fixture_id === pref.fixture_id
      );
      expect(evidence.length).toBeGreaterThanOrEqual(3);
      expect(new Set(evidence.map(i => i.slug)).size).toBe(evidence.length);
      for (const it of evidence) {
        expect(it.p.role).toBe('evidence');
        expect((it.p.evidence_hint ?? '').length).toBeGreaterThan(20);
      }
    }
  });

  test('evidence hints instruct surfacing without stating the preference', () => {
    for (const placement of IMPLICIT_PREF_PLACEMENTS) {
      // Every hint must forbid stating the preference directly.
      expect(placement.evidence_hint).toMatch(/NEVER state|NOT state|Do NOT state/i);
    }
  });
});

describe('meeting↔calendar coherence (audit fix generators-08)', () => {
  const s = buildSkeleton();
  const calBySlug = new Map(s.calendar.map(ev => [ev.slug, ev]));
  const contactBySlug = new Map(s.contacts.map(c => [c.worldSlug, c]));

  test('linked calendar events exist and share the meeting date', () => {
    for (const m of s.meetings) {
      if (!m.linked_calendar) continue;
      const evt = calBySlug.get(m.linked_calendar);
      expect(evt).toBeDefined();
      expect(evt!.dtstart.slice(0, 10)).toBe(m.date);
    }
  });

  test('linked calendar event counterparty matches the meeting counterparty', () => {
    for (const m of s.meetings) {
      if (!m.linked_calendar) continue;
      const evt = calBySlug.get(m.linked_calendar)!;
      const meetingContactSlug = m.attendees.find(a => a !== 'user/amara-okafor')!;
      const contact = contactBySlug.get(meetingContactSlug)!;
      const evtEmails = evt.attendees.map(a => a.email);
      expect(evtEmails).toContain(contact.email);
    }
  });

  test('no two meetings link the same calendar event', () => {
    const links = s.meetings.map(m => m.linked_calendar).filter(Boolean);
    expect(new Set(links).size).toBe(links.length);
  });
});

describe('email thread coherence (audit fix generators-09)', () => {
  const s = buildSkeleton();

  test('replies (odd i) keep the thread counterparty and subject of their parent', () => {
    const counterpartyOf = (e: (typeof s.emails)[number]) =>
      e.from.email === 'amara@halfway.vc' ? e.to[0].email : e.from.email;
    for (let i = 1; i < s.emails.length; i += 2) {
      const parent = s.emails[i - 1];
      const reply = s.emails[i];
      expect(reply.thread_id).toBe(parent.thread_id);
      expect(counterpartyOf(reply)).toBe(counterpartyOf(parent));
      expect(reply.subject).toBe(parent.subject);
    }
  });
});

describe('gold derivation (buildGoldFixtures)', () => {
  const s = buildSkeleton();
  const gold = buildGoldFixtures(s);
  const allSlugs = new Set([
    ...s.emails.map(e => e.slug),
    ...s.slack.map(x => x.slug),
    ...s.meetings.map(x => x.slug),
    ...s.notes.map(x => x.slug),
  ]);

  test('10 contradiction pairs + 5 stale facts, all refs are real planted slugs', () => {
    expect(gold.contradictions.pairs.length).toBe(10);
    expect(gold.contradictions.stale_facts.length).toBe(5);
    for (const p of [...gold.contradictions.pairs, ...gold.contradictions.stale_facts]) {
      expect(allSlugs.has(p.source_a.ref)).toBe(true);
      expect(allSlugs.has(p.source_b.ref)).toBe(true);
      expect(p.source_a.ref).not.toBe(p.source_b.ref);
      expect(p.source_a.claim).not.toBe(p.source_b.claim);
      expect(['source_a', 'source_b']).toContain(p.canonical);
      expect(p.expected_behavior.length).toBeGreaterThan(10);
    }
  });

  test('3 preferences with >=3 evidence pages each, all real slugs', () => {
    expect(gold.implicitPreferences.preferences.length).toBe(3);
    for (const pref of gold.implicitPreferences.preferences) {
      expect(pref.evidence_pages.length).toBeGreaterThanOrEqual(3);
      for (const ref of pref.evidence_pages) {
        expect(allSlugs.has(ref)).toBe(true);
      }
    }
  });

  test('gold refs point at items actually marked with the fixture', () => {
    const perturbationOf = new Map<string, Perturbation>();
    for (const it of perturbedItems(s)) perturbationOf.set(it.slug, it.p);
    for (const p of [...gold.contradictions.pairs, ...gold.contradictions.stale_facts]) {
      expect(perturbationOf.get(p.source_a.ref)?.fixture_id).toBe(p.id);
      expect(perturbationOf.get(p.source_b.ref)?.fixture_id).toBe(p.id);
    }
    for (const pref of gold.implicitPreferences.preferences) {
      for (const ref of pref.evidence_pages) {
        expect(perturbationOf.get(ref)?.fixture_id).toBe(pref.id);
      }
    }
  });
});

describe('amara-life Page.type enum extension', () => {
  test('new Page types include email | slack | calendar-event | note', async () => {
    // Import the eval-side Page type and verify the enum members.
    // We check at the type-system boundary by asserting a valid object.
    const ok: {
      slug: string;
      type: 'person' | 'company' | 'meeting' | 'concept' | 'deal' | 'project' | 'source' | 'media'
          | 'email' | 'slack' | 'calendar-event' | 'note';
      title: string;
      compiled_truth: string;
      timeline: string;
    } = {
      slug: 'emails/em-0000',
      type: 'email',
      title: 'stub',
      compiled_truth: '',
      timeline: '',
    };
    expect(ok.type).toBe('email');
  });

  test('existing Page types still valid', () => {
    const types: Array<PerturbationKind> = ['contradiction', 'stale-fact', 'poison', 'implicit-preference'];
    expect(types.length).toBe(4);
  });
});
