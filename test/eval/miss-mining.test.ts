import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQuestions } from '../../eval/runner/live-recall/run.ts';
import { MAX_STRING, checkMissExport, validateMissExport } from '../../eval/runner/miss-mining/custody.ts';
import { MissMiningRefusal, missNeedles, parseMissLog, type MissEntry } from '../../eval/runner/miss-mining/schema.ts';
import { liveTypeFor, main as convertMain, toLiveRecall } from '../../eval/runner/miss-mining/to-live-recall.ts';
import { main as weeklyMain, weekOf, weeklyCounts } from '../../eval/runner/miss-mining/weekly-counts.ts';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'miss-2026-11-10-001', date: '2026-11-10', ask_kind: 'lookup_meeting_prep', cause: 'retrieval_miss', detection: 'found_later', garry_noticed: false,
  gold: [{ slug: 'people/marisol-vance' }], ...over,
});
const LOG = [
  entry({ cause: 'stale_fact', detection: 'garry_corrected', garry_noticed: true, gold: [{ slug: 'meetings/2026-11-03-bluejay-sync' }], stale: [{ slug: 'people/marisol-vance' }], ask: { exact: 'Where does Marisol Vance work now?', paraphrase: 'Which company did our old supplier contact move to?' } }),
  entry({ id: 'miss-2026-11-11-001', date: '2026-11-11', cause: 'wrong_entity', ask: { exact: 'Which Dana runs Orchid ops?', paraphrase: 'Who handles operations at the sprayer firm?' } }),
  entry({ id: 'miss-2026-11-12-001', date: '2026-11-12', ask_kind: 'time_window', cause: 'retrieval_miss', detection: 'tool_error', ask: { exact: 'What shipped the week of Oct 6?', paraphrase: 'What went out in early October?' } }),
  entry({ id: 'miss-2026-11-12-002', date: '2026-11-12', cause: 'privacy_hidden', privacy_subcause: 'alias_inheritance' }),
  entry({ id: 'miss-2026-11-13-001', date: '2026-11-13', cause: 'stale_fact', live_type: 'freshness', ask: { exact: 'Codename Bluejay status', paraphrase: 'How is the voice app going?' } }),
  entry({ id: 'miss-2026-11-17-001', date: '2026-11-17', cause: 'write_integrity', ask_kind: 'save_ingest', detection: 'tool_error' }),
];
const logText = LOG.map(e => JSON.stringify(e)).join('\n') + '\n';
const entries = parseMissLog(logText);
const refused = (fn: () => unknown) => {
  try { fn(); return 'accepted'; } catch (e) { return e instanceof MissMiningRefusal ? e.code : String(e); }
};

describe('miss-mining log', () => {
  test('parses every field and refuses bad lines naming the line and field only', () => {
    expect(entries).toHaveLength(6);
    expect(entries[3]!.privacy_subcause).toBe('alias_inheritance');
    const bad = (over: Record<string, unknown>) => { try { parseMissLog(JSON.stringify(entry(over))); return 'accepted'; } catch (e) { return (e as Error).message; } };
    expect(bad({ id: 'Marisol Vance' })).toBe('MM_LOG_INVALID: line 1 field id');
    expect(bad({ date: '2026-13-40' })).toBe('MM_LOG_INVALID: line 1 field date');
    expect(bad({ ask_kind: 'gossip' })).toBe('MM_LOG_INVALID: line 1 field ask_kind');
    expect(bad({ cause: 'bad_luck' })).toBe('MM_LOG_INVALID: line 1 field cause');
    expect(bad({ privacy_subcause: 'direct_flag' })).toBe('MM_LOG_INVALID: line 1 field privacy_subcause');
    expect(bad({ detection: 'hunch' })).toBe('MM_LOG_INVALID: line 1 field detection');
    expect(bad({ garry_noticed: 'yes' })).toBe('MM_LOG_INVALID: line 1 field garry_noticed');
    expect(bad({ gold: [] })).toBe('MM_LOG_INVALID: line 1 field gold');
    expect(bad({ ask: { exact: 'only one form' } })).toBe('MM_LOG_INVALID: line 1 field ask');
    expect(() => parseMissLog(logText + JSON.stringify(LOG[0]))).toThrow('line 7 field id');
    expect(() => parseMissLog('{not json')).toThrow('line 1 field json');
  });
});

