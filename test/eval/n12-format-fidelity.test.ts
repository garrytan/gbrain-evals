import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryEntry } from '../../eval/registry.ts';
import { resolveGbrainUnderTest } from '../../eval/runner/gbrain-under-test.ts';
import { assertScorerRejectsFakeSystems } from '../../eval/runner/mutation-kit.ts';
import { ProbeAccounting } from '../../eval/runner/probe-accounting.ts';
import { evaluatePromotion } from '../../eval/runner/promotion.ts';
import {
  N12_DEFAULT_SEED, generateN12World, type Conversation,
} from '../../eval/generators/n12-format-fidelity-gen.ts';
import {
  ADAPTER_RENDERERS, PATTERN_RENDERER_IDS, isoWithOffset, renderAdapterNegatives, renderPattern, type ExpectedTurn,
} from '../../eval/generators/n12-format-renderers.ts';
import {
  adapterStage, alignTurns, honestyStage, inventedTimestamps, noiseLeaks, openSut, parserStage, recovered, runN12, scoreAttendance, summarizeN12,
  type AttendanceRow, type ParsedTurn, type Sut,
} from '../../eval/runner/n12-format-fidelity.ts';

const tmp = mkdtempSync(join(tmpdir(), 'n12-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const world = generateN12World();
const convs = world.ledger.conversations;
const rules = registryEntry('N12')!.promotion!;
const MIN = 60_000;

describe('generator determinism', () => {
  test('same seed, same ledger fingerprint; different seed, different ledger', () => {
    const b = generateN12World({ seed: N12_DEFAULT_SEED });
    const c = generateN12World({ seed: N12_DEFAULT_SEED + 1 });
    expect(world.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(world.fingerprint);
    expect(c.fingerprint).not.toBe(world.fingerprint);
  });

  test('markers are unique, every conversation kind is present, names are placeholders', () => {
    const markers = convs.flatMap(c => c.turns.map(t => t.marker));
    expect(new Set(markers).size).toBe(markers.length);
    expect(convs.map(c => c.kind)).toEqual(['control', 'edges', 'multiline', 'three-party', 'same-speaker', 'tricky', 'midnight', 'offset']);
    for (const c of convs) for (const p of c.participants) expect(p.name).toMatch(/^\p{L}+ Example$/u);
    for (const p of world.ledger.people) expect(p.slug).toMatch(/^people\/[a-z]+-example$/);
  });

  test('meetings: attendees and mentioned people are disjoint; every form appears twice', () => {
    for (const m of world.ledger.meetings) expect(m.attendees.filter(a => m.mentioned.includes(a))).toEqual([]);
    const forms = world.ledger.meetings.map(m => m.form);
    for (const f of new Set(forms)) expect(forms.filter(x => x === f).length).toBe(2);
  });
});

describe('renderers', () => {
  test('a pattern render carries one expected turn per canonical turn, with format-honest timestamps', () => {
    for (const id of PATTERN_RENDERER_IDS) {
      for (const c of convs) {
        const r = renderPattern(id, c)!;
        expect(r.expected.length).toBe(c.turns.length);
        for (const [i, e] of r.expected.entries()) {
          expect(r.body.includes(e.marker)).toBe(true);
          if (r.carries === 'none') expect(e.ts_representable).toBeNull();
          if (r.carries === 'date-time' && !e.seconds_in_text) expect(e.ts_representable).toBe(Date.parse(c.turns[i].at) - (Date.parse(c.turns[i].at) % MIN));
        }
      }
    }
    expect(renderPattern('no-such-pattern', convs[0])).toBeNull();
  });

  test('a time-only format on a page dated before midnight keeps the page date (no rollover is representable)', () => {
    const midnight = convs.find(c => c.kind === 'midnight')!;
    const r = renderPattern('irc-weechat', midnight)!;
    const last = r.expected[r.expected.length - 1];
    expect(new Date(last.ts_representable!).toISOString().slice(0, 10)).toBe(r.page_date);
    expect(last.ts_representable).not.toBe(last.ts_true);
  });

  test('isoWithOffset spells the same instant', () => {
    const t = Date.parse('2026-08-11T05:30:00.000Z');
    expect(isoWithOffset(t, -420)).toBe('2026-08-10T22:30:00.000-07:00');
    expect(Date.parse(isoWithOffset(t, -420))).toBe(t);
    expect(isoWithOffset(t, 0)).toBe('2026-08-11T05:30:00.000Z');
  });
});

describe('scorer on hand-built gold', () => {
  const exp = (marker: string, label: string, ts: number | null, tsTrue = ts ?? 0): ExpectedTurn => ({ marker, role: 'user', labels: [label], ts_representable: ts, ts_true: tsTrue, seconds_in_text: false });
  const t0 = Date.parse('2026-03-03T13:00:00.000Z');
  const gold = [exp('zqa', 'Alice Example', t0), exp('zqb', 'Bob Example', t0 + MIN), exp('zqc', 'Alice Example', t0 + 2 * MIN)];
  const msg = (speaker: string, ts: number, text: string): ParsedTurn => ({ speaker, timestamp: new Date(ts).toISOString(), text });

  test('a perfect parse passes and is recovered', () => {
    const a = alignTurns(gold, [msg('alice example', t0, 'hi zqa'), msg(' Bob  Example ', t0 + MIN, 'zqb'), msg('Alice Example', t0 + 2 * MIN, 'ok zqc')]);
    expect(a.turns.every(t => t.speaker_ok && t.ts_ok)).toBe(true);
    expect(recovered(a)).toBe(true);
    expect([a.extra, a.duplicates, a.merged]).toEqual([0, 0, 0]);
  });

  test('negatives that must fail: merged turn, wrong speaker, wrong minute, missing turn, extra and duplicate messages', () => {
    const merged = alignTurns(gold, [msg('Alice Example', t0, 'zqa then zqb'), msg('Alice Example', t0 + 2 * MIN, 'zqc')]);
    expect(merged.merged).toBe(1);
    expect(merged.turns[1].speaker_ok).toBe(false);
    expect(recovered(merged)).toBe(false);
    const wrong = alignTurns(gold, [msg('Bob Example', t0, 'zqa'), msg('Bob Example', t0 + MIN, 'zqb'), msg('Alice Example', t0 + 3 * MIN, 'zqc')]);
    expect(wrong.turns.map(t => t.speaker_ok)).toEqual([false, true, true]);
    expect(wrong.turns[2].ts_ok).toBe(false);
    expect(recovered(wrong)).toBe(false);
    const missing = alignTurns(gold, [msg('Alice Example', t0, 'zqa')]);
    expect(missing.turns.filter(t => t.found).length).toBe(1);
    const extra = alignTurns(gold, [msg('Alice Example', t0, 'zqa'), msg('X', t0, 'no marker'), msg('Bob Example', t0 + MIN, 'zqb'), msg('Bob Example', t0 + MIN, 'zqb again'), msg('Alice Example', t0 + 2 * MIN, 'zqc')]);
    expect([extra.extra, extra.duplicates]).toEqual([1, 1]);
  });

  test('a format with no time is not timestamp-scored; minute precision is scored separately from carried seconds', () => {
    const a = alignTurns([exp('zqn', 'You', null, t0)], [msg('You', t0, 'zqn')]);
    expect(a.turns[0].ts_ok).toBeNull();
    const withSeconds = t0 + 17_000;
    const b = alignTurns([exp('zqs', 'You', withSeconds)], [msg('You', t0, 'zqs')]);
    expect([b.turns[0].ts_ok, b.turns[0].ts_minute_ok]).toEqual([false, true]);
  });

  test('a product exception (no messages) scores every turn as a miss, never as an error-free empty', () => {
    const a = alignTurns(gold, []);
    expect(a.turns.every(t => !t.found && !t.speaker_ok)).toBe(true);
    expect(recovered(a)).toBe(false);
  });

  test('noise leaks and invented timestamps', () => {
    const parsed = [msg('user', t0, 'hello noisezq1a'), { speaker: 'user', timestamp: '', text: 'x' }, msg('user', t0 + 5_000, 'y')];
    expect(noiseLeaks(['noisezq1a', 'noisezq1b'], parsed)).toEqual(['noisezq1a']);
    expect(inventedTimestamps([t0], parsed)).toEqual([new Date(t0 + 5_000).toISOString()]);
    expect(inventedTimestamps([t0], [{ speaker: 'user', timestamp: '2026-03-03T06:00:00.000-07:00', text: '' }])).toEqual([]);
  });

  test('attendance: mentioned-only people typed attended count as false attendance; recall per form', () => {
    const rows: AttendanceRow[] = [
      { meeting: 'm1', form: 'attendees-section', attendees: ['a', 'b'], mentioned: ['c'], attended: ['a', 'b'], links_seen: 3 },
      { meeting: 'm2', form: 'participants-line', attendees: ['a'], mentioned: ['c'], attended: [], links_seen: 2 },
      { meeting: 'm3', form: 'inline-attendees', attendees: ['a'], mentioned: ['c'], attended: ['a', 'c'], links_seen: 2 },
    ];
    const s = scoreAttendance(rows);
    expect([s.tp, s.fp, s.fn, s.false_attended]).toEqual([3, 1, 1, 1]);
    expect(s.control_recall).toBe(1);
    expect(s.by_form['participants-line'].recall).toBe(0);
    expect(s.documented.recall).toBe(1);
  });
});

// ─── Stages against the pinned gbrain, with broken adapters swapped in ─────

const gut = resolveGbrainUnderTest(null);
const realSut = await openSut(gut);
const control = convs.filter(c => c.kind === 'control');

function summarize(sut: Sut, adapters: Awaited<ReturnType<typeof adapterStage>>, parser: ReturnType<typeof parserStage>, honesty: Awaited<ReturnType<typeof honestyStage>>, attendance: AttendanceRow[] = goldAttendance()) {
  return summarizeN12({ adapterFormats: sut.adapters.map(a => a.format), patternIds: sut.patterns, adapters, parser, honesty, attendance, genericJson: { detected: null, reason: 'unknown_format', parser_phase: 'no_match' } });
}
function goldAttendance(): AttendanceRow[] {
  return world.ledger.meetings.map(m => ({ meeting: m.slug, form: m.form, attendees: m.attendees, mentioned: m.mentioned, attended: m.form === 'participants-line' || m.form === 'speakers-only' ? [] : m.attendees, links_seen: 2 }));
}
const grade = (data: unknown) => evaluatePromotion(rules, { data });

describe('stages on the pinned gbrain', () => {
  test('the registries are enumerated at run time and every registered format has a renderer', () => {
    expect(realSut.adapters.map(a => a.format).sort()).toEqual(Object.keys(ADAPTER_RENDERERS).sort());
    expect([...realSut.patterns].sort()).toEqual([...PATTERN_RENDERER_IDS].sort());
  });

  test('the control conversation comes back whole from every adapter and pattern', async () => {
    const adapters = await adapterStage(realSut, control, join(tmp, 'ok'), new ProbeAccounting(0));
    const parser = parserStage(realSut, control, new ProbeAccounting(0));
    expect(adapters.every(a => recovered(a.align) && a.detection_ok)).toBe(true);
    expect(parser.every(p => recovered(p.align))).toBe(true);
    expect(adapters.every(a => a.noise_leaks.length === 0 && a.invented.length === 0)).toBe(true);
  });

  test('a deliberately broken adapter (roles swapped) fails the control floor', async () => {
    const broken: Sut = {
      ...realSut,
      adapters: realSut.adapters.map(a => ({
        format: a.format,
        async *parse(path: string) {
          const gen = a.parse(path);
          let r = await gen.next();
          while (!r.done) { yield { ...r.value, messages: r.value.messages.map(m => ({ ...m, role: m.role === 'user' ? 'assistant' : 'user' })) }; r = await gen.next(); }
          return r.value;
        },
      })),
    };
    const adapters = await adapterStage(broken, control, join(tmp, 'broken'), new ProbeAccounting(0));
    const s = summarize(broken, adapters, parserStage(realSut, control, new ProbeAccounting(0)), []);
    expect(s.floor.control_recovered_rate).toBeLessThan(1);
    expect(grade(s).failures.map(f => f.id)).toContain('control-turn-floor');
  });

  test('an adapter that throws is a scored miss with the error recorded, not a skipped item', async () => {
    const acc = new ProbeAccounting(1);
    const throwing: Sut = { ...realSut, adapters: [{ format: 'codex', parse: () => { throw new Error('boom'); } }] as never };
    const [item] = await adapterStage(throwing, control, join(tmp, 'throw'), acc);
    expect(item.error).toBe('boom');
    expect(item.align.turns.every(t => !t.found)).toBe(true);
    expect(acc.summary().errors[0].origin).toBe('sut');
  });

  test('a parser that fabricates turns on non-conversation pages fails no-fabricated-turns', async () => {
    const fabricating: Sut = { ...realSut, parse: (body, date) => { const r = realSut.parse(body, date); return r.phase === 'no_match' ? { phase: 'regex_match', messages: [{ speaker: 'Note', timestamp: '2026-04-01T00:00:00Z', text: body.slice(0, 20) }] } : r; } };
    const honesty = await honestyStage(fabricating, world, join(tmp, 'neg'), new ProbeAccounting(0));
    const s = summarize(fabricating, [], [], honesty);
    expect(s.honesty.fabricated).toBeGreaterThan(0);
    expect(grade(s).failures.map(f => f.id)).toContain('no-fabricated-turns');
  });

  test('negative adapter inputs exist for every adapter and yield no session from the real adapters', async () => {
    for (const a of realSut.adapters) expect(renderAdapterNegatives(a.format, join(tmp, 'negs', a.format)).length).toBeGreaterThan(0);
    const honesty = await honestyStage(realSut, world, join(tmp, 'neg-real'), new ProbeAccounting(0));
    expect(honesty.filter(h => h.surface === 'adapter').every(h => h.messages === 0)).toBe(true);
  });
});

// ─── Scorer mutation suite (graded by the preregistered promotion rules) ────

describe('N12 scorer rejects the fake systems', () => {
  type Probe =
    | { kind: 'turn'; conv: Conversation; item: string; expected: ExpectedTurn; allowed: number[]; noise: string[] }
    | { kind: 'negative'; id: string }
    | { kind: 'attendance'; meeting: string; person: string; attended: boolean };
  type Answer = ParsedTurn | null | number | boolean;
  const probes: Probe[] = [];
  for (const c of convs) {
    for (const id of ['imessage-slack', 'irc-weechat', 'chatgpt-export-you-chatgpt']) {
      const r = renderPattern(id, c)!;
      for (const e of r.expected) probes.push({ kind: 'turn', conv: c, item: `${id}:${c.id}`, expected: e, allowed: r.expected.map(x => x.ts_representable ?? Date.parse(`${r.page_date}T00:00:00Z`)), noise: [] });
    }
    const a = ADAPTER_RENDERERS.codex(c, mkdtempSync(join(tmp, 'mut-')));
    for (const e of a.expected) probes.push({ kind: 'turn', conv: c, item: `codex:${c.id}`, expected: e, allowed: a.allowed_instants, noise: a.noise_markers });
  }
  for (const n of world.ledger.negative_pages) probes.push({ kind: 'negative', id: n.id });
  for (const m of world.ledger.meetings) for (const p of [...m.attendees, ...m.mentioned]) probes.push({ kind: 'attendance', meeting: m.slug, person: p, attended: m.attendees.includes(p) });

  const turnAnswer = (p: Extract<Probe, { kind: 'turn' }>, label: string, ts: number, extra = ''): ParsedTurn => ({ speaker: label, timestamp: new Date(ts).toISOString(), text: `${p.expected.marker}${extra}` });
  const truthTs = (p: Extract<Probe, { kind: 'turn' }>) => p.expected.ts_representable ?? p.allowed[0];
  const sameConvTurns = (p: Extract<Probe, { kind: 'turn' }>) => probes.filter((q): q is Extract<Probe, { kind: 'turn' }> => q.kind === 'turn' && q.item === p.item);

  const score = (answers: readonly Answer[]) => {
    const byItem = new Map<string, { expected: ExpectedTurn[]; parsed: ParsedTurn[]; allowed: number[]; noise: string[]; control: boolean }>();
    let fabricated = 0;
    const attendance = new Map<string, AttendanceRow>();
    probes.forEach((p, i) => {
      const a = answers[i];
      if (p.kind === 'turn') {
        const it = byItem.get(p.item) ?? { expected: [], parsed: [], allowed: p.allowed, noise: p.noise, control: p.conv.kind === 'control' };
        it.expected.push(p.expected);
        if (a && typeof a === 'object') it.parsed.push(a);
        byItem.set(p.item, it);
      } else if (p.kind === 'negative') fabricated += a as number;
      else {
        const m = world.ledger.meetings.find(x => x.slug === p.meeting)!;
        const row = attendance.get(p.meeting) ?? { meeting: m.slug, form: m.form, attendees: m.attendees, mentioned: m.mentioned, attended: [], links_seen: 1 };
        if (a === true) row.attended.push(p.person);
        attendance.set(p.meeting, row);
      }
    });
    const items = [...byItem.values()];
    const controls = items.filter(x => x.control).map(x => alignTurns(x.expected, x.parsed));
    const codexItems = [...byItem.entries()].filter(([k]) => k.startsWith('codex:')).map(([, v]) => v);
    const data = {
      honesty: { fabricated },
      adapters: {
        noise_leaks: codexItems.reduce((n, x) => n + noiseLeaks(x.noise, x.parsed).length, 0),
        invented_timestamps: codexItems.reduce((n, x) => n + inventedTimestamps(x.allowed, x.parsed).length, 0),
      },
      attendance: scoreAttendance([...attendance.values()]),
      floor: { control_recovered_rate: controls.filter(recovered).length / controls.length },
    };
    const o = evaluatePromotion(rules, { data });
    return { pass: o.pass, detail: o.failures.map(f => f.id).join(',') || 'all rules pass' };
  };

  test('honest passes; empty, always-positive, always-refuse, stale and wrong-source fail the preregistered rules', () => {
    const results = assertScorerRejectsFakeSystems<Probe, Answer>({
      category: 'N12',
      probes,
      score,
      space: {
        truth: p => (p.kind === 'turn' ? turnAnswer(p, p.expected.labels[0], truthTs(p)) : p.kind === 'negative' ? 0 : p.attended),
        empty: p => (p.kind === 'turn' ? null : p.kind === 'negative' ? 0 : false),
        // Claims everything: every skipped record kept, every page a conversation, everyone attended.
        everything: p => (p.kind === 'turn' ? turnAnswer(p, p.expected.labels[0], truthTs(p), p.noise.length ? ` ${p.noise[0]}` : '') : p.kind === 'negative' ? 3 : true),
        refusal: p => (p.kind === 'turn' ? null : p.kind === 'negative' ? 0 : false),
        // Carries the previous turn's speaker and time forward.
        stale: p => {
          if (p.kind !== 'turn') return undefined;
          const turns = sameConvTurns(p);
          const at = turns.indexOf(p);
          if (at === 0) return undefined;
          return turnAnswer(p, turns[at - 1].expected.labels[0], truthTs(turns[at - 1]));
        },
        // Another conversation's speaker at another conversation's time.
        wrongSource: p => {
          if (p.kind === 'attendance') return p.attended ? undefined : true;
          if (p.kind !== 'turn') return undefined;
          const other = convs.find(c => c.id !== p.conv.id && c.kind !== 'offset')!;
          return turnAnswer(p, other.participants[0].name, Date.parse(other.turns[0].at) + 12_345);
        },
      },
    });
    expect(results.find(r => r.system === 'honest')!.pass).toBe(true);
    if (process.env.N12_SHOW_MUTATION) console.log(JSON.stringify(results.map(r => [r.system, r.pass, r.changed, r.detail])));
  });
});

describe('full run on the pinned gbrain', () => {
  test('runs hermetically, restores the environment, and fills every promotion path', async () => {
    const before = process.env.GBRAIN_HOME;
    const r = await runN12({ gut });
    expect(process.env.GBRAIN_HOME).toBe(before);
    expect(r.harnessError).toBeNull();
    expect(r.presence.every(p => p.ok)).toBe(true);
    const outcome = evaluatePromotion(rules, { data: r.summary });
    for (const res of outcome.results) expect([res.id, typeof res.observed]).toEqual([res.id, 'number']);
    expect(r.summary!.coverage.coverage_rate).toBe(1);
    expect(r.summary!.adapters.items).toBe(Object.keys(ADAPTER_RENDERERS).length * convs.length);
  }, 120_000);
});