describe('miss-mining weekly counts', () => {
  test('counts one Monday-to-Sunday week by cause x ask kind x detection mode only', () => {
    expect(weekOf('2026-11-12')).toEqual({ start: '2026-11-09', end: '2026-11-15' });
    expect(weekOf('2026-11-09')).toEqual({ start: '2026-11-09', end: '2026-11-15' });
    expect(weekOf('2026-11-15')).toEqual({ start: '2026-11-09', end: '2026-11-15' });
    const w = weeklyCounts(entries, '2026-11-12');
    expect(w).toEqual({
      schema: 'miss-weekly-counts/v1', week_start: '2026-11-09', week_end: '2026-11-15', n_entries: 5,
      counts: {
        stale_fact: { lookup_meeting_prep: { garry_corrected: 1, found_later: 1 } },
        wrong_entity: { lookup_meeting_prep: { found_later: 1 } },
        retrieval_miss: { time_window: { tool_error: 1 } },
        privacy_hidden: { lookup_meeting_prep: { found_later: 1 } },
      },
    });
    const text = checkMissExport(w, missNeedles(entries));
    for (const needle of missNeedles(entries)) expect(text).not.toContain(needle);
    expect(text).not.toContain('miss-2026');
    expect(weeklyCounts(entries, '2026-11-17').n_entries).toBe(1);
  });

  test('the CLI writes the checked file and refuses a bad log without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miss-weekly-'));
    try {
      writeFileSync(join(dir, 'log.jsonl'), logText);
      const quiet = console.log, err = console.error;
      console.log = console.error = () => {};
      try {
        expect(weeklyMain(['--log', join(dir, 'log.jsonl'), '--week', '2026-11-10', '--out', join(dir, 'w.json')])).toBe(0);
        writeFileSync(join(dir, 'bad.jsonl'), JSON.stringify(entry({ cause: 'Marisol Vance' })));
        expect(weeklyMain(['--log', join(dir, 'bad.jsonl'), '--week', '2026-11-10', '--out', join(dir, 'bad.json')])).toBe(3);
        expect(weeklyMain([])).toBe(2);
      } finally { console.log = quiet; console.error = err; }
      expect(JSON.parse(readFileSync(join(dir, 'w.json'), 'utf8')).n_entries).toBe(5);
      expect(() => readFileSync(join(dir, 'bad.json'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('miss-mining custody (gate change F1)', () => {
  const PRIVATE = ['Marisol Vance', 'Bluejay', 'the voice app', 'Tommy', 'Thomas Lee', 'people/marisol-vance', 'Halcyon', 'Priya Rao', 'brightwell-8m', '415-555-0199', 'marisol@example.com'];
  const base = () => structuredClone(weeklyCounts(entries, '2026-11-12')) as any;

  test('every private-looking string under 42 characters is refused in any value, array or key position', () => {
    for (const s of PRIVATE) {
      expect(s.length).toBeLessThan(MAX_STRING);
      const placements: Array<(w: any) => void> = [
        w => { w.schema = s; },
        w => { w.week_start = s; },
        w => { w.counts.stale_fact.lookup_meeting_prep.garry_corrected = s; },
        w => { w.counts[s] = { status: { found_later: 1 } }; },
        w => { w.counts.stale_fact[s] = { found_later: 1 }; },
        w => { w.note = s; },
        w => { w.skipped_ids = [s]; },
        w => { w.counts.wrong_entity = [s]; },
      ];
      for (const place of placements) {
        const w = base();
        place(w);
        expect(refused(() => validateMissExport(w))).toBe('MM_CUSTODY_LEAK');
      }
    }
  });

  test('a seeded fuzz of short private-looking strings is refused, and the refusal names only the path', () => {
    let seed = 20261109;
    const next = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
    const first = ['Ines', 'Arlo', 'Dana', 'Theo', 'Mira', 'Rafael', 'Juno', 'Priya'];
    const last = ['Varga', 'Quint', 'Kim', 'Halloran', 'Osei', 'Rao', 'Lee'];
    const codenames = ['Bluejay', 'Kestrel', 'Osprey', 'Heron', 'Lumen', 'Corvid', 'Wren'];
    for (let i = 0; i < 300; i += 1) {
      const kind = Math.floor(next() * 4);
      const s = kind === 0 ? first[Math.floor(next() * first.length)] + ' ' + last[Math.floor(next() * last.length)]
        : kind === 1 ? codenames[Math.floor(next() * codenames.length)]!
        : kind === 2 ? 'project ' + codenames[Math.floor(next() * codenames.length)]!.toLowerCase()
        : last[Math.floor(next() * last.length)]!.toLowerCase() + '-' + Math.floor(next() * 1000);
      expect(s.length).toBeLessThan(MAX_STRING);
      const w = base();
      w.counts.retrieval_miss.time_window.tool_error = s;
      try { validateMissExport(w); throw new Error('accepted ' + i); } catch (e) {
        expect(e).toBeInstanceOf(MissMiningRefusal);
        expect((e as Error).message).not.toContain(s);
      }
    }
  });

  test('allowlisted words, path-bound dates and ids, finite numbers and the 42-character cap', () => {
    expect(() => validateMissExport(base())).not.toThrow();
    expect(refused(() => validateMissExport({ ...base(), n_entries: Number.NaN }))).toBe('MM_CUSTODY_LEAK');
    expect(refused(() => validateMissExport({ ...base(), n_entries: Infinity }))).toBe('MM_CUSTODY_LEAK');
    expect(refused(() => validateMissExport({ ...base(), schema: '2026-11-09' }))).toBe('MM_CUSTODY_LEAK');
    expect(refused(() => validateMissExport({ schema: 'miss-to-live-recall/v1', skipped_ids: ['miss-2026-11-10-001'] }))).toBe('accepted');
    expect(refused(() => validateMissExport({ schema: 'miss-to-live-recall/v1', week_start: 'miss-2026-11-10-001' }))).toBe('MM_CUSTODY_LEAK');
    expect(refused(() => validateMissExport({ schema: 'x'.repeat(MAX_STRING + 1) }))).toBe('MM_CUSTODY_LEAK');
  });

  test('the needle scan refuses a distinctive log string found anywhere in the export text, skips the formats\' own words, and names no content', () => {
    const w = weeklyCounts(entries, '2026-11-12');
    expect(refused(() => checkMissExport(w, ['notes/weekly-counts']))).toBe('accepted');
    expect(refused(() => checkMissExport(w, ['weekly-counts']))).toBe('MM_CUSTODY_LEAK');
    try { checkMissExport(w, ['weekly-counts']); } catch (e) { expect((e as Error).message).not.toContain('weekly-counts'); }
    expect(refused(() => checkMissExport(w, ['retrieval_miss', 'lookup_meeting_prep', 'miss-weekly-counts/v1']))).toBe('accepted');
  });
});

describe('miss-mining to live-recall', () => {
  test('entries with an ask become batch3 questions with derived types; the rest are skipped and counted', () => {
    expect(entries.map(liveTypeFor)).toEqual(['freshness', 'entity', 'time_window', 'topic', 'freshness', 'topic']);
    const { text, summary } = toLiveRecall(entries);
    const qs = parseQuestions(text, 'batch3');
    expect(qs.map(q => q.id + ':' + q.type)).toEqual(['miss-2026-11-10-001:freshness', 'miss-2026-11-11-001:entity', 'miss-2026-11-12-001:time_window']);
    expect(qs[0]!.stale).toEqual([{ slug: 'people/marisol-vance' }]);
    expect(qs[0]!.gold).toEqual([{ slug: 'meetings/2026-11-03-bluejay-sync' }]);
    expect(summary).toMatchObject({ converted: 3, skipped: { no_ask: 2, freshness_without_stale: 1 }, skipped_ids: ['miss-2026-11-12-002', 'miss-2026-11-13-001', 'miss-2026-11-17-001'] });
    const printed = checkMissExport(summary, missNeedles(entries));
    for (const needle of missNeedles(entries)) expect(printed).not.toContain(needle);
  });

  test('the CLI writes the question file privately and prints only the checked summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miss-convert-'));
    const lines: string[] = [];
    const quiet = console.log;
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try {
      writeFileSync(join(dir, 'log.jsonl'), logText);
      expect(convertMain(['--log', join(dir, 'log.jsonl'), '--out', join(dir, 'q.jsonl')])).toBe(0);
      expect(parseQuestions(readFileSync(join(dir, 'q.jsonl'), 'utf8'), 'batch3')).toHaveLength(3);
      const terminal = lines.join('\n');
      for (const needle of missNeedles(entries as MissEntry[])) expect(terminal).not.toContain(needle);
      expect(terminal).toContain('"converted": 3');
    } finally {
      console.log = quiet;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
